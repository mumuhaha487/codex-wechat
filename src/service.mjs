import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bridge } from './bridge.mjs';
import { dataDir, runtimePath, readJson, writeJson, safeError } from './state.mjs';

export const entryPath = fileURLToPath(import.meta.url);
export const defaultPort = Number(process.env.CODEX_WECHAT_PORT || 17389);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function callService(runtime, route, body) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(route === '/api/login' ? 75000 : 10000), redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `本地服务 HTTP ${response.status}`);
  return result;
}

export async function findService() {
  const runtime = await readJson(runtimePath);
  if (!runtime || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !/^[a-f0-9]{64}$/.test(runtime.token)) return null;
  try { await callService(runtime, '/api/status'); return runtime; } catch { return null; }
}

export async function ensureService(workspace) {
  const existing = await findService();
  if (existing) {
    if (workspace) await callService(existing, '/api/workspace', { workspace });
    return existing;
  }
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const log = await fs.open(path.join(dataDir, 'service.log'), 'a', 0o600);
  try {
    const args = [entryPath, 'serve'];
    if (workspace) args.push('--workspace', workspace);
    const child = spawn(process.execPath, args, { detached: true, windowsHide: true,
      stdio: ['ignore', log.fd, log.fd], cwd: workspace || process.cwd() });
    child.on('error', () => {});
    child.unref();
  } finally { await log.close(); }
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(250);
    const runtime = await findService();
    if (runtime) return runtime;
  }
  throw new Error(`微信本地服务启动失败，请检查 ${path.join(dataDir, 'service.log')}`);
}

export function dashboardUrl(runtime) {
  return `http://127.0.0.1:${runtime.port}/#${runtime.token}`;
}

export function validAuthorization(actual, token) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(`Bearer ${token}`);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16384) throw new Error('请求过大。');
  }
  return body ? JSON.parse(body) : {};
}

export async function serve(workspace) {
  if (await findService()) return;
  const bridge = new Bridge();
  // Do not initialize a second polling loop until the listening port is ours.
  const runtime = { port: defaultPort, token: randomBytes(32).toString('hex'), pid: process.pid };
  const dashboard = await fs.readFile(path.join(path.dirname(entryPath), 'dashboard.html'), 'utf8');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    const expectedHost = `127.0.0.1:${runtime.port}`;
    const origin = request.headers.origin;
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    if (request.headers.host !== expectedHost || (origin && origin !== `http://${expectedHost}`)) {
      json(403, { error: '请求来源不受信任。' }); return;
    }
    if (request.method === 'GET' && request.url === '/') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(dashboard); return;
    }
    if (!validAuthorization(request.headers.authorization, runtime.token)) { json(401, { error: '请使用完整的本地连接页面链接。' }); return; }
    try {
      if (request.method === 'GET' && request.url === '/api/status') { json(200, bridge.status()); return; }
      if (request.method === 'GET' && request.url === '/api/qr') { json(200, { qr: bridge.login?.png || null }); return; }
      if (request.method !== 'POST') { json(404, { error: '未找到此接口。' }); return; }
      const body = await readBody(request);
      if (request.url === '/api/login') json(200, await bridge.startLogin(body.workspace));
      else if (request.url === '/api/verify') json(200, bridge.verify(body.code));
      else if (request.url === '/api/disconnect') json(200, await bridge.disconnect());
      else if (request.url === '/api/workspace') { await bridge.setWorkspace(body.workspace); json(200, bridge.status()); }
      else if (request.url === '/api/stop') {
        if (bridge.busy) throw new Error('正在处理消息，请完成后停止服务。');
        json(200, { stopped: true });
        setTimeout(shutdown, 100);
      } else json(404, { error: '未找到此接口。' });
    } catch (error) { json(400, { error: safeError(error) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(defaultPort, '127.0.0.1', resolve); });
  try {
    await bridge.init(workspace);
    await writeJson(runtimePath, runtime);
  } catch (error) { server.close(); bridge.close(); throw error; }
  console.log(`${new Date().toISOString()} Codex WeChat service started on 127.0.0.1:${runtime.port}`);
  async function shutdown() {
    bridge.close();
    server.close();
    const current = await readJson(runtimePath);
    if (current?.token === runtime.token) await fs.rm(runtimePath, { force: true });
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
