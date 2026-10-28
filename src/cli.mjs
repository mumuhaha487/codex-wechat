import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureService, callService, findService, dashboardUrl, serve } from './service.mjs';
import { dataDir, safeError } from './state.mjs';
import { mcp } from './mcp.mjs';

function openBrowser(url) {
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  const index = args.indexOf('--workspace');
  if (index !== -1 && !args[index + 1]) throw new Error('--workspace 后需要目录路径。');
  const workspace = index === -1 ? undefined : path.resolve(args[index + 1]);
  if (command === 'mcp') return mcp();
  if (command === 'serve') return serve(workspace);
  if (command === 'start' || command === 'login') {
    const runtime = await ensureService(workspace);
    if (command === 'login') {
      const result = await callService(runtime, '/api/login', { workspace });
      if (result.qr) {
        const qrPath = path.join(dataDir, 'login-qr.png');
        await fs.writeFile(qrPath, Buffer.from(result.qr, 'base64'), { mode: 0o600 });
        console.log(`二维码：${qrPath}`);
      }
    }
    const url = dashboardUrl(runtime);
    console.log(`本地连接页面：${url}`);
    if (!args.includes('--no-open')) openBrowser(url);
    return;
  }
  if (command === 'status' || command === 'stop' || command === 'disconnect') {
    const runtime = await findService();
    if (!runtime) { console.log(JSON.stringify({ serviceRunning: false, connected: false })); return; }
    const route = command === 'status' ? '/api/status' : command === 'stop' ? '/api/stop' : '/api/disconnect';
    console.log(JSON.stringify(await callService(runtime, route, command === 'status' ? undefined : {}), null, 2));
    return;
  }
  console.log('Codex 微信\n\n命令：login | start | status | disconnect | stop | mcp\n可选：--workspace <目录> --no-open\n\n首次使用：node plugins/codex-wechat/dist/cli.cjs login --workspace <项目目录>');
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
