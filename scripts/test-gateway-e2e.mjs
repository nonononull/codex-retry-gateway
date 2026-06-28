#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const gatewayRoot = path.resolve(import.meta.dirname, "..");
const gatewayEntry = path.join(gatewayRoot, "gateway.mjs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getFreePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : null;
  server.close();
  await once(server, "close");
  if (!port) {
    throw new Error("无法分配空闲端口");
  }
  return port;
}

function createJsonResponse(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function createSseResponse(res, chunks, intervalMs = 20) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse",
  });

  let index = 0;
  const timer = setInterval(() => {
    if (index >= chunks.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    res.write(chunks[index]);
    index += 1;
  }, intervalMs);

  res.on("close", () => {
    clearInterval(timer);
  });
}

function createTerminatedSseResponse(res, chunks, destroyDelayMs = 20) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-upstream-test": "sse-terminated",
  });

  for (const chunk of chunks) {
    res.write(chunk);
  }

  setTimeout(() => {
    res.socket?.destroy();
  }, destroyDelayMs);
}

function buildResponsePayload(parsed, reasoning, retryAttempt = 0) {
  return {
    id: parsed.test_response_id ?? "resp_test",
    model: parsed.test_response_model ?? parsed.model ?? "gpt-5.4",
    system_fingerprint: parsed.test_system_fingerprint ?? "fp_static",
    service_tier: parsed.test_service_tier ?? "priority",
    retry_attempt: retryAttempt,
    usage: {
      output_tokens_details: {
        reasoning_tokens: reasoning,
      },
    },
  };
}

function buildStreamModels(parsed) {
  if (Array.isArray(parsed.test_stream_models) && parsed.test_stream_models.length > 0) {
    return parsed.test_stream_models;
  }
  return [parsed.test_response_model ?? parsed.model ?? "gpt-5.4"];
}

function buildStreamFingerprints(parsed, count) {
  if (Array.isArray(parsed.test_stream_fingerprints) && parsed.test_stream_fingerprints.length > 0) {
    return parsed.test_stream_fingerprints;
  }
  return Array.from({ length: count }, (_, index) => `fp_stream_${index + 1}`);
}

function buildResponseIds(parsed, count) {
  if (Array.isArray(parsed.test_response_ids) && parsed.test_response_ids.length > 0) {
    return parsed.test_response_ids;
  }
  return Array.from({ length: count }, (_, index) => `resp_stream_${index + 1}`);
}

function buildStreamEventIds(parsed, count) {
  if (Array.isArray(parsed.test_stream_event_ids) && parsed.test_stream_event_ids.length > 0) {
    return parsed.test_stream_event_ids;
  }
  return Array.from({ length: count }, () => null);
}

