import { randomBytes, randomUUID } from 'node:crypto';

export const API_BASE = 'https://ilinkai.weixin.qq.com';
export function trustedApiBase(input = API_BASE) {
  const url = new URL(input.includes('://') ? input : `https://${input}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) {
    throw new Error('微信服务器返回了不受信任的 API 地址。');
  }
  return url.origin;
}

export class WeChatApi {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl; }
  async request(endpoint, { base = API_BASE, token, body, timeout = 40000 } = {}) {
    const headers = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '65536' };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64') });
      if (token) headers.Authorization = `Bearer ${token}`;
      if (token) body = { ...body, base_info: { channel_version: '1.0.0', bot_agent: 'CodexWeChat/1.0.0' } };
    }
    const response = await this.fetch(new URL(endpoint, `${trustedApiBase(base)}/`), {
      method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`微信接口 HTTP ${response.status}`);
    const result = await response.json();
    const code = result.errcode || result.ret || 0;
    if (code) {
      const error = new Error(`微信接口返回错误 ${code}，${code === -14 ? '登录已过期，请重新扫码。' : '请稍后重试。'}`);
      error.code = code;
      throw error;
    }
    return result;
  }
  qr(tokens = []) {
    return this.request('ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: tokens }, timeout: 60000 });
  }
  qrStatus(qrcode, base, verifyCode) {
    const query = new URLSearchParams({ qrcode });
    if (verifyCode) query.set('verify_code', verifyCode);
    return this.request(`ilink/bot/get_qrcode_status?${query}`, { base });
  }
  updates(account, cursor) {
    return this.request('ilink/bot/getupdates', { base: account.base, token: account.token,
      body: { get_updates_buf: cursor || '' }, timeout: 65000 });
  }
  send(account, to, context, text, clientId = `codex-wechat-${randomUUID()}`) {
    return this.request('ilink/bot/sendmessage', { base: account.base, token: account.token, body: { msg: {
      from_user_id: '', to_user_id: to, client_id: clientId, message_type: 2,
      message_state: 2, context_token: context, item_list: [{ type: 1, text_item: { text } }],
    } } });
  }
}

export function inboundText(message) {
  return (message.item_list || []).map(item => item.type === 1 ? item.text_item?.text :
    item.type === 3 ? item.voice_item?.text : '').filter(Boolean).join('\n');
}

export function splitText(text, size = 1800) {
  const points = Array.from(text);
  const chunks = [];
  for (let i = 0; i < points.length; i += size) chunks.push(points.slice(i, i + size).join(''));
  return chunks;
}
