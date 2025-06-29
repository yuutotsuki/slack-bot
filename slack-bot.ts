// ===== .env.personal / .env.company 切り替え対応エントリーポイント =====
// slack-bot.ts
// ------------------------------------------------------------
import dotenv from 'dotenv';
// ENV が "company" なら .env.company、指定が無ければ .env.personal を読む
const envPath = `.env.${process.env.ENV || 'personal'}`;
dotenv.config({ path: envPath });
console.log(`✅ .env ファイル読み込み: ${envPath}`);

import { App } from '@slack/bolt';
import { handleSlackMessage } from './handleSlackMessage';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.message(async ({ message, say }) => {
  await handleSlackMessage(message, say);
});

const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
];
const missingVars = requiredEnvVars.filter((key) => !process.env[key]);
if (missingVars.length > 0) {
  console.error(`❌ 必須の環境変数が設定されていません: ${missingVars.join(', ')}`);
  process.exit(1);
}

(async () => {
  try {
    await app.start(3000);
    console.log('⚡️ Slack Gmail Assistant is running on port 3000');
  } catch (error) {
    console.error('❌ アプリの起動中にエラーが発生しました:', error);
    process.exit(1);
  }
})();
