# err.md

## 2026-07-02 reasoning 分桶表不应把 count=1 的 token 显示成“高频 token”

### 现象

- reasoning 行为统计里的三张分桶表：
  - 按模型家族
  - 按思考等级
  - 模型家族 × 思考等级
- 右侧原“高频 token”列会显示类似：
  - `0 x4, 516 x2, 8 x1`
- 当分桶样本较多且 reasoning token 分散时，`x1` 这类低频值被展示成“高频 token”，用户会误以为该列是完整、可靠的高频分布。

### 根因

- 后端 `summarizeGroupedSamples()` 固定取分桶内 `topReasoningTokensForSamples(samples, 3)`。
- 该逻辑只是 Top 3 摘要，不等于真正高频。
- 前端 `formatReasoningTokens()` 也没有过滤 `count=1`，导致低频 token 被画进“高频 token”列。

### 处理

- 分桶表改为展示“重复 token”：
  - 后端只返回分桶内出现次数大于 `1` 的 reasoning token。
  - 前端再次过滤 `count<=1`，兼容旧数据或旧缓存。
  - 没有重复 token 时显示 `无重复 token`。
- 全局“高频 token 排行”不变，因为它是独立的全局排行榜。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `reasoning 模型家族聚合表不应把 count=1 的低频 token 显示为高频 token`
- 修复后：
  - `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-02 Issue #11：上游 Selected model is at capacity 应在网关内重试

### 现象

- 上游返回：
  - `Selected model is at capacity. Please try a different model.`
- 旧行为会把该错误直接透传给 Codex。
- 用户期望这类 capacity 响应由 gateway 内部吞掉并重试，减少会话被上游临时容量波动打断。
- 同时该能力必须能开关，避免策略效果不好时无法回退。

### 根因

- 旧的 `guard_retry_attempts` 只服务于“命中本地拦截规则”的响应。
- 上游真实 HTTP 错误此前按保守策略全部透传，避免误吞普通 `429` / `502`。
- Issue #11 的 capacity 文案是更窄的上游容量错误特征，可以单独处理，但不能泛化成“所有 429 都重试”。

### 处理

- 新增配置：
  - `retry_upstream_capacity_errors`
  - 默认 `true`
  - 管理页可开关，保存后热生效
- 开启后，仅当上游错误响应包含：
  - `Selected model is at capacity. Please try a different model.`
  - 且 HTTP 状态为错误状态时，才触发内部重试。
- capacity 内部重试与本地规则内部重试共用 `guard_retry_attempts`：
  - `0` 表示不重试，直接透传或按现有规则返回
  - 大于 `0` 时吞掉本次 capacity 响应并重新请求上游
- 普通 `429` / `502` 不匹配该文案时仍原样透传。
- 这类被吞掉的 capacity 响应会落 reasoning analytics 样本：
  - `final_action=upstream_capacity_internal_retry`
  - `blocked_by_gateway=true`
  - `matched_current_rule=false`

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `retry_upstream_capacity_errors 默认应为 true`
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\admin-lib.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node --check .\scripts\test-install-restore.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-install-restore.mjs`

## 2026-07-02 final answer only 模式不能拦截 Codex 上下文压缩请求

### 现象

- `final_answer_only_high_xhigh` 模式下，Codex 压缩上下文时可能收到 `reasoning_tokens=0` 或缺失 usage 导致 `reasoning_tokens=null`。
- 压缩响应结构可能接近 `final answer only + commentary not observed`。
- 如果按普通 high/xhigh final answer only 响应拦截，会连续返回本地拦截状态，导致上下文压缩失败。

### 根因

- 旧规则只区分 `reasoning.effort` 和响应结构，没有区分“普通回答请求”和“Codex 上下文维护请求”。
- 本机真实 analytics 样本显示 Codex 压缩链路带有请求头：
  - `x-codex-beta-features: remote_compaction_v2`
- 该请求头足以作为请求侧特征；不能把 `reasoning_tokens=0/null` 全局放行，否则会削弱 high/xhigh final answer only 的正常拦截价值。

### 处理

- 新增请求类型识别：
  - `remote_compaction_v2` / `remote_compaction` / `context_compaction` -> `request_kind=context_compaction`
- `context_compaction` 样本不参与当前拦截规则命中：
  - 不计入 `matched_current_rule`
  - 不计入 `blocked_by_gateway`
  - 不触发 `guard_retry_attempts` 内部重试
- 样本仍完整落盘和导出：
  - `request_kind`
  - `intercept_exempt_reason=context_compaction`
  - `reasoning_tokens=0/null`
  - `final_answer_only`

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `remote_compaction_v2 reasoning_tokens=0 不应被 final only 模式拦截: 502`
- 修复后：
  - `node --check .\gateway.mjs`
  - `node --check .\scripts\test-gateway-e2e.mjs`
  - `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 新增 final answer only 规则样本后，模型家族精确统计需要同步

### 现象

- 为 `final_answer_only_high_xhigh` 增加高思考拦截用例后，`node .\scripts\test-gateway-e2e.mjs` 失败：
  - `gpt-5.5 家族 total_checked 统计不正确`
- 失败发生在 `model_insights.family_breakdown` 精确计数断言。

### 根因

- 新增的 high/xhigh final answer only 请求不仅验证拦截规则，也会进入既有模型一致性统计。
- 这些请求的上游声明模型与请求模型一致，因此会同时增加 `total_checked` 与 `matched`。
- 旧断言使用精确数值，不会自动吸收新增样本。

### 处理

- 保留精确断言，不改成宽松 `>=`。
- 将 `gpt-5.5` 家族统计同步到新增样本后的真实口径：
  - `total_checked = 13`
  - `matched = 12`
  - `match_ratio = 12 / 13`
- 断言失败信息补充实际值，避免后续靠猜测调整。

### 验证

- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 reasoning 特征分析新增 helper 时不要复用既有通用函数名

### 现象

- 为 `/api/analytics/reasoning/analyze` 增加分析 Profile 解析时，新增了一个本地 helper：
  - `normalizeStringList`
- `node --check .\gateway.mjs` 直接失败：
  - `SyntaxError: Identifier 'normalizeStringList' has already been declared`

### 根因

- `gateway.mjs` 早已有全局 `normalizeStringList(values, fallback)`，用于配置归一化。
- 新增分析模块又声明了同名函数，ESM 顶层作用域不允许重复声明。

### 处理

- 将分析模块私有 helper 改名为：
  - `normalizeAnalysisStringList`
- 所有分析 Profile 和过滤条件解析统一使用新名字，避免影响旧配置归一化逻辑。

### 验证

- `node --check .\gateway.mjs`
- `node --check .\scripts\test-gateway-e2e.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 历史导入分析指定 source_paths 时不能再混入默认真实大库

### 现象

- 新增历史导入分析后，E2E 使用临时 SQLite 小库触发 `/api/analytics/imports/run`。
- 任务进度停在 `processed_sources=2/4`，已经完成测试用 CC Switch 和 Codex logs 小库，但又继续扫描默认 `%USERPROFILE%\.codex\logs_2.sqlite` 等真实大库。
- 这会让测试变慢，也会在用户只想分段导入时误扫 1GB / 2GB 级历史库。

