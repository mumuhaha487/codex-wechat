param([string]$Workspace = (Get-Location).Path, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$pluginRepo = Split-Path -Parent $PSScriptRoot
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
Get-Command node, codex -ErrorAction Stop | Out-Null
& codex plugin marketplace add $pluginRepo
if ($LASTEXITCODE -ne 0) { throw 'Could not register the plugin marketplace.' }
& codex plugin add 'codex-wechat@codex-wechat'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the plugin.' }
$loginArgs = @((Join-Path $pluginRepo 'plugins\codex-wechat\dist\cli.cjs'), 'login', '--workspace', $workspacePath)
if ($NoBrowser) { $loginArgs += '--no-open' }
& node @loginArgs
if ($LASTEXITCODE -ne 0) { throw 'The plugin was installed, but WeChat login could not start.' }
Write-Host 'Installed. Start a new Codex desktop chat to load the WeChat tools.'
