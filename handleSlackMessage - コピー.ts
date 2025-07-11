import dotenv from 'dotenv';
const envPath = `.env.${process.env.ENV || 'personal'}`;
dotenv.config({ path: envPath });
console.log(`✅ [handleSlackMessage.ts] .env ファイル読み込み: ${envPath}`);

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

async function fetchConnectToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }
  const connectTokenUrl =
    process.env.CONNECT_TOKEN_URL || 'http://localhost:3001/connect-token';
  const res = await axios.get(connectTokenUrl);
  cachedToken = res.data.token;
  return cachedToken;
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

  const token = await fetchConnectToken();

  const gmailTool = getMcpTool('gmail', token);
  const calendarTool = getMcpTool('calendar', token);

  let response;
  try {
    response = await openai.responses.create({
      model: 'gpt-4.1',
      input: getHistory(userId).join('\n'),
      tools: [gmailTool, calendarTool],
    });
  } catch (e: any) {
    await say('⚠️ OpenAI APIエラー: ' + (e.message || e.toString()));
    return;
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
        await say('⚠️ Gmail API連携エラー: ' + (e.message || e.toString()));
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
  return axios.post(url, data, { headers });
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
  return axios.post(url, data, { headers });
}
