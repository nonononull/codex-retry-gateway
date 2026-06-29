# build.md

## 环境要求

- Windows 需要 PowerShell 5.1+ 或 PowerShell 7+
- macOS / Linux 需要 `bash`
- Node.js 18+

## 直接运行网关

```powershell
node .\gateway.mjs --config .\config.example.json
```

## 推荐用法

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1
```

macOS / Linux:

```bash
bash ./scripts/launch-ui.sh
```

说明：

- 第一次运行会自动安装并接管当前 Codex provider
- 再次运行会自动拉起或重启 gateway，并重新打开 UI
- 不依赖 `cc-switch` 安装本体，也不依赖 `cc-switch` 路由模式
- macOS / Linux 入口依赖 `bash` 和 `Node.js 18+`
- 推荐显式使用 `bash ...sh`，避免跨平台复制后可执行位丢失

## 只启动不自动开浏览器

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1 -NoOpen
```

```bash
bash ./scripts/launch-ui.sh --no-open
```

## 手工安装入口

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-for-current-provider.ps1
```

macOS / Linux:

```bash
bash ./scripts/install-for-current-provider.sh
```

## 恢复原配置

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-codex-config.ps1
```

macOS / Linux:

```bash
bash ./scripts/restore-codex-config.sh
```

## 打开管理页面

```text
http://127.0.0.1:4610/__codex_retry_gateway/ui
```

页面支持：

- 打开 TG 群入口：`https://t.me/AI_INPUT_IM`
- 查看当前接管状态
- 查看本次启动以来的实时日志
- 查看当前规则命中总数、实际拦截总数与实际拦截占比
- 热更新 `reasoning_equals` / `endpoints` / `non_stream_status_code` / `guard_retry_attempts` / `log_match`
- 一键恢复 Codex 原设置并关闭 gateway

并发与日志说明：

- gateway 是本机 Node.js 单进程异步代理，适合 Codex 本地路由和少量并发请求。
- 日志在同一进程内通过单个 `WriteStream` 追加写入；当前模型下不会多进程抢写同一个日志文件。
- 严格流式拦截会缓存 SSE，请求体也会先读入内存；高并发或大响应场景需要额外压测、日志轮转和内存上限治理。

## 本地验证

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\test-launch-ui.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-launch-ui-unix.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-gateway-e2e.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\test-install-restore.ps1
```

## 本机真实验证命令

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/health'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/ui'
```

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1 -NoOpen
```

```powershell
$auth = Get-Content -Raw (Join-Path $env:USERPROFILE '.codex\auth.json') | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($auth.OPENAI_API_KEY)" }
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/v1/models' -Headers $headers
```

```powershell
codex exec --ephemeral --skip-git-repo-check --color never --dangerously-bypass-approvals-and-sandbox -m gpt-5.4-mini -C $env:TEMP --output-last-message (Join-Path $env:TEMP 'codex-retry-gateway-clean-smoke.txt') '只回复OK'
```

```bash
bash ./scripts/launch-ui.sh --no-open
```