### 根因

- `buildHistoricalImportSources()` 对每个数据源都使用“请求路径或默认路径”的写法。
- 只要某个可选 alt 路径没传，就会自动补默认真实路径。
- 这与“传入 `source_paths` 就只分析指定源”的分段导入语义冲突。

### 处理

- 增加 `hasRequestedSources = Object.keys(source_paths).length > 0`。
- 当请求体传入任意 `source_paths` 时，只收集显式指定的数据源，不再混入默认真实大库。
- 不传 `source_paths` 时，才自动发现本机默认 CC Switch、Codex logs 和 Codex sessions。

### 验证

- `node --check .\gateway.mjs`
- `node --check .\scripts\test-gateway-e2e.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-07-01 reasoning 大范围导出不应 31 天硬拒绝，应后台分段导出

### 现象

- 第一版大范围保护把 `31` 天以上 JSON / CSV 导出做成 HTTP `413` 拒绝。
- 用户明确要求大范围导出可以分段慢慢导出，要有进度条和提醒，但不能影响正常代理工作。
- 如果继续用 `413`，后续 60 天、90 天复盘都要人工拆日期，容易漏数据，也不符合“大盘离线分析”的使用方式。

### 根因

- 之前只实现了“防止 UI 卡死”的保护，没有补后台任务通道。
- 同步导出适合短时间段，但长时间段应该从交互请求里拆出去。

### 处理

- 保留 `31` 天以内同步 JSON / CSV 导出。
- `32` 天及以上改为返回 HTTP `202`，并创建后台导出任务：
  - 返回 `export_job.job_id`
  - 返回 `progress.total_days / processed_days / percent`
  - 后台按本地日期逐日读取 analytics 日文件和内存缓冲
  - 每处理一天后让出事件循环，避免长循环占住代理主链路
  - 完成后写入 `<state_root>/analytics/exports/<job_id>/reasoning-export.json|csv`
  - 新增任务状态接口和下载接口
- 管理页导出按钮改为先创建任务，再轮询进度；页面显示“可以继续正常使用 gateway”的提醒，完成后展示下载链接。

### 验证

- `node --check .\gateway.mjs`
- `git diff --check`
- `node .\scripts\test-gateway-e2e.mjs`

### 边界

- 后台任务状态当前保存在 gateway 进程内存中，进程重启后任务状态不会恢复。
- 当前不引入数据库，不打 zip；后续再补每日 rollup、明细索引和压缩包导出。
- 没有重启当前本机 `127.0.0.1:4610` 工作路由。

## 2026-07-01 reasoning analytics 缺少机器可判定激活信号，且大范围查询可能无边界深解析

### 现象

- 补完 reasoning analytics 后，文档要求用硬信号判断新进程是否真正激活。
- 但 E2E 新增断言后首先失败：
  - `status reasoning_behavior 缺少 schema_version=2`
- 这说明状态接口虽然返回了 `reasoning_behavior` 聚合数据，但缺少机器可判定字段。
- 同时，`date_from/date_to` 时间段接口和导出接口会直接读取命中范围内的日文件；如果时间段很大，后续有被大量日文件拖慢的风险。

### 根因

- `buildReasoningBehaviorSnapshotFromSamples()` 只返回业务统计，没有返回 analytics schema 和 ready 状态。
- `buildReasoningBehaviorRuntimeSnapshot()` 也没有追加运行期元信息，例如：
  - `analytics_started_at`
  - `analytics_state_root`
  - 最近 flush 状态
- 时间段查询和导出接口没有先计算日期跨度，也没有大范围降级或拒绝策略。

### 处理

- reasoning snapshot 统一补：
  - `schema_version = 2`
  - `analytics_ready = true`
- runtime metadata 补：
  - `analytics_started_at`
  - `analytics_state_root`
  - `analytics_last_flush_at`
  - `analytics_last_flush_error`
- 状态接口、独立观测接口、JSON 导出都带上这些硬信号。
- 大范围观测查询增加软降级：
  - 超过 `7` 天返回 `degraded=true`
  - `degrade_reason=date_range_too_large`
  - 不返回明细样本
- 第一版大范围导出曾增加明确拒绝：
  - 超过 `31` 天返回 HTTP `413`
  - 错误码 `reasoning_export_range_too_large`
  - 提示缩小范围或后续使用分片/压缩包导出
- 后续已升级为后台分段导出任务；详见上一条 2026-07-01 记录。

### 验证

- 红测：
  - `node .\scripts\test-gateway-e2e.mjs`
  - 先失败在 `status reasoning_behavior 缺少 schema_version=2`
- 修复后：
  - `node --check .\gateway.mjs`
  - `git diff --check`
  - `node .\scripts\test-gateway-e2e.mjs`

### 边界

- 这次先实现硬信号和大盘查询降级边界。
- 没有引入数据库。
- 后台分段导出已在后续记录中补齐，但压缩包导出仍未实现。
- 没有重启当前本机 `127.0.0.1:4610` 工作路由。

## 2026-06-30 reasoning 行为统计 runtime 状态未初始化会让旁路请求直接 502

### 现象

- `node .\scripts\test-gateway-e2e.mjs` 最早失败在：
  - `/v1/models 透传状态异常: 502`
- `/v1/models` 不在 reasoning 检查 endpoints 内，理论上应该只是旁路透传。

### 根因

- 普通代理请求进入后会立即调用：
  - `nextGatewayRequestId(runtime.reasoningBehavior)`
- 但 `runtime` 初始化时没有挂 `reasoningBehavior: createReasoningBehaviorState()`
- 旁路请求还没发到上游，就因为本地状态为空抛错，被顶层 catch 映射成 502。

### 处理

- 在运行时初始化对象中补齐：
  - `reasoningBehavior: createReasoningBehaviorState()`
- 这样所有普通代理请求进入时都能分配 `gateway_request_id`，旁路、检查、失败、重试都共享同一套采集状态。

### 验证

- `node --check .\gateway.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-06-30 inspected 主链 handler 如果不落样本，reasoning 大盘会只剩旁路和失败样本

### 现象

- UI 大盘补齐后，E2E 继续失败：
  - `reasoning 行为样本总数不正确`
- 状态接口里 `reasoning_behavior.summary.total_samples` 明显偏低，只看到旁路、拒绝或失败样本。

### 根因

- `proxyRequest()` 已经为每次 attempt 创建了 `reasoningSample` 和 `structureAccumulator`
- 但 `handleNonStreaming()` / `handleStreaming()` 没有接收和使用这两个对象
- handler 内部返回 `passed`、`observe_only`、`blocked`、`internal_retry` 时没有调用 `finalizeReasoningBehaviorSample()` 和 `recordReasoningBehaviorSample()`
- 流式分支也没有记录首 chunk、首内容、最终 chunk、usage 与结构信号。

