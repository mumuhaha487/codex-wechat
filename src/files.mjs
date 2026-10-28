import fs from 'node:fs/promises';
import path from 'node:path';

export async function withinWorkspace(workspace, input = '.') {
  const root = await fs.realpath(workspace);
  const target = await fs.realpath(path.resolve(root, input));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('路径超出已授权的工作目录。');
  }
  return target;
}

export async function listFiles(workspace, { directory = '.', cursor = 0, limit = 500 } = {}) {
  const root = await fs.realpath(workspace);
  const start = await withinWorkspace(root, directory);
  const files = [];
  const errors = [];
  let index = 0;
  let more = false;
  const visited = new Set();
  async function walk(dir) {
    const real = await withinWorkspace(root, dir);
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = await fs.readdir(real, { withFileTypes: true }); }
    catch (error) { errors.push({ path: path.relative(root, dir), error: error.code }); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      try {
        const target = await withinWorkspace(root, file);
        const stat = await fs.stat(target);
        if (stat.isDirectory()) await walk(file);
        else if (stat.isFile()) {
          if (index++ < cursor) continue;
          if (files.length === limit) { more = true; return; }
          files.push({ path: path.relative(root, file).split(path.sep).join('/'), size: stat.size });
        }
      } catch (error) { errors.push({ path: path.relative(root, file), error: error.code || error.message }); }
      if (more) return;
    }
  }
  await walk(start);
  return { workspace: root, files, nextCursor: more ? cursor + files.length : null, errors };
}

export async function readWorkspaceFile(workspace, { file, offset = 0, length = 65536, encoding = 'utf8' }) {
  const target = await withinWorkspace(workspace, file);
  const handle = await fs.open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('请选择一个普通文件。');
    const data = Buffer.alloc(Math.min(length, Math.max(0, stat.size - offset)));
    const { bytesRead } = await handle.read(data, 0, data.length, offset);
    return { file, offset, bytesRead, size: stat.size, encoding,
      content: data.subarray(0, bytesRead).toString(encoding),
      nextOffset: offset + bytesRead < stat.size ? offset + bytesRead : null };
  } finally { await handle.close(); }
}
