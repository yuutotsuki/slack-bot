import { initializeEnvironment } from './config/environment';
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
import { Mutex } from 'async-mutex';
import util from 'util';
import { fetchConnectToken, clearTokenCache } from './services/tokenService';
import { createGmailDraft, sendGmailMail } from './services/gmailService';
import {
  DraftData,
  generateDraftId,
  saveDraft,
  getDrafts,
  deleteDraft,
  getLatestDraftId
} from './models/draftStore';

// 環境変数初期化（最初に実行）
initializeEnvironment();

function redactSensitive(str: string): string {
  return str
    .replace(/Bearer [\w\-\.]+/g, 'Bearer ***')
    .replace(/token["']?: ?["']?[\w\-\.]+["']?/gi, 'token: "***"');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    console.error("❌ [OpenAI APIエラー]", redactSensitive(util.inspect(e, { depth: 1 })));
    
    // 401エラーの場合はトークンを更新して再試行
    if (e.response?.status === 401) {
      console.log("🔄 [OpenAI API] 401エラー検出、トークンを更新して再試行");
      clearTokenCache();
      
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
        console.error("❌ [OpenAI API再試行エラー]", redactSensitive(util.inspect(retryError, { depth: 1 })));
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
  saveDraft(userId, draftId, draftData);

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
      if (!useDraftId && getDrafts(userId)) {
        // 直近のdraftId（createdAtが最大のもの）
        const drafts = Object.entries(getDrafts(userId));
        if (drafts.length > 0) {
          drafts.sort((a, b) => b[1].createdAt - a[1].createdAt);
          useDraftId = drafts[0][0];
        }
      }
      if (!useDraftId || !getDrafts(userId) || !getDrafts(userId)[useDraftId]) {
        await say('⚠️ draftIdが見つかりません。直近のメール作成後に「保存して」や「送信して」と指示してください。');
        return;
      }
      // draftMap[userId][useDraftId] を参照して処理（ここでGmail API送信/保存などを実装）
      // ここでは仮に内容を表示
      const draft = getDrafts(userId)[useDraftId];
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
        deleteDraft(userId, useDraftId);
      } catch (e: any) {
        console.error('❌ [Gmail API連携エラー]', redactSensitive(util.inspect(e, { depth: 1 })));
        
        // 401エラーの場合はトークンを更新して再試行
        if (e.response?.status === 401) {
          console.log("🔄 [Gmail API] 401エラー検出、トークンを更新して再試行");
          clearTokenCache();
          
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
            deleteDraft(userId, useDraftId);
          } catch (retryError: any) {
            console.error("❌ [Gmail API再試行エラー]", redactSensitive(util.inspect(retryError, { depth: 1 })));
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