function buildResponsesStreamChunks(parsed, reasoning) {
  const models = buildStreamModels(parsed);
  const fingerprints = buildStreamFingerprints(parsed, models.length);
  const responseIds = buildResponseIds(parsed, models.length);
  const eventIds = buildStreamEventIds(parsed, models.length);
  const finalModel = parsed.test_stream_final_model ?? models[models.length - 1];
  const finalFingerprint = fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_stream_1";
  const finalResponseId = responseIds[responseIds.length - 1] ?? responseIds[0] ?? "resp_stream_1";
  const serviceTier = parsed.test_service_tier ?? "priority";
  const chunks = ['data: {"type":"response.output_text.delta","delta":"hello"}\n\n'];

  models.forEach((model, index) => {
    const deltaPayload = {
      type: "response.model.delta",
      model,
      system_fingerprint: fingerprints[index] ?? finalFingerprint,
      service_tier: serviceTier,
      response: {
        model,
      },
    };
    if (!parsed.test_stream_delta_omit_response_id) {
      deltaPayload.response.id = responseIds[index] ?? finalResponseId;
    }
    if (eventIds[index]) {
      deltaPayload.id = eventIds[index];
    }
    chunks.push(
      `data: ${JSON.stringify(deltaPayload)}\n\n`,
    );
  });

  chunks.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      system_fingerprint: finalFingerprint,
      service_tier: serviceTier,
      response: {
        id: finalResponseId,
        model: finalModel,
        usage: {
          output_tokens_details: {
            reasoning_tokens: reasoning,
          },
        },
      },
    })}\n\n`,
  );
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function buildChatCompletionStreamChunks(parsed, reasoning) {
  const models = buildStreamModels(parsed);
  const fingerprints = buildStreamFingerprints(parsed, models.length);
  const finalModel = parsed.test_stream_final_model ?? models[models.length - 1];
  const finalFingerprint = fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_chat_1";
  const chunks = [
    `data: ${JSON.stringify({
      id: "chunk-1",
      model: models[0],
      system_fingerprint: fingerprints[0] ?? finalFingerprint,
      choices: [{ delta: { content: "hello" } }],
    })}\n\n`,
  ];

  for (let index = 1; index < models.length; index += 1) {
    chunks.push(
      `data: ${JSON.stringify({
        id: `chunk-${index + 1}`,
        model: models[index],
        system_fingerprint: fingerprints[index] ?? finalFingerprint,
        choices: [{ delta: { content: " world" } }],
      })}\n\n`,
    );
  }

  chunks.push(
    `data: ${JSON.stringify({
      model: finalModel,
      system_fingerprint: finalFingerprint,
      usage: {
        completion_tokens_details: {
          reasoning_tokens: reasoning,
        },
      },
    })}\n\n`,
  );
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function decodeHtmlEntities(value) {
  return String(value)
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = new Map();
    this.classList = { contains: () => false };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(handler);
  }

  emit(type, event) {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      handler(event);
    }
  }

  querySelectorAll(selector) {
    if (selector !== '.evidence-details[data-sample-key][open]') {
      return [];
    }
    const regex = /<details class="evidence-details" data-sample-key="([^"]+)" open>/g;
    const results = [];
    let current;
    while ((current = regex.exec(this.innerHTML)) !== null) {
      const sampleKey = decodeHtmlEntities(current[1]);
      results.push({
        getAttribute(name) {
          return name === "data-sample-key" ? sampleKey : null;
        },
      });
    }
    return results;
  }
}

async function verifyRenderedUiEvidenceDetailsBehavior(uiHtml) {
  const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
  assert(inlineScriptMatch, "管理页缺少内联脚本");

  const ids = [
    "configForm",
    "reasoningInput",
    "endpointsInput",
    "statusCodeInput",
    "logMatchInput",
    "saveButton",
    "restoreButton",
    "messageBox",
    "listenValue",
    "upstreamValue",
    "providerValue",
    "codexBaseUrlValue",
    "configPathValue",
    "backupPathValue",
    "startedAtValue",
    "proxyRequestCountValue",
    "inspectedCountValue",
    "reasoning516CountValue",
    "reasoning516RatioValue",
    "matchedCountValue",
    "modelMatchRatioValue",
    "modelMismatchCountValue",
    "lowContextFamilyCountValue",
    "modelDriftCountValue",
    "fingerprintDriftCountValue",
    "rebuildSuspectedCountValue",
    "suspiciousSamplesBody",
    "statsFootnote",
    "logsMeta",
    "logsOutput",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id === "configForm" ? "form" : "div")]),
  );
  elements.statusCodeInput.value = "502";

  const statusPayload = {
    listen: "http://127.0.0.1:4610",
    config: {
      upstream_base_url: "http://upstream.example",
      reasoning_equals: [516],
      endpoints: ["/responses"],
      non_stream_status_code: 502,
      log_match: true,
    },
    state: {
      provider_name: "test",
      codex_current_base_url: "http://127.0.0.1:4610",
      latest_backup_path: "backup.json",
    },
    paths: {
      config_path: "config.json",
    },
    metrics: {
      started_at: "2026-06-28T00:00:00.000Z",
      total_proxy_request_count: 0,
      inspected_response_count: 0,
      bypassed_proxy_request_count: 2,
      bypassed_proxy_path_counts: {
        "/v1/models": 2,
      },
      failed_proxy_request_count: 0,
      active_proxy_request_count: 0,
      active_proxy_path_counts: {},
      reasoning_516_count: 0,
      reasoning_516_ratio: 0,
      matched_response_count: 0,
    },
    model_insights: {
      consistency: { match_ratio: 0, mismatched: 0 },
      anomalies: { low_context_family_count: 0 },
      single_request_anomalies: {
        model_drift_count: 0,
        fingerprint_drift_count: 0,
        rebuild_suspected_count: 0,
      },
      suspicious_samples: [],
    },
  };
  const logsPayload = {
    total_entries: 1,
    latest_seq: 1,
    entries: [
      {
        seq: 1,
        at: "2026-06-28T03:18:23.000Z",
        message: "demo log",
      },
    ],
  };
  const fetchCalls = [];

  const fetchMock = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes("/api/status")) {
      return {
        ok: true,
        async json() {
          return statusPayload;
        },
      };
    }
    if (String(url).includes("/api/logs")) {
      return {
        ok: true,
        async json() {
          return logsPayload;
        },
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const sandbox = {
    console,
    URL,
    Date,
    Number,
    String,
    JSON,
    Promise,
    Set,
    Map,
    window: {
      location: { origin: "http://127.0.0.1:4610" },
      clearInterval() {},
      setInterval() {
        return 1;
      },
      setTimeout() {
        return 1;
      },
      confirm() {
        return true;
      },
    },
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
    },
    fetch: fetchMock,
  };
  sandbox.window.fetch = fetchMock;
  sandbox.window.document = sandbox.document;
  sandbox.window.window = sandbox.window;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  new vm.Script(inlineScriptMatch[1]).runInContext(sandbox);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert(typeof sandbox.renderSuspiciousSamples === "function", "管理页未暴露 renderSuspiciousSamples");
  assert(typeof sandbox.buildSampleKey === "function", "管理页未暴露 buildSampleKey");
  const expectedLogLine = `${new Date("2026-06-28T03:18:23.000Z").toLocaleString("zh-CN", { hour12: false })} demo log`;
  assert(
    elements.logsOutput.textContent.includes(expectedLogLine),
    "实时日志应显示与系统时间一致的本地时间",
  );
  assert(
    !elements.logsOutput.textContent.includes("2026-06-28T03:18:23.000Z demo log"),
    "实时日志不应直接显示原始 UTC 时间串",
  );
  assert(
    elements.statsFootnote.textContent.includes("/v1/models"),
    "运行状态脚注应提示未纳入检查的透传路径",
  );
  new vm.Script(`
    lastLogSeq = 999;
    document.getElementById("logsOutput").textContent = "2026-06-28T00:00:00.000Z stale old log";
  `).runInContext(sandbox);
  statusPayload.metrics.started_at = "2026-06-28T04:18:23.000Z";
  logsPayload.total_entries = 1;
  logsPayload.latest_seq = 1;
  logsPayload.entries = [
    {
      seq: 1,
      at: "2026-06-28T04:18:23.000Z",
      message: "fresh restarted log",
    },
  ];
  fetchCalls.length = 0;
  await sandbox.refreshLiveData();
  const expectedRestartLogLine = `${new Date("2026-06-28T04:18:23.000Z").toLocaleString("zh-CN", { hour12: false })} fresh restarted log`;
  assert(
    elements.logsOutput.textContent.includes(expectedRestartLogLine),
    "网关重启后实时日志应重新全量加载并显示本地时间",
  );
  assert(
    !elements.logsOutput.textContent.includes("stale old log"),
    "网关重启后不应继续保留上一次会话的旧日志",
  );
  assert(
    fetchCalls.some((url) => url.includes("/api/logs") && !url.includes("since_seq=")),
    "检测到网关重启后应全量重拉日志，而不是继续走增量日志",
  );

  const sample = {
    ts: "2026-06-28T03:18:23.000Z",
    path: "/responses",
    effective_local_model: "gpt-5.4",
    upstream_model: "-",
    stream_model: "gpt-5.4",
    first_observed_model: "gpt-5.4",
    last_observed_model: "gpt-5.4",
    observed_models: ["gpt-5.4"],
    observed_fingerprints: ["fp_demo"],
    anomaly_type: "single_request_rebuild_suspected",
    confidence: "high",
    evidence_logs: [
      {
        seq: 1,
        at: "2026-06-28T03:18:23.000Z",
        message: "[match] stream path=/responses reasoning_tokens=516 action=strict_502",
      },
      {
        seq: 2,
        at: "2026-06-28T03:18:23.100Z",
        message: "[sample] path=/responses anomaly=single_request_rebuild_suspected confidence=high",
      },
    ],
  };

  sandbox.renderSuspiciousSamples([sample]);
  const sampleKey = sandbox.buildSampleKey(sample);
  elements.suspiciousSamplesBody.emit("toggle", {
    target: {
      tagName: "DETAILS",
      classList: {
        contains(value) {
          return value === "evidence-details";
        },
      },
      getAttribute(name) {
        return name === "data-sample-key" ? sampleKey : null;
      },
      open: true,
    },
  });

  const before = elements.suspiciousSamplesBody.innerHTML;
  sandbox.renderSuspiciousSamples([sample]);
  const afterSame = elements.suspiciousSamplesBody.innerHTML;
  assert(before === afterSame, "最近可疑样本未变化时不应重绘日志证据 DOM");

  const changedSample = {
    ...sample,
    evidence_logs: [
      ...sample.evidence_logs,
      {
        seq: 3,
        at: "2026-06-28T03:18:23.200Z",
        message: "#3 appended",
      },
    ],
  };
  sandbox.renderSuspiciousSamples([changedSample]);
  const afterChanged = elements.suspiciousSamplesBody.innerHTML;
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(afterChanged),
    "最近可疑样本刷新后已展开的日志证据不应自动收起",
  );
}

function startFakeUpstream(port) {
  const failBeforeResponseCounts = new Map();
  const server = http.createServer((req, res) => {
    const responsePaths = new Set(["/responses", "/v1/responses"]);
    const chatCompletionPaths = new Set(["/chat/completions", "/v1/chat/completions"]);

    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      if (req.url.includes("test_fail_before_response=1")) {
        res.socket?.destroy();
        return;
      }
      createJsonResponse(
        res,
        200,
        {
          object: "list",
          data: [{ id: "fake-model" }],
        },
        { "x-upstream-test": "models-ok" },
      );
      return;
    }

    if (req.method === "POST" && responsePaths.has(req.url)) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const reasoning = parsed.test_reasoning_tokens ?? 128;
        if (parsed.test_fail_before_response_once) {
          const failKey = `${req.url}:fail-before-response-once`;
          const failCount = (failBeforeResponseCounts.get(failKey) || 0) + 1;
          failBeforeResponseCounts.set(failKey, failCount);
          if (failCount === 1) {
            res.socket?.destroy();
            return;
          }
        }
        if (parsed.test_error_payload) {
          createJsonResponse(
            res,
            parsed.test_error_status ?? 400,
            parsed.test_error_payload,
            { "x-upstream-test": "responses-error" },
          );
          return;
        }
        const finishJsonResponse = () => {
          const retryAttempt = parsed.test_fail_before_response_once
            ? failBeforeResponseCounts.get(`${req.url}:fail-before-response-once`) || 0
            : 0;
          createJsonResponse(
            res,
            200,
            buildResponsePayload(parsed, reasoning, retryAttempt),
            { "x-upstream-test": `responses-${reasoning}` },
          );
        };
        if (parsed.test_force_terminate) {
          createTerminatedSseResponse(res, [
            'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
          ]);
          return;
        }
        if (parsed.stream) {
          createSseResponse(
            res,
            buildResponsesStreamChunks(parsed, reasoning),
            parsed.test_stream_chunk_delay_ms ?? 20,
          );
          return;
        }
        if (parsed.test_response_delay_ms) {
          setTimeout(finishJsonResponse, parsed.test_response_delay_ms);
          return;
        }
        finishJsonResponse();
      });
      return;
    }

    if (req.method === "POST" && chatCompletionPaths.has(req.url)) {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const reasoning = parsed.test_reasoning_tokens ?? 128;
        if (reasoning === 516) {
          createSseResponse(
            res,
            buildChatCompletionStreamChunks(parsed, 516),
            parsed.test_stream_chunk_delay_ms ?? 20,
          );
          return;
        }

        createSseResponse(
          res,
          buildChatCompletionStreamChunks(parsed, 128),
          parsed.test_stream_chunk_delay_ms ?? 20,
        );
      });
      return;
    }

    createJsonResponse(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function waitForHealth(url, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore startup race
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待网关健康检查超时: ${url}`);
}

