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
- 查看 reasoning 行为统计大盘、高频 token 排行、候选特征组合与最近样本
- 查看 reasoning 统计里的按模型家族、按思考等级、按模型家族+思考等级分桶
- 按统一 Profile 运行 reasoning 特征分析，展示 `analysis_value`、`conclusion`、字段覆盖率、候选摘要和基线对比
- 导出 reasoning 行为统计 JSON / CSV
- 启动历史导入预检并分析后台任务，先判断历史数据是否具备 reasoning 行为特征分析价值
- 热更新 `intercept_rule_mode` / `reasoning_equals` / `endpoints` / `non_stream_status_code` / `guard_retry_attempts` / `retry_upstream_capacity_errors` / `log_match`
- 一键恢复 Codex 原设置并关闭 gateway

拦截规则模式说明：

- `reasoning_tokens` 是默认并推荐的稳定主规则，命中 `reasoning_equals` 即视为当前规则命中；真实使用中 516 拦截仍可能直接影响任务正确性。
- `final_answer_only_high_xhigh` 是实验收窄规则，仅在 `reasoning.effort=high/xhigh` 下拦截 `final answer only + commentary not observed + no tool call + no reasoning item`，且 `reasoning_tokens=null/缺失` 或非 0 的响应结构；普通 `reasoning_tokens=0` 只观察落盘，不触发该实验规则。它可能漏掉仍影响正确性的 516 样本，不建议替代默认 516/1034/1552 主拦截。
- 两个模式二选一；`intercept_streaming` / `intercept_non_streaming` 只控制命中当前规则后是否真正拦截。
- `remote_compaction_v2` 只是 beta feature 标记，不单独识别为压缩请求；只有显式 `context_compaction` 且 `reasoning_tokens=0` 的响应会豁免，`516/1034/1552` 等命中值仍按当前规则处理并受 `guard_retry_attempts` 控制。
- `retry_upstream_capacity_errors` 默认开启，只匹配上游 `Selected model is at capacity. Please try a different model.`；命中后按 `guard_retry_attempts` 在网关内部重试，普通 `429` / `502` 仍原样透传。

reasoning 统计落盘说明：

- 代码层已实现 reasoning analytics，但当前正在运行的旧 gateway 进程不一定已经加载新代码。
- 如果 `GET /__codex_retry_gateway/api/analytics/reasoning` 返回上游 HTML 或非 JSON，说明需要在合适窗口重启或重新拉起 gateway 后再验证。
- 不要在正在承载重要 Codex 会话时贸然重启路由进程；先确认可以中断再操作。
- 每次请求都会尽量记录详细样本，不只记录最终透传成功的请求。
- 已覆盖：
  - 正常透传样本
  - 命中规则但仅观察样本
  - 最终被 gateway 拦截样本
  - gateway 内部重试样本
  - 未纳入检查但被旁路透传的请求样本
  - Codex `remote_compaction_v2` 上下文压缩样本
  - 上游 `fetch failed` 失败样本
  - 本地请求体超限拒绝样本
- 单样本会尽量保留：
  - 请求模型、模型家族、`reasoning.effort`
  - 请求类型 `request_kind`、拦截豁免原因 `intercept_exempt_reason`
  - 本地期望模型 / 上游声明模型 / 流式声明模型 / 最终响应模型
  - 请求摘要、请求体大小、请求体哈希、截断后的部分请求预览
  - token、耗时、TPS、响应结构特征
  - 命中规则、是否拦截、最终动作、上游状态、客户端状态
  - 截断后的失败摘要或响应摘要
- 导出脱敏要求：
  - 不导出 Authorization、Cookie、Set-Cookie、完整请求体、完整响应体。
  - 请求预览建议上限 `500` 字符。
  - 失败摘要、响应摘要和错误消息建议上限 `320` 字符。
  - CSV 优先导出结构字段、数值字段和状态字段。

历史导入分析说明：

- 历史导入独立于实时 reasoning analytics，不会把历史大文件完整写入 `reasoning-behavior-YYYY-MM-DD.json`。
- 默认发现本机 `%USERPROFILE%\.cc-switch\cc-switch.db`、`%USERPROFILE%\.codex\sqlite\logs_2.sqlite`、`%USERPROFILE%\.codex\logs_2.sqlite` 和 `%USERPROFILE%\.codex\sessions`。
- 如果请求体传入 `source_paths`，只分析指定路径，不混入默认真实大库，便于测试和分段导入。
- 历史导入先执行 preflight；缺少 `reasoning_tokens`、`final_answer_only`、`commentary_observed` 等核心字段时，标记 `no_analysis_value` 并停止候选特征分析。
- CC Switch / Codex logs SQLite 使用聚合 SQL；session JSONL 第一版只做文件级索引和 top 大文件，不深解析完整会话正文。
- 输出摘要写入 `<state_root>\analytics\imports\<job_id>\summary.json`，UI 只轮询任务进度和摘要。

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

## GitHub Actions 按需验证

- 工作流：`.github/workflows/macos-smoke.yml`
- 目的：在 `macos-latest` runner 上补一层真实 macOS / Unix 入口冒烟
- 当前状态：仓库侧已手动禁用，默认不在 push / PR 时自动运行；常规验收优先使用上面的本地验证命令
- 当前命令：