### 处理

- `handleNonStreaming()`：
  - 补 usage、响应结构信号
  - 按 `passed` / `observe_only` / `blocked` / `internal_retry` 落样本
- `handleStreaming()`：
  - 补 `first_stream_chunk_at`、`first_content_at`、`final_chunk_at`
  - 累计 SSE payload 的 usage、模型信号和结构信号
  - 按 `passed` / `observe_only` / `blocked` / `internal_retry` / `disconnect` / `upstream_stream_terminated` 落样本
- `upstream_fetch_failed` 样本统一记录 `client_http_status = 502`
- CSV 导出补充流式时序、结构信号、内部重试与 stream termination 字段。

### 验证

- `node --check .\gateway.mjs`
- `node .\scripts\test-gateway-e2e.mjs`

## 2026-06-29 reasoning 统计如果只记“有正常上游响应的请求”，后面很多关键字段会永远缺失

### 现象

- 用户新要求变成：
  - 每一次请求都尽量详细
  - 连当前被拦截的请求也要详细落盘
  - 后续要区分 `gpt-5.4` / `gpt-5.5` 和 `reasoning.effort`
- 旧实现虽然已经有 reasoning 样本，但主要还是围绕“已检查响应”展开：
  - 正常透传和命中规则请求比较完整
  - 但像旁路透传、上游 `fetch failed`、请求体超限这类请求，要么没进样本，要么字段很薄

### 根因

- reasoning 样本之前是围绕 `upstreamResponse` 和检查链路补的
- 请求在这些更早的阶段失败时：
  - 还没进入 `handleNonStreaming()` / `handleStreaming()`
  - 甚至还没完成上游连接
- 结果会导致“统计总数看起来不少，但关键失败请求没有事实样本”

### 处理

- 把 reasoning 样本入口前移到 `proxyRequest()`：
  - 一开始就分配 `gateway_request_id`
  - 一开始就创建请求摘要 accumulator
- 落盘范围扩成：
  - 正常透传
  - observe_only
  - blocked
  - internal_retry
  - bypassed
  - upstream_fetch_failed
  - request_rejected
- 每条样本尽量保留：
  - 请求 headers 脱敏副本
  - 请求体大小 / sha256 / 摘要
  - 请求结构摘要
  - 上游状态 / 客户端状态
  - 失败摘要 / 响应摘要
  - `gpt-5.4` / `gpt-5.5` family
  - `reasoning.effort`
- 聚合新增：
  - `by_model_family`
  - `by_reasoning_effort`
  - `by_model_family_and_effort`

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - reasoning analytics 状态接口新增 family / effort / family+effort 分桶断言
  - reasoning JSON 导出新增请求摘要、失败摘要、客户端状态断言
  - reasoning 日文件新增 `schema_version = 2` 和失败样本断言
- `node .\scripts\test-install-restore.mjs`
  - 安装/恢复回归继续通过

## 2026-06-29 reasoning 统计新增模型/思考等级样本后，模型一致性旧断言需要同步调整

### 现象

- 为了让 reasoning analytics 真正产出 `gpt-5.4` / `gpt-5.5` 与 `reasoning.effort` 分桶
- E2E 新增了几条带不同模型和 effort 的真实请求
- 结果 `model_insights.family_breakdown` 的旧精确断言直接失败
  - 例如 `gpt-5.4 total_checked` 从旧值涨到了新值

### 根因

- 这些新增请求不只是 reasoning analytics 的样本
- 同时也会进入原有 `finalizeModelInsights()` 统计
- 所以 `family_breakdown` 的精确计数必须跟着真实新增样本一起调整

### 处理

- 保留精确断言，不改成模糊的 `>=`
- 先打印实际 `family_breakdown` 真值确认影响面
- 再把 E2E 中这组旧计数同步更新到新口径

### 验证

- `node .\scripts\test-gateway-e2e.mjs` 通过

## 2026-06-29 reasoning 行为统计导出不能只读日文件，必须合并内存缓冲样本

### 现象

- 新增 reasoning 行为统计后：
  - 状态接口和管理页已经能看到最新样本
  - 但 `GET /__codex_retry_gateway/api/analytics/reasoning/export?format=json` 导出的 `samples` 为空或显著偏少

### 根因

- 运行中样本先进入内存 recent window 和 daily buffer
- 日文件写入是节流 flush，不保证每次请求后立刻落盘
- 导出接口如果只读取 `analytics/reasoning-behavior-YYYY-MM-DD.json`，会漏掉尚未 flush 的最新样本

### 处理

- 导出读取逻辑改成：
  - 先读日期范围内的日文件
  - 再合并当前内存里的 `reasoning_behavior_daily_buffers`
  - 最后统一排序并重新计算导出统计

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - 新增 reasoning JSON 导出包含样本断言
  - 新增 reasoning CSV 导出包含表头断言

## 2026-06-29 主动探针测试夹具必须与 stateRoot / auth 查找规则对齐

### 现象

- 新增 reasoning 行为统计后，主动探针相关 E2E 超时
- 状态接口显示：
  - `active_probe.total_runs = 1`
  - 但 `recent_samples` 大量是 `401`
  - `error_excerpt = missing_authorization | authorization header required`

### 根因

- 网关读取鉴权时会按两条路径查找：
  - `path.dirname(codex_config_path)/auth.json`
  - `runtime.paths.stateRoot/auth.json`
- 不同测试场景的 `config.json` 布局不同：
  - 有的是 `<root>/config/config.json`
  - 有的是 `<root>/probe-runtime/config.json`
- 测试夹具若把 `state.json` / `auth.json` 写到错误层级，主动探针就会稳定落到 `401 indeterminate`

### 处理

- 保持 `buildRuntimePaths()` 规则不变：
  - 目录名为 `config` 时，`stateRoot = 上一级`
  - 其他情况，`stateRoot = config.json 所在目录`
- E2E 测试夹具按对应场景写入 `state.json` / `auth.json`
- 对关键 probe 场景额外补一份 `auth.json` 到 `codex_config_path` 同目录，避免目录布局差异再次误伤

### 验证

- `node .\scripts\test-gateway-e2e.mjs`
  - 主动探针长上下文 / warning / 缺鉴权场景全部恢复通过

## 2026-06-29 Issue #6：旧配置缺字段导致 PowerShell StrictMode 安装失败

### 现象

- 用户更新后执行：
  - `powershell -ExecutionPolicy Bypass -File .\scripts\launch-ui.ps1`
- 报错：
  - `The property 'intercept_streaming' cannot be found on this object`
  - 位置指向 `scripts\install-for-current-provider.ps1`

### 根因

- 旧版 `config.json` 没有 `intercept_streaming` / `intercept_non_streaming` / `guard_retry_attempts` 等新增字段
- PowerShell 脚本启用了 `Set-StrictMode -Version Latest`
- 在 StrictMode 下直接访问 `$existingGatewayConfig.intercept_streaming`，缺字段会抛异常，不能像普通 PowerShell 那样默认为 `$null`

### 处理

