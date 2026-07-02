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
- 拦截规则支持二选一：默认并推荐 `reasoning_tokens` 长度模式；`final_answer_only_high_xhigh` 仅作为实验收窄规则，不建议替代默认 516/1034/1552 主拦截
- `final_answer_only_high_xhigh` 排除普通 `reasoning_tokens=0`，这类样本只观察落盘；`reasoning_tokens=null/缺失` 或非 0 的 high/xhigh final answer only 仍可命中实验规则
- 只有显式 `context_compaction` 且 `reasoning_tokens=0` 的压缩响应可豁免拦截；`remote_compaction_v2` 仅是 beta feature 标记，普通 turn 的 516/1034/1552 仍按 `reasoning_tokens` 主规则命中并内部重试
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
- 看历史导入分析
  - 先做字段预检，展示 `analysis_value`、`conclusion` 和 `field_coverage`
  - 缺少核心 reasoning 行为字段时标记 `no_analysis_value`，不把纯历史聚合误当成特征证据
  - 后台聚合 CC Switch SQLite 历史请求
  - 后台聚合 Codex SQLite 日志关键词、等级和 target
  - 文件级索引 Codex session JSONL 大文件
  - 展示导入进度、数据源、请求量、token、延迟、日志行数和 session 体积
- 改 `reasoning_equals`
- 改拦截规则模式：推荐 `reasoning_tokens`；`final_answer_only_high_xhigh` 仅用于短时实验和候选特征复盘
- 改流式 / 非流式拦截目标
- 改 `endpoints`
- 改 `non_stream_status_code`
- 改 `guard_retry_attempts`
- 开关 `retry_upstream_capacity_errors`
- 开关 `log_match`
- 动态查看当前 gateway 的实时日志
- 一键恢复 Codex 原设置

Issue #9 收口说明：

- 已增加 reasoning 行为统计大盘，包含 `reasoning_tokens` 高频排行，用于识别高频 reason token 作为候选特征值。
- 高频排行不是自动定性结论，只作为候选观察入口；后续判断仍应结合模型家族、`reasoning.effort`、final answer only、commentary observed、耗时 / TPS / token 规模归一化偏差一起看。
- 已补上下文压缩保护：只有显式 `context_compaction` 且 `reasoning_tokens=0` 的响应只观察和落盘；`null` 或其它 token 值仍按当前拦截规则处理。
- PR 合并后可关闭 GitHub Issue #9：`https://github.com/nonononull/codex-retry-gateway/issues/9`。

Issue #11 收口说明：

- 已增加 `retry_upstream_capacity_errors` 开关，默认开启。
- 开启后，上游返回 `Selected model is at capacity. Please try a different model.` 这类 capacity 错误时，gateway 会在内部吞掉本次错误并按 `guard_retry_attempts` 继续请求上游，不再直接透传给 Codex。
- 关闭后，capacity 错误保持旧行为，原样透传给 Codex。
- 普通 `429` / `502` 不会因为这个开关被泛化重试，避免把真实限流或上游故障误吞。
- PR 合并后可关闭 GitHub Issue #11：`https://github.com/nonononull/codex-retry-gateway/issues/11`。

说明：

- 页面保存配置后会立即热生效，不需要重启 gateway
- 页面点“恢复 Codex 原设置并关闭网关”后，当前页面会失联，这是预期行为
- 日常恢复优先用 UI；`restore-codex-config.ps1` 作为脚本级应急回滚入口保留
- UI 恢复不会再额外拉起恢复子进程，而是由当前 gateway 直接完成恢复并退出
- 统计口径默认按“本次 gateway 启动以来”累计
- 当前规则命中总数表示命中当前拦截规则的次数，不等于实际拦截次数；默认规则是 `reasoning_equals`，切到 `final_answer_only_high_xhigh` 后则按 high/xhigh 的 final answer only 结构计数，并排除普通 `reasoning_tokens=0`
- 实际拦截占比 = 实际拦截总数 / 被检查响应总数
- 关闭某一类拦截后，该类命中仍会继续计入规则命中与模型一致性观测，但不会计入实际拦截
- `guard_retry_attempts` 对命中当前拦截规则且会被实际拦截的响应生效；开启 `retry_upstream_capacity_errors` 后，也对指定上游 capacity 错误生效
- `retry_upstream_capacity_errors` 只匹配 `Selected model is at capacity. Please try a different model.`，普通 `429` / `502` 等 HTTP 错误如果没有命中该特征，会继续原样透传
- 网关内部重试的每次上游尝试都会计入代理请求总数；每次拿到并检查的响应都会计入被检查响应总数；命中当前拦截规则会计入当前规则命中总数，被吞掉重试或最终拦截会计入实际拦截总数
- 命中日志里的 `action=internal_retry remaining=N` 表示本次命中只在网关内部吞掉并继续重试，没有把失败状态返回给 Codex；`action=return_status_502` 才表示已经达到重试上限或配置为 `0`，本次会对 Codex 返回拦截状态
- `context_compaction` 样本会保留在大盘和导出里；只有实际豁免的 `reasoning_tokens=0` 样本会写入 `intercept_exempt_reason=context_compaction`，其它值仍会计入当前规则命中和实际拦截
- 模型家族一致性面板里的“上游模型”是上游自报
- “声明一致”不等于已证明真实运行一致
- “400K 家族异常”只表示行为上疑似不符合 `1M` 家族
- “单请求模型漂移”和“疑似请求内重建/重试”都按高风险展示
- “疑似请求内重建/重试”仅基于响应信号推断，不能直接确认缓存重建
- 主动探针默认关闭，并且与普通代理请求统计完全隔离
- 主动探针当前只做“声明契约证伪”，不做真实底层模型归因
- 长上下文与 `gpt-5.5` 图片输入属于硬契约探针，可产出 `violation`
- 响应结构、身份一致性、训练截止日期 / 知识表现属于辅助探针，默认只产出 `warning`

