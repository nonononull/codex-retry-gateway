#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function extractLongContextProbeUnits(serializedInput) {
  const match = `${serializedInput || ""}`.match(/__crg_long_context_probe__ phase=([a-z0-9_]+) units=(\d+)/i);
  if (!match) {
    return null;
  }
  return {
    phase: match[1],
    units: Number.parseInt(match[2], 10),
  };
}

function buildLongContextProbeResponsePayload(parsed, inputTokens, outputText = "OK") {
  const safeInputTokens = Math.max(0, Number.parseInt(`${inputTokens}`, 10) || 0);
  const outputTokens = 1;
  return {
    id: parsed.test_response_id ?? "resp_probe_long_context",
    model: parsed.test_response_model ?? parsed.model ?? "gpt-5.4",
    output_text: outputText,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: outputText }],
      },
    ],
    usage: {
      input_tokens: safeInputTokens,
      input_tokens_details: {
        cached_tokens: Math.max(0, Math.min(5000, safeInputTokens)),
      },
      output_tokens: outputTokens,
      output_tokens_details: {
        reasoning_tokens: 0,
      },
      total_tokens: safeInputTokens + outputTokens,
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

function encodeHtmlAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll(">", "&gt;")
    .replaceAll("<", "&lt;");
}

function markEvidenceDetailsOpen(element, sampleKey) {
  const encodedKey = encodeHtmlAttribute(sampleKey);
  const closedTag = `<details class="evidence-details" data-sample-key="${encodedKey}">`;
  const openTag = `<details class="evidence-details" data-sample-key="${encodedKey}" open>`;
  element.innerHTML = element.innerHTML.replace(closedTag, openTag);
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
    "interceptStreamingInput",
    "interceptNonStreamingInput",
    "interceptModeValue",
    "endpointsInput",
    "statusCodeInput",
    "guardRetryAttemptsInput",
    "logMatchInput",
    "probeTargetFamily54Input",
    "probeTargetFamily55Input",
    "probeAutoEnabledInput",
    "probeIntervalMinutesInput",
    "saveButton",
    "probeRunButton",
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
    "matchedCountValue",
    "blockedRatioValue",
    "matchedStreamingCountValue",
    "matchedNonStreamingCountValue",
    "blockedCountValue",
    "blockedStreamingCountValue",
    "blockedNonStreamingCountValue",
    "modelMatchRatioValue",
    "modelMismatchCountValue",
    "lowContextFamilyCountValue",
    "modelDriftCountValue",
    "fingerprintDriftCountValue",
    "rebuildSuspectedCountValue",
    "probeEnabledValue",
    "probeTargetModelValue",
    "probeLastRunValue",
    "probePassCountValue",
    "probeWarningCountValue",
    "probeViolationCountValue",
    "probeTransportErrorCountValue",
    "probeSamplesBody",
    "suspiciousSamplesBody",
    "statsFootnote",
    "logsMeta",
    "logsOutput",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeElement(id === "configForm" ? "form" : "div")]),
  );
  elements.statusCodeInput.value = "502";
  elements.guardRetryAttemptsInput.value = "3";

  const statusPayload = {
    listen: "http://127.0.0.1:4610",
    config: {
      upstream_base_url: "http://upstream.example",
      reasoning_equals: [516],
      intercept_streaming: true,
      intercept_non_streaming: true,
      endpoints: ["/responses"],
      non_stream_status_code: 502,
      guard_retry_attempts: 3,
      log_match: true,
      active_probe: {
        enabled: true,
        interval_ms: 10 * 60 * 1000,
        target_families: ["gpt-5.4", "gpt-5.5"],
      },
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
      total_proxy_request_count: 6,
      inspected_response_count: 4,
      bypassed_proxy_request_count: 2,
      bypassed_proxy_path_counts: {
        "/v1/models": 2,
      },
      failed_proxy_request_count: 0,
      active_proxy_request_count: 0,
      active_proxy_path_counts: {},
      reasoning_516_count: 0,
      reasoning_516_ratio: 0,
      matched_response_count: 2,
      matched_streaming_count: 1,
      matched_non_streaming_count: 1,
      blocked_response_count: 1,
      blocked_streaming_count: 1,
      blocked_non_streaming_count: 0,
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
    active_probe: {
      enabled: true,
      running: false,
      last_target_model: "gpt-5.5",
      last_finished_at: "2026-06-28T03:20:00.000Z",
      pass_count: 1,
      warning_count: 2,
      violation_count: 3,
      transport_error_count: 4,
      recent_samples: [
        {
          ts: "2026-06-28T03:21:00.000Z",
          probe_type: "identity_consistency",
          target_model: "gpt-5.5",
          endpoint_path: "/responses",
          result: "warning",
          result_type: "probe_identity_consistency_warning",
          confidence: "medium",
          http_status: 200,
          duration_ms: 42,
          upstream_model: "gpt-5.5",
          observed_fingerprints: ["fp_probe_1"],
          evidence_logs: [
            {
              at: "2026-06-28T03:21:00.000Z",
              message: "[probe] warning type=identity_consistency",
            },
          ],
        },
      ],
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
  const fetchBodies = [];
  let runProbeRequestCount = 0;
  let locationReloadCount = 0;

  const fetchMock = async (url, options = {}) => {
    fetchCalls.push(String(url));
    if (options?.body) {
      fetchBodies.push({
        url: String(url),
        method: String(options?.method || "GET"),
        body: String(options.body),
      });
    }
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
    if (String(url).includes("/api/config")) {
      const submitted = JSON.parse(String(options?.body || "{}"));
      statusPayload.config = {
        ...statusPayload.config,
        ...submitted,
        active_probe: {
          ...(statusPayload.config?.active_probe || {}),
          ...(submitted.active_probe || {}),
        },
      };
      statusPayload.active_probe = {
        ...statusPayload.active_probe,
        enabled: Boolean(submitted.active_probe?.enabled),
        interval_ms:
          submitted.active_probe?.interval_ms ?? statusPayload.active_probe?.interval_ms,
        target_families: Array.isArray(submitted.active_probe?.target_families)
          ? [...submitted.active_probe.target_families]
          : statusPayload.active_probe?.target_families,
      };
      return {
        ok: true,
        async json() {
          return statusPayload;
        },
      };
    }
    if (String(url).includes("/api/probe/run")) {
      runProbeRequestCount += 1;
      return {
        ok: true,
        async json() {
          return {
            ok: true,
            message: "probe started",
            active_probe: statusPayload.active_probe,
          };
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
      location: {
        origin: "http://127.0.0.1:4610",
        reload() {
          locationReloadCount += 1;
        },
      },
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
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "主动探针状态未正确展示",
  );
  assert(
    elements.probeTargetModelValue.textContent === "gpt-5.5",
    "主动探针目标模型未正确展示",
  );
  assert(
    elements.probeWarningCountValue.textContent === "2",
    "主动探针 warning 次数未正确展示",
  );
  assert(
    elements.probeViolationCountValue.textContent === "3",
    "主动探针 violation 次数未正确展示",
  );
  assert(
    elements.probeTransportErrorCountValue.textContent === "4",
    "主动探针 transport_error 次数未正确展示",
  );
  assert(elements.probeTargetFamily54Input.checked === true, "主动探针未回填 gpt-5.4 复选框");
  assert(elements.probeTargetFamily55Input.checked === true, "主动探针未回填 gpt-5.5 复选框");
  assert(elements.probeAutoEnabledInput.checked === true, "主动探针未回填自动探测开关");
  assert(elements.probeIntervalMinutesInput.value === "10", "主动探针未回填分钟频率");
  assert(elements.interceptStreamingInput.checked === true, "管理页未回填流式拦截开关");
  assert(elements.interceptNonStreamingInput.checked === true, "管理页未回填非流式拦截开关");
  assert(elements.guardRetryAttemptsInput.value === "3", "管理页未回填网关内重试次数");
  assert(
    elements.interceptModeValue.textContent.includes("流式+非流式"),
    "管理页未显示双开拦截模式",
  );
  assert(elements.matchedCountValue.textContent === "2", "管理页未展示当前规则命中总数");
  assert(elements.blockedCountValue.textContent === "1", "管理页未展示实际拦截总数");
  assert(elements.blockedRatioValue.textContent === "25.00%", "管理页未展示实际拦截占比");
  assert(elements.matchedStreamingCountValue.textContent === "1", "管理页未展示流式命中次数");
  assert(elements.matchedNonStreamingCountValue.textContent === "1", "管理页未展示非流式命中次数");
  assert(elements.blockedStreamingCountValue.textContent === "1", "管理页未展示流式拦截次数");
  assert(elements.blockedNonStreamingCountValue.textContent === "0", "管理页未展示非流式拦截次数");
  assert(
    elements.probeSamplesBody.innerHTML.includes("probe_identity_consistency_warning"),
    "主动探针样本表未渲染 warning 样本",
  );
  assert(
    typeof sandbox.runProbeNow === "function",
    "管理页未暴露 runProbeNow",
  );
  assert(
    typeof sandbox.collectActiveProbeFormPayload === "function",
    "管理页未暴露 collectActiveProbeFormPayload",
  );
  assert(
    typeof sandbox.persistActiveProbeConfigFromControls === "function",
    "管理页未暴露 persistActiveProbeConfigFromControls",
  );
  elements.probeTargetFamily54Input.checked = false;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeAutoEnabledInput.checked = true;
  elements.probeAutoEnabledInput.emit("change", {
    target: elements.probeAutoEnabledInput,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert(
    elements.probeEnabledValue.textContent.includes("未开启"),
    "未选中任何模型时，不应允许开启自动探测",
  );
  assert(
    elements.probeAutoEnabledInput.checked === false,
    "未选中任何模型时，自动探测开关应回退为未勾选",
  );
  assert(
    elements.messageBox.textContent.includes("至少选择一个"),
    "未选中任何模型时，应提示至少选择一个目标模型",
  );
  elements.probeTargetFamily54Input.checked = true;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeAutoEnabledInput.checked = false;
  elements.probeIntervalMinutesInput.value = "7";
  const probeConfigPayload = sandbox.collectActiveProbeFormPayload();
  assert(
    probeConfigPayload.enabled === false,
    "主动探针表单未正确收集 enabled",
  );
  assert(
    probeConfigPayload.interval_ms === 7 * 60 * 1000,
    "主动探针表单未正确把分钟频率转换为 interval_ms",
  );
  assert(
    JSON.stringify(probeConfigPayload.target_families) === JSON.stringify(["gpt-5.4"]),
    "主动探针表单未正确收集 target_families",
  );
  const configSaveCountBeforeInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config")
  ).length;
  elements.interceptStreamingInput.checked = false;
  elements.interceptNonStreamingInput.checked = false;
  await sandbox.saveConfig({ preventDefault() {} });
  const configSaveCountAfterInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config")
  ).length;
  assert(
    configSaveCountAfterInvalidIntercept === configSaveCountBeforeInvalidIntercept,
    "流式与非流式都关闭时，管理页不应提交 /api/config",
  );
  assert(
    elements.messageBox.textContent.includes("流式与非流式至少选择一个"),
    "流式与非流式都关闭时，管理页应提示至少选择一个拦截目标",
  );
  elements.interceptStreamingInput.checked = true;
  elements.interceptNonStreamingInput.checked = false;
  await sandbox.saveConfig({ preventDefault() {} });
  const saveConfigCall = fetchBodies.filter((entry) => entry.url.includes("/api/config")).at(-1);
  assert(saveConfigCall, "saveConfig 未请求 /api/config");
  const savedPayload = JSON.parse(saveConfigCall.body);
  assert(savedPayload.intercept_streaming === true, "saveConfig 未提交 intercept_streaming");
  assert(savedPayload.intercept_non_streaming === false, "saveConfig 未提交 intercept_non_streaming");
  assert(savedPayload.guard_retry_attempts === 3, "saveConfig 未提交 guard_retry_attempts");
  assert(savedPayload.active_probe, "saveConfig 未提交 active_probe");
  assert(savedPayload.active_probe.enabled === false, "saveConfig 未提交 active_probe.enabled");
  assert(
    savedPayload.active_probe.interval_ms === 7 * 60 * 1000,
    "saveConfig 未提交 active_probe.interval_ms",
  );
  assert(
    JSON.stringify(savedPayload.active_probe.target_families) === JSON.stringify(["gpt-5.4"]),
    "saveConfig 未提交 active_probe.target_families",
  );
  assert(
    elements.probeEnabledValue.textContent.includes("未开启"),
    "保存为关闭自动探测后，主动探针状态应显示未开启",
  );
  elements.probeAutoEnabledInput.checked = true;
  elements.probeAutoEnabledInput.emit("change", {
    target: elements.probeAutoEnabledInput,
  });
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "勾选开启自动探测后，主动探针状态应立即显示已开启",
  );
  await sandbox.persistActiveProbeConfigFromControls();
  const autoProbeSaveCall = fetchBodies.filter((entry) => entry.url.includes("/api/config")).at(-1);
  assert(autoProbeSaveCall, "勾选开启自动探测后未自动保存 /api/config");
  const autoProbeSavedPayload = JSON.parse(autoProbeSaveCall.body);
  assert(
    autoProbeSavedPayload.active_probe?.enabled === true,
    "勾选开启自动探测后自动保存未写入 active_probe.enabled=true",
  );
  await sandbox.refreshLiveData();
  assert(
    elements.probeEnabledValue.textContent.includes("已开启"),
    "勾选开启自动探测后，主动探针状态不应被页面自动刷新打回未开启",
  );
  await sandbox.runProbeNow();
  assert(runProbeRequestCount === 1, "runProbeNow 未请求 /api/probe/run");
  assert(
    fetchCalls.some((url) => url.includes("/api/probe/run")),
    "管理页未调用手动探测接口",
  );
  const runProbeCall = fetchBodies.find((entry) => entry.url.includes("/api/probe/run"));
  assert(runProbeCall, "runProbeNow 未提交请求体");
  const runProbePayload = JSON.parse(runProbeCall.body);
  assert(runProbePayload.active_probe, "runProbeNow 未提交 active_probe");
  assert(
    runProbePayload.active_probe.enabled === true,
    "runProbeNow 未提交当前 active_probe.enabled",
  );
  assert(
    runProbePayload.active_probe.interval_ms === 7 * 60 * 1000,
    "runProbeNow 未提交当前 active_probe.interval_ms",
  );
  assert(
    JSON.stringify(runProbePayload.active_probe.target_families) === JSON.stringify(["gpt-5.4"]),
    "runProbeNow 未提交当前 active_probe.target_families",
  );
  elements.probeTargetFamily54Input.checked = false;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeAutoEnabledInput.checked = true;
  await sandbox.persistActiveProbeConfigFromControls().then(
    () => {
      throw new Error("未选中任何模型时，persistActiveProbeConfigFromControls 不应成功");
    },
    (error) => {
      assert(
        String(error?.message || error).includes("至少选择一个"),
        "未选中任何模型时，persistActiveProbeConfigFromControls 应返回目标模型校验错误",
      );
    },
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
  assert(
    locationReloadCount === 1,
    "检测到网关重启后，管理页应自动刷新以加载新的内联脚本",
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

  const probeSample = {
    ts: "2026-06-28T03:21:00.000Z",
    probe_type: "identity_consistency",
    target_model: "gpt-5.5",
    endpoint_path: "/responses",
    result: "warning",
    result_type: "probe_identity_consistency_warning",
    confidence: "medium",
    http_status: 200,
    duration_ms: 42,
    upstream_model: "gpt-5.5",
    observed_fingerprints: ["fp_probe_1"],
    evidence_logs: [
      {
        at: "2026-06-28T03:21:00.000Z",
        message: "[probe] warning type=identity_consistency",
      },
    ],
  };
  sandbox.renderProbeSamples([probeSample]);
  const probeSampleKey = sandbox.buildProbeSampleKey(probeSample);
  elements.probeSamplesBody.emit("toggle", {
    target: {
      tagName: "DETAILS",
      classList: {
        contains(value) {
          return value === "evidence-details";
        },
      },
      getAttribute(name) {
        return name === "data-sample-key" ? probeSampleKey : null;
      },
      open: true,
    },
  });
  markEvidenceDetailsOpen(elements.probeSamplesBody, probeSampleKey);
  const probeBefore = elements.probeSamplesBody.innerHTML;
  sandbox.renderProbeSamples([probeSample]);
  const probeAfterSame = elements.probeSamplesBody.innerHTML;
  assert(
    probeBefore === probeAfterSame,
    "主动探针样本未变化时不应重绘日志证据 DOM",
  );
  const changedProbeSample = {
    ...probeSample,
    evidence_logs: [
      ...probeSample.evidence_logs,
      {
        at: "2026-06-28T03:21:00.500Z",
        message: "[probe] second line",
      },
    ],
  };
  sandbox.renderProbeSamples([changedProbeSample]);
  const probeAfterChanged = elements.probeSamplesBody.innerHTML;
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(probeAfterChanged),
    "主动探针样本刷新后已展开的日志证据不应自动收起",
  );
  const silentProbeSample = {
    ts: "2026-06-28T03:22:00.000Z",
    probe_type: "image_input",
    target_model: "gpt-5.4",
    endpoint_path: "/responses",
    result: "warning",
    result_type: "probe_image_input_violation",
    confidence: "high",
    http_status: 400,
    duration_ms: 22,
    upstream_model: "gpt-5.4-mini",
    observed_fingerprints: ["fp_probe_silent"],
    evidence_logs: [
      {
        at: "2026-06-28T03:22:00.000Z",
        message: "[probe] silent open preservation",
      },
    ],
  };
  sandbox.renderProbeSamples([silentProbeSample]);
  const silentProbeKey = sandbox.buildProbeSampleKey(silentProbeSample);
  markEvidenceDetailsOpen(elements.probeSamplesBody, silentProbeKey);
  const silentChangedProbeSample = {
    ...silentProbeSample,
    evidence_logs: [
      ...silentProbeSample.evidence_logs,
      {
        at: "2026-06-28T03:22:00.100Z",
        message: "[probe] changed while open",
      },
    ],
  };
  sandbox.renderProbeSamples([silentChangedProbeSample]);
  const silentChangedProbeKey = sandbox.buildProbeSampleKey(silentChangedProbeSample);
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(elements.probeSamplesBody.innerHTML),
    "主动探针样本即使未显式触发 toggle 事件，也不应在刷新后自动收起",
  );
  const changedAgainSample = {
    ...changedSample,
    evidence_logs: [
      ...changedSample.evidence_logs,
      {
        seq: 4,
        at: "2026-06-28T03:18:23.300Z",
        message: "#4 suspicious changed again",
      },
    ],
  };
  sandbox.renderSuspiciousSamples([changedAgainSample]);
  const probeAfterSuspiciousRefresh = elements.probeSamplesBody.innerHTML;
  assert(
    probeAfterSuspiciousRefresh.includes(`data-sample-key=\"${encodeHtmlAttribute(silentChangedProbeKey)}\" open`),
    "最近可疑样本刷新后，不应把主动探针样本已展开的日志证据一起收起",
  );
  const prependedProbeSample = {
    ts: "2026-06-28T03:20:30.000Z",
    probe_type: "long_context",
    target_model: "gpt-5.5",
    endpoint_path: "/responses",
    result: "violation",
    result_type: "probe_low_context_family_violation",
    confidence: "high",
    http_status: 400,
    duration_ms: 31,
    upstream_model: "gpt-5.4-mini",
    observed_fingerprints: ["fp_probe_0"],
    evidence_logs: [
      {
        at: "2026-06-28T03:20:30.000Z",
        message: "[probe] violation type=long_context",
      },
    ],
  };
  sandbox.renderProbeSamples([prependedProbeSample, silentChangedProbeSample]);
  const openProbeKeysAfterPrepend = elements.probeSamplesBody
    .querySelectorAll('.evidence-details[data-sample-key][open]')
    .map((node) => node.getAttribute("data-sample-key"));
  assert(
    openProbeKeysAfterPrepend.includes(silentChangedProbeKey),
    "主动探针样本前面插入新记录后，已展开的日志证据不应自动收起",
  );
}

function startFakeUpstream(port) {
  const failBeforeResponseCounts = new Map();
  const reasoningSequenceCounts = new Map();
  const identityProbeCounts = new Map();
  const probeRequests = [];
  const responseRequests = [];
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
        const authorization = req.headers.authorization || "";
        const probeBlockedByUpstream = authorization === "Bearer sk-probe-blocked";
        const sequenceKey =
          Array.isArray(parsed.test_reasoning_sequence)
            ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
            : null;
        const sequenceCount = sequenceKey ? reasoningSequenceCounts.get(sequenceKey) || 0 : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)]
          : parsed.test_reasoning_tokens ?? 128;
        const serializedInput = JSON.stringify(parsed.input || "");
        const requestSnapshot = {
          path: req.url,
          headers: {
            authorization,
            userAgent: req.headers["user-agent"] || null,
            openaiBeta: req.headers["openai-beta"] || null,
            xStainlessLang: req.headers["x-stainless-lang"] || null,
          },
          body: parsed,
          probeType: null,
          phase: null,
          units: null,
        };
        responseRequests.push(requestSnapshot);
        if (parsed.test_fail_before_response_once) {
          const failKey = `${req.url}:fail-before-response-once`;
          const failCount = (failBeforeResponseCounts.get(failKey) || 0) + 1;
          failBeforeResponseCounts.set(failKey, failCount);
          if (failCount === 1) {
            res.socket?.destroy();
            return;
          }
        }
        if (parsed.test_fail_before_response_always) {
          res.socket?.destroy();
          return;
        }
        const longContextProbe = extractLongContextProbeUnits(serializedInput);
        if (longContextProbe) {
          requestSnapshot.probeType = "long_context";
          requestSnapshot.phase = longContextProbe.phase;
          requestSnapshot.units = longContextProbe.units;
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-long-context-unauthorized" },
            );
            return;
          }
          if (probeBlockedByUpstream) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message: "Upstream service temporarily unavailable",
                },
              },
              { "x-upstream-test": "responses-probe-long-context-upstream-blocked" },
            );
            return;
          }
          const simulatedInputTokens = 6000 + longContextProbe.units;
          if (simulatedInputTokens < 400000) {
            createJsonResponse(
              res,
              200,
              buildLongContextProbeResponsePayload(parsed, simulatedInputTokens),
              {
                "x-upstream-test": `responses-probe-long-context-${longContextProbe.phase}-ok`,
              },
            );
            return;
          }
          createJsonResponse(
            res,
            400,
            {
              error: {
                code: "context_length_exceeded",
                message: "request too large for 400000 context window",
              },
            },
            { "x-upstream-test": "responses-probe-long-context" },
          );
          return;
        }
        if (serializedInput.includes("__crg_image_input_probe__")) {
          requestSnapshot.probeType = "image_input";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-image-input-unauthorized" },
            );
            return;
          }
          if (probeBlockedByUpstream) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message: "Upstream access forbidden, please contact administrator",
                },
              },
              { "x-upstream-test": "responses-probe-image-input-upstream-blocked" },
            );
            return;
          }
          if (serializedInput.includes("data:image/svg+xml")) {
            createJsonResponse(
              res,
              502,
              {
                error: {
                  type: "upstream_error",
                  message: "unsupported image mime type: svg",
                },
              },
              { "x-upstream-test": "responses-probe-image-input-svg-blocked" },
            );
            return;
          }
          createJsonResponse(
            res,
            400,
            {
              error: {
                code: "unsupported_image_input",
                message: "model does not support image input",
              },
            },
            { "x-upstream-test": "responses-probe-image-input" },
          );
          return;
        }
        if (serializedInput.includes("__crg_response_structure_probe__")) {
          requestSnapshot.probeType = "response_structure";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-response-structure-unauthorized" },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            {
              output_text:
                '当然可以，下面是结果：\n{"items":[{"key":"a","value":1},{"key":"b","value":2},{"key":"c","value":3}]}',
            },
            { "x-upstream-test": "responses-probe-response-structure" },
          );
          return;
        }
        if (serializedInput.includes("__crg_identity_probe__")) {
          requestSnapshot.probeType = "identity_consistency";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-identity-unauthorized" },
            );
            return;
          }
          const identityKey = `${req.url}:identity-probe`;
          const identityCount = (identityProbeCounts.get(identityKey) || 0) + 1;
          identityProbeCounts.set(identityKey, identityCount);
          const outputText =
            identityCount % 2 === 1
              ? '{"self_reported_model":"gpt-5.5","self_reported_family":"gpt-5.5","claims_image_input":true,"claims_cutoff":"2025-01-01"}'
              : '{"self_reported_model":"gpt-5.3","self_reported_family":"gpt-5.3","claims_image_input":false,"claims_cutoff":"2024-01-01"}';
          createJsonResponse(
            res,
            200,
            { output_text: outputText },
            { "x-upstream-test": "responses-probe-identity" },
          );
          return;
        }
        if (serializedInput.includes("__crg_knowledge_cutoff_probe__:self_cutoff")) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-knowledge-self-cutoff-unauthorized" },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: '{"claims_cutoff":"2024-01-01"}' },
            { "x-upstream-test": "responses-probe-knowledge-self-cutoff" },
          );
          return;
        }
        if (serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_1")) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-knowledge-anchor-1-unauthorized" },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: "乔·拜登" },
            { "x-upstream-test": "responses-probe-knowledge-anchor-1" },
          );
          return;
        }
        if (serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_2")) {
          requestSnapshot.probeType = "knowledge_cutoff";
          probeRequests.push(requestSnapshot);
          if (!authorization.startsWith("Bearer ")) {
            createJsonResponse(
              res,
              401,
              {
                error: {
                  code: "missing_authorization",
                  message: "authorization header required",
                },
              },
              { "x-upstream-test": "responses-probe-knowledge-anchor-2-unauthorized" },
            );
            return;
          }
          createJsonResponse(
            res,
            200,
            { output_text: "2024" },
            { "x-upstream-test": "responses-probe-knowledge-anchor-2" },
          );
          return;
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
        const sequenceKey =
          Array.isArray(parsed.test_reasoning_sequence)
            ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
            : null;
        const sequenceCount = sequenceKey ? reasoningSequenceCounts.get(sequenceKey) || 0 : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)]
          : parsed.test_reasoning_tokens ?? 128;
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
    server.listen(port, "127.0.0.1", () => {
      server.probeRequests = probeRequests;
      server.responseRequests = responseRequests;
      resolve(server);
    });
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

