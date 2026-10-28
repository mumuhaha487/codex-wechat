// Optional live smoke check: uses the current local Codex account/model.
import { CodexClient } from '../src/codex.mjs';
const client = new CodexClient();
try {
  const thread = await client.thread(process.cwd());
  console.log('Codex thread created:', thread);
  const answer = await client.answer(thread, process.cwd(), '请读取当前目录 package.json，只回答 name 字段的值。不要修改文件。');
  console.log('Codex file-read response:', answer);
  if (!answer.includes('codex-wechat')) throw new Error('Expected workspace file content in the answer.');
} finally { client.close(); }
