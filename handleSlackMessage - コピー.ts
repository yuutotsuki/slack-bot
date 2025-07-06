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

  const text = response.output_text ?? '';
  console.log('[handleSlackMessage] OpenAI response text:', text);

  if (/下書きが作成|送信しました|ラベルを追加|保存しました/.test(text)) {
    await say('✅ Gmail 操作を完了したよ！\n\n' + text + '\n\n💬 必要なら書き続けて指示してね。');
    clearHistory(userId);
  } else if (/認証|エラー/.test(text)) {
    await say('⚠️ エラーかも…トークンや権限を確認してね。');
    clearHistory(userId);
  } else {
    await say('📝 ' + text + '\n\n問題なければ「送信して」「ラベルをつけて」など返信してね。やめる場合は返信不要だよ。');
  }
}

function isStartMessage(message: any, userId: string): boolean {
  const text = typeof message.text === 'string' ? message.text : '';
  const hasKeyword = /(下書き|送信|ラベル|メール)/.test(text);
  const noHistory = !getHistory(userId) || getHistory(userId).length === 0;
  return hasKeyword || noHistory;
}
