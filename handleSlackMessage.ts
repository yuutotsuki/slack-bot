import dotenv from 'dotenv';
const envPath = `.env.${process.env.ENV || 'personal'}`;
dotenv.config({ path: envPath });
console.log(`✅ [handleSlackMessage.ts] .env ファイル読み込み: ${envPath}`);

// 環境変数読み込み後の確認ログ（セキュリティ考慮）
console.log('🔍 [handleSlackMessage.ts] 環境変数読み込み確認:');
console.log('  - ENV:', process.env.ENV);
console.log('  - NODE_ENV:', process.env.NODE_ENV);
console.log('  - CONNECT_TOKEN_URL:', process.env.CONNECT_TOKEN_URL);
console.log('  - OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '設定済み' : '未設定');
console.log('  - PIPEDREAM_PROJECT_ID:', process.env.PIPEDREAM_PROJECT_ID ? '設定済み' : '未設定');

import { SayFn } from '@slack/bolt';
import OpenAI from 'openai';
import {
  getHistory,
  setHistory,
  appendToHistory,
  clearHistory,
} from './conversationStore';
import { getMcpTool } from './getMcpTool';
import { buildSystemPrompt } from './promptBuilder';
import axios from 'axios';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

let cachedToken: string = '';
let tokenExpiry: number = 0; // トークンの有効期限（UNIXタイムスタンプ）

async function fetchConnectToken(): Promise<string> {
  const now = Date.now();
  
  // トークンが存在し、有効期限が切れていない場合はキャッシュを使用
  if (cachedToken && now < tokenExpiry) {
    console.log('🔄 [fetchConnectToken] キャッシュされたトークンを使用');
    return cachedToken;
  }
  
  // トークンが無効または期限切れの場合はクリア
  if (cachedToken) {
    console.log('🔄 [fetchConnectToken] トークンが期限切れのため更新します');
    cachedToken = '';
    tokenExpiry = 0;
  }
  
  // 環境変数のデバッグ用ログ（セキュリティ考慮）
  console.log('🔍 [fetchConnectToken] 環境変数確認:');
  console.log('  - CONNECT_TOKEN_URL:', process.env.CONNECT_TOKEN_URL);
  console.log('  - ENV:', process.env.ENV);
  console.log('  - NODE_ENV:', process.env.NODE_ENV);
  
  const connectTokenUrl =
    process.env.CONNECT_TOKEN_URL || 'http://localhost:3001/connect-token';
  
  console.log('🔗 [fetchConnectToken] 使用するURL:', connectTokenUrl);
  
  try {
    const res = await axios.get(connectTokenUrl);
    cachedToken = res.data.token;
    
    // トークンの有効期限を設定（デフォルトで30分後）
    // レスポンスにexpires_inが含まれている場合はそれを使用
    const expiresIn = res.data.expires_in || 1800; // デフォルト30分
    tokenExpiry = now + (expiresIn * 1000);
    
    console.log('✅ [fetchConnectToken] トークン取得成功');
    console.log(`⏰ [fetchConnectToken] トークン有効期限: ${new Date(tokenExpiry).toLocaleString()}`);
    return cachedToken;
  } catch (error: any) {
    console.error('❌ [fetchConnectToken] トークン取得エラー:', error.message);
    console.error('  - ステータス:', error.response?.status);
    console.error('  - レスポンス:', error.response?.data);
    
    // エラー時はキャッシュをクリア
    cachedToken = '';
    tokenExpiry = 0;
    throw error;
  }
}

// =============================
// draftId方式 仮記憶ストア
// =============================
export type DraftData = {
  body: string;
  threadId?: string;
  subject?: string;
  to?: string;
  createdAt: number; // UNIXタイムスタンプ
};

// userIdごとにdraftIdでDraftDataを管理
const draftMap: { [userId: string]: { [draftId: string]: DraftData } } = {};

// UUID生成関数（簡易版）
function generateDraftId(): string {
  return 'draft-' + Math.random().toString(36).substr(2, 9);
}

export async function handleSlackMessage(message: any, say: SayFn) {
  console.log("📩 Step 1: Slackからメッセージを受信しました", message);
  const userId = message.user;
  if (!userId || message.subtype === 'bot_message') return;

  const start = isStartMessage(message, userId);
  const history = getHistory(userId);

  if (start) {
    await say('📨 アシスタントを起動したよ！🤖');
    setHistory(userId, [buildSystemPrompt(message.text)]);
  } else {
    appendToHistory(userId, `\n---\n${message.text}\n---`);
  }

  let token: string;
  try {
    console.log("🔐 Step 2: connect-token-server へ fetchConnectToken 開始");
    token = await fetchConnectToken();
    console.log("🔑 Step 3: トークン取得成功", token);
  } catch (error: any) {
    console.error('❌ [fetchConnectToken] トークン取得エラー:', error);
    await say('⚠️ connect-token-server からトークン取得に失敗しました: ' + (error.message || error.toString()));
    return;
  }

  const gmailTool = getMcpTool('gmail', token);
  const calendarTool = getMcpTool('calendar', token);

  let response;
  try {
    console.log("📡 Step 4: OpenAI に問い合わせ開始");
    response = await openai.responses.create({
      model: 'gpt-4.1',
      input: getHistory(userId).join('\n'),
      tools: [gmailTool, calendarTool],
    });
    console.log("✅ Step 5: OpenAI 応答を受信", response);
  } catch (e: any) {
    console.error("❌ [OpenAI APIエラー]", e);
    
    // 401エラーの場合はトークンを更新して再試行
    if (e.message && e.message.includes('401') && e.message.includes('invalid')) {
      console.log("🔄 [OpenAI API] 401エラー検出、トークンを更新して再試行");
      cachedToken = '';
      tokenExpiry = 0;
      
      try {
        const newToken = await fetchConnectToken();
        const newGmailTool = getMcpTool('gmail', newToken);
        const newCalendarTool = getMcpTool('calendar', newToken);
        
        response = await openai.responses.create({
          model: 'gpt-4.1',
          input: getHistory(userId).join('\n'),
          tools: [newGmailTool, newCalendarTool],
        });
        console.log("✅ Step 5: トークン更新後のOpenAI 応答を受信", response);
      } catch (retryError: any) {
        console.error("❌ [OpenAI API再試行エラー]", retryError);
        await say('⚠️ トークン更新後もOpenAI APIエラーが発生しました: ' + (retryError.message || retryError.toString()));
        return;
      }
    } else {
      await say('⚠️ OpenAI APIエラー: ' + (e.message || e.toString()));
      return;
    }
  }

  let text = response.output_text ?? '';
  console.log('[handleSlackMessage] OpenAI response text:', text);

  // draftId抽出・保存処理
  let draftIdMatch = text.match(/draftId: ([a-zA-Z0-9\-_]+)/);
  let draftId = draftIdMatch ? draftIdMatch[1] : undefined;
  if (!draftId) {
    draftId = generateDraftId();
    text += `\ndraftId: ${draftId}`;
  }

  // 本文・threadId・件名・宛先の抽出（簡易: 正規表現やパターンで）
  const bodyMatch = text.match(/本文[:：]\s*([\s\S]*?)(?:\n|$)/);
  const subjectMatch = text.match(/件名[:：]\s*(.+)/);
  const toMatch = text.match(/宛先[:：]\s*(.+)/);
  const threadIdMatch = text.match(/threadId[:：]?\s*([a-zA-Z0-9\-_]+)/);

  const draftData: DraftData = {
    body: bodyMatch ? bodyMatch[1].trim() : '',
    subject: subjectMatch ? subjectMatch[1].trim() : undefined,
    to: toMatch ? toMatch[1].trim() : undefined,
    threadId: threadIdMatch ? threadIdMatch[1].trim() : undefined,
    createdAt: Date.now(),
  };
  if (!draftMap[userId]) draftMap[userId] = {};
  draftMap[userId][draftId] = draftData;

  if (/下書きが作成|送信しました|ラベルを追加|保存しました/.test(text)) {
    await say('✅ Gmail 操作を完了したよ！\n\n' + text + '\n\n💬 必要なら書き続けて指示してね。');
    clearHistory(userId);
  } else if (/認証|エラー/.test(text)) {
    await say('⚠️ エラーかも…トークンや権限を確認してね。');
    clearHistory(userId);
  } else {
    // 「保存して」「送信して」等の後続コマンド時のdraftId特定
    if (/保存して|送信して/.test(message.text)) {
      // メッセージからdraftIdを抽出
      let msgDraftIdMatch = message.text.match(/draftId[:：]?\s*([a-zA-Z0-9\-_]+)/);
      let useDraftId = msgDraftIdMatch ? msgDraftIdMatch[1] : undefined;
      if (!useDraftId && draftMap[userId]) {
        // 直近のdraftId（createdAtが最大のもの）
        const drafts = Object.entries(draftMap[userId]);
        if (drafts.length > 0) {
          drafts.sort((a, b) => b[1].createdAt - a[1].createdAt);
          useDraftId = drafts[0][0];
        }
      }
      if (!useDraftId || !draftMap[userId] || !draftMap[userId][useDraftId]) {
        await say('⚠️ draftIdが見つかりません。直近のメール作成後に「保存して」や「送信して」と指示してください。');
        return;
      }
      // draftMap[userId][useDraftId] を参照して処理（ここでGmail API送信/保存などを実装）
      // ここでは仮に内容を表示
      const draft = draftMap[userId][useDraftId];
      try {
        let result;
        if (/保存して/.test(message.text)) {
          result = await createGmailDraft(token, draft);
          await say(`✅ 下書きを保存しました（draftId: ${useDraftId}）`);
        } else if (/送信して/.test(message.text)) {
          result = await sendGmailMail(token, draft);
          await say(`✅ メールを送信しました（draftId: ${useDraftId}）`);
        }
        // draft使用後は削除
        delete draftMap[userId][useDraftId];
      } catch (e: any) {
        console.error('❌ [Gmail API連携エラー]', e);
        
        // 401エラーの場合はトークンを更新して再試行
        if (e.response?.status === 401 || (e.message && e.message.includes('401'))) {
          console.log("🔄 [Gmail API] 401エラー検出、トークンを更新して再試行");
          cachedToken = '';
          tokenExpiry = 0;
          
          try {
            const newToken = await fetchConnectToken();
            let retryResult;
            if (/保存して/.test(message.text)) {
              retryResult = await createGmailDraft(newToken, draft);
              await say(`✅ 下書きを保存しました（draftId: ${useDraftId}）`);
            } else if (/送信して/.test(message.text)) {
              retryResult = await sendGmailMail(newToken, draft);
              await say(`✅ メールを送信しました（draftId: ${useDraftId}）`);
            }
            // draft使用後は削除
            delete draftMap[userId][useDraftId];
          } catch (retryError: any) {
            console.error("❌ [Gmail API再試行エラー]", retryError);
            await say('⚠️ トークン更新後もGmail API連携エラーが発生しました: ' + (retryError.message || retryError.toString()));
          }
        } else {
          await say('⚠️ Gmail API連携エラー: ' + (e.message || e.toString()));
        }
      }
    } else {
      await say('📝 ' + text + '\n\n問題なければ「送信して」「ラベルをつけて」など返信してね。やめる場合は返信不要だよ。');
    }
  }
}

function isStartMessage(message: any, userId: string): boolean {
  const text = typeof message.text === 'string' ? message.text : '';
  const hasKeyword = /(下書き|送信|ラベル|メール)/.test(text);
  const noHistory = !getHistory(userId) || getHistory(userId).length === 0;
  return hasKeyword || noHistory;
}

// draft一覧取得
export function getDrafts(userId: string): { [draftId: string]: DraftData } {
  return draftMap[userId] || {};
}

// draft削除
export function deleteDraft(userId: string, draftId: string): boolean {
  if (draftMap[userId] && draftMap[userId][draftId]) {
    delete draftMap[userId][draftId];
    return true;
  }
  return false;
}

// =============================
// Gmail API連携（下書き保存・送信）
// =============================
async function createGmailDraft(token: string, draft: DraftData) {
  const url = 'https://remote.mcp.pipedream.net/actions/gmail/create_draft';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-pd-project-id': process.env.PIPEDREAM_PROJECT_ID!,
    'x-pd-environment': process.env.PIPEDREAM_ENVIRONMENT!,
    'x-pd-external-user-id': process.env.PIPEDREAM_EXTERNAL_USER_ID!,
    'x-pd-app-slug': 'gmail',
  };
  const data = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
  };
  console.log("🚀 Step 6: Gmail 下書き作成リクエスト開始");
  const res = await axios.post(url, data, { headers });
  console.log("✅ Step 7: Gmail 下書き作成リクエスト成功", res.data);
  return res;
}

async function sendGmailMail(token: string, draft: DraftData) {
  const url = 'https://remote.mcp.pipedream.net/actions/gmail/send_email';
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-pd-project-id': process.env.PIPEDREAM_PROJECT_ID!,
    'x-pd-environment': process.env.PIPEDREAM_ENVIRONMENT!,
    'x-pd-external-user-id': process.env.PIPEDREAM_EXTERNAL_USER_ID!,
    'x-pd-app-slug': 'gmail',
  };
  const data = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
  };
  console.log("🚀 Step 6: Gmail メール送信リクエスト開始");
  const res = await axios.post(url, data, { headers });
  console.log("✅ Step 7: Gmail メール送信リクエスト成功", res.data);
  return res;
}
