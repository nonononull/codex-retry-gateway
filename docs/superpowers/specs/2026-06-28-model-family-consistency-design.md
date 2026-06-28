# codex-retry-gateway 模型家族一致性检测设计

日期：2026-06-28

状态：已获主线程方向确认，待规格审阅

## 1. 背景

当前 `codex-retry-gateway` 已能：

- 接管 Codex 到本地网关的流量
- 统计 `reasoning_tokens = 516` 命中情况
- 在 UI 中展示代理请求、命中次数、日志和基础配置

牢大的新需求不是“展示一个模型名”这么简单，而是：

- 本地配置是 `gpt-5.4` 时，要验证链路表现是否符合 `gpt-5.4` 家族特征
- 本地配置是 `gpt-5.5` 时，要验证链路表现是否符合 `gpt-5.5` 家族特征
- 页面要展示占比与异常信号
- 不能把上游自报模型名直接当成铁证，避免被上游“掺水”误导

## 2. 当前已知事实

基于当前官方文档，`gpt-5.4` 与 `gpt-5.5` 共享以下特征：

- 上下文窗口：`1M`
- 最大输出：`128K`
- 支持流式

这意味着：

- `400K` 上下文型失败可以说明“疑似不是 `1M` 家族”
- 但单靠上下文窗口行为，不能稳定区分 `gpt-5.4` 和 `gpt-5.5`
- 要区分 `gpt-5.4` 和 `gpt-5.5`，第一期主要依赖“声明一致性”

## 3. 目标

第一期只支持以下期望家族：

- `gpt-5.4`
- `gpt-5.5`

第一期要解决的问题：

1. 识别本地期望模型家族
2. 识别上游声明模型家族
3. 识别流式返回中的模型声明
4. 识别同一请求内是否发生模型漂移或疑似重建
5. 判断“声明是否一致”
6. 判断“行为上是否仍像 1M 家族”
7. 在 UI 中清楚展示占比、可疑样本和可信度

## 4. 非目标

第一期明确不做：

- 不承诺“证明上游真实运行的底层模型”
- 不主动发探针请求做压测或模型鉴定
- 不扩展到所有模型家族
- 不把任何单一弱信号描述成“已确认掺水”
- 不把“单请求内发生漂移”直接表述为“已确认缓存重建”

## 5. 术语

### 5.1 本地配置模型

从 Codex 当前配置 `config.toml` 的顶层 `model` 读取，例如：

- `gpt-5.4`
- `gpt-5.5`

它表示“本地当前希望使用什么模型”。

### 5.2 本地请求模型

从实际转发请求体中的 `model` 字段读取。

它表示“这一笔请求实际声明要什么模型”。

### 5.3 上游声明模型

从上游非流式响应体或流式事件中提取到的 `model` 字段。

它表示“上游声称自己返回了什么模型”。

### 5.4 有效本地期望模型

优先级如下：

1. 本地请求模型
2. 本地配置模型
3. `unknown`

后续所有一致性判断都基于“有效本地期望模型”。

## 6. 模型家族归一化规则

新增 `normalizeModelFamily(modelName)`：

- `gpt-5.4`
- `gpt-5.4-<snapshot>`
  - 归一为 `gpt-5.4`
- `gpt-5.5`
- `gpt-5.5-<snapshot>`
  - 归一为 `gpt-5.5`
- 包含 `mini`
  - 归一为 `mini`
- 包含 `nano`
  - 归一为 `nano`
- 其他未知值
  - 归一为 `other`
- 缺失
  - 归一为 `unknown`

第一期只有当“有效本地期望模型家族”为 `gpt-5.4` 或 `gpt-5.5` 时，才进入这套检测。

## 7. 证据模型

第一期把证据分为三层：

### 7.1 声明证据

来源：

- 本地配置模型
- 本地请求模型
- 上游非流式响应模型
- 上游流式事件模型

用途：

- 判断本地期望与上游声明是否一致

### 7.2 流式证据

来源：

