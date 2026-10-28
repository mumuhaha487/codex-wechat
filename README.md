# Codex 微信插件

通过微信扫码连接本机 Codex，在微信里连续对话、阅读和分析当前项目中的文件。适用于 **Codex 桌面版 / Windows**，也可以用命令行独立运行连接服务。

## 功能

- 微信扫码登录，支持微信数字验证码和登录状态显示。
- 仅接受扫码账号的私聊消息；支持文字和微信已转写的语音。
- 使用本机已有的 Codex 登录、Provider 和模型配置，无需在插件里填写 API Key。
- 独立的持久 Codex 会话，`/new` 重新开始，`/status` 查看工作目录。
- 递归列出目录中的所有普通文件，包含子目录、隐藏文件、Git 忽略文件；不限制扩展名。文本和二进制文件均可分页读取。
- Codex 默认以只读权限运行，适合问答、代码阅读、文件分析。
- 插件附带完整运行包；安装者不必执行 `npm install` 或安装 OpenClaw。

## 环境要求

1. Node.js **22.13 或更新版本**，`node` 在 PATH 中。
2. 已安装并登录 Codex CLI，`codex` 在 PATH 中；需要支持 `codex plugin add` 和 `codex app-server`。开发验证使用 Codex CLI 0.157.1。
3. 本机能访问微信 iLink 接口，手机微信具备该接口的扫码连接能力。能否成功绑定以微信实际返回为准。

## 安装到 Codex 桌面版

在 PowerShell 中：

```powershell
git clone https://github.com/mumuhaha487/codex-wechat.git
cd codex-wechat
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Workspace 'D:\project\QQclaw'
```

安装脚本会注册此仓库的插件市场、安装 `codex-wechat`，并打开本机扫码页面。用手机微信扫描二维码，按微信提示确认；如需数字验证码，在页面输入即可。

然后在 Codex 桌面版**开始一个新聊天**加载插件；若插件列表未更新，重新启动桌面版。在插件中可以找到 **Codex 微信**。对 Codex 说：

> 使用微信插件连接当前项目，给我登录二维码。

也可以直接从 GitHub 安装：

```powershell
codex plugin marketplace add mumuhaha487/codex-wechat
codex plugin add codex-wechat@codex-wechat
```

此方式需要在新聊天中调用插件的 `wechat_login` 工具，并把当前项目的绝对路径传为 `workspace`。

## 微信使用

扫码成功后，进入微信对应会话发送文字，例如：

> 这个项目的目录结构是什么？
>
> 阅读 README.md，告诉我怎么运行。
>
> 分析 src 目录中的代码，解释入口和主要流程。

`/status` 查看连接与工作目录，`/new` 清空当前微信对话的历史引用、开始新会话。本插件会创建独立的 Codex 会话，不接管当前正在进行的桌面聊天。**当前版本不下载或发送图片、视频、附件，也不修改项目文件。**

文件读取工具覆盖已配置工作目录中的全部普通文件，没有扩展名白名单。大文件通过 `cursor` 或字节 `offset` 分页；二进制使用 `base64`。符号链接和 Windows junction 解析后必须仍在此目录内；操作系统禁止访问的文件会报告错误。

## 服务管理

```powershell
# 打开扫码页面，或更换授权工作目录
node .\plugins\codex-wechat\dist\cli.cjs login --workspace 'D:\project\QQclaw'

# 查看状态
npm run status

# 退出微信，删除保存的账号凭证
node .\plugins\codex-wechat\dist\cli.cjs disconnect

# 停止后台服务（保留登录状态，下次可恢复）
npm run stop
```

`start` / `login` 会启动隐藏的后台进程；关闭扫码页不会断开微信。电脑必须保持开机、联网。电脑重启后运行 `npm start` 恢复；插件不自动增加开机启动任务。

更换目录会重置微信会话。正在处理消息或仍有待回复消息时暂不允许切换目录。微信登录失效后，本地页面会提示重新扫码。

本地数据默认保存在 `%USERPROFILE%\.codex\wechat`，与 Git 仓库分离。其中 `state.json` 含微信凭证、会话 ID 和待回复消息，`runtime.json` 含本地服务访问令牌；不要分享这些文件。服务只监听 `127.0.0.1:17389`，管理接口需要令牌，并检查 Host 和浏览器来源。页面地址的 `#` 片段是本机连接凭证，请只在本机打开。

可选环境变量：`CODEX_WECHAT_DATA_DIR`（独立数据目录）、`CODEX_WECHAT_PORT`（本机端口）、`CODEX_WECHAT_CODEX_BIN`（Codex 可执行文件路径）。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `wechat_login` | 设置工作目录、启动连接、生成 PNG 二维码与本地页面链接 |
| `wechat_status` | 查看连接、目录和处理状态 |
| `wechat_disconnect` | 断开连接并清除微信凭证 |
| `workspace_list_files` | 递归分页列出所有文件 |
| `workspace_read_file` | 分页读取文本或二进制文件 |

远程问答默认以 Codex 的 `readOnly` sandbox 和 `never` approval policy 运行。修改文件、运行需要写入的操作请回到桌面版进行。消息发送失败会保留已生成回复并复用 client ID 重试，避免网络重试反复调用模型。服务在生成结果但尚未落盘的瞬间崩溃，仍可能重复执行该次只读问答。

## 开发和验证

```powershell
npm ci --ignore-scripts
npm test
npm run build
```

源码位于 `src/`；提交时一并提交 `plugins/codex-wechat/dist/`。GitHub Actions 在 Windows 和 Linux 检查测试和构建产物。自动测试使用模拟微信服务；真实账号的扫码和微信往返对话必须在安装环境完成，不能由这些测试证明。

微信协议参考腾讯公开项目 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)；本项目是独立实现，非腾讯或 OpenAI 官方插件。Codex 插件格式参考 [OpenAI 插件文档](https://developers.openai.com/plugins/build/plugins)。

## 卸载

先运行 `npm run stop`，再运行：

```powershell
codex plugin remove codex-wechat@codex-wechat
codex plugin marketplace remove codex-wechat
```

如需清除登录凭证，先运行 `disconnect`。卸载插件不自动删除用户数据。

MIT License；运行包所含第三方许可证见 `plugins/codex-wechat/dist/THIRD-PARTY-LICENSES.txt`。
