# Guard Retry Attempts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增可动态配置的“网关内规则重试次数”，让命中拦截规则的响应先在网关内部重试，避免把本地规则拦截状态直接暴露给 Codex。

**Architecture:** 在现有单次代理请求链路外包一层按规则命中结果驱动的 upstream attempt 循环。流式 strict 缓冲与非流式处理函数在“命中且仍有内部重试额度”时返回内部 sentinel，`proxyRequest()` 重新请求上游；真实上游 HTTP 错误未命中规则时保持透传。

**Tech Stack:** Node.js ESM、原生 `fetch`、内嵌管理页 HTML/CSS/JS、现有 `scripts/test-gateway-e2e.mjs` E2E 测试。

---

## 关键假设

- 配置字段名为 `guard_retry_attempts`。
- `guard_retry_attempts = 0` 表示不做网关内部规则重试，保持旧行为。
- `guard_retry_attempts = N` 表示命中拦截规则后最多额外向上游发起 `N` 次请求。
- 内部重试只由“响应内容命中当前拦截规则且当前配置会实际拦截”触发。
- 上游真实 HTTP `429` / `502` 等状态码如果没有命中规则，继续原样透传给 Codex。
- `fetch failed` 属于没有拿到 HTTP 响应的连接/网络错误，本轮不改变既有轻量重试和上游错误处理。

## 文件结构

- Modify: `gateway.mjs`
  - 增加默认配置、配置归一化、管理页输入框、保存 payload。
  - 增加规则内部重试 sentinel 与 attempt 循环。
  - 调整代理请求统计为每次 upstream attempt 计入。
- Modify: `scripts/test-gateway-e2e.mjs`
  - 增加配置校验、UI 顺序、非流式/流式规则内部重试、真实上游错误透传、统计累计覆盖。
- Modify: `scripts/test-install-restore.mjs`
  - 增加管理页包含新字段、状态接口配置包含新字段的覆盖。
- Modify: `config.example.json`
  - 增加 `guard_retry_attempts` 示例值。
- Modify: `README.md`
  - 补充字段语义、动态生效、统计口径。
- Modify: `build.md`
  - 补充管理页热更新字段列表。
- Modify: `err.md`
  - 记录 Codex 遇到本地规则拦截状态会自动重连，本轮改为网关内规则重试的排错结论。

## Task 1: 写失败测试

**Files:**
- Modify: `scripts/test-gateway-e2e.mjs`
- Modify: `scripts/test-install-restore.mjs`

- [ ] **Step 1: 增加管理页字段测试**

在 UI 表单测试中加入：

```js
assert(html.includes('id="guardRetryAttemptsInput"'), "UI should include guard retry attempts input");
assert(html.includes("网关内重试次数"), "UI should label guard retry attempts");
assert(
  html.indexOf('name="non_stream_status_code"') < html.indexOf('name="guard_retry_attempts"') &&
    html.indexOf('name="guard_retry_attempts"') < html.indexOf('name="log_match"'),
  "guard retry attempts should be rendered between non_stream_status_code and log_match",
);
```

在 fake DOM refs 中加入 `guardRetryAttemptsInput`，断言 `fillForm()` 回填 `"3"`，`saveConfig()` payload 包含 `guard_retry_attempts: 3`。

- [ ] **Step 2: 增加配置 API 测试**

新增断言：

```js
await postJson(`${gatewayBase}/__codex_retry_gateway/api/config`, { guard_retry_attempts: 0 });
const zeroStatus = await getJson(`${gatewayBase}/__codex_retry_gateway/api/status`);
assert.equal(zeroStatus.config.guard_retry_attempts, 0);

const negative = await fetch(`${gatewayBase}/__codex_retry_gateway/api/config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ guard_retry_attempts: -1 }),
});
assert.equal(negative.status, 400);