- Chat Completions SSE chunk 顶层 `model`
- Chat Completions SSE chunk 顶层 `system_fingerprint`
- Responses SSE 事件里可观测到的 `model` 或 `response.model`

用途：

- 在流式场景下补足“完整响应模型可能拿不到”的问题
- 如果流式路径能看到模型声明，就单独展示“流式声明占比”

说明：

- 如果某类流式事件没有 `model`，视为“未观测到”，不是错误
- UI 必须明确显示“无声明”而不是乱猜

### 7.3 行为证据

来源：

- 上游返回的错误状态和错误文本
- 超限提示中的数字特征

第一期只做一类行为异常：

- `400K` 家族异常

命中条件示例：

- 错误文本含 `400000`
- 错误文本含 `400k`
- 错误文本含 `context_length_exceeded`
- 本地期望为 `gpt-5.4` 或 `gpt-5.5`，却出现明显像 `400K` 上下文限制的失败

这类异常只说明：

- 行为上不像 `1M` 家族

它不能单独证明：

- 一定是 `gpt-5.4-mini`
- 一定不是别的中间层限制

### 7.4 单请求漂移证据

来源：

- 同一请求生命周期内观测到的多个 `model`
- 同一请求生命周期内观测到的多个 `system_fingerprint`
- 同一请求生命周期内观测到的多个响应身份或结束声明

用途：

- 识别“跑到一半切模”
- 识别“疑似请求内重建/重试”

说明：

- 如果同一请求先后观测到多个不同模型家族，属于高风险漂移
- 如果同一请求模型未变，但 `system_fingerprint` 明显漂移，属于高风险
- 这类信号可以支持“疑似请求内重建/重试”的推断
- 但不能直接证明 provider 内部发生了缓存重建

## 8. 判定规则

### 8.1 通过

满足全部条件：

- 有效本地期望模型家族是 `gpt-5.4` 或 `gpt-5.5`
- 上游声明模型家族与本地期望一致，或上游声明缺失
- 未出现 `400K` 家族异常

### 8.2 高风险声明不一致

满足任一条件：

- 本地期望是 `gpt-5.4`，上游声明是 `gpt-5.5`
- 本地期望是 `gpt-5.5`，上游声明是 `gpt-5.4`
- 本地期望是 `gpt-5.4` 或 `gpt-5.5`，上游声明是 `mini`
- 本地期望是 `gpt-5.4` 或 `gpt-5.5`，上游声明是 `nano`
- 本地期望是 `gpt-5.4` 或 `gpt-5.5`，上游声明是 `other`

### 8.3 中高风险行为异常

满足全部条件：

- 本地期望是 `gpt-5.4` 或 `gpt-5.5`
- 上游声明缺失，或上游声明与本地一致
- 出现 `400K` 家族异常

UI 文案不写“确认掺水”，而写：

- `疑似低上下文家族行为`

### 8.4 证据不足

满足全部条件：

- 本地期望模型未知，或不属于 `gpt-5.4` / `gpt-5.5`
- 上游声明也拿不到
- 没有行为异常

UI 文案写：

- `证据不足`

### 8.5 单请求高风险模型漂移

满足任一条件：

- 同一请求内先后观测到 `gpt-5.4` 与 `gpt-5.5`
- 同一请求内先后观测到 `gpt-5.4` / `gpt-5.5` 与 `mini`
- 同一请求内先后观测到 `gpt-5.4` / `gpt-5.5` 与 `nano`

UI 文案写：

- `单请求模型漂移`

### 8.6 单请求高风险疑似重建/重试

满足任一条件：

- 同一请求内模型家族未变，但观测到多个 `system_fingerprint`
- 同一请求内结束阶段声明与前序流式声明不一致
- 同一请求内观测到多个互相矛盾的响应身份信号

UI 文案写：

- `疑似请求内重建/重试`

说明：

- 该结论是基于响应信号推断
- UI 必须明确写出“无法直接确认缓存重建”

## 9. 数据结构设计