```bash
node ./scripts/test-launch-ui-unix.mjs
```

## 本机真实验证命令

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/health'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/ui'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning'
```

成功标准：

- HTTP 状态为 `200`。
- 响应 `Content-Type` 是 JSON 或正文可解析为 JSON。
- JSON 中包含 `ok: true`、`summary`、`top_reasoning_tokens`、`candidate_patterns`、`recent_samples`。
- JSON 中包含 `schema_version: 2`、`analytics_ready: true`、`analytics_started_at`、`analytics_state_root` 这类机器可判定信号。
- 如果返回 HTML，表示当前运行实例不是已加载 analytics 的新版 gateway。

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json'
```

成功标准：

- HTTP 状态为 `200`。
- JSON 中包含 `schema_version`、`exported_at`、`summary`、`samples`。
- JSON 中包含 `analytics_ready: true`。
- 不应包含完整 prompt、完整 answer 或 Authorization。
- `31` 天以内保持同步导出；`32` 天及以上应返回 `202` 并创建后台导出任务。
- 后台导出任务应按日期分段处理，UI 显示进度条和“可以继续正常使用 gateway”的提醒，完成后提供下载链接。

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=csv'
```

成功标准：

- HTTP 状态为 `200`。
- CSV 表头至少包含 `sample_id`、`gateway_request_id`、`request_kind`、`intercept_exempt_reason`、`request_reasoning_effort`、`reasoning_tokens`、`duration_total_ms`、`output_tps`、`commentary_observed`、`client_http_status`。

时间段观测示例：

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning?date_from=2026-06-29&date_to=2026-06-30'
```

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=2026-06-29&date_to=2026-06-30'
```

reasoning 特征分析示例：

```powershell
$body = @{
  filters = @{
    include_retries = $true
    include_blocked = $true
  }
  conditions = @{
    reasoning_tokens = @(516)
    final_answer_only = $true
    commentary_not_observed = $true
    time_normalization_deviation = 'high'
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/analyze'
```

成功标准：

- HTTP 状态为 `200`。
- JSON 中包含 `analysis_profile=516_candidate_review_v1`。
- JSON 中包含 `analysis_value`、`conclusion`、`field_coverage`、`candidate_summary`、`baseline_comparison`。
- 结论只表示候选复盘等级，不修改现有拦截规则。

落盘文件检查：

```powershell
Get-ChildItem (Join-Path $env:USERPROFILE '.codex-retry-gateway\analytics') -Filter 'reasoning-behavior-*.json'
```

成功标准：

- 重启并产生请求后，目录里出现 `reasoning-behavior-YYYY-MM-DD.json`。
- 文件内 `schema_version` 为 `2`。
- `samples` 中能看到模型、模型家族、`request_reasoning_effort`、token、耗时、TPS、状态、重试和拦截字段。

反例验证口径：

- 旧进程返回 HTML 或非 JSON 时，不能视为 analytics 已激活。
- 缺少 `schema_version` 或 analytics ready 信号时，只能视为部分可用，不能视为完整激活。
- 大时间段观测查询超过 `7` 天时，应返回 `degraded=true` 和 `degrade_reason=date_range_too_large`，不能全量深解析到卡死。
- JSON / CSV 导出超过 `31` 天时，不应阻塞 UI 或代理主链路；应返回 `202`、`background_export=true` 和 `export_job.job_id`，由前端轮询任务进度并在完成后下载。

后台导出任务检查示例：

```powershell
$job = Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=2026-01-01&date_to=2026-03-15'
$job.export_job
Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning/export/jobs/$($job.export_job.job_id)"
```

成功标准：

- 创建请求返回 HTTP `202`。
- `export_job.progress.total_days` 等于选择的本地日期天数。
- `processed_days` 会随后台处理推进，完成后 `status=completed`。
- 完成后 `download_url` 指向 `/api/analytics/reasoning/export/jobs/<job_id>/download`。
- 导出期间普通代理请求不需要等待该任务完成。

历史导入分析任务检查示例：

```powershell
$job = Invoke-RestMethod -Method Post -ContentType 'application/json' -Body '{}' -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/run'
$job.import_job
Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/jobs/$($job.import_job.job_id)"
Invoke-RestMethod -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/latest'
Invoke-RestMethod -Method Post -ContentType 'application/json' -Body (@{ job_id = $job.import_job.job_id } | ConvertTo-Json) -UseBasicParsing 'http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/imports/analyze'
```

成功标准：

- 创建请求返回 HTTP `202`。
- `import_job.progress.total_sources` 表示本次发现或指定的数据源数。
- 任务完成后 `status=completed`，`preflight.analysis_value` 为 `valuable`、`partial` 或 `no_analysis_value`。
- `feature_analysis` 中包含 `analysis_profile`、`analysis_value`、`conclusion`、`field_coverage`、`candidate_summary` 和 `baseline_comparison`。
- `no_analysis_value` 表示历史源缺核心字段，应放弃候选特征分析；此时可以保留轻量摘要，但不要求展示 CC Switch 模型深聚合。
- `valuable` 或 `partial` 时，`summary` 中包含请求量、token、日志行数、session 文件数等摘要，且仍不读取完整 prompt、完整 answer、Authorization 或 Cookie。
- 导入期间普通代理请求不需要等待该任务完成。

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
