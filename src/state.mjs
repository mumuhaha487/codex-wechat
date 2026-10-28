import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const dataDir = process.env.CODEX_WECHAT_DATA_DIR || path.join(os.homedir(), '.codex', 'wechat');
export const statePath = path.join(dataDir, 'state.json');
export const runtimePath = path.join(dataDir, 'runtime.json');

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function loadState() {
  return { workspace: process.cwd(), sessions: {}, seen: [], pending: [], ...await readJson(statePath, {}) };
}

export function safeError(error) {
  return String(error?.message || error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(bot_token|context_token|token|authorization)["'\s:=]+[^\s,}]+/gi, '$1=[redacted]')
    .slice(0, 500);
}