async function waitForStatusCondition(url, predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastPayload = await fetch(url).then((response) => response.json());
      if (predicate(lastPayload)) {
        return lastPayload;
      }
    } catch {
      // ignore startup race
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `等待状态条件超时: ${url} last=${JSON.stringify(lastPayload)}`,
  );
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
  const probeGatewayPort = await getFreePort();
  const warningProbeGatewayPort = await getFreePort();
  const configPath = path.join(tempRoot, "config.json");
  const logPath = path.join(tempRoot, "gateway.log");
  const probeConfigDir = path.join(tempRoot, "probe-runtime");
  const probeConfigPath = path.join(probeConfigDir, "config.json");
  const probeLogPath = path.join(tempRoot, "probe-gateway.log");
  const probeCodexConfigPath = path.join(tempRoot, "probe-codex-config.toml");
  const probeStatePath = path.join(tempRoot, "state.json");
  const warningProbeRoot = path.join(tempRoot, "warning-probe");
  const warningProbeConfigDir = path.join(warningProbeRoot, "config");
  const warningProbeConfigPath = path.join(warningProbeConfigDir, "config.json");
  const warningProbeLogPath = path.join(warningProbeRoot, "gateway.log");
  const warningProbeCodexConfigPath = path.join(warningProbeRoot, "codex-config.toml");
  const warningProbeStatePath = path.join(warningProbeRoot, "state.json");

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
  let probeGateway = null;
  let warningProbeGateway = null;

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
    assert(statusBeforeUiRefresh.config?.intercept_streaming === true, "intercept_streaming 默认应开启");
    assert(statusBeforeUiRefresh.config?.intercept_non_streaming === true, "intercept_non_streaming 默认应开启");
    assert(statusBeforeUiRefresh.config?.guard_retry_attempts === 3, "guard_retry_attempts 默认应为 3");
    assert(statusBeforeUiRefresh.active_probe, "status 缺少 active_probe");
    assert(statusBeforeUiRefresh.active_probe.enabled === false, "active_probe 默认应关闭");
    assert(statusBeforeUiRefresh.active_probe.running === false, "active_probe 初始不应处于运行中");
    assert(statusBeforeUiRefresh.active_probe.total_runs === 0, "active_probe 初始 total_runs 应为 0");
    assert(statusBeforeUiRefresh.active_probe.warning_count === 0, "active_probe 初始 warning_count 应为 0");
    assert(statusBeforeUiRefresh.active_probe.violation_count === 0, "active_probe 初始 violation_count 应为 0");
    assert(
      Array.isArray(statusBeforeUiRefresh.active_probe.recent_samples),
      "active_probe.recent_samples 应为数组",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.warning_type_counts === "object" &&
        statusBeforeUiRefresh.active_probe.warning_type_counts !== null,
      "active_probe.warning_type_counts 应存在",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.violation_type_counts === "object" &&
        statusBeforeUiRefresh.active_probe.violation_type_counts !== null,
      "active_probe.violation_type_counts 应存在",
    );
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
    assert(uiHtml.includes('id="probeTargetFamily54Input"'), "管理页缺少 gpt-5.4 主动探针复选框");
    assert(uiHtml.includes('id="probeTargetFamily55Input"'), "管理页缺少 gpt-5.5 主动探针复选框");
    assert(uiHtml.includes('id="probeAutoEnabledInput"'), "管理页缺少自动探测开关");
    assert(uiHtml.includes('id="probeIntervalMinutesInput"'), "管理页缺少主动探针分钟频率输入框");
    assert(uiHtml.includes('id="probeRunButton"'), "管理页缺少立即探测按钮");
    assert(uiHtml.includes('id="interceptStreamingInput"'), "管理页缺少流式拦截复选框");
    assert(uiHtml.includes('id="interceptNonStreamingInput"'), "管理页缺少非流式拦截复选框");
    assert(uiHtml.includes('id="interceptModeValue"'), "管理页缺少当前拦截模式展示");
    assert(uiHtml.includes('id="guardRetryAttemptsInput"'), "管理页缺少网关内重试次数输入框");
    assert(uiHtml.includes("网关内重试次数"), "管理页缺少网关内重试次数标签");
    assert(uiHtml.includes("TG群："), "管理页缺少 TG 群入口文案");
    assert(uiHtml.includes('href="https://t.me/AI_INPUT_IM"'), "管理页缺少 TG 群链接");
    assert(
      uiHtml.indexOf('name="non_stream_status_code"') < uiHtml.indexOf('name="guard_retry_attempts"') &&
        uiHtml.indexOf('name="guard_retry_attempts"') < uiHtml.indexOf('name="log_match"'),
      "网关内重试次数应位于 non_stream_status_code 与 log_match 之间",
    );
    assert(!uiHtml.includes("516 命中次数"), "管理页不应再显示 516 命中次数卡片");
    assert(!uiHtml.includes("516 占比"), "管理页不应再显示 516 占比卡片");
    assert(uiHtml.includes("当前规则命中总数"), "管理页缺少当前规则命中总数卡片");
    assert(uiHtml.includes("实际拦截总数"), "管理页缺少实际拦截总数卡片");
    assert(uiHtml.includes("实际拦截占比"), "管理页缺少实际拦截占比卡片");
    const matchedStatsIndex = uiHtml.indexOf("当前规则命中总数");
    const blockedTotalStatsIndex = uiHtml.indexOf("实际拦截总数");
    const blockedRatioStatsIndex = uiHtml.indexOf("实际拦截占比");
    assert(
      matchedStatsIndex < blockedTotalStatsIndex && blockedTotalStatsIndex < blockedRatioStatsIndex,
      "管理页统计卡片顺序应为当前规则命中总数、实际拦截总数、实际拦截占比",
    );
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
    await new Promise((resolve) => setTimeout(resolve, 80));
    const brokenBypassLogText = await readFile(logPath, "utf8");
    assert(
      brokenBypassLogText.includes("[upstream-error] fetch failed after retry path=/v1/models"),
      "上游 fetch failed 应记录为 upstream-error 摘要日志",
    );
    assert(
      !brokenBypassLogText.includes("[error] TypeError: fetch failed"),
      "上游 fetch failed 不应记录为 gateway 内部 error 堆栈",
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

    const defaultModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      defaultModeStatus.metrics.matched_non_streaming_count === 8,
      `双开默认模式下非流式命中次数不正确: ${defaultModeStatus.metrics.matched_non_streaming_count}`,
    );
    assert(
      defaultModeStatus.metrics.blocked_non_streaming_count === 8,
      `双开默认模式下非流式拦截次数不正确: ${defaultModeStatus.metrics.blocked_non_streaming_count}`,
    );

    const invalidInterceptConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: false,
          intercept_non_streaming: false,
        }),
      },
    );
    const invalidInterceptConfigPayload = await invalidInterceptConfigResponse.json();
    assert(
      invalidInterceptConfigResponse.status === 400,
      `流式与非流式都关闭时后端应拒绝: ${invalidInterceptConfigResponse.status}`,
    );
    assert(
      `${invalidInterceptConfigPayload?.error?.message || ""}`.includes("流式与非流式至少选择一个"),
      "流式与非流式都关闭时后端应返回拦截目标校验错误",
    );

    const streamOnlyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: true,
          intercept_non_streaming: false,
        }),
      },
    );
    assert(streamOnlyConfigResponse.status === 200, `切换仅流式拦截失败: ${streamOnlyConfigResponse.status}`);
    const nonBlockedNonStreamResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        test_response_model: "gpt-5.4",
        test_reasoning_tokens: 516,
      }),
    });
    const nonBlockedNonStreamBody = await nonBlockedNonStreamResponse.json();
    assert(
      nonBlockedNonStreamResponse.status === 200,
      `仅流式模式下非流式命中应透传: ${nonBlockedNonStreamResponse.status}`,
    );
    assert(
      nonBlockedNonStreamBody?.usage?.output_tokens_details?.reasoning_tokens === 516,
      "仅流式模式下非流式命中透传体不正确",
    );
    const statusAfterStreamOnlyNonStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterStreamOnlyNonStream.metrics.matched_non_streaming_count === 9,
      `仅流式模式下非流式命中仍应计数: ${statusAfterStreamOnlyNonStream.metrics.matched_non_streaming_count}`,
    );
    assert(
      statusAfterStreamOnlyNonStream.metrics.blocked_non_streaming_count === 8,
      `仅流式模式下非流式透传不应增加拦截数: ${statusAfterStreamOnlyNonStream.metrics.blocked_non_streaming_count}`,
    );
    assert(
      statusAfterStreamOnlyNonStream.model_insights.consistency?.matched >= 1,
      "仅流式模式下非流式命中透传仍应进入模型一致性收口",
    );

    const nonStreamOnlyConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: false,
          intercept_non_streaming: true,
        }),
      },
    );
    assert(
      nonStreamOnlyConfigResponse.status === 200,
      `切换仅非流式拦截失败: ${nonStreamOnlyConfigResponse.status}`,
    );
    const observedOnlyStream = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        model: "gpt-5.4",
        stream: true,
        test_reasoning_tokens: 516,
        test_stream_models: ["gpt-5.4", "gpt-5.4"],
        test_stream_fingerprints: ["fp_same_observe", "fp_same_observe"],
        test_response_ids: ["resp_same_observe", "resp_same_observe"],
      },
    );
    assert(observedOnlyStream.status === 200, `仅非流式模式下流式命中应透传: ${observedOnlyStream.status}`);
    assert(observedOnlyStream.text.includes("hello"), "仅非流式模式下流式命中应保留正常 chunk");
    assert(observedOnlyStream.text.includes("[DONE]"), "仅非流式模式下流式命中应完整结束");
    assert(!observedOnlyStream.closedByError, "仅非流式模式下流式命中不应异常断开");
    const statusAfterObservedOnlyStream = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterObservedOnlyStream.metrics.matched_streaming_count === 1,
      `仅非流式模式下流式命中仍应计数: ${statusAfterObservedOnlyStream.metrics.matched_streaming_count}`,
    );
    assert(
      statusAfterObservedOnlyStream.metrics.blocked_streaming_count === 0,
      `仅非流式模式下流式透传不应增加流式拦截数: ${statusAfterObservedOnlyStream.metrics.blocked_streaming_count}`,
    );
    assert(
      !statusAfterObservedOnlyStream.model_insights.suspicious_samples?.some(
        (sample) => sample.path === "/responses" && sample.anomaly_type === "single_request_rebuild_suspected",
      ),
      "仅非流式模式下正常观察流式 516 不应生成 single_request_rebuild_suspected 可疑样本",
    );

    const bothModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_streaming: true,
          intercept_non_streaming: true,
        }),
      },
    );
    assert(bothModeConfigResponse.status === 200, `恢复双开拦截失败: ${bothModeConfigResponse.status}`);

    const zeroGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 0,
        }),
      },
    );
    assert(
      zeroGuardRetryConfigResponse.status === 200,
      `guard_retry_attempts=0 应保存成功: ${zeroGuardRetryConfigResponse.status}`,
    );
    const zeroGuardRetryStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      zeroGuardRetryStatus.config?.guard_retry_attempts === 0,
      "guard_retry_attempts=0 未在状态接口生效",
    );
    const zeroRetryKey = "non-stream-zero-retry-516";
    const zeroRetryResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test_sequence_key: zeroRetryKey,
        test_reasoning_sequence: [516],
      }),
    });
    const zeroRetryBody = await zeroRetryResponse.json();
    assert(
      zeroRetryResponse.status === 502,
      `guard_retry_attempts=0 命中规则应直接返回 502: ${zeroRetryResponse.status}`,
    );
    assert(
      zeroRetryBody?.error?.code === "reasoning_guard_triggered",
      "guard_retry_attempts=0 命中规则返回体不正确",
    );
    assert(
      upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === zeroRetryKey).length === 1,
      "guard_retry_attempts=0 命中规则不应触发内部重试",
    );
    const zeroRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      zeroRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=return_status_502",
        ),
      ),
      "guard_retry_attempts=0 命中规则日志应标记为 return_status_502",
    );
    const negativeGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: -1,
        }),
      },
    );
    assert(
      negativeGuardRetryConfigResponse.status === 400,
      `guard_retry_attempts=-1 应被拒绝: ${negativeGuardRetryConfigResponse.status}`,
    );
    const invalidGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: "abc",
        }),
      },
    );
    assert(
      invalidGuardRetryConfigResponse.status === 400,
      `guard_retry_attempts=abc 应被拒绝: ${invalidGuardRetryConfigResponse.status}`,
    );
    const oneGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 1,
        }),
      },
    );
    assert(
      oneGuardRetryConfigResponse.status === 200,
      `guard_retry_attempts=1 应保存成功: ${oneGuardRetryConfigResponse.status}`,
    );

    const statusBeforeGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const nonStreamRetryKey = "non-stream-516-then-128";
    const nonStreamRetryResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4",
        test_response_model: "gpt-5.4",
        test_sequence_key: nonStreamRetryKey,
        test_reasoning_sequence: [516, 128],
      }),
    });
    const nonStreamRetryBody = await nonStreamRetryResponse.json();
    assert(
      nonStreamRetryResponse.status === 200,
      `非流式命中后应由网关内部重试恢复为 200: ${nonStreamRetryResponse.status}`,
    );
    assert(
      nonStreamRetryBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
      "非流式命中后内部重试未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === nonStreamRetryKey).length === 2,
      "非流式命中后内部重试应向上游请求 2 次",
    );
    const nonStreamRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      nonStreamRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "非流式内部重试日志应标记为 internal_retry",
    );
    const statusAfterNonStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterNonStreamGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeGuardRetry.metrics.total_proxy_request_count + 2,
      "非流式内部重试应按每次上游尝试计入代理请求总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.inspected_response_count ===
        statusBeforeGuardRetry.metrics.inspected_response_count + 2,
      "非流式内部重试应按每次响应计入被检查响应总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.matched_response_count ===
        statusBeforeGuardRetry.metrics.matched_response_count + 1,
      "非流式内部重试首次命中应计入当前规则命中总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.blocked_response_count ===
        statusBeforeGuardRetry.metrics.blocked_response_count + 1,
      "非流式内部重试首次吞掉响应应计入实际拦截总数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.matched_non_streaming_count ===
        statusBeforeGuardRetry.metrics.matched_non_streaming_count + 1,
      "非流式内部重试首次命中应计入非流式命中次数",
    );
    assert(
      statusAfterNonStreamGuardRetry.metrics.blocked_non_streaming_count ===
        statusBeforeGuardRetry.metrics.blocked_non_streaming_count + 1,
      "非流式内部重试首次吞掉响应应计入非流式拦截次数",
    );

    const upstreamErrorKey = "real-upstream-429";
    const upstreamErrorResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test_sequence_key: upstreamErrorKey,
        test_error_status: 429,
        test_error_payload: {
          error: {
            type: "rate_limit_error",
            message: "too many requests",
          },
        },
      }),
    });
    const upstreamErrorBody = await upstreamErrorResponse.json();
    assert(upstreamErrorResponse.status === 429, `上游真实 429 应透传: ${upstreamErrorResponse.status}`);
    assert(upstreamErrorBody?.error?.type === "rate_limit_error", "上游真实 429 响应体应透传");
    assert(
      upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === upstreamErrorKey).length === 1,
      "上游真实 429 不应触发规则内部重试",
    );

    const statusBeforeExceededGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const exceededRetryKey = "non-stream-516-then-516";
    const exceededRetryResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test_sequence_key: exceededRetryKey,
        test_reasoning_sequence: [516, 516],
      }),
    });
    const exceededRetryBody = await exceededRetryResponse.json();
    assert(
      exceededRetryResponse.status === 502,
      `非流式连续命中超过上限后应返回拦截状态: ${exceededRetryResponse.status}`,
    );
    assert(
      exceededRetryBody?.error?.code === "reasoning_guard_triggered",
      "非流式连续命中超过上限后返回体不正确",
    );
    assert(
      upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === exceededRetryKey).length === 2,
      "非流式连续命中超过上限时应只请求 2 次上游",
    );
    const exceededRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      exceededRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "非流式连续命中超过上限的第一次命中日志应标记为 internal_retry",
    );
    assert(
      exceededRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] non-stream path=/responses reasoning_tokens=516 action=return_status_502",
        ),
      ),
      "非流式连续命中超过上限的最终命中日志应标记为 return_status_502",
    );
    const statusAfterExceededGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterExceededGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeExceededGuardRetry.metrics.total_proxy_request_count + 2,
      "非流式连续命中超过上限时代理请求总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.inspected_response_count ===
        statusBeforeExceededGuardRetry.metrics.inspected_response_count + 2,
      "非流式连续命中超过上限时被检查响应总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.matched_response_count ===
        statusBeforeExceededGuardRetry.metrics.matched_response_count + 2,
      "非流式连续命中超过上限时规则命中总数应增加 2",
    );
    assert(
      statusAfterExceededGuardRetry.metrics.blocked_response_count ===
        statusBeforeExceededGuardRetry.metrics.blocked_response_count + 2,
      "非流式连续命中超过上限时实际拦截总数应增加 2",
    );

    const statusBeforeStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const streamRetryKey = "stream-516-then-128";
    const streamRetryResponse = await readSseUntilClose(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        stream: true,
        test_sequence_key: streamRetryKey,
        test_reasoning_sequence: [516, 128],
      },
    );
    assert(
      streamRetryResponse.status === 200,
      `流式命中后应由网关内部重试恢复为 200: ${streamRetryResponse.status}`,
    );
    assert(streamRetryResponse.text.includes("[DONE]"), "流式内部重试未返回第二次正常 SSE");
    assert(!streamRetryResponse.text.includes("reasoning_guard_triggered"), "流式内部重试不应暴露首次拦截体");
    assert(
      upstream.responseRequests.filter((entry) => entry.body?.test_sequence_key === streamRetryKey).length === 2,
      "流式命中后内部重试应向上游请求 2 次",
    );
    const streamRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      streamRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[match] stream path=/responses reasoning_tokens=516 action=internal_retry remaining=1",
        ),
      ),
      "流式内部重试日志应标记为 internal_retry",
    );
    const statusAfterStreamGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterStreamGuardRetry.metrics.total_proxy_request_count ===
        statusBeforeStreamGuardRetry.metrics.total_proxy_request_count + 2,
      "流式内部重试应按每次上游尝试计入代理请求总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.inspected_response_count ===
        statusBeforeStreamGuardRetry.metrics.inspected_response_count + 2,
      "流式内部重试应按每次响应计入被检查响应总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.matched_response_count ===
        statusBeforeStreamGuardRetry.metrics.matched_response_count + 1,
      "流式内部重试首次命中应计入当前规则命中总数",
    );
    assert(
      statusAfterStreamGuardRetry.metrics.blocked_response_count ===
        statusBeforeStreamGuardRetry.metrics.blocked_response_count + 1,
      "流式内部重试首次吞掉响应应计入实际拦截总数",
    );

    const restoreDefaultGuardRetryConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      restoreDefaultGuardRetryConfigResponse.status === 200,
      `恢复 guard_retry_attempts=3 失败: ${restoreDefaultGuardRetryConfigResponse.status}`,
    );

    const recoveredResponse = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_fail_before_response_once: true }),
    });
    const recoveredBody = await recoveredResponse.json();
    assert(recoveredResponse.status === 200, `首次 fetch failed 后未自动恢复: ${recoveredResponse.status}`);
    assert(recoveredBody?.retry_attempt === 2, "首次 fetch failed 后未命中第二次上游请求");

    const failedResponsesProxy = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test_fail_before_response_always: true }),
    });
    const failedResponsesProxyBody = await failedResponsesProxy.json();
    assert(failedResponsesProxy.status === 502, `连续上游 fetch failed 后应返回 502: ${failedResponsesProxy.status}`);
    assert(
      failedResponsesProxyBody?.error?.type === "upstream_error" &&
        failedResponsesProxyBody?.error?.code === "upstream_fetch_failed",
      `连续上游 fetch failed 后应返回 upstream_error 摘要: ${JSON.stringify(failedResponsesProxyBody)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedResponsesProxyLogText = await readFile(logPath, "utf8");
    assert(
      failedResponsesProxyLogText.includes("[upstream-error] fetch failed after retry path=/responses"),
      "连续 /responses 上游 fetch failed 应记录 upstream-error 摘要日志",
    );
    assert(
      !failedResponsesProxyLogText.includes("[error] TypeError: fetch failed"),
      "连续 /responses 上游 fetch failed 不应记录 gateway 内部 error 堆栈",
    );

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
      Math.abs(
        statusWithModelInsights.model_insights.consistency?.match_ratio -
          statusWithModelInsights.model_insights.consistency?.matched /
            (statusWithModelInsights.model_insights.consistency?.matched +
              statusWithModelInsights.model_insights.consistency?.mismatched),
      ) < 1e-9,
      "声明一致率应只按 matched / (matched + mismatched) 计算，不应把 unknown 计入分母",
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
      familyBreakdown["gpt-5.4"]?.consistency?.total_checked === 11,
      `gpt-5.4 家族 total_checked 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.total_checked}`,
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.matched === 9,
      `gpt-5.4 家族 matched 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.matched}`,
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
      Math.abs(familyBreakdown["gpt-5.4"]?.consistency?.match_ratio - 9 / 10) < 1e-9,
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

    await mkdir(probeConfigDir, { recursive: true });
    await writeFile(
      probeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(probeConfigDir, "..", "state.json"),
      `${JSON.stringify({ codex_config_path: probeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(tempRoot, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    const probeConfig = {
      ...config,
      listen_port: probeGatewayPort,
      active_probe: {
        enabled: true,
        interval_ms: 60 * 60 * 1000,
        startup_delay_ms: 20,
        timeout_ms: 3000,
        target_families: ["gpt-5.5"],
        endpoint_candidates: ["/responses"],
        image_input: {
          enabled: true,
        },
        response_structure: {
          enabled: false,
          repeat_count: 2,
        },
        identity_consistency: {
          enabled: false,
          repeat_count: 2,
        },
        knowledge_cutoff: {
          enabled: false,
          max_questions: 3,
        },
        long_context: {
          enabled: true,
          target_input_tokens: 450000,
        },
      },
    };
    await writeFile(probeConfigPath, JSON.stringify(probeConfig, null, 2), "utf8");
    probeGateway = startGateway(probeConfigPath, probeLogPath);
    await waitForHealth(`http://127.0.0.1:${probeGatewayPort}${config.health_path}`);
    const probeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 1 &&
        Number(payload?.active_probe?.violation_count) >= 2,
      5000,
    );
    assert(
      probeStatus.active_probe.total_runs === 1,
      `主动探针首轮 total_runs 不正确: ${probeStatus.active_probe.total_runs}`,
    );
    assert(
      probeStatus.active_probe.violation_count === 2,
      `主动长上下文探针未计入 violation_count: ${probeStatus.active_probe.violation_count}`,
    );
    assert(
      probeStatus.active_probe.transport_error_count === 0,
      `主动探针不应把鉴权成功后的请求记成 transport_error: ${probeStatus.active_probe.transport_error_count}`,
    );
    assert(
      probeStatus.active_probe.violation_type_counts?.probe_low_context_family_violation === 1,
      "主动长上下文探针未记录 probe_low_context_family_violation",
    );
    assert(
      probeStatus.active_probe.violation_type_counts?.probe_image_input_violation === 1,
      "主动图片输入探针未记录 probe_image_input_violation",
    );
    assert(
      probeStatus.active_probe.last_target_model === "gpt-5.5",
      `主动探针目标模型不正确: ${probeStatus.active_probe.last_target_model}`,
    );
    assert(
      probeStatus.active_probe.last_target_family === "gpt-5.5",
      `主动探针目标家族不正确: ${probeStatus.active_probe.last_target_family}`,
    );
    assert(
      probeStatus.metrics.total_proxy_request_count === 0,
      `主动探针不应污染普通代理统计: ${probeStatus.metrics.total_proxy_request_count}`,
    );
    assert(
      Array.isArray(probeStatus.active_probe.recent_samples) &&
        probeStatus.active_probe.recent_samples.some(
          (sample) =>
            sample.probe_type === "long_context" &&
            sample.result_type === "probe_low_context_family_violation",
        ),
      "主动长上下文探针未保留违约样本",
    );
    const longContextProbeSample = probeStatus.active_probe.recent_samples.find(
      (sample) => sample.probe_type === "long_context",
    );
    assert(longContextProbeSample, "主动长上下文探针缺少样本");
    assert(
      longContextProbeSample.requested_input_tokens === 450000,
      `主动长上下文探针未记录 requested_input_tokens: ${longContextProbeSample.requested_input_tokens}`,
    );
    assert(
      longContextProbeSample.token_budget_source === "response_usage",
      `主动长上下文探针 token_budget_source 不正确: ${longContextProbeSample.token_budget_source}`,
    );
    assert(
      longContextProbeSample.evidence_logs.some((entry) => `${entry.message || ""}`.includes("target_input_tokens=450000")),
      "主动长上下文探针未保留 token budget 证据",
    );
    assert(
      probeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "image_input" &&
          sample.result_type === "probe_image_input_violation",
      ),
      "主动图片输入探针未保留违约样本",
    );
    const initialLongContextProbeRequests = upstream.probeRequests.filter(
      (entry) => entry.probeType === "long_context",
    );
    assert(
      initialLongContextProbeRequests.length >= 3,
      `主动长上下文探针首轮请求数过少: ${initialLongContextProbeRequests.length}`,
    );
    const initialBudgetProbeRequests = initialLongContextProbeRequests.filter(
      (entry) => `${entry.phase || ""}`.startsWith("budget"),
    );
    assert(
      initialBudgetProbeRequests.length >= 1,
      "主动长上下文探针首轮缺少预算请求",
    );
    assert(
      initialBudgetProbeRequests.every((entry) => Number(entry.units) >= 400000),
      `主动长上下文探针预算请求 unit_count 过小: ${JSON.stringify(initialBudgetProbeRequests.map((entry) => entry.units))}`,
    );
    assert(
      initialLongContextProbeRequests.every(
        (entry) =>
          typeof entry.headers.userAgent === "string" &&
          entry.headers.userAgent.trim() !== "" &&
          !/^node$/i.test(entry.headers.userAgent.trim()),
      ),
      `主动探针缺少明确 User-Agent: ${JSON.stringify(initialLongContextProbeRequests.map((entry) => entry.headers.userAgent))}`,
    );
    assert(
      initialLongContextProbeRequests.every(
        (entry) => entry.body?.reasoning?.effort === "medium",
      ),
      `主动探针默认 reasoning.effort 不正确: ${JSON.stringify(initialLongContextProbeRequests.map((entry) => entry.body?.reasoning?.effort ?? null))}`,
    );
    const primedProbeUserAgent = "CodexDesktop/active-probe-test";
    const primedResponse = await fetch(`http://127.0.0.1:${probeGatewayPort}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": primedProbeUserAgent,
        "openai-beta": "responses=v1",
        "x-stainless-lang": "js",
      },
      body: JSON.stringify({
        model: "gpt-5.5",
        reasoning: {
          effort: "high",
        },
        test_reasoning_tokens: 128,
      }),
    });
    assert(primedResponse.status === 200, `主动探针画像预热请求失败: ${primedResponse.status}`);
    const probeRequestCountBeforeManualDualRun = upstream.probeRequests.length;
    const manualDualProbeResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/probe/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          active_probe: {
            enabled: false,
            interval_ms: 5 * 60 * 1000,
            target_families: ["gpt-5.4", "gpt-5.5"],
          },
        }),
      },
    );
    assert(manualDualProbeResponse.status === 202, `双模型手动探针触发失败: ${manualDualProbeResponse.status}`);
    const manualDualProbePayload = await manualDualProbeResponse.json();
    assert(manualDualProbePayload.ok === true, "双模型手动探针响应 ok 不正确");
    assert(
      manualDualProbePayload.active_probe?.running === true,
      "双模型手动探针触发后应立即进入 running 状态",
    );
    const dualProbeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 2 &&
        payload?.active_probe?.running === false &&
        Array.isArray(payload?.active_probe?.recent_samples) &&
        payload.active_probe.recent_samples.length >= 4,
      5000,
    );
    assert(
      dualProbeStatus.active_probe.total_runs === 2,
      `双模型手动探针 total_runs 不正确: ${dualProbeStatus.active_probe.total_runs}`,
    );
    const dualProbeSamples = dualProbeStatus.active_probe.recent_samples.slice(0, 4);
    assert(
      dualProbeSamples.length === 4,
      `双模型手动探针最近样本应为 4 条，实际 ${dualProbeSamples.length}`,
    );
    assert(
      dualProbeSamples.filter((sample) => sample.target_model === "gpt-5.4" && sample.probe_type === "long_context").length === 1,
      "双模型手动探针缺少 gpt-5.4 long_context 样本",
    );
    assert(
      dualProbeSamples.filter((sample) => sample.target_model === "gpt-5.4" && sample.probe_type === "image_input").length === 1,
      "双模型手动探针缺少 gpt-5.4 image_input 样本",
    );
    assert(
      dualProbeSamples.filter((sample) => sample.target_model === "gpt-5.5" && sample.probe_type === "long_context").length === 1,
      "双模型手动探针缺少 gpt-5.5 long_context 样本",
    );
    assert(
      dualProbeSamples.filter((sample) => sample.target_model === "gpt-5.5" && sample.probe_type === "image_input").length === 1,
      "双模型手动探针缺少 gpt-5.5 image_input 样本",
    );
    assert(
      dualProbeSamples.every((sample) => sample.http_status === 400),
      `双模型手动探针状态码应为 400 违约，实际 ${JSON.stringify(dualProbeSamples.map((sample) => sample.http_status))}`,
    );
    assert(
      dualProbeSamples.every((sample) => sample.confidence === "high"),
      `双模型手动探针违约 confidence 应为 high，实际 ${JSON.stringify(dualProbeSamples.map((sample) => sample.confidence))}`,
    );
    const inheritedProbeRequests = upstream.probeRequests.slice(probeRequestCountBeforeManualDualRun);
    assert(
      inheritedProbeRequests.length >= 8,
      `双模型手动探针请求数过少: ${inheritedProbeRequests.length}`,
    );
    assert(
      inheritedProbeRequests.every((entry) => entry.headers.userAgent === primedProbeUserAgent),
      `主动探针未继承最近真实请求的 User-Agent: ${JSON.stringify(inheritedProbeRequests.map((entry) => entry.headers.userAgent))}`,
    );
    assert(
      inheritedProbeRequests.every((entry) => entry.body?.reasoning?.effort === "high"),
      `主动探针未继承最近真实请求的 reasoning.effort: ${JSON.stringify(inheritedProbeRequests.map((entry) => entry.body?.reasoning?.effort ?? null))}`,
    );
    const inheritedBudgetProbeRequests = inheritedProbeRequests.filter(
      (entry) => entry.probeType === "long_context" && `${entry.phase || ""}`.startsWith("budget"),
    );
    assert(
      inheritedBudgetProbeRequests.length >= 2,
      "双模型手动探针缺少长上下文预算请求",
    );
    assert(
      inheritedBudgetProbeRequests.every((entry) => Number(entry.units) >= 400000),
      `双模型手动探针预算请求 unit_count 过小: ${JSON.stringify(inheritedBudgetProbeRequests.map((entry) => entry.units))}`,
    );

    await mkdir(warningProbeConfigDir, { recursive: true });
    await writeFile(
      warningProbeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(warningProbeConfigDir, "..", "state.json"),
      `${JSON.stringify({ codex_config_path: warningProbeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(warningProbeRoot, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
      "utf8",
    );
    const warningProbeConfig = {
      ...config,
      listen_port: warningProbeGatewayPort,
      active_probe: {
        enabled: true,
        interval_ms: 60 * 60 * 1000,
        startup_delay_ms: 20,
        timeout_ms: 3000,
        target_families: ["gpt-5.5"],
        endpoint_candidates: ["/responses"],
        image_input: {
          enabled: false,
        },
        response_structure: {
          enabled: true,
          repeat_count: 2,
        },
        identity_consistency: {
          enabled: true,
          repeat_count: 2,
        },
        knowledge_cutoff: {
          enabled: true,
          max_questions: 3,
        },
        long_context: {
          enabled: false,
          target_input_tokens: 450000,
        },
      },
    };
    await writeFile(
      warningProbeConfigPath,
      JSON.stringify(warningProbeConfig, null, 2),
      "utf8",
    );
    warningProbeGateway = startGateway(warningProbeConfigPath, warningProbeLogPath);
    await waitForHealth(`http://127.0.0.1:${warningProbeGatewayPort}${config.health_path}`);
    const warningProbeStatus = await waitForStatusCondition(
      `http://127.0.0.1:${warningProbeGatewayPort}/__codex_retry_gateway/api/status`,
      (payload) =>
        Number(payload?.active_probe?.total_runs) >= 1 &&
        Number(payload?.active_probe?.warning_count) >= 3,
      5000,
    );
    assert(
      warningProbeStatus.active_probe.total_runs === 1,
      `辅助探针首轮 total_runs 不正确: ${warningProbeStatus.active_probe.total_runs}`,
    );
    assert(
      warningProbeStatus.active_probe.warning_count === 3,
      `辅助探针 warning_count 不正确: ${warningProbeStatus.active_probe.warning_count}`,
    );
    assert(
      warningProbeStatus.active_probe.violation_count === 0,
      `辅助探针不应计入 violation_count: ${warningProbeStatus.active_probe.violation_count}`,
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts?.probe_response_structure_warning === 1,
      "响应结构辅助探针未记录 probe_response_structure_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts?.probe_identity_consistency_warning === 1,
      "身份一致性辅助探针未记录 probe_identity_consistency_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts?.probe_knowledge_cutoff_warning === 1,
      "训练截止日期辅助探针未记录 probe_knowledge_cutoff_warning",
    );
    assert(
      warningProbeStatus.metrics.total_proxy_request_count === 0,
      `辅助探针不应污染普通代理统计: ${warningProbeStatus.metrics.total_proxy_request_count}`,
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "response_structure" &&
          sample.result === "warning" &&
          sample.result_type === "probe_response_structure_warning",
      ),
      "响应结构辅助探针未保留 warning 样本",
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "identity_consistency" &&
          sample.result === "warning" &&
          sample.result_type === "probe_identity_consistency_warning",
      ),
      "身份一致性辅助探针未保留 warning 样本",
    );
    assert(
      warningProbeStatus.active_probe.recent_samples.some(
        (sample) =>
          sample.probe_type === "knowledge_cutoff" &&
          sample.result === "warning" &&
          sample.result_type === "probe_knowledge_cutoff_warning",
      ),
      "训练截止日期辅助探针未保留 warning 样本",
    );

    const probeAuthPath = path.join(tempRoot, "auth.json");
    const probeAuthBackupContent = await readFile(probeAuthPath, "utf8");
    try {
      await writeFile(
        probeAuthPath,
        `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-blocked" }, null, 2)}\n`,
        "utf8",
      );
      const blockedProbeResponse = await fetch(
        `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/probe/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            active_probe: {
              enabled: false,
              interval_ms: 5 * 60 * 1000,
              target_families: ["gpt-5.4"],
            },
          }),
        },
      );
      assert(blockedProbeResponse.status === 202, `上游阻断探针触发失败: ${blockedProbeResponse.status}`);
      const blockedProbeStatus = await waitForStatusCondition(
        `http://127.0.0.1:${probeGatewayPort}/__codex_retry_gateway/api/status`,
        (payload) =>
          Number(payload?.active_probe?.total_runs) >= 3 &&
          payload?.active_probe?.running === false &&
          Number(payload?.active_probe?.transport_error_count) >= 2,
        5000,
      );
      assert(
        blockedProbeStatus.active_probe.transport_error_count === 2,
        `上游阻断探针 transport_error_count 不正确: ${blockedProbeStatus.active_probe.transport_error_count}`,
      );
      const blockedProbeSamples = blockedProbeStatus.active_probe.recent_samples.slice(0, 2);
      assert(
        blockedProbeSamples.length === 2,
        `上游阻断探针最近样本应为 2 条，实际 ${blockedProbeSamples.length}`,
      );
      assert(
        blockedProbeSamples.every((sample) => sample.result === "transport_error"),
        "上游阻断探针结果应为 transport_error",
      );
      assert(
        blockedProbeSamples.every((sample) => sample.http_status === 502),
        `上游阻断探针状态码应为 502，实际 ${JSON.stringify(blockedProbeSamples.map((sample) => sample.http_status))}`,
      );
      assert(
        blockedProbeSamples.every((sample) => sample.confidence == null),
        "上游阻断探针 confidence 应为空",
      );
      assert(
        blockedProbeSamples.every(
          (sample) =>
            typeof sample.error_excerpt === "string" &&
            sample.error_excerpt.includes("upstream_error"),
        ),
        "上游阻断探针应保留 upstream_error 摘要",
      );
      assert(
        blockedProbeSamples.every(
          (sample) =>
            Array.isArray(sample.evidence_logs) &&
            sample.evidence_logs.some((entry) => String(entry?.message || "").includes("finish type=")) &&
            sample.evidence_logs.some((entry) => String(entry?.message || "").includes("detail=upstream_error")),
        ),
        "上游阻断探针样本应保留结束日志和 upstream_error 细节",
      );
    } finally {
      await writeFile(probeAuthPath, probeAuthBackupContent, "utf8");
    }

    const unauthProbeGatewayPort = await getFreePort();
    const unauthProbeConfigDir = path.join(tempRoot, "unauth-probe", "config");
    const unauthProbeConfigPath = path.join(unauthProbeConfigDir, "config.json");
    const unauthProbeLogPath = path.join(tempRoot, "unauth-probe", "gateway.log");
    const unauthProbeCodexConfigPath = path.join(tempRoot, "unauth-probe", "codex-config.toml");
    const unauthProbeStatePath = path.join(tempRoot, "unauth-probe", "state.json");
    await mkdir(unauthProbeConfigDir, { recursive: true });
    await writeFile(
      unauthProbeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      unauthProbeStatePath,
      `${JSON.stringify({ codex_config_path: unauthProbeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    const authBackupPath = path.join(os.homedir(), ".codex", "auth.json");
    const authBackupContent = await readFile(authBackupPath, "utf8");
    await writeFile(authBackupPath, "{}\n", "utf8");
    let unauthProbeGateway = null;
    try {
      const unauthProbeConfig = {
        ...config,
        listen_port: unauthProbeGatewayPort,
        active_probe: {
          enabled: true,
          interval_ms: 60 * 60 * 1000,
          startup_delay_ms: 20,
          timeout_ms: 3000,
          target_families: ["gpt-5.5"],
          endpoint_candidates: ["/responses"],
          image_input: {
            enabled: true,
          },
          response_structure: {
            enabled: false,
            repeat_count: 2,
          },
          identity_consistency: {
            enabled: false,
            repeat_count: 2,
          },
          knowledge_cutoff: {
            enabled: false,
            max_questions: 3,
          },
          long_context: {
            enabled: true,
            target_input_tokens: 450000,
          },
        },
      };
      await writeFile(
        unauthProbeConfigPath,
        JSON.stringify(unauthProbeConfig, null, 2),
        "utf8",
      );
      unauthProbeGateway = startGateway(unauthProbeConfigPath, unauthProbeLogPath);
      await waitForHealth(`http://127.0.0.1:${unauthProbeGatewayPort}${config.health_path}`);
      const unauthProbeStatus = await waitForStatusCondition(
        `http://127.0.0.1:${unauthProbeGatewayPort}/__codex_retry_gateway/api/status`,
        (payload) =>
          Number(payload?.active_probe?.total_runs) >= 1 &&
          Array.isArray(payload?.active_probe?.recent_samples) &&
          payload.active_probe.recent_samples.length >= 2,
        5000,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every((sample) => sample.http_status === 401),
        `缺鉴权时主动探针状态码应为 401，实际 ${JSON.stringify(unauthProbeStatus.active_probe.recent_samples.map((sample) => sample.http_status))}`,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every((sample) => sample.result === "indeterminate"),
        "缺鉴权时主动探针结果应为 indeterminate",
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every((sample) => sample.confidence == null),
        `缺鉴权时主动探针 confidence 应为空，实际 ${JSON.stringify(unauthProbeStatus.active_probe.recent_samples.map((sample) => sample.confidence))}`,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) =>
            typeof sample.error_excerpt === "string" &&
            sample.error_excerpt.includes("authorization"),
        ),
        "缺鉴权时主动探针应保留错误摘要",
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) =>
            Array.isArray(sample.evidence_logs) &&
            sample.evidence_logs.some((entry) => String(entry?.message || "").includes("finish type=")) &&
            sample.evidence_logs.some((entry) => String(entry?.message || "").includes("detail=")),
        ),
        "缺鉴权时主动探针样本应保留结束日志和错误细节",
      );
    } finally {
      await writeFile(authBackupPath, authBackupContent, "utf8");
      if (unauthProbeGateway) {
        unauthProbeGateway.child.kill();
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    const logText = await readFile(logPath, "utf8");
    assert(
      !logText.includes("[error] TypeError: terminated"),
      "上游半路断流后不应记录 terminated error 日志",
    );

    process.stdout.write("PASS codex-retry-gateway e2e\n");
  } finally {
    gateway.child.kill();
    if (probeGateway) {
      probeGateway.child.kill();
    }
    if (warningProbeGateway) {
      warningProbeGateway.child.kill();
    }
    upstream.close();
    await once(upstream, "close");
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