function startGateway(configPath, logPath) {
  const child = spawn(process.execPath, [gatewayEntry, "--config", configPath, "--log", logPath], {
    cwd: gatewayRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return {
    child,
    getOutput() {
      return { stdout, stderr };
    },
  };
}

async function readSseUntilClose(url, requestBody) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf8");
  let text = "";
  let closedByError = false;

  while (true) {
    try {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    } catch (error) {
      closedByError = true;
      text += `\n[[reader-error:${error?.name || "unknown"}]]`;
      break;
    }
  }

  text += decoder.decode();
  return {
    status: response.status,
    headers: response.headers,
    text,
    closedByError,
  };
}

async function run() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-retry-gateway-"));
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const configPath = path.join(tempRoot, "config.json");
  const logPath = path.join(tempRoot, "gateway.log");

  const config = {
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
    request_body_limit_bytes: 10 * 1024 * 1024,
    endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
    reasoning_equals: [516],
    non_stream_status_code: 502,
    stream_action: "strict_502",
    log_match: true,
    health_path: "/__codex_retry_gateway/health",
  };

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const upstream = await startFakeUpstream(upstreamPort);
  const gateway = startGateway(configPath, logPath);

  try {
    await waitForHealth(`http://127.0.0.1:${gatewayPort}${config.health_path}`);

    const modelsResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
    assert(modelsResponse.status === 200, `/v1/models 透传状态异常: ${modelsResponse.status}`);
    assert(
      modelsResponse.headers.get("x-upstream-test") === "models-ok",
      "/v1/models 未保留上游头",
    );

    const statusBeforeUiRefresh = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const uiHtml = await fetch(`http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/ui`).then((response) =>
      response.text(),
    );
    const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
    assert(inlineScriptMatch, "管理页缺少内联脚本");
    try {
      new vm.Script(inlineScriptMatch[1]);
    } catch (error) {
      throw new Error(`管理页内联脚本语法无效: ${error?.message || error}`);
    }
    assert(uiHtml.includes('id="statsFootnote"'), "管理页运行状态脚注缺少 statsFootnote 挂点");
    assert(!uiHtml.includes("家族声明分布"), "管理页不应再显示家族声明分布");
    assert(!uiHtml.includes('id="family54Stats"'), "管理页不应再渲染 family54Stats");
    assert(!uiHtml.includes('id="family55Stats"'), "管理页不应再渲染 family55Stats");
    assert(!uiHtml.includes("<h3>gpt-5.4</h3>"), "管理页不应再显示 gpt-5.4 分列标题");
    assert(!uiHtml.includes("<h3>gpt-5.5</h3>"), "管理页不应再显示 gpt-5.5 分列标题");
    assert(!uiHtml.includes('id="family54Summary"'), "管理页不应再渲染 family54Summary");
    assert(!uiHtml.includes('id="family55Summary"'), "管理页不应再渲染 family55Summary");
    await verifyRenderedUiEvidenceDetailsBehavior(uiHtml);
    await fetch(`http://127.0.0.1:${gatewayPort}/favicon.ico`);
    const statusAfterUiRefresh = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusBeforeUiRefresh.metrics.bypassed_proxy_request_count === 1,
      "status 未正确记录未纳入检查的透传请求数",
    );
    assert(
      statusBeforeUiRefresh.metrics.failed_proxy_request_count === 0,
      "测试基线下不应存在代理失败请求",
    );
    assert(
      statusBeforeUiRefresh.metrics.total_proxy_request_count -
        statusBeforeUiRefresh.metrics.inspected_response_count ===
        statusBeforeUiRefresh.metrics.bypassed_proxy_request_count +
          statusBeforeUiRefresh.metrics.failed_proxy_request_count,
      "代理请求总数与被检查响应总数的差值应能由透传请求和失败请求解释",
    );
    assert(
      statusAfterUiRefresh.metrics.total_proxy_request_count ===
        statusBeforeUiRefresh.metrics.total_proxy_request_count,
      "管理页刷新相关请求不应增加代理请求总数",
    );
    const brokenBypassResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models?test_fail_before_response=1`,
    );
    assert(brokenBypassResponse.status === 502, `异常旁路请求应返回 502，实际为 ${brokenBypassResponse.status}`);
    const statusAfterBrokenBypass = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterBrokenBypass.metrics.bypassed_proxy_request_count ===
        statusBeforeUiRefresh.metrics.bypassed_proxy_request_count,
      "旁路透传半路失败时不应同时计入 bypassed_proxy_request_count",
    );
    assert(
      statusAfterBrokenBypass.metrics.failed_proxy_request_count ===
        statusBeforeUiRefresh.metrics.failed_proxy_request_count + 1,
      "旁路透传半路失败时应单独计入 failed_proxy_request_count",
    );
    const slowRequestPromise = fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test_reasoning_tokens: 128,
        test_response_delay_ms: 180,
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusDuringSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusDuringSlowRequest.metrics.active_proxy_request_count >= 1,
      "代理请求进行中时应记录 active_proxy_request_count",
    );
    assert(
      statusDuringSlowRequest.metrics.active_proxy_path_counts?.["/responses"] >= 1,
      "代理请求进行中时应记录 active_proxy_path_counts",
    );
    const slowRequestResponse = await slowRequestPromise;
    assert(slowRequestResponse.status === 200, `慢速代理请求状态异常: ${slowRequestResponse.status}`);
    await slowRequestResponse.text();
    const statusAfterSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterSlowRequest.metrics.active_proxy_request_count === 0,
      "代理请求结束后 active_proxy_request_count 应回到 0",
    );

    for (const responsePath of ["/responses", "/v1/responses"]) {
      const blockedResponse = await fetch(`http://127.0.0.1:${gatewayPort}${responsePath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_reasoning_tokens: 516 }),
      });
      const blockedBody = await blockedResponse.json();
      assert(blockedResponse.status === 502, `${responsePath} 516 未返回 502: ${blockedResponse.status}`);
      assert(
        blockedBody?.error?.code === "reasoning_guard_triggered",
        `${responsePath} 516 返回体不正确`,
      );

      const okResponse = await fetch(`http://127.0.0.1:${gatewayPort}${responsePath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_reasoning_tokens: 128 }),
      });
      const okBody = await okResponse.json();
      assert(okResponse.status === 200, `${responsePath} 128 透传状态异常: ${okResponse.status}`);
      assert(okResponse.headers.get("x-upstream-test") === "responses-128", `${responsePath} 128 未保留头`);
      assert(
        okBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
        `${responsePath} 128 返回体异常`,
      );
    }

    const recoveredResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_fail_before_response_once: true }),
    });
    const recoveredBody = await recoveredResponse.json();
    assert(recoveredResponse.status === 200, `首次 fetch failed 后未自动恢复: ${recoveredResponse.status}`);
    assert(recoveredBody?.retry_attempt === 2, "首次 fetch failed 后未命中第二次上游请求");

    const familyMatchedResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", test_response_model: "gpt-5.4" }),
    });
    assert(familyMatchedResponse.status === 200, `gpt-5.4 一致声明请求失败: ${familyMatchedResponse.status}`);

    const familyMatched55Response = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.5", test_response_model: "gpt-5.5" }),
    });
    assert(familyMatched55Response.status === 200, `gpt-5.5 一致声明请求失败: ${familyMatched55Response.status}`);

    const familyMismatchResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", test_response_model: "gpt-5.4-mini" }),
    });
    assert(familyMismatchResponse.status === 200, `模型声明不一致请求失败: ${familyMismatchResponse.status}`);

    const lowContextResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        test_error_status: 400,
        test_error_payload: {
          error: {
            code: "context_length_exceeded",
            message: "request too large for 400000 context window",
          },
        },
      }),
    });
    assert(lowContextResponse.status === 400, `400K 家族异常未保留上游状态: ${lowContextResponse.status}`);

    for (const streamPath of [
      "/responses",
      "/v1/responses",
      "/chat/completions",
      "/v1/chat/completions",
    ]) {
      const blockedStream = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}${streamPath}`,
        { stream: true, test_reasoning_tokens: 516 },
      );
      assert(blockedStream.status === 502, `${streamPath} 516 未返回 502: ${blockedStream.status}`);
      assert(!blockedStream.text.includes("hello"), `${streamPath} 严格 502 模式不应先透传正常 chunk`);
      assert(!blockedStream.text.includes("[DONE]"), `${streamPath} 严格 502 模式不应回放 DONE`);
      const blockedStreamBody = JSON.parse(blockedStream.text);
      assert(
        blockedStreamBody?.error?.code === "reasoning_guard_triggered",
        `${streamPath} 流式 516 返回体不正确`,
      );

      const okStream = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}${streamPath}`,
        { stream: true, test_reasoning_tokens: 128 },
      );
      assert(okStream.status === 200, `${streamPath} 128 首状态异常: ${okStream.status}`);
      assert(okStream.text.includes("[DONE]"), `${streamPath} 流式 128 未完整结束`);
      assert(!okStream.closedByError, `${streamPath} 流式 128 不应异常断开`);
    }

    const blockedStreamWithEventIds = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.4",
        stream: true,
        test_reasoning_tokens: 516,
        test_stream_models: ["gpt-5.4", "gpt-5.4"],
        test_stream_fingerprints: ["fp_same", "fp_same"],
        test_response_ids: ["resp_same", "resp_same"],
        test_stream_event_ids: ["evt_same_1", "evt_same_2"],
        test_stream_delta_omit_response_id: true,
      },
    );
    assert(
      blockedStreamWithEventIds.status === 502,
      `带事件 id 的 516 流式请求未返回 502: ${blockedStreamWithEventIds.status}`,
    );
    const statusAfterBlockedStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterBlockedStream.model_insights.single_request_anomalies?.rebuild_suspected_count === 0,
      "正常拦截 516 不应计入疑似请求内重建/重试",
    );
    assert(
      !statusAfterBlockedStream.model_insights.suspicious_samples?.some(
        (sample) => sample.path === "/responses" && sample.anomaly_type === "single_request_rebuild_suspected",
      ),
      "正常拦截 516 不应生成 single_request_rebuild_suspected 可疑样本",
    );

    const driftedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.5",
        stream: true,
        test_reasoning_tokens: 128,
        test_stream_models: ["gpt-5.5", "gpt-5.4-mini"],
        test_stream_fingerprints: ["fp_stream_a", "fp_stream_b"],
      },
    );
    assert(driftedStream.status === 200, `单请求模型漂移流未透传成功: ${driftedStream.status}`);

    const rebuildSuspectedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/chat/completions`,
      {
        model: "gpt-5.5",
        stream: true,
        test_reasoning_tokens: 128,
        test_stream_models: ["gpt-5.5", "gpt-5.5"],
        test_stream_fingerprints: ["fp_chat_a", "fp_chat_b"],
      },
    );
    assert(
      rebuildSuspectedStream.status === 200,
      `疑似请求内重建流未透传成功: ${rebuildSuspectedStream.status}`,
    );

    const terminatedStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      { stream: true, test_force_terminate: true },
    );
    assert(terminatedStream.status === 502, `/responses 上游半路断流未返回 502: ${terminatedStream.status}`);

    const statusWithModelInsights = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(statusWithModelInsights.model_insights, "status 缺少 model_insights");
    assert(
      statusWithModelInsights.model_insights.consistency?.matched >= 2,
      "模型一致性 matched 统计未记录 gpt-5.4 / gpt-5.5 一致请求",
    );
    assert(
      statusWithModelInsights.model_insights.consistency?.mismatched >= 1,
      "模型一致性 mismatched 统计未记录声明不一致请求",
    );
    assert(
      Math.abs(statusWithModelInsights.model_insights.consistency?.match_ratio - 4 / 6) < 1e-9,
      "声明一致率应只按已声明样本计算，不应把 unknown 计入分母",
    );
    assert(
      statusWithModelInsights.model_insights.anomalies?.low_context_family_count >= 1,
      "400K 家族异常统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies?.model_drift_count >= 1,
      "单请求模型漂移统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies?.rebuild_suspected_count >= 1,
      "疑似请求内重建/重试统计未记录",
    );
    assert(
      Array.isArray(statusWithModelInsights.model_insights.suspicious_samples) &&
        statusWithModelInsights.model_insights.suspicious_samples.length >= 3,
      "可疑样本未保留",
    );
    assert(
      statusWithModelInsights.model_insights.suspicious_samples.some(
        (sample) => Array.isArray(sample.evidence_logs) && sample.evidence_logs.length > 0,
      ),
      "可疑样本未保留日志证据",
    );
    const familyBreakdown = statusWithModelInsights.model_insights.family_breakdown;
    assert(familyBreakdown, "status 缺少 family_breakdown");
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.total_checked === 4,
      "gpt-5.4 家族 total_checked 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.matched === 2,
      "gpt-5.4 家族 matched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.mismatched === 1,
      "gpt-5.4 家族 mismatched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.unknown === 1,
      "gpt-5.4 家族 unknown 统计不正确",
    );
    assert(
      Math.abs(familyBreakdown["gpt-5.4"]?.consistency?.match_ratio - 2 / 3) < 1e-9,
      "gpt-5.4 家族声明一致率应排除 unknown",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.anomalies?.low_context_family_count === 1,
      "gpt-5.4 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies?.model_drift_count === 0,
      "gpt-5.4 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies?.fingerprint_drift_count === 0,
      "gpt-5.4 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies?.rebuild_suspected_count === 0,
      "gpt-5.4 家族 rebuild_suspected_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.total_checked === 3,
      "gpt-5.5 家族 total_checked 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.matched === 2,
      "gpt-5.5 家族 matched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.mismatched === 1,
      "gpt-5.5 家族 mismatched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.unknown === 0,
      "gpt-5.5 家族 unknown 统计不正确",
    );
    assert(
      Math.abs(familyBreakdown["gpt-5.5"]?.consistency?.match_ratio - 2 / 3) < 1e-9,
      "gpt-5.5 家族声明一致率统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.anomalies?.low_context_family_count === 0,
      "gpt-5.5 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies?.model_drift_count === 1,
      "gpt-5.5 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies?.fingerprint_drift_count === 1,
      "gpt-5.5 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies?.rebuild_suspected_count === 1,
      "gpt-5.5 家族 rebuild_suspected_count 统计不正确",
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    const logText = await readFile(logPath, "utf8");
    assert(
      !logText.includes("[error] TypeError: terminated"),
      "上游半路断流后不应记录 terminated error 日志",
    );

    process.stdout.write("PASS codex-retry-gateway e2e\n");
  } finally {
    gateway.child.kill();
    upstream.close();
    await once(upstream, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