const invalid = await fetch(`${gatewayBase}/__codex_retry_gateway/api/config`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ guard_retry_attempts: "abc" }),
});
assert.equal(invalid.status, 400);
```

- [ ] **Step 3: 增加非流式规则内部重试测试**

让假上游按 `test_reasoning_sequence: [516, 128]` 对同一个 sequence key 依次返回不同 `reasoning_tokens`。请求配置 `guard_retry_attempts: 1` 后断言：

```js
assert.equal(response.status, 200);
assert.equal(upstreamRequestCountForKey, 2);
assert.equal(metrics.total_proxy_request_count, previousTotal + 2);
assert.equal(metrics.inspected_response_count, previousInspected + 2);
assert.equal(metrics.matched_response_count, previousMatched + 1);
assert.equal(metrics.blocked_response_count, previousBlocked + 1);
assert.equal(metrics.matched_non_streaming_count, previousMatchedNonStreaming + 1);
assert.equal(metrics.blocked_non_streaming_count, previousBlockedNonStreaming + 1);
```

- [ ] **Step 4: 增加上游真实错误透传测试**

让假上游返回 `test_error_status: 429`，配置 `guard_retry_attempts: 2`，断言客户端拿到 `429` 且假上游只收到 1 次请求。

- [ ] **Step 5: 增加连续命中超过上限测试**

使用 `test_reasoning_sequence: [516, 516]` 与 `guard_retry_attempts: 1`，断言最终仍返回配置的 `non_stream_status_code`，并且两次 attempt 都计入代理请求、被检查响应、命中总数、实际拦截总数。

- [ ] **Step 6: 增加流式 strict 规则内部重试测试**

使用流式 `test_reasoning_sequence: [516, 128]` 与 `guard_retry_attempts: 1`，断言第一次 strict 缓冲命中后被吞掉并重试，最终客户端收到第二次的正常 SSE，假上游收到 2 次。

- [ ] **Step 7: 运行红灯测试**

Run:

```powershell
node .\scripts\test-gateway-e2e.mjs
```

Expected: FAIL，失败点应指向 `guard_retry_attempts` 字段不存在或规则内部重试行为未实现。

## Task 2: 实现配置与管理页

**Files:**
- Modify: `gateway.mjs`
- Modify: `config.example.json`

- [ ] **Step 1: 增加默认配置**

在 `DEFAULT_CONFIG` 增加：

```js
guard_retry_attempts: 3,
```

- [ ] **Step 2: 增加归一化函数**

新增：

```js
function normalizeGuardRetryAttempts(value) {
  const text = `${value ?? ""}`.trim();
  if (text === "") {
    throw new Error("guard_retry_attempts must be an integer greater than or equal to 0");
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== text || parsed < 0) {
    throw new Error("guard_retry_attempts must be an integer greater than or equal to 0");
  }
  return parsed;
}
```

- [ ] **Step 3: 接入加载与保存**

`loadConfig()` 合并默认值后归一化：

```js
config.guard_retry_attempts = normalizeGuardRetryAttempts(config.guard_retry_attempts);
```

`buildEditableConfig()` 在 payload 含 `guard_retry_attempts` 时归一化写入；payload 未包含时沿用当前值，保持现有部分更新 API 风格。

- [ ] **Step 4: 管理页插入新字段**

在 `non_stream_status_code` 与 `log_match` 之间插入：

```html
<div class="field">
  <label for="guardRetryAttemptsInput">网关内重试次数</label>
  <input id="guardRetryAttemptsInput" name="guard_retry_attempts" type="number" min="0" step="1" required />
  <div class="hint">仅对命中拦截规则的响应生效；上游 429/502 等真实错误会直接透传。</div>