- `install-for-current-provider.ps1` 新增本地 helper：
  - `Get-OptionalPropertyValue`
- 所有可选旧配置字段统一通过 `PSObject.Properties[...]` 安全读取
- 缺失字段回落默认值：
  - `intercept_streaming = true`
  - `intercept_non_streaming = true`
  - `guard_retry_attempts = 3`
  - 其他字段沿用既有默认
- `scripts/test-install-restore.mjs` 增加旧配置缺字段后再次执行安装脚本的回归覆盖

### 跨平台补充

- 本轮专门重跑 Windows 和 Unix 入口测试
- 发现当前 worktree 缺 `.gitattributes`，导致 `.sh` 入口再次变成 CRLF，Bash 报：
  - `set: pipefail\r: invalid option name`
- 新增 `.gitattributes`：
  - `*.sh text eol=lf`
- 将现有 `.sh` 入口统一转为 LF

### 验证

- `node .\scripts\test-install-restore.mjs` 通过
- `node .\scripts\test-launch-ui.mjs` 通过
- `node .\scripts\test-launch-ui-unix.mjs` 通过

## 2026-06-29 命中拦截规则后不能继续把失败状态码暴露给 Codex

### 现象

- 规则拦截此前会向 Codex 返回本地 `502`
- Codex 遇到失败状态后会自动 `Reconnecting...`
- 连续重连达到上限后，会话可能断开
- 实测 `409` 和 `422` 也会触发 Codex 自动重连，不能作为最终拦截收口状态码

### 根因

- 网关把“本地规则拦截”伪装成 HTTP 失败状态返回给 Codex
- Codex 无法区分这是本地规则命中，还是上游真实故障
- 早期为了快速上线依赖 Codex 自身重连，导致命中规则时有断会话风险

### 处理

- 新增 `guard_retry_attempts`
  - 默认 `3`
  - 必须是大于等于 `0` 的整数
  - `0` 表示不做网关内部规则重试
  - 无上限，管理页保存后立即生效
- 仅当响应命中当前拦截规则且会被实际拦截时，网关内部重新请求上游
- 上游真实 HTTP `429` / `502` 等错误如果没有命中规则，继续原样透传给 Codex
- `fetch failed` 仍按既有上游连接失败逻辑处理，本轮不改变其语义
- 内部重试统计沿用现有 UI 口径：
  - 每次上游尝试计入代理请求总数
  - 每次被检查的响应计入被检查响应总数
  - 命中规则计入当前规则命中总数
  - 被吞掉重试或最终拦截计入实际拦截总数
- 命中日志动作：
  - `action=internal_retry remaining=N`：本次命中被网关吞掉，并继续内部重试，没有暴露给 Codex
  - `action=return_status_502`：重试次数为 `0` 或已达到上限，本次才真正向 Codex 返回拦截状态
  - `action=observe_only`：当前类型命中但配置为只观察不拦截

### 验证

- `node .\scripts\test-gateway-e2e.mjs`：
  - 覆盖非流式 `516 -> 128` 内部重试恢复为 `200`
  - 覆盖流式 strict `516 -> 128` 内部重试恢复为正常 SSE
  - 覆盖连续 `516 -> 516` 超过上限后才返回本地拦截状态
  - 覆盖上游真实 `429` 不触发规则内部重试并原样透传
- `node .\scripts\test-install-restore.mjs`：
  - 覆盖新装默认 `guard_retry_attempts = 3`
  - 覆盖旧配置迁移补默认值
  - 覆盖保存配置持久化 `guard_retry_attempts`

## 2026-06-28 长上下文主动探针从词数近似升级为 token 预算硬探针

### 现象

- 旧版 `long_context` 只按 `target_word_count` 构造重复文本
- 虽然能大致撞进 `>400K` 区间，但不能证明请求真的按目标模型口径到达了目标 token 预算

### 根因

- 上游当前不兼容官方 `responses/input_tokens` 计数接口
- 旧实现只能用词数近似，证据强度不够

### 处理

- 长上下文探针配置改为 `long_context.target_input_tokens`
- 探针先发送小样本校准请求，读取同一目标模型返回的 `usage.input_tokens`
- 再按真实返回口径估算并构造预算请求
- 样本与日志里落盘：
  - `target_input_tokens`
  - `observed_input_tokens`
  - `estimated_input_tokens`
  - `budget_source=response_usage`

### 验证

- 仓库回归：
  - `node .\scripts\test-gateway-e2e.mjs` 通过
- UI 文案回归：
  - “模型家族一致性” 改为 “模型家族一致性（被动探针）”

## 2026-06-28 主动探针图片输入误报 502 / transport_error

### 现象

- 主动探针里的 `image_input` 在真实上游上持续返回：
  - `502`
  - `transport_error` 或 `indeterminate`
- 但同一时段：
  - `long_context` 可以 `200 pass`
  - 用户手工实测 `gpt-5.4` / `gpt-5.5` 图片能力正常

### 根因

- 探针图片使用的是 `data:image/svg+xml;base64,...`
- 当前兼容链路对 `SVG data URL` 处理不稳定，真实现象会表现为上游拒绝、超时或被转写成 `502`
- 官方文档列出的常见视觉输入类型是 `png / jpg / gif / webp`，不包含 `svg`

### 处理

- 将主动探针内置图片从 `SVG data URL` 改为光栅 `PNG data URL`
- 保持探针请求结构不变，只替换图片 MIME 类型与内容
- 在 E2E 假上游里增加一条约束：
  - 若图片探针仍发送 `data:image/svg+xml`，则模拟上游异常
  - 这样可以防止后续回归把 `SVG` 又带回来

### 验证

- 仓库回归：
  - `node .\scripts\test-gateway-e2e.mjs` 通过
- 本机真实验证：
  - `gpt-5.5 image_input`：`200 pass`，证据为 `A`
  - `gpt-5.4 image_input`：`200 pass`，证据为 `A`

## 2026-06-26 独立 Codex Retry Gateway

### 设计边界

- 只解决 Codex 已可访问上游时的 `reasoning_tokens = 516` 重试问题
- 不替代 `cc-switch` 的协议路由转换
- 流式场景默认策略是：
  - 先缓存上游流
  - 一旦检测到命中 `516`
  - 统一返回 `502`

### 当前已知限制

- 如果上游只支持 Chat Completions、而 Codex 当前链路需要 Responses 协议转换，这个项目不处理该转换
- 这个项目依赖 Codex / Codex Desktop 自身的自动重试能力

### 本次已确认并修复的问题

1. `gateway.mjs` 非流式透传发头顺序错误
   - 现象：`ERR_HTTP_HEADERS_SENT`
   - 根因：`writeHead()` 在 `copyHeadersToClient()` 之前调用
   - 结果：正常 `128` 响应也会被打断

2. PowerShell 脚本在 `powershell.exe` 下的解析兼容性
   - 现象：脚本乱码并伴随解析异常
   - 根因：新脚本初版包含中文运行时字符串，且 `param(...)` 不在文件最前
   - 处理：运行时输出改成 ASCII，并把 `param(...)` 提前到文件顶部

