# err.md

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