</div>
```

JS refs / `fillForm()` / `saveConfig()` 同步使用 `guardRetryAttemptsInput`。

- [ ] **Step 5: 更新示例配置**

`config.example.json` 增加：

```json
"guard_retry_attempts": 3
```

## Task 3: 实现规则内部重试

**Files:**
- Modify: `gateway.mjs`

- [ ] **Step 1: 定义内部 sentinel**

新增：

```js
class GuardBlockedRetrySignal extends Error {
  constructor({ streamKind }) {
    super("guard response blocked for internal retry");
    this.name = "GuardBlockedRetrySignal";
    this.streamKind = streamKind;
  }
}
```

- [ ] **Step 2: 非流式命中时返回重试信号**

在 `handleNonStreaming()` 命中且 `config.intercept_non_streaming` 为 true 时：

```js
recordBlockedResponse("non_streaming");
finalizeModelInsights(...);
if (context.guardRetryRemaining > 0) {
  return { guardRetry: true };
}
res.writeHead(config.non_stream_status_code, ...);
res.end(blockedBody);
return { handled: true };
```

命中但 observe-only 时仍透传，不触发内部重试。

- [ ] **Step 3: 流式 strict 命中时返回重试信号**

在 `handleStreaming()` strict 缓冲命中且 `config.intercept_streaming` 为 true 时：

```js
recordBlockedResponse("streaming");
finalizeModelInsights(...);
if (context.guardRetryRemaining > 0) {
  return { guardRetry: true };
}
res.writeHead(config.non_stream_status_code, ...);
res.end(blockedBody);
return { handled: true };
```

非 strict 或 observe-only 行为保持现状。

- [ ] **Step 4: `proxyRequest()` 包裹 attempt 循环**

读取客户端 body 一次后：

```js
let guardAttemptsUsed = 0;
while (true) {
  recordProxyAttemptStart(pathname);
  try {
    const upstreamResponse = await fetchUpstreamWithRetry(...);
    const result = await dispatchHandler(..., {
      guardRetryRemaining: Math.max(0, config.guard_retry_attempts - guardAttemptsUsed),
    });
    if (result?.guardRetry && guardAttemptsUsed < config.guard_retry_attempts) {
      guardAttemptsUsed += 1;
      continue;
    }
    return;
  } finally {
    recordProxyAttemptEnd(pathname);
  }
}
```

每次 attempt 都要增加 `total_proxy_request_count`，并在 finally 结束 active 统计。

- [ ] **Step 5: 保持上游错误透传**

只在 handler 明确返回 `guardRetry` 时循环。`fetchUpstreamWithRetry()` 拿到的 HTTP `429` / `502` 继续作为 `Response` 进入 handler；未命中规则时由现有透传逻辑返回客户端。

## Task 4: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `build.md`
- Modify: `err.md`

- [ ] **Step 1: README 增加配置说明**

增加：

```markdown
- `guard_retry_attempts`：命中当前拦截规则后，网关内部额外重试上游的次数；`0` 表示不重试，无上限，管理页可热更新。
```

并说明上游真实错误透传、内部重试统计会累计到代理请求总数 / 被检查响应总数 / 当前规则命中总数 / 实际拦截总数。

- [ ] **Step 2: build.md 增加管理页字段**

把热更新字段列表补成包含 `guard_retry_attempts`。

- [ ] **Step 3: err.md 增加排错条目**

记录：Codex 对 `409` / `422` / 本地 `502` 都会自动重连，命中规则不能继续暴露失败状态；采用网关内部规则重试，只对命中规则生效，真实上游错误继续透传。

## Task 5: 验证

**Files:**
- Verify only

- [ ] **Step 1: 语法检查**

Run:

```powershell
node --check .\gateway.mjs
```

Expected: exit 0。

- [ ] **Step 2: E2E 回归**

Run:

```powershell
node .\scripts\test-gateway-e2e.mjs
```

Expected: exit 0。

- [ ] **Step 3: 安装恢复回归**

Run:

```powershell
node .\scripts\test-install-restore.mjs
```

Expected: exit 0。

- [ ] **Step 4: diff 空白检查**

Run:

```powershell
git diff --check
```

Expected: exit 0。

- [ ] **Step 5: 工作区检查**

Run:

```powershell
git status --short --branch
```

Expected: 只显示本轮计划内文件变更。

## 自检

- 规格覆盖：配置、UI 位置、必填最小值、无上限、真实上游错误透传、规则命中内部重试、统计累计、文档和验证均有任务覆盖。
- 占位扫描：无 `TBD` / `TODO` / “稍后实现”类占位。
- 类型一致：全计划统一使用 `guard_retry_attempts`，语义统一为“额外内部重试次数”。
