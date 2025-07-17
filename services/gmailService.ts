import axios from 'axios';
import { getEnvironmentVariable } from '../config/environment';
import { DraftData } from '../models/draftStore';

function buildPdHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-pd-project-id': getEnvironmentVariable('PIPEDREAM_PROJECT_ID'),
    'x-pd-environment': getEnvironmentVariable('PIPEDREAM_ENVIRONMENT'),
    'x-pd-external-user-id': getEnvironmentVariable('PIPEDREAM_EXTERNAL_USER_ID'),
    'x-pd-app-slug': 'gmail',
  };
}

export async function createGmailDraft(token: string, draft: DraftData) {
  const url = 'https://remote.mcp.pipedream.net/actions/gmail/create_draft';
  const headers = buildPdHeaders(token);
  const data = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
  };
  console.log('🚀 [gmailService] Gmail 下書き作成リクエスト開始');
  const res = await axios.post(url, data, { headers });
  console.log('✅ [gmailService] Gmail 下書き作成リクエスト成功', res.data);
  return res;
}

export async function sendGmailMail(token: string, draft: DraftData) {
  const url = 'https://remote.mcp.pipedream.net/actions/gmail/send_email';
  const headers = buildPdHeaders(token);
  const data = {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
    threadId: draft.threadId,
  };
  console.log('🚀 [gmailService] Gmail メール送信リクエスト開始');
  const res = await axios.post(url, data, { headers });
  console.log('✅ [gmailService] Gmail メール送信リクエスト成功', res.data);
  return res;
} 