在现有 `monitor` 上新增以下结构：

```js
{
  local_model_counts: {},
  upstream_model_counts: {},
  stream_model_counts: {},
  model_consistency: {
    total_checked: 0,
    matched: 0,
    mismatched: 0,
    unknown: 0
  },
  model_family_anomalies: {
    low_context_family_count: 0
  },
  single_request_anomalies: {
    model_drift_count: 0,
    fingerprint_drift_count: 0,
    rebuild_suspected_count: 0
  },
  suspicious_model_samples: [
    {
      ts,
      path,
      local_config_model,
      local_request_model,
      effective_local_model,
      upstream_model,
      stream_model,
      first_observed_model,
      last_observed_model,
      observed_models,
      observed_model_families,
      system_fingerprint,
      observed_fingerprints,
      service_tier,
      anomaly_type,
      confidence
    }
  ]
}
```

保留样本数量建议：

- 最近 `50` 条

## 10. 采集点设计

### 10.1 本地配置模型

新增一个轻量解析函数，从 `state.codex_config_path` 对应的 `config.toml` 读取当前顶层 `model`。

更新策略：

- 网关启动时读取一次
- 每次状态接口返回时可按需刷新
- 每次代理请求开始时，如果缓存为空则补读

### 10.2 本地请求模型

在 `proxyRequest()` 中解析请求 JSON 后读取：

- `requestJson?.model`

### 10.3 非流式上游模型

在 `handleNonStreaming()` 中：

- 解析完整响应 JSON
- 提取 `model`
- 提取 `service_tier`
- 提取 `system_fingerprint`

### 10.4 流式上游模型

在 `handleStreaming()` 中：

- 复用现有 SSE 解析
- 每个事件 JSON 块里尝试提取：
  - 顶层 `model`
  - 顶层 `system_fingerprint`
  - 顶层 `service_tier`
  - 嵌套 `response.model`

如果流式过程中观测到模型声明：

- 更新 `stream_model_counts`
- 记录最近一次声明到本次响应上下文

同时为当前请求维护运行期上下文：

- `observedModels`
- `observedModelFamilies`
- `observedFingerprints`
- `firstObservedModel`
- `lastObservedModel`
- `finalResponseModel`

在请求结束时统一做一次单请求漂移判定。

### 10.5 行为异常

在统一错误处理和正常返回错误体解析中检测：

- HTTP `4xx/5xx`
- 响应 JSON 文本
- 错误 message / code / param

如果出现 `400K` 上下文型特征：

- 计入 `low_context_family_count`
- 记录一条可疑样本

### 10.6 单请求漂移判定

每笔请求结束时执行：

1. 归一化本请求内所有观测到的模型家族
2. 如果家族集合大小大于 `1`
   - 计入 `model_drift_count`
   - 记录 `单请求模型漂移`
3. 如果家族集合大小等于 `1`，但 `fingerprint` 集合大小大于 `1`
   - 计入 `fingerprint_drift_count`
   - 记录 `疑似请求内重建/重试`
4. 如果流式阶段与结束阶段的模型声明不一致
   - 计入 `rebuild_suspected_count`
   - 记录 `疑似请求内重建/重试`

证据保留要求：

- 每条可疑样本必须保留本请求观测到的模型集合与指纹集合
- 便于 UI 和后续排障直接回看

## 11. UI 设计

在现有管理页新增一块“模型家族一致性”面板。

### 11.1 概览卡片

- 当前本地配置模型
- 当前本地配置模型家族
- 声明一致率
- 高风险声明不一致次数
- `400K` 家族异常次数
- 单请求模型漂移次数
- 疑似请求内重建/重试次数

### 11.2 占比卡片

- 本地请求模型占比
- 上游声明模型占比
- 流式声明模型占比

说明：

- 如果某项没有观测值，显示 `暂无数据`

### 11.3 可疑样本表

列：

