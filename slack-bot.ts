import { App } from '@slack/bolt';
import { handleSlackMessage } from './handleSlackMessage';
import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.message(async ({ message, say }) => {
  await handleSlackMessage(message, say);
});

(async () => {
  await app.start(3000);
  console.log('⚡️ Slack Gmail Assistant is running on port 3000');
})();
