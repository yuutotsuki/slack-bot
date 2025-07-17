import axios from 'axios';
import { Mutex } from 'async-mutex';
import { getEnvironmentVariable } from '../config/environment';

let cachedToken: string = '';
let tokenExpiry: number = 0; // トークンの有効期限（UNIXタイムスタンプ）
const tokenMutex = new Mutex();

export async function fetchConnectToken(): Promise<string> {
  return await tokenMutex.runExclusive(async () => {
    const now = Date.now();
    if (cachedToken && now < tokenExpiry) {
      console.log('🔄 [tokenService] キャッシュされたトークンを使用');
      return cachedToken;
    }
    if (cachedToken) {
      console.log('🔄 [tokenService] トークンが期限切れのため更新します');
      cachedToken = '';
      tokenExpiry = 0;
    }
    const connectTokenUrl = getEnvironmentVariable('CONNECT_TOKEN_URL', 'http://localhost:3001/connect-token');
    console.log('🔗 [tokenService] 使用するURL:', connectTokenUrl);
    try {
      const res = await axios.get(connectTokenUrl);
      cachedToken = res.data.token;
      const expiresIn = res.data.expires_in || 1800;
      tokenExpiry = now + (expiresIn * 1000);
      console.log('✅ [tokenService] トークン取得成功');
      console.log(`⏰ [tokenService] トークン有効期限: ${new Date(tokenExpiry).toLocaleString()}`);
      return cachedToken;
    } catch (error: any) {
      console.error('❌ [tokenService] トークン取得エラー:', error.message);
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