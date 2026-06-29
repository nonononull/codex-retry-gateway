# Codex Retry Gateway

TG群：[https://t.me/AI_INPUT_IM](https://t.me/AI_INPUT_IM)

一个不依赖 `cc-switch` 路由模式的独立本地网关。

项目真源说明：

- 如果你想看“这个项目当前代码到底负责什么、请求链路怎么走、统计口径怎么算、主动/被动探针边界在哪里”，优先看：
  - `docs/superpowers/specs/2026-06-28-project-source-of-truth.md`

目标：

- 保持 Codex 继续使用现有 `auth.json`
- 只把 `config.toml` 的当前 provider `base_url` 改成本地网关
- 非流式命中默认集合 `reasoning_tokens = 516 / 1034 / 1552` 时，默认先在网关内部重试，超过上限后才返回 `502`
- 流式命中时默认先缓存并判断；一旦命中默认集合 `516 / 1034 / 1552`，默认先在网关内部重试，超过上限后才统一返回 `502`
- 默认同时拦截 root 路径和 `/v1` 路径：
  - `/responses`
  - `/chat/completions`
  - `/v1/responses`
  - `/v1/chat/completions`

限制：

- 这个网关不负责 `Responses` 和 `Chat Completions` 协议互转
- 如果你的上游本身不支持 Codex 当前使用的协议，这个网关不会替你补齐转换能力
- 这个网关是本机单进程代理，适合 Codex 本地路由与少量并发请求，不定位为公网高并发反向代理

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

- 打开顶部 `TG群：https://t.me/AI_INPUT_IM` 入口
- 看当前监听地址、真实上游、当前 provider、当前 Codex base URL
- 看本次 gateway 启动以来的实时统计
  - 代理请求总数
  - 被检查响应总数
  - 当前规则命中总数
  - 实际拦截总数
  - 实际拦截占比
  - 流式 / 非流式规则命中次数
  - 流式 / 非流式实际拦截次数
- 看模型家族一致性统计
  - 本地请求模型占比
  - 上游声明模型占比
  - 流式声明模型占比
  - 声明一致率
  - `400K` 家族异常次数
  - 单请求模型漂移次数
  - 疑似请求内重建/重试次数
- 看主动探针统计
  - 最近目标模型
  - 通过次数
  - warning 次数
  - 违约次数
  - transport error 次数
  - 最近主动探针样本与日志证据
- 改 `reasoning_equals`
- 改流式 / 非流式拦截目标
- 改 `endpoints`
- 改 `non_stream_status_code`
- 改 `guard_retry_attempts`
- 开关 `log_match`
- 动态查看当前 gateway 的实时日志
- 一键恢复 Codex 原设置

说明：

- 页面保存配置后会立即热生效，不需要重启 gateway
- 页面点“恢复 Codex 原设置并关闭网关”后，当前页面会失联，这是预期行为
- 日常恢复优先用 UI；`restore-codex-config.ps1` 作为脚本级应急回滚入口保留
- UI 恢复不会再额外拉起恢复子进程，而是由当前 gateway 直接完成恢复并退出
- 统计口径默认按“本次 gateway 启动以来”累计
- 当前规则命中总数表示命中 `reasoning_equals` 的次数，不等于实际拦截次数
- 实际拦截占比 = 实际拦截总数 / 被检查响应总数
- 关闭某一类拦截后，该类命中仍会继续计入规则命中与模型一致性观测，但不会计入实际拦截
- `guard_retry_attempts` 只对命中当前拦截规则且会被实际拦截的响应生效；上游真实 `429` / `502` 等 HTTP 错误如果没有命中规则，会继续原样透传
- 网关内部规则重试的每次上游尝试都会计入代理请求总数；每次拿到并检查的响应都会计入被检查响应总数；命中会计入当前规则命中总数，被吞掉重试或最终拦截会计入实际拦截总数
- 命中日志里的 `action=internal_retry remaining=N` 表示本次命中只在网关内部吞掉并继续重试，没有把失败状态返回给 Codex；`action=return_status_502` 才表示已经达到重试上限或配置为 `0`，本次会对 Codex 返回拦截状态
- 模型家族一致性面板里的“上游模型”是上游自报
- “声明一致”不等于已证明真实运行一致
- “400K 家族异常”只表示行为上疑似不符合 `1M` 家族
- “单请求模型漂移”和“疑似请求内重建/重试”都按高风险展示
- “疑似请求内重建/重试”仅基于响应信号推断，不能直接确认缓存重建
- 主动探针默认关闭，并且与普通代理请求统计完全隔离
- 主动探针当前只做“声明契约证伪”，不做真实底层模型归因
- 长上下文与 `gpt-5.5` 图片输入属于硬契约探针，可产出 `violation`
- 响应结构、身份一致性、训练截止日期 / 知识表现属于辅助探针，默认只产出 `warning`

## 如何调整拦截条件

编辑：

```text
Windows: %USERPROFILE%\.codex-retry-gateway\config\config.json
macOS / Linux: ~/.codex-retry-gateway/config/config.json
```

常用字段：

- `reasoning_equals`
  - 默认 `[516, 1034, 1552]`
- `intercept_streaming`
  - 默认 `true`
  - 控制流式响应命中 `reasoning_equals` 后是否真正拦截
- `intercept_non_streaming`
  - 默认 `true`
  - 控制非流式响应命中 `reasoning_equals` 后是否真正拦截
  - `intercept_streaming` 与 `intercept_non_streaming` 不能同时为 `false`
- `endpoints`
  - 默认包含 root 与 `/v1` 两套路径
- `non_stream_status_code`
  - 默认 `502`
- `guard_retry_attempts`
  - 默认 `3`
  - 命中当前拦截规则后，网关内部额外重试上游的次数
  - `0` 表示不做网关内部规则重试
  - 无上限，管理页保存后立即生效
- `stream_action`
  - 默认 `strict_502`
  - `strict_502`：先缓存整个流，命中 `reasoning_equals` 里的值时统一返回 `502`
  - `disconnect`：兼容旧行为；若命中发生在已透传 chunk 之后，则直接断开连接
- `log_match`
  - 是否记录命中日志
- `active_probe.enabled`
  - 是否开启主动探针
- `active_probe.endpoint_candidates`
  - 主动探针优先使用的上游路径
- `active_probe.long_context`
  - 长上下文硬契约探针配置
  - `target_input_tokens` 默认 `460000`，探针会按真实 `usage.input_tokens` 口径校准预算并落证据
- `active_probe.image_input`
  - `gpt-5.5` 图片输入硬契约探针配置
- `active_probe.response_structure`
  - 响应结构辅助探针配置
- `active_probe.identity_consistency`
  - 身份一致性辅助探针配置
- `active_probe.knowledge_cutoff`
  - 训练截止日期 / 知识表现辅助探针配置

改完后重启：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-gateway.ps1 -RestartIfRunning
```

```bash
bash ./scripts/start-gateway.sh --restart-if-running
```

如果你已经打开管理页，优先直接在页面里改，通常不需要手改 `config.json`。

## 并发与日志写入

当前 gateway 是 Node.js 单进程异步 HTTP 代理：

- 可以同时处理多个 Codex 请求；每个请求都会独立读取请求体、请求上游、检查响应并更新统计。
- `guard_retry_attempts` 的内部重试是按单个客户端请求独立计算的，不会和其他并发请求共享重试次数。
- 日志写入使用同一个进程内 `WriteStream` 追加到日志文件；在当前单进程模型下，日志写入会按事件循环顺序排队，不会出现多进程同时抢写同一个日志文件的问题。
- UI 实时日志来自内存里的 `log_entries`，文件日志和 UI 日志都会记录同一类事件。

需要注意：

- 严格流式拦截模式会先缓存上游 SSE，再决定透传、内部重试或返回 `502`；并发流式请求多、响应很大时，内存占用会增加。
- 请求体会按 `request_body_limit_bytes` 先读入内存，默认限制是 `10MB`。
- 当前 `log_entries` 是本次启动以来的内存累计；长时间高频运行会增加内存占用。
- 如果要把它放到公网或很高 QPS 场景，建议前面加成熟反向代理，并补日志轮转、内存日志上限、压测和进程守护。

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
  - 验证首次一键启动自动安装、再次启动自动复用、UI 可访问、默认 `516/1034/1552` 拦截仍生效
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
