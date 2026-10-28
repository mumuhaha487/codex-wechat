import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { listFiles, readWorkspaceFile } from './files.mjs';
import { loadState, safeError } from './state.mjs';
import { callService, dashboardUrl, ensureService, findService } from './service.mjs';

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
export async function mcp() {
  const server = new McpServer({ name: 'codex-wechat', version: '1.0.0' });
  const wrap = handler => async args => {
    try { return await handler(args); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: safeError(error) }] }; }
  };
  server.registerTool('wechat_status', {
    description: '检查微信连接、授权工作目录及任务状态，不显示登录凭证。', inputSchema: {},
    annotations: { readOnlyHint: true },
  }, wrap(async () => {
    const runtime = await findService();
    return textResult(runtime ? await callService(runtime, '/api/status') : { connected: false, serviceRunning: false, workspace: (await loadState()).workspace });
  }));
  if (!process.env.CODEX_WECHAT_REMOTE) {
    server.registerTool('wechat_login', {
      description: '启动微信连接并生成扫码登录 PNG，返回本地连接页面链接。workspace 应为用户当前项目目录。',
      inputSchema: { workspace: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    }, wrap(async ({ workspace }) => {
      const runtime = await ensureService(workspace);
      const result = await callService(runtime, '/api/login', { workspace });
      const { qr, ...status } = result;
      const content = [{ type: 'text', text: JSON.stringify({ ...status, dashboard: dashboardUrl(runtime),
        message: status.connected ? '微信已连接。' : '请使用微信扫描二维码并确认连接。需要验证码时，请在本地页面输入。' }, null, 2) }];
      if (qr) content.push({ type: 'image', data: qr, mimeType: 'image/png' });
      return { content };
    }));
    server.registerTool('wechat_disconnect', {
      description: '按用户要求断开微信连接并删除本地登录凭证。', inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true },
    }, wrap(async () => {
      const runtime = await findService();
      return textResult(runtime ? await callService(runtime, '/api/disconnect', {}) : { connected: false });
    }));
  }
  server.registerTool('workspace_list_files', {
    description: '递归列出已配置工作目录中的所有普通文件，包含隐藏文件和被 Git 忽略的文件。返回 nextCursor 时继续分页。',
    inputSchema: { directory: z.string().default('.'), cursor: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(2000).default(500) },
    annotations: { readOnlyHint: true },
  }, wrap(async args => textResult(await listFiles((await loadState()).workspace, args))));
  server.registerTool('workspace_read_file', {
    description: '读取工作目录中的任意普通文件，不限制扩展名。offset/length 按字节计，二进制用 base64；有 nextOffset 时可继续读取。',
    inputSchema: { file: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(262144).default(65536), encoding: z.enum(['utf8', 'base64']).default('utf8') },
    annotations: { readOnlyHint: true },
  }, wrap(async args => textResult(await readWorkspaceFile((await loadState()).workspace, args))));
  await server.connect(new StdioServerTransport());
}