## reasoning 行为统计后续路线

代码层已经完成第一阶段：全量采集、按日落盘、时间段大盘、JSON / CSV 导出、候选特征组合展示。
同时已补历史导入分析第一版：它独立于实时 reasoning analytics，只做后台聚合摘要，不把本地大库完整灌入实时日文件。

运行态注意：

- 如果本机 `127.0.0.1:4610` 还是旧 gateway 进程，新接口不会自动生效。
- 重新拉起或重启 gateway 后，才会开始写入 `%USERPROFILE%\.codex-retry-gateway\analytics\reasoning-behavior-YYYY-MM-DD.json`。
- 验证 `GET /__codex_retry_gateway/api/analytics/reasoning` 应返回 JSON；如果返回上游 HTML，说明当前运行实例没有加载 analytics 代码。
- 未经确认不要直接动正在承载 Codex 会话的路由进程。

后续不要把当前 `516` 全拦策略直接当成最终结论。`516` 只是高价值观察点，不等于“已确认降智”。真正要继续收敛的是这组组合特征：

```text
reasoning_tokens 异常值 + final_answer only + commentary_not_observed + 时序归一化偏差
```

海量数据分析口径：

- `gateway analytics` 是后续逐请求、逐重试、逐拦截的主事实源。
- `CC Switch` 日志和 `Codex session` 历史日志只做历史回填、字段探索和交叉校验。
- 实时特征分析通过 `/__codex_retry_gateway/api/analytics/reasoning/analyze` 读取 runtime analytics，并按统一 Profile `516_candidate_review_v1` 返回 `analysis_value`、`conclusion`、`field_coverage`、候选摘要和基线对比。
- 历史导入分析通过 `/__codex_retry_gateway/api/analytics/imports/run` 创建后台任务，通过 `/jobs/<job_id>` 轮询进度，通过 `/latest` 读取最近结果，通过 `/analyze` 对指定或最近 job 输出同口径分析结果。
- 历史导入第一版只聚合 CC Switch SQLite、Codex logs SQLite 和 Codex sessions JSONL 文件级索引；不会读取完整 prompt、完整 answer、Authorization 或 Cookie。
- 历史导入先跑 preflight；没有 `reasoning_tokens`、`final_answer_only`、`commentary_observed` 等核心字段时，结果为 `no_analysis_value`，可以保留摘要但不进入候选特征确认。
- 大盘优先看 rollup 聚合，明细只在时间段、模型、思考等级或候选特征下钻时读取。
- 面对 20GB 级 Codex session 历史日志，不做单进程全量 JSON 深解析；先用 `rg` / SQLite schema / key 扫描定位字段，再抽代表文件深解析。
- 导出默认按时间段输出 JSON / CSV；数据继续变大后必须走 rollup 优先、分页/分片、压缩包和每日索引，不让 UI 无边界深解析。
- 同步导出建议限制在 `31` 天以内；超过后创建后台导出任务，页面显示进度条和提醒，完成后再提供下载链接。
- 请求预览、失败摘要、响应摘要都必须截断和脱敏；CSV 默认只放结构字段、数值字段和状态字段。

516 分析口径：

- `普通观察 516`：命中 `reasoning_tokens=516`，但未同时满足候选复盘组合。
- `候选复盘 516`：`reasoning_tokens=516 + final_answer only + commentary_not_observed + 时序归一化偏差高`。
- `普通观察 516` 不等于确认正常，`候选复盘 516` 也不等于确认降智；两者都只是不同优先级的观察队列。
- UI 必须标注“516 只是观察点，不代表降智结论”，候选组合只能显示为“仅观察 / 候选复盘”。

后续优先级：

1. 继续扩充观测大盘，不改现有路由和拦截语义。
   - 补“普通观察 516 / 候选复盘 516”对比视图。
   - 补按 `gpt-5.4` / `gpt-5.5`、`reasoning.effort`、token 规模分层后的时序对比。
   - 补时序归一化偏差分布图，不把耗时、TPS、token 长度拆成单独判据。