3. `stop-gateway.ps1` 与 PowerShell 内置只读变量 `$PID` 冲突
   - 现象：安装脚本在重启 gateway 时失败
   - 处理：改用 `$gatewayPid`

4. `start-gateway.ps1` 启动 Node 时路径带空格
   - 现象：gateway 进程启动后立刻退出
   - 根因：`Start-Process` 参数未显式带引号
   - 处理：改为手工拼带引号的 `ArgumentList`

5. PowerShell 单元素数组落盘时被拆成标量
   - 现象：`reasoning_equals` 被写成 `516`，不是 `[516]`
   - 处理：在公共归一化函数里强制返回数组

6. 旧脏配置迁移后出现嵌套/拼接 endpoints
   - 现象：`endpoints` 可能变成嵌套数组，或出现一条用空格拼接的脏字符串
   - 处理：安装脚本合并 endpoints 时做递归拍平和空白拆分

7. 真实 Codex 客户端请求路径不是 `/v1/responses`
   - 现象：`codex exec` 在 gateway 关闭时真实报错地址是 `http://127.0.0.1:4610/responses`
   - 结论：默认配置必须同时覆盖：
     - `/responses`
     - `/chat/completions`
     - `/v1/responses`
     - `/v1/chat/completions`

8. UI 恢复动作最初采用“子进程拉起 restore 脚本”方案
   - 现象：浏览器拿到 `202`，但临时 `config.toml`、`state.json`、`gateway.pid` 都没有变化
   - 根因：恢复动作通过 detached 子进程接力时，链路可靠性不足，实际没有把恢复流程真正执行完
   - 处理：改为当前 gateway 进程直接复制备份、清理状态并自我退出

9. 新增内嵌 UI 管理页
   - 入口：`/__codex_retry_gateway/ui`
   - 能力：
     - 查看当前接管状态
     - 热更新 `reasoning_equals`
     - 热更新 `endpoints`
     - 热更新 `non_stream_status_code`
     - 开关 `log_match`
     - 一键恢复 Codex 原设置

10. 用户不接受 `cc-switch` 路由模式，且不希望手工改设置
   - 现象：仅有安装脚本和 UI 还不够，首次接管、再次拉起、重新打开 UI 仍需要手工串命令
   - 处理：新增 `launch-ui.ps1`
   - 结果：
     - 首次运行自动安装并打开 UI
     - 再次运行自动复用 `state.json + config.json` 并重启 gateway
     - 平时规则调整和恢复统一回到 UI 内完成

11. UI 需要动态显示实时日志、`516` 次数和占比
   - 现象：原 UI 只能改配置，看不到运行中的命中趋势
   - 处理：
     - 在 `gateway.mjs` 内增加运行期统计
     - 增加日志接口
     - UI 轮询显示“被检查响应总数 / 516 命中次数 / 516 占比 / 实时日志”
   - 统计口径：
     - 按本次 gateway 启动以来累计
     - `516` 占比 = `reasoning_tokens = 516` 的响应次数 / 被检查响应总数

12. macOS / Linux 不能直接使用现有 PowerShell 管理脚本
   - 现象：`launch-ui.ps1`、`restore-codex-config.ps1` 等入口绑定了 PowerShell 和 Windows 进程控制
   - 处理：
     - 新增跨平台 `node` 管理核心
     - 新增 `.sh` 包装入口：
       - `launch-ui.sh`
       - `restore-codex-config.sh`
       - `install-for-current-provider.sh`
       - `start-gateway.sh`
       - `stop-gateway.sh`
   - 结果：
     - Windows 继续走 `.ps1`
     - macOS / Linux 直接走 `.sh`
     - UI、状态文件、gateway 主逻辑保持同一套

13. Windows 主机上模拟 Unix shell 入口时存在路径与 Node 版本兼容问题
   - 现象：
     - Bash 入口最初找不到脚本路径
     - Bash 默认 `node` 版本过老，不支持现代语法
     - `node.exe` 需要 Windows 路径，而 shell 侧是 POSIX 路径
   - 处理：
     - 测试改成相对 POSIX 路径执行 `.sh`
     - `.sh` 优先选择 `node.exe`
     - 在 WSL / Bash 场景下把路径参数转换回 Windows 路径后再交给 `node.exe`

14. 上游流式连接中途终止时被误记为网关错误，首次瞬断也缺少最小重试
   - 现象：
     - 日志出现：
       - `TypeError: terminated`
       - `TypeError: fetch failed`
     - 其中一部分来自上游 SSE 中途断流，另一部分来自上游首次连接瞬时失败
   - 根因：
     - `handleStreaming()` 直接把 `reader.read()` 抛出的 `AbortError` / `TypeError: terminated` 冒到统一错误处理
     - `proxyRequest()` 对上游 `fetch()` 没有做一次轻量重试，首个瞬断会直接返回 `502`
   - 处理：
     - 新增预期流终止识别：
       - `AbortError`
       - `TypeError: terminated`
     - 这两类在流式处理中按“连接已结束”收口，不再记 `[error]`
     - 新增上游 `fetch failed` 的一次自动重试
     - 新增严格 `502` 流式模式：
       - 默认不再抢先透传 `200` 头和首个 chunk
       - 先缓存流，再根据 `reasoning_tokens` 决定透传或返回 `502`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 `/responses` 流式覆盖
       - 新增“上游半路断流不刷 error 日志”断言
       - 新增“首次 fetch failed 后第二次成功恢复”断言
       - 新增“流式 `516` 统一返回 `502`，不再先透传半截 chunk”断言
     - `scripts/test-install-restore.mjs` 继续通过

15. 管理页刷新会把代理请求总数加一
   - 现象：
     - 打开或刷新 `__codex_retry_gateway/ui` 后，页面里的“代理请求总数”会额外增加
   - 根因：
     - 浏览器自动请求 `/favicon.ico`
     - 网关未把该请求识别为管理页附属资源，落入普通代理路径并计入 `total_proxy_request_count`
   - 处理：
     - 在管理请求分支提前处理 `/favicon.ico`
     - 直接返回 `204`
     - 不再进入普通代理计数
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“管理页刷新相关请求不应增加代理请求总数”断言

16. 新增模型家族一致性检测与单请求高风险漂移检测
   - 目标：
     - 本地模型为 `gpt-5.4` / `gpt-5.5` 时，检查链路声明和行为是否符合 `1M` 家族特征
   - 处理：
     - 新增本地请求模型、上游声明模型、流式声明模型统计
     - 新增声明一致率与最近可疑样本
     - 新增 `400K` 家族异常检测
     - 新增单请求模型漂移检测
     - 新增疑似请求内重建/重试检测
   - 证据保留：
     - 每条可疑样本保留：
       - 本地期望模型
       - 上游声明模型
       - 流式声明模型
       - 首个观测模型
       - 最后观测模型
       - 模型集合
       - 指纹集合
   - 边界：
     - 声明一致不等于已证明真实运行一致
     - `400K` 家族异常只表示行为上疑似不符合 `1M` 家族
     - 单请求模型漂移与疑似请求内重建/重试都按高风险展示
     - 无法直接确认 provider 内部缓存重建
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 `gpt-5.4` / `gpt-5.5` 一致声明断言
       - 新增 `mini` 声明不一致断言
       - 新增 `400000 context window` 异常断言
       - 新增单请求模型漂移断言
       - 新增疑似请求内重建/重试断言

