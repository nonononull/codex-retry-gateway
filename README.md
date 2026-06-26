# Codex Retry Gateway

一个不依赖 `cc-switch` 路由模式的独立本地网关。

目标：

- 保持 Codex 继续使用现有 `auth.json`
- 只把 `config.toml` 的当前 provider `base_url` 改成本地网关
- 非流式命中 `reasoning_tokens = 516` 时返回 `502`
- 流式命中时默认先缓存并判断；一旦命中 `516`，统一返回 `502`
- 默认同时拦截 root 路径和 `/v1` 路径：
  - `/responses`
  - `/chat/completions`
  - `/v1/responses`
  - `/v1/chat/completions`

限制：

- 这个网关不负责 `Responses` 和 `Chat Completions` 协议互转
- 如果你的上游本身不支持 Codex 当前使用的协议，这个网关不会替你补齐转换能力

## 默认路径

Windows:

- Codex 配置：`%USERPROFILE%\.codex\config.toml`
- Gateway 状态目录：`%USERPROFILE%\.codex-retry-gateway`

macOS / Linux:

- Codex 配置：`~/.codex/config.toml`
- Gateway 状态目录：`~/.codex-retry-gateway`

## 当前版本说明

- 这是一个可独立发布、独立运行的仓库
- 默认监听地址是 `http://127.0.0.1:4610`
- 默认示例上游见 `config.example.json`
- 实际运行时配置会写到当前用户目录下的 gateway 状态目录

## 一键启动并打开管理页

在仓库根目录执行：

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1
```

macOS / Linux:

```bash
bash ./scripts/launch-ui.sh
```

这个脚本是默认入口，执行后会自动完成：

- 第一次运行时：
  - 备份当前用户目录下的 Codex `config.toml`
  - 生成当前用户目录下的 gateway `config.json`
  - 启动本地 gateway
  - 把当前 `model_provider` 对应的 `base_url` 改到本地 gateway
- 之后再次运行时：
  - 自动复用现有安装状态
  - 自动重启或拉起 gateway
  - 自动再次打开管理页

默认会打开：

```text
http://127.0.0.1:4610/__codex_retry_gateway/ui
```

如果你只想启动、不自动开浏览器：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1 -NoOpen
```

```bash
bash ./scripts/launch-ui.sh --no-open
```

常用参数：

- Windows 参数：
  - `-CodexConfigPath`
  - `-StateRoot`
  - `-ListenHost`
  - `-ListenPort`
  - `-NoOpen`
- macOS / Linux 参数：
  - `--codex-config-path`
  - `--state-root`
  - `--listen-host`
  - `--listen-port`
  - `--no-open`

macOS / Linux 说明：

- 需要 `bash`
- 需要 `Node.js 18+`
- Unix 入口会调用跨平台 `node` 管理核心，不依赖 PowerShell
- 推荐显式使用 `bash ...sh`
- 这样即使目录是从 Windows 或压缩包复制过来、没有可执行位，也能直接运行

## 手工安装入口

如果你明确只想做脚本级安装，不想自动打开 UI，也可以直接执行：

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-for-current-provider.ps1
```

macOS / Linux:

```bash
bash ./scripts/install-for-current-provider.sh
```

## 如何恢复

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-codex-config.ps1
```

macOS / Linux:

```bash
bash ./scripts/restore-codex-config.sh
```

这个脚本会：

- 停掉本地 gateway
- 用最近一次备份恢复当前用户目录下的 Codex `config.toml`
- 删除当前安装状态文件

## 管理页面

页面入口：

```text
http://127.0.0.1:4610/__codex_retry_gateway/ui
```

页面里可以直接做这几件事：

- 看当前监听地址、真实上游、当前 provider、当前 Codex base URL
- 看本次 gateway 启动以来的实时统计
  - 代理请求总数
  - 被检查响应总数
  - `516` 命中次数
  - `516` 占比
- 改 `reasoning_equals`
- 改 `endpoints`
- 改 `non_stream_status_code`
- 开关 `log_match`
- 动态查看当前 gateway 的实时日志
- 一键恢复 Codex 原设置

说明：