2. 优化时序归一化算法。
   - 当前 `time_normalization_deviation` 只是第一版固定 baseline。
   - 后续应按模型家族、思考等级、输入/输出 token 规模建立动态基线。
   - 网络延迟、上游排队、首 token 延迟要单独保留，不要混成一个“耗时短”结论。
3. 增强导出与离线分析。
   - CSV 可以继续扩列，补更完整的流式时序、结构计数、模型声明、重试链路字段。
   - 后台导出任务已经支持按日期慢慢导出；后续再补每日 rollup、明细索引和压缩包导出，不急着引入数据库。
4. 做 observe-only 特征规则。
   - 先只标记候选，不进入拦截。
   - 规则形态可以从 `reasoning_tokens_outlier + final_answer_only + commentary_not_observed + time_normalization_deviation` 开始。
   - UI 要明确显示“仅观察”，避免误以为已经自动拦截。
5. 人工确认后再做特征拦截。
   - 只有当样本足够、误伤可解释、普通观察 516 和候选复盘 516 能稳定区分后，才考虑把 observe-only 规则升级为 intercept。
   - 现有 `reasoning_equals` 自定义拦截仍保留；`final_answer_only_high_xhigh` 作为可切换新模式，效果不好可以直接回退默认模式。

暂时不做：

- 不做自动“降智”判定。
- 不用单个 `reasoning_tokens` 值直接定性。
- 不用单独耗时阈值拦截。
- 不保存完整 prompt、完整 answer 或 Authorization。
- 不把主动探针样本混进真实代理请求统计。

## 如何调整拦截条件

编辑：

```text
Windows: %USERPROFILE%\.codex-retry-gateway\config\config.json
macOS / Linux: ~/.codex-retry-gateway/config/config.json
```

常用字段：

- `reasoning_equals`
  - 默认 `[516, 1034, 1552]`
- `intercept_rule_mode`
  - 默认并推荐 `reasoning_tokens`
  - `reasoning_tokens`：稳定主规则，命中 `reasoning_equals` 即视为当前规则命中；真实使用中 516 拦截仍可能直接影响任务正确性
  - `final_answer_only_high_xhigh`：实验收窄规则，仅当 `reasoning.effort` 为 `high` / `xhigh`，响应结构是 `final answer only`、未观察到 commentary、无 tool call、无 reasoning item，且 `reasoning_tokens` 为 `null/缺失` 或非 0 时命中；普通 `reasoning_tokens=0` 只观察落盘，不触发该实验规则
  - 两个模式二选一；效果不确定或以任务正确性优先时，使用 `reasoning_tokens`
  - `request_kind=context_compaction` 只有在 `reasoning_tokens=0` 时豁免；`516/1034/1552` 等命中值仍按当前规则处理，并受 `guard_retry_attempts` 控制
- `intercept_streaming`
  - 默认 `true`
  - 控制流式响应命中当前拦截规则后是否真正拦截
- `intercept_non_streaming`
  - 默认 `true`
  - 控制非流式响应命中当前拦截规则后是否真正拦截
  - `intercept_streaming` 与 `intercept_non_streaming` 不能同时为 `false`
- `endpoints`
  - 默认包含 root 与 `/v1` 两套路径
- `non_stream_status_code`
  - 默认 `502`
- `guard_retry_attempts`
  - 默认 `3`
  - 命中当前拦截规则后，网关内部额外重试上游的次数
  - 开启 `retry_upstream_capacity_errors` 后，也用于上游 capacity 错误的内部重试次数
  - `0` 表示不做网关内部重试
  - 无上限，管理页保存后立即生效
- `retry_upstream_capacity_errors`
  - 默认 `true`
  - 开启后，匹配上游 `Selected model is at capacity. Please try a different model.` 错误并在 gateway 内部重试
  - 关闭后，上述 capacity 错误也按旧行为原样透传
  - 普通 `429` / `502` 不会因为这个开关被泛化重试
- `stream_action`
  - 默认 `strict_502`
  - `strict_502`：先缓存整个流，命中当前拦截规则时统一返回 `502`
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
- 请求体会按 `request_body_limit_bytes` 先读入内存，默认限制是 `100MB`。
- 超过 `request_body_limit_bytes` 的请求会被本地 gateway 直接拒绝，并返回 `413 request_body_limit_exceeded`；这类情况不是上游故障。
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

- 本地 CI 为默认验收入口
  - 优先在本机运行 `test-gateway-e2e.ps1` / `test-install-restore.ps1` / `test-launch-ui.ps1` / `test-launch-ui-unix.ps1`
  - GitHub Actions `macos-smoke` 已在仓库侧手动禁用，push / PR 不再自动运行
  - 需要补足“本地没有 mac”时的 Unix 入口冒烟时，再按需手动重新启用或触发 `macos-smoke`
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