17. 管理页内联脚本语法错误会导致整页状态全部不灌值
   - 现象：
     - `运行状态`、`拦截规则`、`模型家族一致性` 都显示为初始空值
     - 浏览器控制台报：
       - `SyntaxError: Invalid or unexpected token`
   - 根因：
     - 新增“日志证据”展示时，内联脚本里的 `join('\n')` 被模板 HTML 吃成了真实换行
     - 最终生成的 `<script>` 语法非法，初始化逻辑完全没有执行
   - 处理：
     - 改成 `join('\\n')`
     - 在 `scripts/test-gateway-e2e.mjs` 里新增“管理页内联脚本可被 `vm.Script` 解析”断言

18. Unix `.sh` 入口在 Bash 下因为 CRLF 行尾直接失败
   - 现象：
     - `scripts/test-launch-ui-unix.mjs` 失败
     - Bash 报错：
       - `set: pipefail\r: invalid option name`
   - 根因：
     - `.sh` 文件被写成了 `CRLF`
     - Bash 把 `\r` 当成命令内容的一部分
   - 处理：
     - 把所有 `.sh` 入口统一转成 `LF`
     - 新增仓库级 `.gitattributes`
       - `*.sh text eol=lf`

19. 最近可疑样本里的“查看日志”会在自动刷新后瞬间收起
   - 现象：
     - 点开“日志证据”里的 `查看 N 条`
     - 约 2 秒一次的页面轮询后会自动收起
   - 根因：
     - `renderSuspiciousSamples()` 每次轮询都会整体重写 `tbody.innerHTML`
     - `<details>` 的展开态属于 DOM 本地状态，节点被重建后自然丢失
   - 处理：
     - 给最近可疑样本增加签名比对
     - 样本数据没变化时不重绘
     - 样本数据有变化时保留用户已展开的 `data-sample-key` 状态并恢复
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“最近可疑样本未变化时不应重绘日志证据 DOM”断言
       - 新增“最近可疑样本刷新后已展开的日志证据不应自动收起”断言

20. 正常拦截流式 `516` 会被误报成 `single_request_rebuild_suspected`
   - 现象：
     - `/responses` 流式命中 `reasoning_tokens = 516` 被本地严格 `502` 正常拦截后
     - 管理页仍可能出现：
       - `single_request_rebuild_suspected`
   - 根因：
     - 流式 SSE 事件里的顶层 `id` 可能只是事件 id，不是响应 `response.id`
     - 监控层此前把流式 payload 顶层 `id` 也记进 `observedResponseIds`
     - 同一请求里多个事件 id 被误当成多个响应 id，触发“疑似请求内重建/重试”
   - 处理：
     - `extractPayloadResponseId()` 改为仅在非流式场景允许回退到 payload 顶层 `id`
     - 流式场景只认 `payload.response.id`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“带事件 id 的 516 流式请求未返回 502”覆盖
       - 新增“正常拦截 516 不应计入疑似请求内重建/重试”断言
       - 新增“正常拦截 516 不应生成 single_request_rebuild_suspected 可疑样本”断言

21. 管理页实时日志时间显示与本机时间不一致，且代理请求总数与被检查响应总数差值缺少解释
   - 现象：
     - “实时日志”直接显示原始 UTC 时间串
     - `代理请求总数` 与 `被检查响应总数` 存在差值时，页面看不出是哪些请求造成的
   - 根因：
     - `renderLogs()` 直接输出 `entry.at`，没有复用 `formatTimestamp()`
     - `total_proxy_request_count` 统计的是所有进入普通代理分支的请求
     - `inspected_response_count` 只统计真正进入检查逻辑的响应
     - 像 `/v1/models` 这类未纳入 `endpoints` 检查范围的透传请求会进入代理总数，但不会进入被检查总数
   - 处理：
     - `renderLogs()` 改为统一走 `formatTimestamp()`
     - 新增运行期统计：
       - `bypassed_proxy_request_count`
       - `bypassed_proxy_path_counts`
       - `failed_proxy_request_count`
     - 在“运行状态”脚注里明确展示：
       - 总数计算口径
       - 当前差值
       - 未纳入检查的透传路径分布
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“实时日志应显示与系统时间一致的本地时间”断言
       - 新增“运行状态脚注应提示未纳入检查的透传路径”断言
       - 新增“代理请求总数与被检查响应总数的差值应能由透传请求和失败请求解释”断言

22. 管理页差值在慢请求进行中会继续放大，但页面之前没有把“进行中的代理请求”单独解释出来
   - 现象：
     - `代理请求总数` 与 `被检查响应总数` 的差值不只出现在透传或失败请求场景
     - 当普通代理请求仍在执行中时，差值会临时增大，但页面之前无法说明来源
   - 根因：
     - 缺少运行期 `active` 统计
     - `proxyRequest()` 也没有把普通代理请求生命周期包进开始/结束计数
   - 处理：
     - 新增运行期统计：
       - `active_proxy_request_count`
       - `active_proxy_path_counts`
     - 在普通代理请求进入后立刻记 `active start`
     - 无论成功、旁路、流式、非流式还是失败，都在 `finally` 里记 `active end`
     - “运行状态”脚注改成：
       - `代理请求总数 = 被检查响应总数 + 未纳入检查的透传请求 + 失败请求 + 进行中的代理请求`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“代理请求进行中时应记录 active_proxy_request_count”断言
       - 新增“代理请求进行中时应记录 active_proxy_path_counts”断言
       - 新增“代理请求结束后 active_proxy_request_count 应回到 0”断言

23. 声明一致率把 `unknown` 也算进分母，导致百分比与“不一致次数 / 可疑样本”口径互相打架
   - 现象：
     - 管理页里“声明一致率”可能不是 `100%`
     - 但“声明不一致次数”仍然是 `0`
     - 最近可疑样本也没有 `model_family_mismatch`
   - 根因：
     - 一致率此前按：
       - `matched / total_checked`
     - 其中 `unknown` 表示本次没有拿到可比对的上游声明，它不该被计入“不一致”，却被错误计入了一致率分母
   - 处理：
     - 一致率改为只按已声明样本计算：
       - `matched / (matched + mismatched)`
     - `unknown` 继续单独保留，但不再拉低一致率
     - 管理页文案补充“未声明样本不计入分母”
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“声明一致率应只按已声明样本计算”断言
       - 新增 `gpt-5.4` / `gpt-5.5` 家族一致率排除 `unknown` 断言

