import axios from 'axios';
import { Mutex } from 'async-mutex';

let cachedToken: string = '';
let tokenExpiry: number = 0; // トークンの有効期限（UNIXタイムスタンプ）
const tokenMutex = new Mutex(); // fetchConnectToken用のmutex

export async function fetchConnectToken(): Promise<string> {
  return await tokenMutex.runExclusive(async () => {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
      console.log('🔄 [fetchConnectToken] キャッシュされたトークンを使用');
      return cachedToken;
    }
    if (cachedToken) {
      console.log('🔄 [fetchConnectToken] トークンが期限切れのため更新します');
      cachedToken = '';
      tokenExpiry = 0;
    }
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
      const expiresIn = res.data.expires_in || 1800; // デフォルト30分
      tokenExpiry = now + (expiresIn * 1000);
      console.log('✅ [fetchConnectToken] トークン取得成功');
      console.log(`⏰ [fetchConnectToken] トークン有効期限: ${new Date(tokenExpiry).toLocaleString()}`);
      return cachedToken;
    } catch (error: any) {
      console.error('❌ [fetchConnectToken] トークン取得エラー:', error.message);
      console.error('  - ステータス:', error.response?.status);
      console.error('  - レスポンス:', error.response?.data);
      cachedToken = '';
      tokenExpiry = 0;
      throw error;
    }
  });
}

export function clearTokenCache() {
  cachedToken = '';
  tokenExpiry = 0;
} 