- 时间
- 路径
- 本地期望模型
- 上游声明模型
- 流式声明模型
- 首个观测模型
- 最后观测模型
- 观测到的模型集合
- `fingerprint`
- 观测到的 `fingerprint` 集合
- 异常类型
- 可信度

### 11.4 风险说明文案

固定文案必须存在：

- `本地模型` 表示本机配置或请求声明
- `上游模型` 表示上游自报
- `声明一致` 不等于已证明真实运行一致
- `400K 家族异常` 只表示行为上疑似不符合 1M 家族
- `单请求模型漂移` 表示同一请求生命周期内观测到多个模型家族
- `疑似请求内重建/重试` 仅基于响应信号推断，不能直接确认缓存重建

## 12. API 设计

扩展 `GET /__codex_retry_gateway/api/status` 返回：

```json
{
  "model_insights": {
    "local_config_model": "gpt-5.5",
    "local_config_family": "gpt-5.5",
    "local_model_counts": {},
    "upstream_model_counts": {},
    "stream_model_counts": {},
    "consistency": {
      "total_checked": 0,
      "matched": 0,
      "mismatched": 0,
      "unknown": 0,
      "match_ratio": 0
    },
    "anomalies": {
      "low_context_family_count": 0
    },
    "single_request_anomalies": {
      "model_drift_count": 0,
      "fingerprint_drift_count": 0,
      "rebuild_suspected_count": 0
    },
    "suspicious_samples": []
  }
}
```

## 13. 测试设计

新增或扩展 E2E：

1. 本地请求 `gpt-5.4`，上游返回 `gpt-5.4`
   - 应计为一致

2. 本地请求 `gpt-5.5`，上游返回 `gpt-5.5`
   - 应计为一致

3. 本地请求 `gpt-5.4`，上游返回 `gpt-5.4-mini`
   - 应计为高风险声明不一致

4. 本地请求 `gpt-5.5`，流式 chunk 返回 `gpt-5.4-mini`
   - 应计为高风险声明不一致

5. 本地请求 `gpt-5.4`，响应返回 `context_length_exceeded` 且错误文本含 `400000`
   - 应计为 `400K` 家族异常

6. 响应无 `model`
   - 不应误记为声明不一致
   - 应计为 `unknown`

7. snapshot 名称
   - `gpt-5.4-2026-03-05` 归一为 `gpt-5.4`
   - `gpt-5.5-2026-03-05` 归一为 `gpt-5.5`

8. 同一请求流式阶段先返回 `gpt-5.5`，后续又返回 `gpt-5.4-mini`
   - 应计为 `单请求模型漂移`

9. 同一请求模型不变，但出现多个 `system_fingerprint`
   - 应计为 `疑似请求内重建/重试`

## 14. 本地验证计划

实现后按下面顺序验证：

1. `node scripts/test-gateway-e2e.mjs`
2. 启动本地运行目录网关
3. 用本地 Codex 当前真实路由跑至少一轮正常请求
4. 打开 UI 检查：
   - 模型卡片是否出现
   - 占比是否增长
   - 文案是否没有夸大
5. 如果 UI 和统计口径符合预期，再同步到 GitHub

## 15. 风险与边界

- 上游如果同时伪造“模型声明”和“行为”，第一期无法绝对证明掺水
- `gpt-5.4` 与 `gpt-5.5` 的官方窗口同属 `1M` 家族，第一期行为检测不能稳定区分二者
- Responses 流式是否总能拿到 `model` 字段，取决于上游事件形态；因此必须允许“流式无声明”
- 单请求漂移只能证明“观测信号发生变化”，不能直接证明 provider 内部缓存命中或缓存重建

## 16. 推荐实现路径

采用“声明一致性 + 1M 家族行为校验”的最小可行方案：

1. 先补 monitor 数据结构和归一化函数
2. 再补非流式和流式采集
3. 再补状态接口
4. 最后补 UI 和 E2E

这个顺序的好处是：

- 每一步都能单独验证
- UI 只消费已经稳定的状态接口
- 不会把“展示层需求”反向绑死核心判断逻辑