24. 网关重启后管理页会把上一次会话的旧日志继续留在页面里，导致“实时日志时间仍不对”
   - 现象：
     - 网关已重启、`started_at` 已变成新会话
     - 但“实时日志”区域仍可能保留上一轮会话里的旧文本
     - `logsMeta` 会显示新的日志总数，`logsOutput` 却还是旧内容
   - 根因：
     - 管理页日志轮询依赖 `since_seq`
     - 网关重启后，新的日志序号会从小值重新开始
     - 页面若继续沿用旧的 `lastLogSeq` 做增量请求，会拿不到完整新日志
     - 旧页面内容因此不会被替换
   - 处理：
     - 页面保存上一轮 `metrics.started_at`
     - 检测到 `started_at` 变化后，立即清空增量游标并全量重拉日志
     - 若增量响应里的 `latest_seq` 小于当前游标，也自动回退为全量重拉
     - 管理页 HTML 与管理接口统一补 `cache-control: no-store`
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“网关重启后实时日志应重新全量加载并显示本地时间”断言
       - 新增“网关重启后不应继续保留上一次会话的旧日志”断言
       - 新增“检测到网关重启后应全量重拉日志”断言

25. 新增主动探针运行层，并与普通代理统计完全隔离
   - 目标：
     - 在不干扰 `proxyRequest()` 主链路的前提下，低频主动验证 `gpt-5.4` / `gpt-5.5` 声明契约
   - 处理：
     - 在 `gateway.mjs` 内新增 `active_probe` 配置和独立 `probeMonitor`
     - 新增主动探针状态快照 `active_probe`
     - 新增低频定时调度，不进入普通代理请求统计
   - 当前范围：
     - 长上下文硬契约探针
     - `gpt-5.5` 图片输入硬契约探针
     - 响应结构辅助探针
     - 身份一致性辅助探针
     - 训练截止日期 / 知识表现辅助探针
   - 边界：
     - 只做声明证伪，不做真实底层模型归因
     - 辅助探针默认只产出 `warning`
     - `transport_error` 不计入违约
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增 probe-only gateway 的 `violation` 断言
       - 新增 probe-only gateway 的 `warning` 断言
       - 新增“主动探针不应污染普通代理统计”断言

26. 管理页新增“主动探针”面板，并展示独立样本与日志证据
   - 现象：
     - 之前状态接口已有 `active_probe`，但管理页没有对应展示区域
   - 处理：
     - 新增主动探针概览卡片：
       - 状态
       - 最近目标模型
       - 最近一次运行
       - 通过 / warning / 违约 / transport error 次数
     - 新增最近主动探针样本表与日志证据
   - 验证：
     - `scripts/test-gateway-e2e.mjs`
       - 新增“主动探针状态未正确展示”相关 UI 断言
     - `scripts/test-install-restore.mjs`
       - 新增管理页包含“主动探针”与状态接口暴露 `active_probe` 断言

27. 管理页模板字符串里直接写反引号文案会让 gateway 启动即崩
   - 现象：
     - 新增“主动探针”说明文案后，`/__codex_retry_gateway/health` 超时
     - `node --check gateway.mjs` 报：
       - `SyntaxError: Unexpected identifier 'warning'`
   - 根因：
     - 管理页 HTML 本身位于 JS 模板字符串中
     - 文案里直接写了反引号包裹的 `warning` / `violation` / `transport_error`
     - 导致模板字符串被提前截断
   - 处理：
     - 把该段文案改成普通文本，不再在模板字符串里直接嵌反引号
   - 验证：
     - `node --check .\\gateway.mjs`
     - `node .\\scripts\\test-gateway-e2e.mjs`

28. 真实上游的长上下文主动探针使用大量唯一编号词，会把请求体打得过碎，导致探针极慢甚至先拿到 `502`
   - 现象：
     - 假上游 E2E 全绿
     - 但真实 `ai.input.im` 上，`gpt-5.4` 长上下文探针可能耗时接近 100 秒，甚至返回 `502`
     - 同一条探针改成高密度重复词后，可在几秒内正常返回 `200`
   - 根因：
     - 旧版 `buildLongContextProbeText()` 生成的是 `w000001`、`w000002` 这类大量唯一词
     - 真实上游在分词/前置服务处理这种超高基数输入时，负担远大于“相同 token 重复”的正常长上下文场景
     - 结果把本应用来验证 400K/900K 契约的探针，先打成了“上游服务暂时不可用”
   - 处理：
     - 长上下文探针改为高密度重复 `a` token
     - 仍保持总量超过 400K 级别，但避免因为输入构造方式本身制造伪 `502`
   - 验证：
     - `node .\\scripts\\test-gateway-e2e.mjs`
     - 真实本机路由 `POST /__codex_retry_gateway/api/probe/run`
       - `gpt-5.4 long_context` 从慢速 `502` 变为快速 `200 pass`

29. 主动探针样本之前只保留了 `start` 日志，且 `401/502` 这类上游错误摘要没有落进样本
   - 现象：
     - 管理页“最近主动探针样本”里的“查看”经常只能看到开始日志
     - `401`、`502 upstream_error` 等真实证据没有保留下来
     - `现在探测一次` 还会一直等待整轮探针跑完，真实上游慢时很像按钮卡死
   - 根因：
     - `collectProbeEvidenceLogs()` 在结果日志写入前就被调用
     - `error_excerpt` 只记录 `requestError`，不会从 HTTP 错误响应体提取摘要
     - `/api/probe/run` 同步等待 `safeRunActiveProbeOnce()` 全部完成后才返回
   - 处理：
     - 为主动探针样本补充：
       - `finish ... status=... result=... confidence=...`
       - `detail=...` 错误摘要
     - `error_excerpt` 改为优先保留响应体里的 `error.type/code/message` 或文本摘要
     - `/api/probe/run` 改为后台启动探针，立即返回 `202`
   - 验证：
     - `node .\\scripts\\test-gateway-e2e.mjs`
     - `powershell -ExecutionPolicy Bypass -File .\\scripts\\test-install-restore.ps1`
     - 真实本机路由状态接口：
      - `image_input` 样本可见 `upstream_error | Upstream access forbidden, please contact administrator`
      - `gpt-5.5 long_context` 样本可见 `upstream_error | Upstream service temporarily unavailable`

30. 流式 / 非流式拦截目标拆分后，命中统计不能等同于实际拦截统计
   - 现象：
     - 用户需要三种模式：
       - 仅拦流式
       - 仅拦非流式
       - 流式 + 非流式都拦
     - 如果只用旧的 `matched_response_count`，页面无法区分“命中了但当前配置只观察”和“命中了并实际拦截”
   - 根因：
     - 旧配置只有 `stream_action` 与 `non_stream_status_code`
     - 旧统计只有规则命中总数，没有按流式 / 非流式拆分，也没有 blocked 统计
     - 非流式命中被拦截时如果提前返回，模型一致性收口会漏掉这批响应
   - 处理：
     - 新增配置：
       - `intercept_streaming`
       - `intercept_non_streaming`
     - 默认双开，保持旧行为兼容
     - 后端和管理页都禁止两个开关同时关闭
     - 新增统计：
       - `matched_streaming_count`
       - `matched_non_streaming_count`
       - `blocked_response_count`
       - `blocked_streaming_count`
       - `blocked_non_streaming_count`
     - `matched_response_count` 继续表示规则命中次数，不改成实际拦截次数
     - 命中但未拦截时日志写 `action=observe_only`
     - 非流式命中无论拦截还是透传，都进入 `finalizeModelInsights()`
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
     - `node .\scripts\test-install-restore.mjs`
     - `node --check .\gateway.mjs`
     - `git diff --check`