- 页面保存配置后会立即热生效，不需要重启 gateway
- 页面点“恢复 Codex 原设置并关闭网关”后，当前页面会失联，这是预期行为
- 日常恢复优先用 UI；`restore-codex-config.ps1` 作为脚本级应急回滚入口保留
- UI 恢复不会再额外拉起恢复子进程，而是由当前 gateway 直接完成恢复并退出
- 统计口径默认按“本次 gateway 启动以来”累计
- `516` 占比 = `reasoning_tokens = 516` 的响应次数 / 被检查响应总数

## 如何调整拦截条件

编辑：

```text
Windows: %USERPROFILE%\.codex-retry-gateway\config\config.json
macOS / Linux: ~/.codex-retry-gateway/config/config.json
```

常用字段：

- `reasoning_equals`
  - 例如 `[516]`
- `endpoints`
  - 默认包含 root 与 `/v1` 两套路径
- `non_stream_status_code`
  - 默认 `502`
- `stream_action`
  - 默认 `strict_502`
  - `strict_502`：先缓存整个流，命中 `516` 时统一返回 `502`
  - `disconnect`：兼容旧行为；若命中发生在已透传 chunk 之后，则直接断开连接
- `log_match`
  - 是否记录命中日志

改完后重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-gateway.ps1 -RestartIfRunning
```

```bash
bash ./scripts/start-gateway.sh --restart-if-running
```

如果你已经打开管理页，优先直接在页面里改，通常不需要手改 `config.json`。

## 其他机器如何应用

在其他 Windows 机器上：

1. 复制整个仓库目录
2. 确保本机有 `Node.js 18+`
3. 不需要安装 `cc-switch`，也不需要使用 `cc-switch` 路由模式
4. 在仓库根目录执行 `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1`
5. 如需回滚，优先在 UI 里点“恢复 Codex 原设置并关闭网关”；脚本级回滚仍可执行 `powershell -ExecutionPolicy Bypass -File .\scripts\restore-codex-config.ps1`

在其他 macOS / Linux 机器上：

1. 复制整个仓库目录
2. 确保本机有 `bash`
3. 确保本机有 `Node.js 18+`
4. 不需要安装 `cc-switch`，也不需要使用 `cc-switch` 路由模式
5. 在仓库根目录执行 `bash ./scripts/launch-ui.sh`
6. 如需回滚，优先在 UI 里点“恢复 Codex 原设置并关闭网关”；脚本级回滚仍可执行 `bash ./scripts/restore-codex-config.sh`

运行时状态默认写到当前用户目录：

```text
Windows: %USERPROFILE%\.codex-retry-gateway
macOS / Linux: ~/.codex-retry-gateway
```

## 已验证事项

- `test-gateway-e2e.ps1`
  - 已通过
  - 验证 `/responses`、`/chat/completions`、`/v1/responses`、`/v1/chat/completions`
- `test-install-restore.ps1`
  - 已通过
  - 验证安装、透传、UI 页面、热更新配置、实时日志、516 统计、恢复闭环
- `test-launch-ui.ps1`
  - 已通过
  - 验证首次一键启动自动安装、再次启动自动复用、UI 可访问、默认 516 拦截仍生效
- `test-launch-ui-unix.ps1`
  - 已通过
  - 在当前 Windows 主机的 Bash 环境里验证 Unix `.sh` 入口能完成启动、透传、恢复闭环
- `bash ./scripts/launch-ui.sh --no-open`
  - 已通过
  - 当前机器实测返回 `mode=reuse`
  - 后续 `GET /__codex_retry_gateway/health`、`GET /__codex_retry_gateway/ui`、`GET /v1/models` 都返回 `200`
- `codex exec`
  - 已通过
  - 在 Bash 默认入口重新拉起 gateway 后，当前机器再次返回 `OK`
- 当前实机验证示例
  - `GET http://127.0.0.1:4610/__codex_retry_gateway/health` 已通过
  - `GET http://127.0.0.1:4610/v1/models` 已通过，并成功透传到配置里的真实上游
  - `GET http://127.0.0.1:4610/__codex_retry_gateway/ui` 已实际打开并确认页面内容
- `codex exec` 历史现象
  - gateway 关闭时，真实报错地址为 `http://127.0.0.1:4610/responses`
  - gateway 恢复后，`codex exec` 已再次成功返回 `OK`
