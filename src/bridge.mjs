import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { WeChatApi, API_BASE, inboundText, splitText, trustedApiBase } from './wechat.mjs';
import { CodexClient } from './codex.mjs';
import { loadState, statePath, writeJson, safeError } from './state.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function messageKey(message) {
  return createHash('sha256').update(JSON.stringify([
    message.from_user_id, message.message_id || message.client_id || message.seq || message,
  ])).digest('hex');
}

export class Bridge {
  constructor({ api = new WeChatApi(), codex = new CodexClient(), persist = value => writeJson(statePath, value) } = {}) {
    this.api = api;
    this.codex = codex;
    this.persist = persist;
    this.running = true;
    this.login = null;
    this.lastError = null;
    this.busy = false;
    this.saveQueue = Promise.resolve();
  }
  async init(workspace) {
    this.state = await loadState();
    if (workspace) await this.setWorkspace(workspace);
    this.loop = this.pollLoop();
  }
  save() {
    const snapshot = structuredClone(this.state);
    const operation = this.saveQueue.catch(() => {}).then(() => this.persist(snapshot));
    this.saveQueue = operation;
    return operation;
  }
  async setWorkspace(directory) {
    if (this.busy) throw new Error('正在处理微信消息，请完成后再切换目录。');
    const workspace = await fs.realpath(directory);
    if (!(await fs.stat(workspace)).isDirectory()) throw new Error('工作目录不存在。');
    if (workspace !== this.state.workspace) {
      if (this.state.pending.length) throw new Error('还有待回复的微信消息，请处理完成后再切换目录。');
      this.state.workspace = workspace;
      this.state.sessions = {};
      this.loadedThread = null;
      await this.save();
    }
  }
  status() {
    return { connected: Boolean(this.state.account) && !this.expired, workspace: this.state.workspace,
      readOnly: true, busy: this.busy, pending: this.state.pending.length,
      loginStatus: this.login?.status || null, error: this.lastError,
      threadId: this.state.account ? this.state.sessions[this.state.account.user] || null : null,
      lastReceivedAt: this.state.lastReceivedAt || null, lastRepliedAt: this.state.lastRepliedAt || null };
  }
  async startLogin(workspace) {
    if (workspace) await this.setWorkspace(workspace);
    if (this.expired) await this.disconnect();
    if (this.state.account) return { ...this.status(), message: '已连接，如需更换账号，请先断开连接。' };
    if (this.login && Date.now() - this.login.created < 240000 && !['expired', 'verify_code_blocked', 'error'].includes(this.login.status)) {
      return { ...this.status(), qr: this.login.png };
    }
    if (this.loginRequest) return this.loginRequest;
    this.loginRequest = this.createLogin().finally(() => { this.loginRequest = null; });
    return this.loginRequest;
  }
  async createLogin() {
    const result = await this.api.qr();
    if (!result.qrcode || !result.qrcode_img_content) throw new Error('微信未返回二维码。');
    const png = (await QRCode.toBuffer(result.qrcode_img_content, { width: 360, margin: 3 })).toString('base64');
    const login = this.login = { qrcode: result.qrcode, png, created: Date.now(), status: 'wait', base: API_BASE };
    this.lastError = null;
    this.loginLoop(login).catch(error => { if (this.login === login) { this.lastError = safeError(error); login.status = 'error'; } });
    return { ...this.status(), qr: png };
  }
  async loginLoop(login) {
    while (this.running && this.login === login && Date.now() - login.created < 300000) {
      if (login.status === 'need_verifycode' && !login.verifyCode) { await delay(500); continue; }
      let result;
      try { result = await this.api.qrStatus(login.qrcode, login.base, login.verifyCode); }
      catch (error) { this.lastError = safeError(error); await delay(2000); continue; }
      if (this.login !== login) return;
      this.lastError = null;
      login.status = result.status;
      if (result.status === 'scaned_but_redirect' && result.redirect_host) login.base = trustedApiBase(result.redirect_host);
      if (result.status === 'need_verifycode') login.verifyCode = null;
      if (['expired', 'verify_code_blocked'].includes(result.status)) return;
      if (result.status === 'binded_redirect') throw new Error('此微信连接已绑定其他实例，请在微信中解除后重新扫码。');
      if (result.status === 'confirmed') {
        if (!result.bot_token || !result.ilink_user_id || !result.ilink_bot_id) {
          throw new Error('微信未返回完整账号信息，无法确认扫码账号。请重新登录。');
        }
        this.state.account = { token: result.bot_token, user: result.ilink_user_id,
          bot: result.ilink_bot_id, base: trustedApiBase(result.baseurl || login.base) };
        this.state.cursor = '';
        this.state.seen = [];
        this.state.pending = [];
        this.state.sessions = {};
        await this.save();
        this.login = null;
        return;
      }
      await delay(800);
    }
    if (this.login === login) login.status = 'expired';
  }
  verify(code) {
    if (this.login?.status !== 'need_verifycode') throw new Error('当前不需要验证码。');
    if (!/^\d{4,12}$/.test(code)) throw new Error('请输入微信上显示的数字验证码。');
    this.login.verifyCode = code;
    return { ok: true };
  }
  async disconnect() {
    if (this.busy) throw new Error('正在处理消息，请完成后断开连接。');
    this.login = null;
    this.expired = false;
    this.loadedThread = null;
    delete this.state.account;
    this.state.cursor = '';
    this.state.pending = [];
    this.state.seen = [];
    this.state.sessions = {};
    this.lastError = null;
    await this.save();
    return this.status();
  }
  async ingest(response, account) {
    if (this.state.account !== account) return;
    const known = new Set([...this.state.seen, ...this.state.pending.map(item => item.key)]);
    for (const message of response.msgs || []) {
      if (message.message_type !== 1 || message.from_user_id !== account.user || message.group_id || !message.context_token) continue;
      const key = messageKey(message);
      if (known.has(key)) continue;
      known.add(key);
      this.state.pending.push({ key, message, sent: 0 });
      this.state.lastReceivedAt = new Date().toISOString();
    }
    // Persist the inbox and cursor in the same atomic snapshot before processing.
    if (response.get_updates_buf) this.state.cursor = response.get_updates_buf;
    await this.save();
  }
  async processNext() {
    const item = this.state.pending[0];
    const account = this.state.account;
    if (!item || !account) return;
    this.busy = true;
    try {
      const message = item.message;
      const text = inboundText(message).trim();
      if (!item.chunks) {
        let reply;
        if (text === '/new') {
          delete this.state.sessions[account.user];
          reply = '已开始新的对话。';
        } else if (text === '/status') {
          reply = `Codex 微信已连接\n工作目录：${this.state.workspace}\n文件权限：只读\n新对话：/new`;
        } else if (!text) {
          reply = '当前支持文字和已转写为文字的语音。请用文字描述你的问题或本地文件路径。';
        } else {
          try {
            let thread = this.state.sessions[account.user];
            if (!this.loadedThread || this.loadedThread !== thread) {
              thread = await this.codex.thread(this.state.workspace, thread);
              this.state.sessions[account.user] = thread;
              this.loadedThread = thread;
              await this.save();
            }
            reply = await this.codex.answer(thread, this.state.workspace, text);
          } catch (error) {
            this.loadedThread = null;
            reply = `Codex 暂时无法完成本次请求：${safeError(error)}\n请检查桌面版的模型连接，或发送 /new 开始新对话后重试。`;
          }
        }
        item.chunks = splitText(reply);
        await this.save();
      }
      for (; item.sent < item.chunks.length; ) {
        await this.api.send(account, message.from_user_id, message.context_token,
          item.chunks[item.sent], `cw-${item.key.slice(0, 32)}-${item.sent}`);
        item.sent++;
        await this.save();
      }
      this.state.pending.shift();
      this.state.seen = [...this.state.seen, item.key].slice(-2000);
      this.state.lastRepliedAt = new Date().toISOString();
      this.lastError = null;
      await this.save();
    } finally { this.busy = false; }
  }
  async pollLoop() {
    let failures = 0;
    while (this.running) {
      if (!this.state.account || this.expired) { await delay(1000); continue; }
      try {
        if (this.state.pending.length) await this.processNext();
        else {
          const account = this.state.account;
          const updates = await this.api.updates(account, this.state.cursor);
          await this.ingest(updates, account);
          if (!updates.msgs?.length) await delay(300);
        }
        failures = 0;
      } catch (error) {
        this.lastError = safeError(error);
        if (!this.codex.child) this.loadedThread = null;
        if (error.code === -14) {
          // Require a fresh login instead of repeatedly hitting an expired session.
          this.expired = true;
          this.login = null;
        }
        await delay(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)));
      }
    }
  }
  close() { this.running = false; this.login = null; this.codex.close(); }
}