31. 上游 API 不可用时不应刷网关内部错误堆栈
   - 现象：
     - 日志反复出现：
       - `[retry] upstream fetch failed attempt=1 ...`
       - `[error] TypeError: fetch failed`
     - 用户确认这类报错来自上游 API 异常，不是 gateway 自身逻辑崩溃
   - 根因：
     - 统一 catch 把重试后仍失败的上游 `fetch failed` 当成普通 gateway 内部错误记录
     - 结果日志里出现大段堆栈，容易误判为本地网关问题
   - 处理：
     - 保留一次轻量重试
     - 重试后仍失败时继续返回 `502`
     - 响应错误类型改为：
       - `type=upstream_error`
       - `code=upstream_fetch_failed`
     - 日志改为摘要：
       - `[upstream-error] fetch failed after retry path=... message=fetch failed`
     - 其他未知错误仍继续记录 `[error]` 堆栈
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增连续上游 fetch failed 返回 `upstream_error` 断言
       - 新增日志不包含 `[error] TypeError: fetch failed` 断言

32. 管理页运行状态移除旧 516 专属卡片，改为实际拦截口径
   - 现象：
     - 用户希望删除 `516 命中次数`
     - `当前规则命中总数` 放到原 `516 命中次数` 位置
     - `516 占比` 改为 `实际拦截占比`
     - `实际拦截总数` 放到原 `516 占比` 位置
   - 根因：
     - 拦截目标拆成流式 / 非流式后，`516` 专属统计不再是管理页最核心口径
     - 用户真正关心的是当前规则命中、实际拦截总数和实际拦截占比
   - 处理：
     - 管理页移除 `516 命中次数` 与 `516 占比` 卡片
     - 运行状态卡片顺序调整为：
       - 当前规则命中总数
       - 实际拦截总数
       - 实际拦截占比
     - `实际拦截占比 = blocked_response_count / inspected_response_count`
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
     - `node .\scripts\test-install-restore.mjs`

33. 管理页运行状态脚注会把大量透传路径完整展开，导致 UI 爆长
   - 现象：
     - 当 gateway 代理真实前端站点时
     - `运行状态` 脚注会把 `/assets/*`、`/login`、`/logo.png`、`/api/v1/settings/public` 等透传路径全部平铺出来
     - 整块说明文字会被撑得很长，阅读体验很差
   - 根因：
     - 管理页脚注里的 `formatPathCounts()` 直接把所有路径计数 `join('，')`
     - 没有做条目数收敛或摘要化
   - 处理：
     - 保留路径分布提示，但只展示按次数排序后的前 `3` 项
     - 剩余条目统一收敛成 `其余 N 项`
     - 进行中的代理请求路径说明继续保留，不改统计口径
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增“运行状态脚注应对过多透传路径做摘要收敛”断言
       - 新增“不应把所有透传路径完整展开”断言
       - 新增“进行中的代理请求路径仍应展示”断言
     - `node --check .\gateway.mjs`
     - `git diff --check`

34. 请求体超过本地上限时不应误记成 gateway 内部错误
   - 现象：
     - 日志出现：
       - `[error] Error: 请求体超过限制: 104857600 bytes`
     - 用户容易误判成 gateway 自身崩溃或上游异常
   - 根因：
     - `readRequestBody()` 超限时直接抛普通 `Error`
     - 顶层统一 catch 会把它按通用 `502 gateway_error` 和 `[error]` 堆栈收口
   - 处理：
     - 为请求体超限增加单独错误语义：
       - HTTP `413`
       - `type=gateway_rejection`
       - `code=request_body_limit_exceeded`
     - 日志改为摘要：
       - `[gateway-reject] request body too large path=... limit=... message=...`
     - 继续计入 `failed_proxy_request_count`
   - 额外修正：
     - 原默认 `request_body_limit_bytes = 10MB` 会挡住真实 Codex 大上下文请求
     - 默认值上调到 `100MB`
     - 安装脚本和复用迁移会把旧默认 `10MB` 自动升级到新默认
   - 验证：
     - `node .\scripts\test-gateway-e2e.mjs`
       - 新增“超限请求体应返回 413”断言
       - 新增“超限请求体应返回 request_body_limit_exceeded”断言
       - 新增“超限请求体应记录为 gateway-reject 摘要日志”断言
       - 新增“不应记录 [error] Error: 请求体超过限制”断言
     - `node --check .\gateway.mjs`
     - `git diff --check`

### 2026-06-26 实测证据

- 假上游 E2E
  - `test-gateway-e2e.ps1` 通过
  - 已验证 root 路径和 `/v1` 路径都能区分 `516` 与 `128`
- 安装/恢复闭环
  - `test-install-restore.ps1` 通过
  - 已验证 UI 页面、状态接口、日志接口、516 统计、热更新配置、UI 恢复闭环
- 一键启动入口
  - `test-launch-ui.ps1` 通过
  - 已验证首次启动自动安装、再次启动自动复用、UI 页面可达、默认 `516 -> 502` 规则仍生效
- Unix shell 入口
  - `test-launch-ui-unix.ps1` 通过
  - 已验证 `.sh` 入口能完成启动、透传、恢复闭环
- Bash 默认入口实机验证
  - `bash ./scripts/launch-ui.sh --no-open` 通过
  - 输出 `mode=reuse`
  - `GET /__codex_retry_gateway/health` 返回 `200`
  - `GET /__codex_retry_gateway/ui` 返回 `200`
  - `GET /v1/models` 返回 `200`，并继续透传到真实上游
- Bash 入口后的 `codex exec` 实机验证
  - 命令退出码 `0`
  - 最后一条消息文件返回 `OK`
- 当前真实 provider
  - 当前 Codex 配置里的 `base_url` 已可切到 `http://127.0.0.1:4610`
  - 当前 gateway 运行配置里的 `upstream_base_url` 会指向用户自己的真实上游
  - `GET /__codex_retry_gateway/health` 返回 `ok=true`
  - `GET /v1/models` 已经经本地 gateway 成功透传到真实上游
  - `GET /__codex_retry_gateway/ui` 已实机打开，页面显示当前 upstream、provider、config 路径和 516 规则
- 真实 `codex exec`
  - gateway 停止时，CLI 真实提示：
    - `url: http://127.0.0.1:4610/responses`
    - 并自动进入 `Reconnecting...`
  - gateway 恢复后，`codex exec` 在临时目录再次成功返回 `OK`
