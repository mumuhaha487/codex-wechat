import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFiles, readWorkspaceFile } from '../src/files.mjs';
import { WeChatApi, trustedApiBase, splitText } from '../src/wechat.mjs';
import { Bridge } from '../src/bridge.mjs';
import { validAuthorization } from '../src/service.mjs';

test('all workspace files include hidden and ignored files, support pagination and binary reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cw-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.hidden'));
  await fs.writeFile(path.join(root, '.gitignore'), '*.bin\n');
  await fs.writeFile(path.join(root, '.hidden', 'secret.txt'), 'hello');
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0, 1, 255, 128]));
  const first = await listFiles(root, { limit: 2 });
  assert.equal(first.files.length, 2);
  assert.equal(first.nextCursor, 2);
  const second = await listFiles(root, { cursor: first.nextCursor, limit: 2 });
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.files, ...second.files].map(file => file.path).sort(), ['.gitignore', '.hidden/secret.txt', 'data.bin']);
  assert.equal((await readWorkspaceFile(root, { file: 'data.bin', encoding: 'base64', length: 2 })).content, 'AAE=');
  const tail = await readWorkspaceFile(root, { file: '.hidden/secret.txt', offset: 2, length: 3 });
  assert.equal(tail.content, 'llo');
  assert.equal(tail.nextOffset, null);
  await assert.rejects(readWorkspaceFile(root, { file: '../' }), /超出/);
  await fs.symlink(path.dirname(root), path.join(root, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readWorkspaceFile(root, { file: 'outside' }), /超出/);
});

test('WeChat transport carries per-message context, auth, cursor and validates business errors', async () => {
  const calls = [];
  const api = new WeChatApi({ fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return { ok: true, json: async () => ({ ret: 0 }) };
  } });
  const account = { base: 'https://ilinkai.weixin.qq.com', token: 'test-token' };
  await api.send(account, 'owner', 'context-from-inbound', 'hello', 'stable-id');
  const sent = JSON.parse(calls[0].body);
  assert.equal(calls[0].headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].headers['iLink-App-Id'], 'bot');
  assert.equal(sent.msg.context_token, 'context-from-inbound');
  assert.equal(sent.msg.client_id, 'stable-id');
  assert.equal(sent.msg.message_type, 2);
  await api.updates(account, 'persisted-cursor');
  assert.equal(JSON.parse(calls[1].body).get_updates_buf, 'persisted-cursor');
  const broken = new WeChatApi({ fetchImpl: async () => ({ ok: true, json: async () => ({ ret: -14 }) }) });
  await assert.rejects(broken.updates(account), error => error.code === -14);
  assert.throws(() => trustedApiBase('https://ilinkai.weixin.qq.com.evil.example'), /不受信任/);
  assert.throws(() => trustedApiBase('http://ilinkai.weixin.qq.com'), /不受信任/);
  assert.throws(() => trustedApiBase('https://user:pass@ilinkai.weixin.qq.com'), /不受信任/);
  assert.equal(trustedApiBase('ilinkai.weixin.qq.com'), account.base);
});

function fixture({ send, answer } = {}) {
  const snapshots = [];
  let answers = 0;
  const bridge = new Bridge({
    persist: async state => { snapshots.push(structuredClone(state)); },
    api: { send: send || (async () => {}) },
    codex: { thread: async () => 'thread-1', answer: async () => { answers++; return answer || 'Codex reply'; }, close() {} },
  });
  bridge.state = { workspace: '/project', account: { user: 'owner' }, pending: [], sessions: {}, seen: [] };
  const msg = { message_type: 1, message_id: '9007199254740993000', from_user_id: 'owner',
    context_token: 'context', item_list: [{ type: 1, text_item: { text: 'Question' } }] };
  return { bridge, msg, snapshots, answerCount: () => answers };
}

test('durable inbox accepts only QR owner, rejects groups/bots, deduplicates before committing cursor', async () => {
  const { bridge, msg, snapshots, answerCount } = fixture();
  await bridge.ingest({ get_updates_buf: 'cursor-2', msgs: [msg, msg,
    { ...msg, from_user_id: 'stranger' }, { ...msg, group_id: 'group' }, { ...msg, message_type: 2 }] }, bridge.state.account);
  assert.equal(bridge.state.pending.length, 1);
  assert.equal(snapshots[0].cursor, 'cursor-2');
  assert.equal(snapshots[0].pending.length, 1);
  await bridge.processNext();
  assert.equal(answerCount(), 1);
  assert.equal(bridge.state.pending.length, 0);
  await bridge.ingest({ msgs: [msg] }, bridge.state.account);
  assert.equal(bridge.state.pending.length, 0);
});

test('send retry reuses persisted reply and stable ID without rerunning Codex', async () => {
  const ids = [];
  let first = true;
  const { bridge, msg, answerCount } = fixture({ send: async (...args) => {
    ids.push(args[4]);
    if (first) { first = false; throw new Error('network unavailable'); }
  } });
  await bridge.ingest({ msgs: [msg] }, bridge.state.account);
  await assert.rejects(bridge.processNext(), /network unavailable/);
  assert.deepEqual(bridge.state.pending[0].chunks, ['Codex reply']);
  await bridge.processNext();
  assert.equal(answerCount(), 1);
  assert.equal(ids[0], ids[1]);
});

test('new conversation command resets history and error replies do not loop model requests', async () => {
  const { bridge, msg, answerCount } = fixture();
  bridge.state.sessions.owner = 'previous';
  msg.item_list[0].text_item.text = '/new';
  await bridge.ingest({ msgs: [msg] }, bridge.state.account);
  await bridge.processNext();
  assert.equal(bridge.state.sessions.owner, undefined);
  assert.equal(answerCount(), 0);
  msg.message_id = 'next';
  msg.item_list[0].text_item.text = 'Please answer';
  bridge.codex.answer = async () => { throw new Error('model unavailable'); };
  await bridge.ingest({ msgs: [msg] }, bridge.state.account);
  await bridge.processNext();
  assert.equal(bridge.state.pending.length, 0);
});

test('long messages preserve Unicode and local service authentication is exact', () => {
  const text = '你好😀'.repeat(1700);
  const chunks = splitText(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= 1800));
  assert.equal(validAuthorization('Bearer abc', 'abc'), true);
  assert.equal(validAuthorization('Bearer ab', 'abc'), false);
  assert.equal(validAuthorization(undefined, 'abc'), false);
});
