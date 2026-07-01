#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(`${stdout || ""}`);
    });
  });
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
  const payload = {
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
  if (parsed.test_omit_reasoning_tokens) {
    delete payload.usage.output_tokens_details.reasoning_tokens;
  }
  if (parsed.test_include_reasoning_item) {
    payload.output = [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  if (parsed.test_include_final_answer_only) {
    payload.output = [
      {
        type: "message",
        content: [{ type: "output_text", text: "visible final answer" }],
      },
    ];
  }
  return payload;
}

function extractLongContextProbeUnits(serializedInput) {
  const match = `${serializedInput || ""}`.match(
    /__crg_long_context_probe__ phase=([a-z0-9_]+) units=(\d+)/i,
  );
  if (!match) {
    return null;
  }
  return {
    phase: match[1],
    units: Number.parseInt(match[2], 10),
  };
}

function buildLongContextProbeResponsePayload(
  parsed,
  inputTokens,
  outputText = "OK",
) {
  const safeInputTokens = Math.max(
    0,
    Number.parseInt(`${inputTokens}`, 10) || 0,
  );
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
  if (
    Array.isArray(parsed.test_stream_models) &&
    parsed.test_stream_models.length > 0
  ) {
    return parsed.test_stream_models;
  }
  return [parsed.test_response_model ?? parsed.model ?? "gpt-5.4"];
}

function buildStreamFingerprints(parsed, count) {
  if (
    Array.isArray(parsed.test_stream_fingerprints) &&
    parsed.test_stream_fingerprints.length > 0
  ) {
    return parsed.test_stream_fingerprints;
  }
  return Array.from({ length: count }, (_, index) => `fp_stream_${index + 1}`);
}

function buildResponseIds(parsed, count) {
  if (
    Array.isArray(parsed.test_response_ids) &&
    parsed.test_response_ids.length > 0
  ) {
    return parsed.test_response_ids;
  }
  return Array.from(
    { length: count },
    (_, index) => `resp_stream_${index + 1}`,
  );
}

function buildStreamEventIds(parsed, count) {
  if (
    Array.isArray(parsed.test_stream_event_ids) &&
    parsed.test_stream_event_ids.length > 0
  ) {
    return parsed.test_stream_event_ids;
  }
  return Array.from({ length: count }, () => null);
}

function buildResponsesStreamChunks(parsed, reasoning) {
  const models = buildStreamModels(parsed);
  const fingerprints = buildStreamFingerprints(parsed, models.length);
  const responseIds = buildResponseIds(parsed, models.length);
  const eventIds = buildStreamEventIds(parsed, models.length);
  const finalModel =
    parsed.test_stream_final_model ?? models[models.length - 1];
  const finalFingerprint =
    fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_stream_1";
  const finalResponseId =
    responseIds[responseIds.length - 1] ?? responseIds[0] ?? "resp_stream_1";
  const serviceTier = parsed.test_service_tier ?? "priority";
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
  ];

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
    chunks.push(`data: ${JSON.stringify(deltaPayload)}\n\n`);
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
  const finalModel =
    parsed.test_stream_final_model ?? models[models.length - 1];
  const finalFingerprint =
    fingerprints[fingerprints.length - 1] ?? fingerprints[0] ?? "fp_chat_1";
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
    this.hidden = false;
    this.href = "";
    this.style = {};
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
    if (selector !== ".evidence-details[data-sample-key][open]") {
      return [];
    }
    const regex =
      /<details class="evidence-details" data-sample-key="([^"]+)" open>/g;
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

  setAttribute(name, value) {
    this[name] = value;
  }
}

async function verifyRenderedUiEvidenceDetailsBehavior(uiHtml) {
  const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
  assert(inlineScriptMatch, "管理页缺少内联脚本");

  const ids = [
    "configForm",
    "reasoningInput",
    "interceptRuleModeReasoningTokensInput",
    "interceptRuleModeFinalOnlyInput",
    "interceptStreamingInput",
    "interceptNonStreamingInput",
    "interceptModeValue",
    "endpointsInput",
    "statusCodeInput",
    "guardRetryAttemptsInput",
    "retryUpstreamCapacityErrorsInput",
    "logMatchInput",
    "probeTargetFamily54Input",
    "probeTargetFamily55Input",
    "probeAutoEnabledInput",
    "probeIntervalMinutesInput",
    "saveButton",
    "reasoningExportJsonButton",
    "reasoningExportCsvButton",
    "reasoningRangeTodayButton",
    "reasoningRangeWeekButton",
    "reasoningRangeApplyButton",
    "reasoningDateFromInput",
    "reasoningDateToInput",
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
    "reasoningTotalSamplesValue",
    "reasoningFinalOnlyRatioValue",
    "reasoningCommentaryRatioValue",
    "reasoningAvgDurationValue",
    "reasoningAvgOutputTpsValue",
    "reasoningAvgAdjustedTpsValue",
    "reasoningExportMeta",
    "reasoningExportProgress",
    "reasoningExportProgressFill",
    "reasoningExportProgressText",
    "reasoningExportDownloadLink",
    "reasoningRangeChip",
    "reasoningTopTokensChart",
    "reasoningOutputTpsChart",
    "reasoningByModelFamilyBody",
    "reasoningByEffortBody",
    "reasoningByFamilyEffortBody",
    "reasoningTokenTableLimitSelect",
    "reasoningCandidatePatternLimitSelect",
    "reasoningRecentSamplesLimitSelect",
    "reasoningByTokenBody",
    "reasoningCandidatePatternsBody",
    "reasoningRecentSamplesBody",
    "reasoningAnalysisModelFamilyInput",
    "reasoningAnalysisEffortInput",
    "reasoningAnalysisTokenInput",
    "reasoningAnalysisFinalOnlySelect",
    "reasoningAnalysisCommentarySelect",
    "reasoningAnalysisStatusSelect",
    "reasoningAnalysisIncludeRetriesInput",
    "reasoningAnalysisIncludeBlockedInput",
    "reasoningAnalyzeButton",
    "reasoningAnalysisValue",
    "reasoningAnalysisConclusion",
    "reasoningAnalysisCoverageBody",
    "reasoningAnalysisCandidateSummaryValue",
    "reasoningAnalysisBaselineValue",
    "historicalImportRunButton",
    "historicalImportProgress",
    "historicalImportProgressFill",
    "historicalImportProgressText",
    "historicalImportSummaryValue",
    "historicalImportAnalysisValue",
    "historicalImportAnalysisConclusion",
    "historicalImportCoverageBody",
    "historicalImportCandidateSummaryValue",
    "historicalImportBaselineValue",
    "historicalImportSourcesBody",
    "historicalImportCcModelsBody",
    "historicalImportCodexLogsBody",
    "historicalImportSessionsBody",
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
    ids.map((id) => [
      id,
      new FakeElement(id === "configForm" ? "form" : "div"),
    ]),
  );
  elements.statusCodeInput.value = "502";
  elements.guardRetryAttemptsInput.value = "3";
  elements.retryUpstreamCapacityErrorsInput.checked = true;
  elements.reasoningAnalysisTokenInput.value = "516";
  elements.reasoningAnalysisModelFamilyInput.value = "gpt-5.4,gpt-5.5";
  elements.reasoningAnalysisEffortInput.value = "high,medium";
  elements.reasoningAnalysisFinalOnlySelect.value = "true";
  elements.reasoningAnalysisCommentarySelect.value = "not_observed";
  elements.reasoningAnalysisStatusSelect.value = "any";
  elements.reasoningAnalysisIncludeRetriesInput.checked = true;
  elements.reasoningAnalysisIncludeBlockedInput.checked = true;

  const statusPayload = {
    listen: "http://127.0.0.1:4610",
    config: {
      upstream_base_url: "http://upstream.example",
      intercept_rule_mode: "reasoning_tokens",
      reasoning_equals: [516],
      intercept_streaming: true,
      intercept_non_streaming: true,
      endpoints: ["/responses"],
      non_stream_status_code: 502,
      guard_retry_attempts: 3,
      retry_upstream_capacity_errors: true,
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
      total_proxy_request_count: 15,
      inspected_response_count: 4,
      bypassed_proxy_request_count: 9,
      bypassed_proxy_path_counts: {
        "/v1/models": 2,
        "/assets/index-mL8x2mJx.js": 2,
        "/assets/vendor-misc-DB0Q8XAf.css": 2,
        "/login": 1,
        "/logo.png": 1,
        "/api/v1/settings/public": 1,
      },
      failed_proxy_request_count: 0,
      active_proxy_request_count: 2,
      active_proxy_path_counts: {
        "/responses": 2,
      },
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
  const reasoningBehaviorPayload = {
    summary: {
      total_samples: 4,
      final_answer_only_ratio: 0.5,
      commentary_present_ratio: 0.25,
      avg_duration_total_ms: 1200,
      avg_output_tps: 18.5,
      avg_reasoning_adjusted_tps: 42.25,
      wording:
        "统计结果只表示可观测结构信号，用于发现候选异常特征，不代表最终归因，也不证明模型内部没有思考。final answer only / commentary observed 不是互补关系，剩余样本可能是 tool call、reasoning item 或普通 output 组合。",
    },
    top_reasoning_tokens: [
      { value: 516, count: 2, ratio: 0.5 },
      { value: 128, count: 1, ratio: 0.25 },
    ],
    output_tps_buckets: [
      { label: "0-5", count: 0 },
      { label: "5-15", count: 1 },
      { label: "15-30", count: 3 },
    ],
    by_model_family: [
      {
        model_family: "gpt-5.5",
        count: 3,
        ratio: 0.75,
        final_answer_only_ratio: 2 / 3,
        commentary_present_ratio: 1 / 3,
        avg_duration_total_ms: 1050,
        avg_output_tps: 19,
        top_reasoning_tokens: [
          { value: 516, count: 2 },
          { value: 128, count: 1 },
        ],
      },
      {
        model_family: "gpt-5.4",
        count: 1,
        ratio: 0.25,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1650,
        avg_output_tps: 14,
        top_reasoning_tokens: [{ value: 128, count: 1 }],
      },
    ],
    by_reasoning_effort: [
      {
        reasoning_effort: "high",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 980,
        avg_reasoning_adjusted_tps: 41,
        top_reasoning_tokens: [{ value: 516, count: 2 }],
      },
      {
        reasoning_effort: "medium",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0.5,
        avg_duration_total_ms: 1420,
        avg_reasoning_adjusted_tps: 33,
        top_reasoning_tokens: [{ value: 128, count: 2 }],
      },
    ],
    by_model_family_and_effort: [
      {
        group_key: "gpt-5.5|high",
        group_label: "gpt-5.5 / high",
        model_family: "gpt-5.5",
        reasoning_effort: "high",
        count: 2,
        ratio: 0.5,
        final_answer_only_ratio: 0.5,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 980,
        avg_output_tps: 21,
        top_reasoning_tokens: [{ value: 516, count: 2 }],
      },
      {
        group_key: "gpt-5.4|medium",
        group_label: "gpt-5.4 / medium",
        model_family: "gpt-5.4",
        reasoning_effort: "medium",
        count: 1,
        ratio: 0.25,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1650,
        avg_output_tps: 14,
        top_reasoning_tokens: [{ value: 128, count: 1 }],
      },
    ],
    by_reasoning_token: [
      {
        value: 516,
        count: 2,
        final_answer_only_ratio: 1,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 900,
        avg_output_tps: 21,
        last_seen_at: "2026-06-28T03:21:00.000Z",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        value: 7000 + index,
        count: 1,
        final_answer_only_ratio: 0,
        commentary_present_ratio: 0,
        avg_duration_total_ms: 1000 + index,
        avg_output_tps: 10 + index,
        last_seen_at: "2026-06-28T03:20:00.000Z",
      })),
    ],
    candidate_patterns: [
      {
        pattern_key: "reasoning=516|final_answer_only|commentary_not_observed",
        count: 2,
        ratio: 0.5,
        avg_duration_total_ms: 900,
        avg_output_tps: 21,
        last_seen_at: "2026-06-28T03:21:00.000Z",
        status: "observe_only",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        pattern_key: `candidate-extra-${index}`,
        count: 1,
        ratio: 0.01,
        avg_duration_total_ms: 1200 + index,
        avg_output_tps: 12 + index,
        avg_time_normalization_deviation: 0.1 + index / 100,
        last_seen_at: "2026-06-28T03:20:00.000Z",
        status: "observe_only",
      })),
    ],
    recent_samples: [
      {
        ts: "2026-06-28T03:21:00.000Z",
        path: "/responses",
        request_model: "gpt-5.5",
        effective_local_model_family: "gpt-5.5",
        request_reasoning_effort: "high",
        reasoning_tokens: 516,
        output_tokens: 128,
        duration_total_ms: 900,
        output_tps: 21,
        upstream_http_status: 200,
        client_http_status: 502,
        final_answer_only: true,
        has_commentary: false,
        commentary_observed: false,
        matched_current_rule: true,
        blocked_by_gateway: true,
        final_action: "blocked",
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        ts: "2026-06-28T03:20:00.000Z",
        path: `/responses/recent-extra-${index}`,
        request_model: `recent-extra-${index}`,
        effective_local_model_family: "gpt-5.5",
        request_reasoning_effort: "medium",
        reasoning_tokens: 128 + index,
        output_tokens: 256 + index,
        duration_total_ms: 1400 + index,
        output_tps: 16 + index,
        upstream_http_status: 200,
        client_http_status: 200,
        final_answer_only: false,
        has_commentary: true,
        commentary_observed: true,
        matched_current_rule: false,
        blocked_by_gateway: false,
        final_action: "passed",
      })),
    ],
  };
  const reasoningAnalysisPayload = {
    ok: true,
    analysis_profile: "516_candidate_review_v1",
    analysis_value: "valuable",
    conclusion: "candidate",
    field_coverage: {
      reasoning_tokens: 1,
      final_answer_only: 1,
      commentary_observed: 1,
      duration_total_ms: 1,
      output_tokens: 1,
      model_family: 1,
      reasoning_effort: 1,
    },
    candidate_summary: {
      candidate_count: 2,
      candidate_ratio: 0.5,
      reasoning_516_count: 2,
      commentary_not_observed_count: 2,
      last_seen_at: "2026-06-28T03:21:00.000Z",
    },
    baseline_comparison: {
      baseline_count: 2,
      candidate_avg_time_normalization_deviation: 0.82,
      baseline_avg_time_normalization_deviation: 0.13,
    },
    samples_preview: [],
  };
  const fetchCalls = [];
  const fetchBodies = [];
  const exportJobs = new Map();
  const historicalImportJobs = new Map();
  let runProbeRequestCount = 0;
  let historicalImportRunCount = 0;
  let locationReloadCount = 0;
  const openedUrls = [];

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
    if (String(url).includes("/api/analytics/reasoning/export/jobs/")) {
      const urlText = String(url);
      const jobId = decodeURIComponent(
        urlText.split("/api/analytics/reasoning/export/jobs/")[1]?.split("/")[0] || "",
      );
      const job = exportJobs.get(jobId) || {
        job_id: jobId,
        status: "completed",
        progress: { processed_days: 40, total_days: 40, percent: 1 },
        download_url: `/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(jobId)}/download`,
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, export_job: job };
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning/export")) {
      const jobId = "ui-export-job-1";
      const job = {
        job_id: jobId,
        status: "running",
        format: String(url).includes("format=csv") ? "csv" : "json",
        progress: { processed_days: 0, total_days: 40, percent: 0 },
        download_url: null,
      };
      exportJobs.set(jobId, {
        ...job,
        status: "completed",
        progress: { processed_days: 40, total_days: 40, percent: 1 },
        download_url: `/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(jobId)}/download`,
      });
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            ok: true,
            export_job: job,
            message: "已创建后台导出任务，可以继续正常使用 gateway。",
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning/analyze")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return reasoningAnalysisPayload;
        },
      };
    }
    if (String(url).includes("/api/analytics/reasoning")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return reasoningBehaviorPayload;
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/analyze")) {
      const job = historicalImportJobs.get("ui-import-job-1") || null;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            ...(job?.feature_analysis || {
              analysis_profile: "516_candidate_review_v1",
              analysis_value: "no_analysis_value",
              conclusion: "no_analysis_value",
              field_coverage: {},
              candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
              baseline_comparison: { baseline_count: 0 },
              samples_preview: [],
            }),
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/jobs/")) {
      const urlText = String(url);
      const jobId = decodeURIComponent(
        urlText.split("/api/analytics/imports/jobs/")[1]?.split("/")[0] || "",
      );
      const job = historicalImportJobs.get(jobId) || {
        job_id: jobId,
        status: "completed",
        progress: {
          processed_sources: 3,
          total_sources: 3,
          percent: 1,
          current_step: "completed",
        },
        summary: {
          source_count: 3,
          total_requests: 165965,
          successful_requests: 150000,
          failed_requests: 15965,
          total_input_tokens: 1234567,
          total_output_tokens: 765432,
          avg_latency_ms: 1880,
          codex_log_rows: 276092,
          session_file_count: 2000,
          session_total_bytes: 987654321,
        },
        preflight: {
          analysis_value: "no_analysis_value",
          can_build_reasoning_features: false,
          can_build_candidate_patterns: false,
          missing_core_fields: [
            "reasoning_tokens",
            "final_answer_only",
            "commentary_observed",
          ],
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          decision_reason:
            "缺少 reasoning 行为核心结构字段，历史数据无分析价值。",
        },
        feature_analysis: {
          ok: true,
          analysis_profile: "516_candidate_review_v1",
          analysis_value: "no_analysis_value",
          conclusion: "no_analysis_value",
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
          baseline_comparison: { baseline_count: 0 },
          samples_preview: [],
        },
        sources: [
          {
            source_type: "cc_switch_sqlite",
            path: "C:/Users/dashuai/.cc-switch/cc-switch.db",
            status: "completed",
            row_count: 165965,
          },
          {
            source_type: "codex_logs_sqlite",
            path: "C:/Users/dashuai/.codex/sqlite/logs_2.sqlite",
            status: "completed",
            row_count: 276092,
          },
        ],
        cc_switch: {
          by_model: [
            {
              model: "gpt-5.5",
              count: 1000,
              success_count: 900,
              failure_count: 100,
              avg_duration_ms: 2100,
              input_tokens: 500000,
              output_tokens: 200000,
            },
          ],
        },
        codex_logs: {
          by_level: [{ level: "INFO", count: 200000 }],
          keyword_hits: [{ keyword: "reasoning_tokens", count: 128 }],
        },
        sessions: {
          file_count: 2000,
          total_bytes: 987654321,
          top_files: [
            {
              path: "C:/Users/dashuai/.codex/sessions/2026/06/demo.jsonl",
              bytes: 123456789,
              modified_at: "2026-06-30T12:00:00.000Z",
            },
          ],
        },
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return { ok: true, import_job: job };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/run")) {
      historicalImportRunCount += 1;
      const jobId = "ui-import-job-1";
      const job = {
        job_id: jobId,
        status: "running",
        progress: {
          processed_sources: 0,
          total_sources: 3,
          percent: 0,
          current_step: "扫描历史数据源",
        },
        summary: null,
      };
      historicalImportJobs.set(jobId, {
        ...job,
        status: "completed",
        progress: {
          processed_sources: 3,
          total_sources: 3,
          percent: 1,
          current_step: "completed",
        },
        summary: {
          source_count: 3,
          total_requests: 165965,
          successful_requests: 150000,
          failed_requests: 15965,
          total_input_tokens: 1234567,
          total_output_tokens: 765432,
          avg_latency_ms: 1880,
          codex_log_rows: 276092,
          session_file_count: 2000,
          session_total_bytes: 987654321,
        },
        preflight: {
          analysis_value: "no_analysis_value",
          can_build_reasoning_features: false,
          can_build_candidate_patterns: false,
          missing_core_fields: [
            "reasoning_tokens",
            "final_answer_only",
            "commentary_observed",
          ],
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          decision_reason:
            "缺少 reasoning 行为核心结构字段，历史数据无分析价值。",
        },
        feature_analysis: {
          ok: true,
          analysis_profile: "516_candidate_review_v1",
          analysis_value: "no_analysis_value",
          conclusion: "no_analysis_value",
          field_coverage: {
            reasoning_tokens: 0,
            final_answer_only: 0,
            commentary_observed: 0,
            duration_total_ms: 1,
            output_tokens: 1,
            model_family: 1,
            reasoning_effort: 0,
          },
          candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
          baseline_comparison: { baseline_count: 0 },
          samples_preview: [],
        },
        sources: [
          {
            source_type: "cc_switch_sqlite",
            path: "C:/Users/dashuai/.cc-switch/cc-switch.db",
            status: "completed",
            row_count: 165965,
          },
        ],
        cc_switch: {
          by_model: [
            {
              model: "gpt-5.5",
              count: 1000,
              success_count: 900,
              failure_count: 100,
              avg_duration_ms: 2100,
              input_tokens: 500000,
              output_tokens: 200000,
            },
          ],
        },
        codex_logs: {
          by_level: [{ level: "INFO", count: 200000 }],
          keyword_hits: [{ keyword: "reasoning_tokens", count: 128 }],
        },
        sessions: {
          file_count: 2000,
          total_bytes: 987654321,
          top_files: [
            {
              path: "C:/Users/dashuai/.codex/sessions/2026/06/demo.jsonl",
              bytes: 123456789,
              modified_at: "2026-06-30T12:00:00.000Z",
            },
          ],
        },
      });
      return {
        ok: true,
        status: 202,
        async json() {
          return {
            ok: true,
            message: "历史导入分析已在后台开始，可以继续正常使用 gateway。",
            import_job: job,
          };
        },
      };
    }
    if (String(url).includes("/api/analytics/imports/latest")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            ok: true,
            import_job: historicalImportJobs.get("ui-import-job-1") || null,
          };
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
          submitted.active_probe?.interval_ms ??
          statusPayload.active_probe?.interval_ms,
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
      open(url) {
        openedUrls.push(String(url));
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

  assert(
    typeof sandbox.renderSuspiciousSamples === "function",
    "管理页未暴露 renderSuspiciousSamples",
  );
  assert(
    typeof sandbox.buildSampleKey === "function",
    "管理页未暴露 buildSampleKey",
  );
  const expectedLogLine = `${new Date("2026-06-28T03:18:23.000Z").toLocaleString("zh-CN", { hour12: false })} demo log`;
  assert(
    elements.logsOutput.textContent.includes(expectedLogLine),
    "实时日志应显示与系统时间一致的本地时间",
  );
  assert(
    !elements.logsOutput.textContent.includes(
      "2026-06-28T03:18:23.000Z demo log",
    ),
    "实时日志不应直接显示原始 UTC 时间串",
  );
  assert(
    elements.statsFootnote.textContent.includes("/v1/models"),
    "运行状态脚注应提示未纳入检查的透传路径",
  );
  assert(
    elements.statsFootnote.textContent.includes("其余 3 项"),
    "运行状态脚注应对过多透传路径做摘要收敛",
  );
  assert(
    !elements.statsFootnote.textContent.includes("/api/v1/settings/public"),
    "运行状态脚注不应把所有透传路径完整展开",
  );
  assert(
    elements.statsFootnote.textContent.includes("/responses x2"),
    "运行状态脚注应继续提示进行中的代理请求路径",
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
  assert(
    elements.probeTargetFamily54Input.checked === true,
    "主动探针未回填 gpt-5.4 复选框",
  );
  assert(
    elements.probeTargetFamily55Input.checked === true,
    "主动探针未回填 gpt-5.5 复选框",
  );
  assert(
    elements.probeAutoEnabledInput.checked === true,
    "主动探针未回填自动探测开关",
  );
  assert(
    elements.probeIntervalMinutesInput.value === "10",
    "主动探针未回填分钟频率",
  );
  assert(
    elements.interceptStreamingInput.checked === true,
    "管理页未回填流式拦截开关",
  );
  assert(
    elements.interceptNonStreamingInput.checked === true,
    "管理页未回填非流式拦截开关",
  );
  assert(
    elements.guardRetryAttemptsInput.value === "3",
    "管理页未回填网关内重试次数",
  );
  assert(
    elements.retryUpstreamCapacityErrorsInput.checked === true,
    "管理页未回填上游 capacity 错误内重试开关",
  );
  assert(
    elements.interceptModeValue.textContent.includes("流式+非流式"),
    "管理页未显示双开拦截模式",
  );
  assert(
    elements.matchedCountValue.textContent === "2",
    "管理页未展示当前规则命中总数",
  );
  assert(
    elements.blockedCountValue.textContent === "1",
    "管理页未展示实际拦截总数",
  );
  assert(
    elements.blockedRatioValue.textContent === "25.00%",
    "管理页未展示实际拦截占比",
  );
  assert(
    elements.matchedStreamingCountValue.textContent === "1",
    "管理页未展示流式命中次数",
  );
  assert(
    elements.matchedNonStreamingCountValue.textContent === "1",
    "管理页未展示非流式命中次数",
  );
  assert(
    elements.blockedStreamingCountValue.textContent === "1",
    "管理页未展示流式拦截次数",
  );
  assert(
    elements.blockedNonStreamingCountValue.textContent === "0",
    "管理页未展示非流式拦截次数",
  );
  assert(
    elements.reasoningTotalSamplesValue.textContent === "4",
    "reasoning 行为统计未展示样本总数",
  );
  assert(
    elements.reasoningFinalOnlyRatioValue.textContent === "50.00%",
    "reasoning 行为统计未展示 final_answer only 占比",
  );
  assert(
    elements.reasoningCommentaryRatioValue.textContent === "25.00%",
    "reasoning 行为统计未展示 commentary observed 占比",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("候选异常特征"),
    "reasoning 行为统计未展示风险说明",
  );
  assert(
    uiHtml.includes("final answer only") && uiHtml.includes("commentary observed"),
    "reasoning 大盘 UI 应显示 final answer only / commentary observed 标准特征词",
  );
  assert(
    uiHtml.includes("运行特征分析") &&
      uiHtml.includes("analysis_value") &&
      uiHtml.includes("field_coverage") &&
      uiHtml.includes("conclusion"),
    "reasoning 大盘缺少特征分析入口或分析结果字段",
  );
  assert(
    uiHtml.includes('class="range-bar reasoning-range-toolbar"'),
    "reasoning 时间筛选和导出按钮应合并为同一行工具栏",
  );
  const reasoningToolbarMatch = uiHtml.match(
    /<div class="range-bar reasoning-range-toolbar">([\s\S]*?)<\/div>\s*<p class="reasoning-subtitle">特征分析条件<\/p>/,
  );
  assert(reasoningToolbarMatch, "reasoning 紧凑工具栏结构不正确");
  assert(
    [
      "reasoningDateFromInput",
      "reasoningDateToInput",
      "reasoningRangeTodayButton",
      "reasoningRangeWeekButton",
      "reasoningRangeApplyButton",
      "reasoningExportJsonButton",
      "reasoningExportCsvButton",
    ].every((id) => reasoningToolbarMatch[1].includes(id)),
    "reasoning 时间筛选和导出控件应在同一个工具栏内",
  );
  assert(
    uiHtml.includes(".reasoning-range-toolbar") &&
      uiHtml.includes("repeat(5, auto)") &&
      uiHtml.includes("font-size: 12px") &&
      uiHtml.includes(".reasoning-range-toolbar :is(input, button)") &&
      uiHtml.includes("min-height: 36px") &&
      uiHtml.includes("padding: 7px 12px"),
    "reasoning 时间筛选工具栏控件应使用紧凑尺寸",
  );
  assert(
    uiHtml.includes('id="sideNav"') &&
      uiHtml.includes('class="side-nav"') &&
      uiHtml.includes("快速导航"),
    "管理页缺少左侧快速导航",
  );
  assert(
    [
      'href="#topSection"',
      'href="#statusSection"',
      'href="#rulesSection"',
      'href="#reasoningBehaviorSection"',
      'href="#historicalImportSection"',
      'href="#modelSection"',
      'href="#probeSection"',
      'href="#logsSection"',
    ].every((anchor) => uiHtml.includes(anchor)),
    "侧边导航缺少关键功能区锚点",
  );
  assert(
    uiHtml.includes(".side-nav") &&
      uiHtml.includes("position: fixed") &&
      uiHtml.includes("top: 28px") &&
      uiHtml.includes("scroll-margin-top") &&
      uiHtml.includes("@media (max-width: 1339px)"),
    "侧边导航应固定在桌面侧边、对齐主内容顶部，并在窄屏退化",
  );
  assert(
    uiHtml.includes("width: 128px") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes('html[data-theme="dark"] .side-nav-title') &&
      uiHtml.includes("color: #9fb2c8") &&
      uiHtml.includes("#0f1d2f") &&
      !uiHtml.includes("rgba(32, 230, 195, 0.1) 0, rgba(32, 230, 195, 0.1) 1px"),
    "侧边导航暗色配色应贴合页面，不应使用突兀亮青色斜纹或标题色",
  );
  assert(
    uiHtml.includes("max-width: 1080px") &&
      uiHtml.includes('<div class="shell">'),
    "新增导航不应改变原主体 shell 布局",
  );
  assert(
    uiHtml.includes("预检并分析"),
    "历史导入按钮应升级为预检并分析",
  );
  assert(
    uiHtml.includes("historical-import-control-stack") &&
      uiHtml.includes("historical-import-status") &&
      uiHtml.includes("historical-import-status-text") &&
      uiHtml.includes('id="historicalImportProgress" data-progress-active="false"'),
    "历史导入预检区应使用专用状态组件布局",
  );
  assert(
    uiHtml.includes(".historical-import-status") &&
      uiHtml.includes("justify-content: center") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes('.historical-import-status[data-progress-active="false"] .bar-row') &&
      uiHtml.includes("display: none"),
    "历史导入状态组件应居中显示文字，并在未开始时隐藏空进度条",
  );
  assert(
    [
      "reasoningAnalysisModelFamilyInput",
      "reasoningAnalysisEffortInput",
      "reasoningAnalysisTokenInput",
      "reasoningAnalysisFinalOnlySelect",
      "reasoningAnalysisCommentarySelect",
      "reasoningAnalysisStatusSelect",
      "reasoningAnalyzeButton",
    ].every((id) => uiHtml.includes(id)),
    "reasoning 行为统计缺少分析条件控件",
  );
  assert(
    !uiHtml.includes("<label>commentary</label>") &&
      !uiHtml.includes("<th>commentary</th>"),
    "reasoning 大盘 UI 不应把 commentary observed 简写成 commentary",
  );
  assert(
    !uiHtml.includes("仅最终答案结构占比") &&
      !uiHtml.includes("可观测 commentary 阶段占比"),
    "reasoning 大盘 UI 不应把解释性中文长标签放进指标名",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("可观测结构信号") &&
      elements.reasoningExportMeta.textContent.includes("不证明模型内部没有思考"),
    "reasoning 大盘风险说明应解释 commentary/final only 口径",
  );
  assert(
    elements.reasoningExportMeta.textContent.includes("不是互补关系") &&
      elements.reasoningExportMeta.textContent.includes("tool call") &&
      elements.reasoningExportMeta.textContent.includes("reasoning item"),
    "reasoning 大盘风险说明应解释 final answer only/commentary observed 不是互补项",
  );
  assert(
    elements.reasoningRangeChip.textContent.includes("当前时间窗：默认最近窗口"),
    "reasoning 时间窗状态未明确展示默认范围",
  );
  assert(
    uiHtml.includes('class="range-chip range-status-chip" id="reasoningRangeChip"') &&
      /\.range-status-chip\s*\{\s*color:\s*var\(--muted\);\s*background:\s*rgba\(148,\s*163,\s*184,\s*0\.12\);\s*border:\s*1px solid rgba\(148,\s*163,\s*184,\s*0\.2\);\s*box-shadow:\s*none;\s*\}/.test(
        uiHtml,
      ) &&
      /html\[data-theme="dark"\]\s*\.range-status-chip\s*\{\s*color:\s*#cbd5e1;\s*background:\s*rgba\(148,\s*163,\s*184,\s*0\.12\);\s*border-color:\s*rgba\(148,\s*163,\s*184,\s*0\.22\);\s*\}/.test(
        uiHtml,
      ),
    "reasoning 时间窗状态应弱化为状态提示，避免像可点击按钮",
  );
  assert(
    /\.coverage-table-wrap\s*\{\s*width:\s*100%;\s*max-width:\s*none;\s*margin:\s*0;\s*overflow-x:\s*hidden;\s*\}/.test(
      uiHtml,
    ) &&
      uiHtml.includes(".coverage-table-wrap table") &&
      uiHtml.includes("min-width: 0") &&
      uiHtml.includes("width: 100%") &&
      uiHtml.includes("table-layout: fixed") &&
      uiHtml.includes(".coverage-table-wrap :is(th, td)") &&
      uiHtml.includes("text-align: center") &&
      uiHtml.includes("vertical-align: middle"),
    "reasoning field_coverage 表格应铺满所在内容区，避免太窄突兀",
  );
  assert(
    uiHtml.includes("range-chip-rail") &&
      uiHtml.includes("justify-content: center") &&
      uiHtml.includes("gap: 10px") &&
      uiHtml.includes(".range-chip-rail #reasoningExportProgress") &&
      uiHtml.includes("width: min(100%, 440px)") &&
      uiHtml.includes('<div class="range-chip-rail">'),
    "reasoning 状态 chip 应整体居中且宽度协调，避免组件挤在一起",
  );
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("516"),
    "reasoning token 聚合表未渲染 516 行",
  );
  assert(
    uiHtml.includes('id="reasoningTokenTableLimitSelect"') &&
      uiHtml.includes('id="reasoningCandidatePatternLimitSelect"') &&
      uiHtml.includes('id="reasoningRecentSamplesLimitSelect"') &&
      uiHtml.includes("scroll-table-wrap"),
    "reasoning 行为统计表缺少显示数量选择或滚动容器",
  );
  assert(
    uiHtml.includes("white-space: nowrap") &&
      !uiHtml.includes(".scroll-table-wrap th") &&
      !uiHtml.includes("position: sticky"),
    "reasoning token 滚动表不应使用 sticky 表头，避免表头浮层覆盖第一行数据",
  );
  assert(
    uiHtml.includes(".scroll-table-wrap table") &&
      uiHtml.includes("width: max-content") &&
      uiHtml.includes(".scroll-table-wrap :is(th, td)"),
    "reasoning 滚动表应让内容撑出横向滚动，避免宽表被挤压换行",
  );
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("7008") &&
      !elements.reasoningByTokenBody.innerHTML.includes("7009"),
    "reasoning token 聚合表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningTokenTableLimitSelect.value = "20";
  elements.reasoningTokenTableLimitSelect.emit("change", {});
  assert(
    elements.reasoningByTokenBody.innerHTML.includes("7011"),
    "reasoning token 聚合表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningByModelFamilyBody.innerHTML.includes("gpt-5.5"),
    "reasoning 模型家族聚合表未渲染 gpt-5.5 行",
  );
  assert(
    elements.reasoningByModelFamilyBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByModelFamilyBody.innerHTML.includes("128 x1"),
    "reasoning 模型家族聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningByEffortBody.innerHTML.includes("high"),
    "reasoning 思考等级聚合表未渲染 high 行",
  );
  assert(
    elements.reasoningByEffortBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByEffortBody.innerHTML.includes("128 x1"),
    "reasoning 思考等级聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningByFamilyEffortBody.innerHTML.includes("gpt-5.5 / high"),
    "reasoning 模型+思考等级聚合表未渲染组合行",
  );
  assert(
    elements.reasoningByFamilyEffortBody.innerHTML.includes("516 x2") &&
      !elements.reasoningByFamilyEffortBody.innerHTML.includes("128 x1"),
    "reasoning 模型+思考等级聚合表不应把 count=1 的低频 token 显示为高频 token",
  );
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("observe_only"),
    "候选特征组合表未渲染 observe_only 状态",
  );
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-8") &&
      !elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-9"),
    "候选特征组合表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningCandidatePatternLimitSelect.value = "20";
  elements.reasoningCandidatePatternLimitSelect.emit("change", {});
  assert(
    elements.reasoningCandidatePatternsBody.innerHTML.includes("candidate-extra-11"),
    "候选特征组合表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("blocked"),
    "reasoning 最近样本表未渲染最终动作",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("high"),
    "reasoning 最近样本表未渲染思考等级",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("502"),
    "reasoning 最近样本表未渲染客户端状态",
  );
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-8") &&
      !elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-9"),
    "reasoning 最近样本表默认应只显示 10 行，避免页面过长",
  );
  elements.reasoningRecentSamplesLimitSelect.value = "20";
  elements.reasoningRecentSamplesLimitSelect.emit("change", {});
  assert(
    elements.reasoningRecentSamplesBody.innerHTML.includes("recent-extra-11"),
    "reasoning 最近样本表选择 20 后应显示更多行",
  );
  assert(
    elements.reasoningTopTokensChart.innerHTML.includes("token 516"),
    "reasoning 高频 token 图表未渲染",
  );
  assert(
    typeof sandbox.runReasoningFeatureAnalysis === "function",
    "管理页未暴露 reasoning 特征分析函数",
  );
  await sandbox.runReasoningFeatureAnalysis();
  assert(
    elements.reasoningAnalysisValue.textContent.includes("valuable"),
    "reasoning 特征分析未展示 analysis_value",
  );
  assert(
    elements.reasoningAnalysisConclusion.textContent.includes("candidate"),
    "reasoning 特征分析未展示 conclusion",
  );
  assert(
    elements.reasoningAnalysisCoverageBody.innerHTML.includes("reasoning_tokens") &&
      elements.reasoningAnalysisCoverageBody.innerHTML.includes("commentary_observed"),
    "reasoning 特征分析未展示 field_coverage",
  );
  assert(
    elements.reasoningAnalysisCandidateSummaryValue.textContent.includes("2"),
    "reasoning 特征分析未展示候选命中摘要",
  );
  assert(
    elements.historicalImportSummaryValue.textContent.includes("历史导入"),
    "历史导入分析摘要未渲染初始状态",
  );
  assert(
    typeof sandbox.runHistoricalImportAnalysis === "function",
    "管理页未暴露历史导入分析函数",
  );
  await sandbox.runHistoricalImportAnalysis();
  await new Promise((resolve) => setImmediate(resolve));
  assert(historicalImportRunCount === 1, "历史导入分析按钮未触发后台任务");
  assert(
    elements.historicalImportProgressText.textContent.includes("完成"),
    "历史导入分析未显示完成进度",
  );
  assert(
    elements.historicalImportProgress.dataset.progressActive === "true",
    "历史导入完成后应显示进度条状态",
  );
  assert(
    elements.historicalImportAnalysisValue.textContent.includes("no_analysis_value") ||
      elements.historicalImportAnalysisValue.textContent.includes("无分析价值"),
    "历史导入预检未展示无分析价值结论",
  );
  assert(
    elements.historicalImportCoverageBody.innerHTML.includes("reasoning_tokens") &&
      elements.historicalImportCoverageBody.innerHTML.includes("final_answer_only"),
    "历史导入预检未展示字段覆盖率",
  );
  assert(
    elements.historicalImportSummaryValue.textContent.includes("165965"),
    "历史导入分析未展示历史请求总量",
  );
  assert(
    elements.historicalImportSourcesBody.innerHTML.includes("cc_switch_sqlite"),
    "历史导入分析未展示数据源表",
  );
  assert(
    elements.historicalImportCcModelsBody.innerHTML.includes("gpt-5.5"),
    "历史导入分析未展示 CC Switch 模型聚合",
  );
  assert(
    elements.historicalImportCodexLogsBody.innerHTML.includes("reasoning_tokens"),
    "历史导入分析未展示 Codex 日志关键词命中",
  );
  assert(
    elements.historicalImportSessionsBody.innerHTML.includes("demo.jsonl"),
    "历史导入分析未展示 session 大文件索引",
  );
  assert(
    elements.probeSamplesBody.innerHTML.includes(
      "probe_identity_consistency_warning",
    ),
    "主动探针样本表未渲染 warning 样本",
  );
  assert(typeof sandbox.runProbeNow === "function", "管理页未暴露 runProbeNow");
  assert(
    typeof sandbox.collectActiveProbeFormPayload === "function",
    "管理页未暴露 collectActiveProbeFormPayload",
  );
  assert(
    typeof sandbox.persistActiveProbeConfigFromControls === "function",
    "管理页未暴露 persistActiveProbeConfigFromControls",
  );
  assert(
    typeof sandbox.setReasoningBehaviorDateRange === "function",
    "管理页未暴露 setReasoningBehaviorDateRange",
  );
  assert(
    typeof sandbox.openReasoningBehaviorExport === "function",
    "管理页未暴露 reasoning 导出函数",
  );
  sandbox.setReasoningBehaviorDateRange("2026-06-27", "2026-06-28");
  const rangedReasoningRequestUrl = sandbox
    .getReasoningBehaviorRequestUrl(
      "http://127.0.0.1:4610/__codex_retry_gateway/api/analytics/reasoning",
    )
    .toString();
  assert(
    rangedReasoningRequestUrl.includes("date_from=2026-06-27") &&
      rangedReasoningRequestUrl.includes("date_to=2026-06-28"),
    "reasoning 状态接口构造器未携带选中时间段",
  );
  assert(
    sandbox
      .formatReasoningBehaviorDateRangeLabel("2026-06-27", "2026-06-28")
      .includes("2026-06-27"),
    "reasoning 时间窗标签未展示选中范围",
  );
  assert(
    typeof sandbox.shouldUseBackgroundReasoningExport === "function",
    "管理页未暴露后台导出判断函数",
  );
  assert(
    sandbox.shouldUseBackgroundReasoningExport() === false,
    "2 天 reasoning 导出不应走后台任务",
  );
  const openedUrlsBeforeRangeExport = openedUrls.length;
  await sandbox.openReasoningBehaviorExport("json");
  await sandbox.openReasoningBehaviorExport("csv");
  const exportedRangeUrls = openedUrls.slice(openedUrlsBeforeRangeExport);
  assert(
    exportedRangeUrls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=json") &&
        url.includes("date_from=2026-06-27") &&
        url.includes("date_to=2026-06-28"),
    ),
    "短范围 reasoning JSON 导出未直接打开下载链接",
  );
  assert(
    exportedRangeUrls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=csv") &&
        url.includes("date_from=2026-06-27") &&
        url.includes("date_to=2026-06-28"),
    ),
    "短范围 reasoning CSV 导出未直接打开下载链接",
  );
  const fetchCallsBeforeBackgroundExport = fetchCalls.length;
  sandbox.setReasoningBehaviorDateRange("2026-01-01", "2026-03-15");
  assert(
    sandbox.shouldUseBackgroundReasoningExport() === true,
    "大范围 reasoning 导出应走后台任务",
  );
  await sandbox.openReasoningBehaviorExport("json");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const backgroundExportFetchCalls = fetchCalls.slice(fetchCallsBeforeBackgroundExport);
  assert(
    backgroundExportFetchCalls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export") &&
        url.includes("format=json") &&
        url.includes("date_from=2026-01-01") &&
        url.includes("date_to=2026-03-15"),
    ),
    "reasoning JSON 后台导出请求未携带大范围时间段",
  );
  assert(
    backgroundExportFetchCalls.some(
      (url) =>
        url.includes("/api/analytics/reasoning/export/jobs/ui-export-job-1"),
    ),
    "reasoning 后台导出未轮询任务进度",
  );
  assert(
    elements.reasoningExportProgressText.textContent.includes("后台导出"),
    "reasoning 后台导出未显示进度提示",
  );
  assert(
    elements.reasoningExportDownloadLink.href.includes("/download"),
    "reasoning 后台导出完成后未显示下载链接",
  );
  sandbox.setReasoningBehaviorDateRange("2026-06-27", "2026-06-28");
  const openedUrlsBeforeDirectButtonExport = openedUrls.length;
  await sandbox.openReasoningBehaviorExport("json");
  await sandbox.openReasoningBehaviorExport("csv");
  const directButtonExportUrls = openedUrls.slice(openedUrlsBeforeDirectButtonExport);
  assert(
    directButtonExportUrls.some((url) => url.includes("format=json")),
    "reasoning JSON 导出按钮未打开下载链接",
  );
  assert(
    directButtonExportUrls.some((url) => url.includes("format=csv")),
    "reasoning CSV 导出按钮未打开下载链接",
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
    JSON.stringify(probeConfigPayload.target_families) ===
      JSON.stringify(["gpt-5.4"]),
    "主动探针表单未正确收集 target_families",
  );
  const configSaveCountBeforeInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config"),
  ).length;
  elements.interceptStreamingInput.checked = false;
  elements.interceptNonStreamingInput.checked = false;
  await sandbox.saveConfig({ preventDefault() {} });
  const configSaveCountAfterInvalidIntercept = fetchBodies.filter((entry) =>
    entry.url.includes("/api/config"),
  ).length;
  assert(
    configSaveCountAfterInvalidIntercept ===
      configSaveCountBeforeInvalidIntercept,
    "流式与非流式都关闭时，管理页不应提交 /api/config",
  );
  assert(
    elements.messageBox.textContent.includes("流式与非流式至少选择一个"),
    "流式与非流式都关闭时，管理页应提示至少选择一个拦截目标",
  );
  elements.interceptStreamingInput.checked = true;
  elements.interceptNonStreamingInput.checked = false;
  elements.interceptRuleModeReasoningTokensInput.checked = false;
  elements.interceptRuleModeFinalOnlyInput.checked = true;
  await sandbox.saveConfig({ preventDefault() {} });
  const saveConfigCall = fetchBodies
    .filter((entry) => entry.url.includes("/api/config"))
    .at(-1);
  assert(saveConfigCall, "saveConfig 未请求 /api/config");
  const savedPayload = JSON.parse(saveConfigCall.body);
  assert(
    savedPayload.intercept_streaming === true,
    "saveConfig 未提交 intercept_streaming",
  );
  assert(
    savedPayload.intercept_non_streaming === false,
    "saveConfig 未提交 intercept_non_streaming",
  );
  assert(
    savedPayload.intercept_rule_mode === "final_answer_only_high_xhigh",
    "saveConfig 未提交 final answer only 拦截模式",
  );
  assert(
    savedPayload.guard_retry_attempts === 3,
    "saveConfig 未提交 guard_retry_attempts",
  );
  assert(
    savedPayload.retry_upstream_capacity_errors === true,
    "saveConfig 未提交 retry_upstream_capacity_errors",
  );
  assert(savedPayload.active_probe, "saveConfig 未提交 active_probe");
  assert(
    savedPayload.active_probe.enabled === false,
    "saveConfig 未提交 active_probe.enabled",
  );
  assert(
    savedPayload.active_probe.interval_ms === 7 * 60 * 1000,
    "saveConfig 未提交 active_probe.interval_ms",
  );
  assert(
    JSON.stringify(savedPayload.active_probe.target_families) ===
      JSON.stringify(["gpt-5.4"]),
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
  const autoProbeSaveCall = fetchBodies
    .filter((entry) => entry.url.includes("/api/config"))
    .at(-1);
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
  const runProbeCall = fetchBodies.find((entry) =>
    entry.url.includes("/api/probe/run"),
  );
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
    JSON.stringify(runProbePayload.active_probe.target_families) ===
      JSON.stringify(["gpt-5.4"]),
    "runProbeNow 未提交当前 active_probe.target_families",
  );
  elements.probeTargetFamily54Input.checked = false;
  elements.probeTargetFamily55Input.checked = false;
  elements.probeAutoEnabledInput.checked = true;
  await sandbox.persistActiveProbeConfigFromControls().then(
    () => {
      throw new Error(
        "未选中任何模型时，persistActiveProbeConfigFromControls 不应成功",
      );
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
        message:
          "[match] stream path=/responses reasoning_tokens=516 action=strict_502",
      },
      {
        seq: 2,
        at: "2026-06-28T03:18:23.100Z",
        message:
          "[sample] path=/responses anomaly=single_request_rebuild_suspected confidence=high",
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
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      afterChanged,
    ),
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
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      probeAfterChanged,
    ),
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
  const silentChangedProbeKey = sandbox.buildProbeSampleKey(
    silentChangedProbeSample,
  );
  assert(
    /<details class="evidence-details" data-sample-key="[^"]+" open>/.test(
      elements.probeSamplesBody.innerHTML,
    ),
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
    probeAfterSuspiciousRefresh.includes(
      `data-sample-key=\"${encodeHtmlAttribute(silentChangedProbeKey)}\" open`,
    ),
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
    .querySelectorAll(".evidence-details[data-sample-key][open]")
    .map((node) => node.getAttribute("data-sample-key"));
  assert(
    openProbeKeysAfterPrepend.includes(silentChangedProbeKey),
    "主动探针样本前面插入新记录后，已展开的日志证据不应自动收起",
  );
}

async function createHistoricalImportFixtures(tempRoot) {
  const sqlite3Path = process.env.SQLITE3_EXE || "sqlite3";
  const fixtureRoot = path.join(tempRoot, "historical-import-fixtures");
  const ccSwitchDbPath = path.join(fixtureRoot, "cc-switch.db");
  const codexLogsDbPath = path.join(fixtureRoot, "logs_2.sqlite");
  const sessionsRoot = path.join(fixtureRoot, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
  await execFileText(
    sqlite3Path,
    [
      ccSwitchDbPath,
      [
        "CREATE TABLE proxy_request_logs (",
        "request_id TEXT, provider_id TEXT, app_type TEXT, model TEXT, request_model TEXT,",
        "input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER,",
        "input_cost_usd REAL, output_cost_usd REAL, total_cost_usd REAL,",
        "latency_ms INTEGER, first_token_ms INTEGER, duration_ms INTEGER, status_code INTEGER,",
        "error_message TEXT, session_id TEXT, provider_type TEXT, is_streaming INTEGER,",
        "created_at TEXT, data_source TEXT, pricing_model TEXT",
        ");",
        "INSERT INTO proxy_request_logs VALUES ('r1','p1','codex','gpt-5.5','gpt-5.5',100,20,5,0,0.01,0.02,0.03,300,120,800,200,NULL,'s1','openai',1,'2026-06-30T10:00:00.000Z','cc-switch','standard');",
        "INSERT INTO proxy_request_logs VALUES ('r2','p1','codex','gpt-5.4','gpt-5.4',200,10,0,2,0.02,0.01,0.03,900,300,1800,502,'bad upstream','s2','openai',0,'2026-06-30T11:00:00.000Z','cc-switch','standard');",
      ].join(" "),
    ],
    { cwd: fixtureRoot },
  );
  await execFileText(
    sqlite3Path,
    [
      codexLogsDbPath,
      [
        "CREATE TABLE logs (",
        "id INTEGER, ts TEXT, ts_nanos INTEGER, level TEXT, target TEXT, feedback_log_body TEXT,",
        "module_path TEXT, file TEXT, line INTEGER, thread_id TEXT, process_uuid TEXT, estimated_bytes INTEGER",
        ");",
        "INSERT INTO logs VALUES (1,'2026-06-30T10:00:00.000Z',0,'INFO','codex_core','reasoning_tokens=516 final_answer','m','f',1,'t1','p1',128);",
        "INSERT INTO logs VALUES (2,'2026-06-30T11:00:00.000Z',0,'ERROR','codex_core','upstream 502','m','f',2,'t1','p1',64);",
      ].join(" "),
    ],
    { cwd: fixtureRoot },
  );
  await writeFile(
    path.join(sessionsRoot, "large-session.jsonl"),
    `${JSON.stringify({ ts: "2026-06-30T10:00:00.000Z", type: "demo" })}\n`,
    "utf8",
  );
  return {
    ccSwitchDbPath,
    codexLogsDbPath,
    sessionsRoot,
  };
}

function startFakeUpstream(port) {
  const failBeforeResponseCounts = new Map();
  const reasoningSequenceCounts = new Map();
  const capacityErrorCounts = new Map();
  const identityProbeCounts = new Map();
  const probeRequests = [];
  const responseRequests = [];
  const server = http.createServer((req, res) => {
    const responsePaths = new Set(["/responses", "/v1/responses"]);
    const chatCompletionPaths = new Set([
      "/chat/completions",
      "/v1/chat/completions",
    ]);

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
        const probeBlockedByUpstream =
          authorization === "Bearer sk-probe-blocked";
        const sequenceKey = Array.isArray(parsed.test_reasoning_sequence)
          ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
          : null;
        const sequenceCount = sequenceKey
          ? reasoningSequenceCounts.get(sequenceKey) || 0
          : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[
              Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)
            ]
          : (parsed.test_reasoning_tokens ?? 128);
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
        if (parsed.test_capacity_error_once) {
          const capacityKey = `${req.url}:capacity:${parsed.test_sequence_key || "default"}`;
          const capacityCount = (capacityErrorCounts.get(capacityKey) || 0) + 1;
          capacityErrorCounts.set(capacityKey, capacityCount);
          if (capacityCount === 1) {
            createJsonResponse(
              res,
              parsed.test_capacity_error_status ?? 429,
              parsed.test_capacity_error_payload ?? {
                error: {
                  type: "rate_limit_error",
                  code: "model_at_capacity",
                  message:
                    "Selected model is at capacity. Please try a different model.",
                },
              },
              { "x-upstream-test": "responses-capacity-error" },
            );
            return;
          }
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
              {
                "x-upstream-test": "responses-probe-long-context-unauthorized",
              },
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
              {
                "x-upstream-test":
                  "responses-probe-long-context-upstream-blocked",
              },
            );
            return;
          }
          const simulatedInputTokens = 6000 + longContextProbe.units;
          if (simulatedInputTokens < 400000) {
            createJsonResponse(
              res,
              200,
              buildLongContextProbeResponsePayload(
                parsed,
                simulatedInputTokens,
              ),
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
                  message:
                    "Upstream access forbidden, please contact administrator",
                },
              },
              {
                "x-upstream-test":
                  "responses-probe-image-input-upstream-blocked",
              },
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
              {
                "x-upstream-test":
                  "responses-probe-response-structure-unauthorized",
              },
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
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:self_cutoff")
        ) {
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
              {
                "x-upstream-test":
                  "responses-probe-knowledge-self-cutoff-unauthorized",
              },
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
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_1")
        ) {
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
              {
                "x-upstream-test":
                  "responses-probe-knowledge-anchor-1-unauthorized",
              },
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
        if (
          serializedInput.includes("__crg_knowledge_cutoff_probe__:anchor_2")
        ) {
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
              {
                "x-upstream-test":
                  "responses-probe-knowledge-anchor-2-unauthorized",
              },
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
            ? failBeforeResponseCounts.get(
                `${req.url}:fail-before-response-once`,
              ) || 0
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
        const sequenceKey = Array.isArray(parsed.test_reasoning_sequence)
          ? `${req.url}:${parsed.test_sequence_key || JSON.stringify(parsed.test_reasoning_sequence)}`
          : null;
        const sequenceCount = sequenceKey
          ? reasoningSequenceCounts.get(sequenceKey) || 0
          : 0;
        if (sequenceKey) {
          reasoningSequenceCounts.set(sequenceKey, sequenceCount + 1);
        }
        const reasoning = sequenceKey
          ? parsed.test_reasoning_sequence[
              Math.min(sequenceCount, parsed.test_reasoning_sequence.length - 1)
            ]
          : (parsed.test_reasoning_tokens ?? 128);
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
  const child = spawn(
    process.execPath,
    [gatewayEntry, "--config", configPath, "--log", logPath],
    {
      cwd: gatewayRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

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
  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "codex-retry-gateway-"),
  );
  const upstreamPort = await getFreePort();
  const gatewayPort = await getFreePort();
  const probeGatewayPort = await getFreePort();
  const warningProbeGatewayPort = await getFreePort();
  const limitGatewayPort = await getFreePort();
  const configPath = path.join(tempRoot, "config.json");
  const logPath = path.join(tempRoot, "gateway.log");
  const limitConfigPath = path.join(tempRoot, "limit-config.json");
  const limitLogPath = path.join(tempRoot, "limit-gateway.log");
  const probeConfigDir = path.join(tempRoot, "probe-runtime");
  const probeConfigPath = path.join(probeConfigDir, "config.json");
  const probeLogPath = path.join(tempRoot, "probe-gateway.log");
  const probeCodexConfigPath = path.join(tempRoot, "probe-codex-config.toml");
  const probeStatePath = path.join(tempRoot, "state.json");
  const warningProbeRoot = path.join(tempRoot, "warning-probe");
  const warningProbeConfigDir = path.join(warningProbeRoot, "config");
  const warningProbeConfigPath = path.join(
    warningProbeConfigDir,
    "config.json",
  );
  const warningProbeLogPath = path.join(warningProbeRoot, "gateway.log");
  const warningProbeCodexConfigPath = path.join(
    warningProbeRoot,
    "codex-config.toml",
  );
  const warningProbeStatePath = path.join(warningProbeRoot, "state.json");

  const config = {
    listen_host: "127.0.0.1",
    listen_port: gatewayPort,
    upstream_base_url: `http://127.0.0.1:${upstreamPort}`,
    request_body_limit_bytes: 10 * 1024 * 1024,
    endpoints: [
      "/responses",
      "/chat/completions",
      "/v1/responses",
      "/v1/chat/completions",
    ],
    reasoning_equals: [516],
    non_stream_status_code: 502,
    stream_action: "strict_502",
    log_match: true,
    health_path: "/__codex_retry_gateway/health",
  };

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const limitConfig = {
    ...config,
    listen_port: limitGatewayPort,
    request_body_limit_bytes: 1024,
  };
  await writeFile(
    limitConfigPath,
    JSON.stringify(limitConfig, null, 2),
    "utf8",
  );

  const upstream = await startFakeUpstream(upstreamPort);
  const gateway = startGateway(configPath, logPath);
  const limitGateway = startGateway(limitConfigPath, limitLogPath);
  let probeGateway = null;
  let warningProbeGateway = null;

  try {
    await waitForHealth(`http://127.0.0.1:${gatewayPort}${config.health_path}`);
    await waitForHealth(
      `http://127.0.0.1:${limitGatewayPort}${config.health_path}`,
    );

    const modelsResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/models`,
    );
    assert(
      modelsResponse.status === 200,
      `/v1/models 透传状态异常: ${modelsResponse.status}`,
    );
    assert(
      modelsResponse.headers.get("x-upstream-test") === "models-ok",
      "/v1/models 未保留上游头",
    );

    const statusBeforeUiRefresh = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusBeforeUiRefresh.config?.intercept_streaming === true,
      "intercept_streaming 默认应开启",
    );
    assert(
      statusBeforeUiRefresh.config?.intercept_non_streaming === true,
      "intercept_non_streaming 默认应开启",
    );
    assert(
      statusBeforeUiRefresh.config?.guard_retry_attempts === 3,
      "guard_retry_attempts 默认应为 3",
    );
    assert(
      statusBeforeUiRefresh.config?.retry_upstream_capacity_errors === true,
      "retry_upstream_capacity_errors 默认应为 true",
    );
    assert(
      statusBeforeUiRefresh.config?.intercept_rule_mode === "reasoning_tokens",
      "intercept_rule_mode 默认应为 reasoning_tokens",
    );
    assert(statusBeforeUiRefresh.active_probe, "status 缺少 active_probe");
    assert(
      statusBeforeUiRefresh.active_probe.enabled === false,
      "active_probe 默认应关闭",
    );
    assert(
      statusBeforeUiRefresh.active_probe.running === false,
      "active_probe 初始不应处于运行中",
    );
    assert(
      statusBeforeUiRefresh.active_probe.total_runs === 0,
      "active_probe 初始 total_runs 应为 0",
    );
    assert(
      statusBeforeUiRefresh.active_probe.warning_count === 0,
      "active_probe 初始 warning_count 应为 0",
    );
    assert(
      statusBeforeUiRefresh.active_probe.violation_count === 0,
      "active_probe 初始 violation_count 应为 0",
    );
    assert(
      Array.isArray(statusBeforeUiRefresh.active_probe.recent_samples),
      "active_probe.recent_samples 应为数组",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.warning_type_counts ===
        "object" &&
        statusBeforeUiRefresh.active_probe.warning_type_counts !== null,
      "active_probe.warning_type_counts 应存在",
    );
    assert(
      typeof statusBeforeUiRefresh.active_probe.violation_type_counts ===
        "object" &&
        statusBeforeUiRefresh.active_probe.violation_type_counts !== null,
      "active_probe.violation_type_counts 应存在",
    );
    const uiHtml = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/ui`,
    ).then((response) => response.text());
    const inlineScriptMatch = uiHtml.match(/<script>([\s\S]*)<\/script>/);
    assert(inlineScriptMatch, "管理页缺少内联脚本");
    try {
      new vm.Script(inlineScriptMatch[1]);
    } catch (error) {
      throw new Error(`管理页内联脚本语法无效: ${error?.message || error}`);
    }
    assert(
      uiHtml.includes('id="statsFootnote"'),
      "管理页运行状态脚注缺少 statsFootnote 挂点",
    );
    assert(!uiHtml.includes("家族声明分布"), "管理页不应再显示家族声明分布");
    assert(
      !uiHtml.includes('id="family54Stats"'),
      "管理页不应再渲染 family54Stats",
    );
    assert(
      !uiHtml.includes('id="family55Stats"'),
      "管理页不应再渲染 family55Stats",
    );
    assert(
      !uiHtml.includes("<h3>gpt-5.4</h3>"),
      "管理页不应再显示 gpt-5.4 分列标题",
    );
    assert(
      !uiHtml.includes("<h3>gpt-5.5</h3>"),
      "管理页不应再显示 gpt-5.5 分列标题",
    );
    assert(
      !uiHtml.includes('id="family54Summary"'),
      "管理页不应再渲染 family54Summary",
    );
    assert(
      !uiHtml.includes('id="family55Summary"'),
      "管理页不应再渲染 family55Summary",
    );
    assert(
      uiHtml.includes('id="probeTargetFamily54Input"'),
      "管理页缺少 gpt-5.4 主动探针复选框",
    );
    assert(
      uiHtml.includes('id="probeTargetFamily55Input"'),
      "管理页缺少 gpt-5.5 主动探针复选框",
    );
    assert(
      uiHtml.includes('id="probeAutoEnabledInput"'),
      "管理页缺少自动探测开关",
    );
    assert(
      uiHtml.includes('id="probeIntervalMinutesInput"'),
      "管理页缺少主动探针分钟频率输入框",
    );
    assert(uiHtml.includes('id="probeRunButton"'), "管理页缺少立即探测按钮");
    assert(
      uiHtml.includes('id="interceptStreamingInput"'),
      "管理页缺少流式拦截复选框",
    );
    assert(
      uiHtml.includes('id="interceptNonStreamingInput"'),
      "管理页缺少非流式拦截复选框",
    );
    assert(
      uiHtml.includes('id="interceptRuleModeReasoningTokensInput"') &&
        uiHtml.includes('value="reasoning_tokens"') &&
        uiHtml.includes('id="interceptRuleModeFinalOnlyInput"') &&
        uiHtml.includes('value="final_answer_only_high_xhigh"') &&
        uiHtml.includes("final answer only") &&
        uiHtml.includes("仅 high / xhigh 模式使用"),
      "管理页缺少 reasoning_tokens/final answer only 二选一拦截模式",
    );
    assert(
      uiHtml.includes('class="field rule-mode-field"') &&
        uiHtml.includes('class="inline-toggle rule-mode-toggle"') &&
        uiHtml.includes('.rule-mode-toggle input[type="radio"]') &&
        uiHtml.includes('width: 16px;') &&
        uiHtml.includes('font-size: 12px;'),
      "拦截规则模式 radio 应使用紧凑样式，避免按钮和字体过大",
    );
    assert(
      uiHtml.includes('id="interceptModeValue"'),
      "管理页缺少当前拦截模式展示",
    );
    assert(
      uiHtml.includes('id="guardRetryAttemptsInput"'),
      "管理页缺少网关内重试次数输入框",
    );
    assert(uiHtml.includes("网关内重试次数"), "管理页缺少网关内重试次数标签");
    assert(
      uiHtml.includes('id="retryUpstreamCapacityErrorsInput"'),
      "管理页缺少上游 capacity 错误内重试开关",
    );
    assert(
      uiHtml.includes("上游 capacity 错误内重试"),
      "管理页缺少上游 capacity 错误内重试标签",
    );
    assert(uiHtml.includes("TG群："), "管理页缺少 TG 群入口文案");
    assert(
      uiHtml.includes('href="https://t.me/AI_INPUT_IM"'),
      "管理页缺少 TG 群链接",
    );
    assert(
      uiHtml.indexOf('name="non_stream_status_code"') <
        uiHtml.indexOf('name="guard_retry_attempts"') &&
        uiHtml.indexOf('name="guard_retry_attempts"') <
          uiHtml.indexOf('name="retry_upstream_capacity_errors"') &&
        uiHtml.indexOf('name="retry_upstream_capacity_errors"') <
          uiHtml.indexOf('name="log_match"'),
      "网关内重试次数和上游 capacity 开关应位于 non_stream_status_code 与 log_match 之间",
    );
    assert(
      !uiHtml.includes("516 命中次数"),
      "管理页不应再显示 516 命中次数卡片",
    );
    assert(!uiHtml.includes("516 占比"), "管理页不应再显示 516 占比卡片");
    assert(
      uiHtml.includes("当前规则命中总数"),
      "管理页缺少当前规则命中总数卡片",
    );
    assert(uiHtml.includes("实际拦截总数"), "管理页缺少实际拦截总数卡片");
    assert(uiHtml.includes("实际拦截占比"), "管理页缺少实际拦截占比卡片");
    const matchedStatsIndex = uiHtml.indexOf("当前规则命中总数");
    const blockedTotalStatsIndex = uiHtml.indexOf("实际拦截总数");
    const blockedRatioStatsIndex = uiHtml.indexOf("实际拦截占比");
    assert(
      matchedStatsIndex < blockedTotalStatsIndex &&
        blockedTotalStatsIndex < blockedRatioStatsIndex,
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
    assert(
      brokenBypassResponse.status === 502,
      `异常旁路请求应返回 502，实际为 ${brokenBypassResponse.status}`,
    );
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
      brokenBypassLogText.includes(
        "[upstream-error] fetch failed after retry path=/v1/models",
      ),
      "上游 fetch failed 应记录为 upstream-error 摘要日志",
    );
    assert(
      !brokenBypassLogText.includes("[error] TypeError: fetch failed"),
      "上游 fetch failed 不应记录为 gateway 内部 error 堆栈",
    );
    const oversizedPayloadResponse = await fetch(
      `http://127.0.0.1:${limitGatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(2048, 65),
      },
    );
    const oversizedPayloadBody = await oversizedPayloadResponse.json();
    assert(
      oversizedPayloadResponse.status === 413,
      `超限请求体应返回 413，实际为 ${oversizedPayloadResponse.status}`,
    );
    assert(
      oversizedPayloadBody?.error?.type === "gateway_rejection",
      "超限请求体应返回本地拒绝类型",
    );
    assert(
      oversizedPayloadBody?.error?.code === "request_body_limit_exceeded",
      "超限请求体应返回单独错误码",
    );
    assert(
      `${oversizedPayloadBody?.error?.message || ""}`.includes(
        "请求体超过限制",
      ),
      "超限请求体应返回明确错误信息",
    );
    const statusAfterOversizedPayload = await fetch(
      `http://127.0.0.1:${limitGatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterOversizedPayload.metrics.failed_proxy_request_count === 1,
      "超限请求体应计入 failed_proxy_request_count",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const oversizedPayloadLogText = await readFile(limitLogPath, "utf8");
    assert(
      oversizedPayloadLogText.includes(
        "[gateway-reject] request body too large path=/responses",
      ),
      "超限请求体应记录为 gateway-reject 摘要日志",
    );
    assert(
      !oversizedPayloadLogText.includes("[error] Error: 请求体超过限制"),
      "超限请求体不应记录为 gateway 内部 error 堆栈",
    );
    const slowRequestPromise = fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_reasoning_tokens: 128,
          test_response_delay_ms: 180,
        }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const statusDuringSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusDuringSlowRequest.metrics.active_proxy_request_count >= 1,
      "代理请求进行中时应记录 active_proxy_request_count",
    );
    assert(
      statusDuringSlowRequest.metrics.active_proxy_path_counts?.[
        "/responses"
      ] >= 1,
      "代理请求进行中时应记录 active_proxy_path_counts",
    );
    const slowRequestResponse = await slowRequestPromise;
    assert(
      slowRequestResponse.status === 200,
      `慢速代理请求状态异常: ${slowRequestResponse.status}`,
    );
    await slowRequestResponse.text();
    const statusAfterSlowRequest = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusAfterSlowRequest.metrics.active_proxy_request_count === 0,
      "代理请求结束后 active_proxy_request_count 应回到 0",
    );

    for (const responsePath of ["/responses", "/v1/responses"]) {
      const blockedResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}${responsePath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: responsePath === "/responses" ? "gpt-5.5" : "gpt-5.4",
            reasoning: {
              effort: responsePath === "/responses" ? "high" : "medium",
            },
            messages: [{ role: "user", content: "blocked sample" }],
            test_reasoning_tokens: 516,
            test_include_final_answer_only: true,
          }),
        },
      );
      const blockedBody = await blockedResponse.json();
      assert(
        blockedResponse.status === 502,
        `${responsePath} 516 未返回 502: ${blockedResponse.status}`,
      );
      assert(
        blockedBody?.error?.code === "reasoning_guard_triggered",
        `${responsePath} 516 返回体不正确`,
      );

      const okResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}${responsePath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: responsePath === "/responses" ? "gpt-5.4" : "gpt-5.5",
            reasoning: {
              effort: responsePath === "/responses" ? "medium" : "high",
            },
            messages: [{ role: "user", content: "ok sample" }],
            test_reasoning_tokens: 128,
          }),
        },
      );
      const okBody = await okResponse.json();
      assert(
        okResponse.status === 200,
        `${responsePath} 128 透传状态异常: ${okResponse.status}`,
      );
      assert(
        okResponse.headers.get("x-upstream-test") === "responses-128",
        `${responsePath} 128 未保留头`,
      );
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
    assert(
      defaultModeStatus.reasoning_behavior,
      "status 接口缺少 reasoning_behavior",
    );
    assert(
      defaultModeStatus.reasoning_behavior.schema_version === 2,
      "status reasoning_behavior 缺少 schema_version=2",
    );
    assert(
      defaultModeStatus.reasoning_behavior.analytics_ready === true,
      "status reasoning_behavior 缺少 analytics_ready=true",
    );
    assert(
      typeof defaultModeStatus.reasoning_behavior.analytics_started_at ===
        "string" &&
        defaultModeStatus.reasoning_behavior.analytics_started_at.length > 0,
      "status reasoning_behavior 缺少 analytics_started_at",
    );
    assert(
      Number(defaultModeStatus.reasoning_behavior.summary?.total_samples) >= 8,
      `reasoning 行为样本总数不正确: ${JSON.stringify(defaultModeStatus.reasoning_behavior.summary)}`,
    );
    assert(
      defaultModeStatus.reasoning_behavior.summary?.commentary_observed_ratio ===
        defaultModeStatus.reasoning_behavior.summary?.commentary_present_ratio,
      "status reasoning_behavior summary 缺少 commentary_observed_ratio 兼容别名",
    );
    assert(
      Array.isArray(
        defaultModeStatus.reasoning_behavior.top_reasoning_tokens,
      ) &&
        defaultModeStatus.reasoning_behavior.top_reasoning_tokens.some(
          (entry) => entry.value === 516,
        ),
      "reasoning 高频 token 排行榜缺少 516",
    );
    assert(
      Array.isArray(defaultModeStatus.reasoning_behavior.by_model_family) &&
        defaultModeStatus.reasoning_behavior.by_model_family.some(
          (entry) =>
            (entry.model_family === "gpt-5.4" ||
              entry.model_family === "gpt-5.5") &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "status 接口未返回按模型家族聚合",
    );
    assert(
      Array.isArray(defaultModeStatus.reasoning_behavior.by_reasoning_effort) &&
        defaultModeStatus.reasoning_behavior.by_reasoning_effort.some(
          (entry) =>
            (entry.reasoning_effort === "high" ||
              entry.reasoning_effort === "medium") &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "status 接口未返回按思考等级聚合",
    );
    assert(
      Array.isArray(
        defaultModeStatus.reasoning_behavior.by_model_family_and_effort,
      ) &&
        defaultModeStatus.reasoning_behavior.by_model_family_and_effort.some(
          (entry) =>
            entry.model_family === "gpt-5.4" ||
            entry.model_family === "gpt-5.5" ||
            entry.group_key === "gpt-5.5|high",
        ),
      "status 接口未返回按模型家族+思考等级聚合",
    );
    const directAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    assert(
      directAnalytics.schema_version === 2 &&
        directAnalytics.analytics_ready === true,
      "独立 reasoning analytics 接口缺少 schema_version 或 analytics_ready",
    );
    assert(
      Number(directAnalytics.summary?.total_samples) >= 8,
      "独立 reasoning analytics 接口未返回样本统计",
    );
    assert(
      directAnalytics.summary?.commentary_observed_ratio ===
        directAnalytics.summary?.commentary_present_ratio,
      "独立 reasoning analytics 接口缺少 commentary_observed_ratio",
    );
    assert(
      Array.isArray(directAnalytics.by_reasoning_token) &&
        directAnalytics.by_reasoning_token.some(
          (entry) =>
            Number.isFinite(Number(entry.commentary_observed_ratio)) &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "独立 reasoning analytics 接口 by_reasoning_token 缺少 commentary_observed_ratio",
    );
    assert(
      Array.isArray(directAnalytics.candidate_patterns) &&
        directAnalytics.candidate_patterns.every(
          (entry) => !`${entry.pattern_key || ""}`.includes("commentary_absent"),
        ) &&
        (directAnalytics.candidate_patterns.length === 0 ||
          directAnalytics.candidate_patterns.some((entry) =>
            `${entry.pattern_key || ""}`.includes("commentary_not_observed"),
          )),
      "独立 reasoning analytics 候选特征应使用 commentary_not_observed 口径",
    );
    assert(
      Array.isArray(directAnalytics.by_model_family) &&
        directAnalytics.by_model_family.some(
          (entry) => entry.model_family === "gpt-5.5",
        ),
      "独立 reasoning analytics 接口未返回 gpt-5.5 family 聚合",
    );
    assert(
      Array.isArray(directAnalytics.by_reasoning_effort) &&
        directAnalytics.by_reasoning_effort.some(
          (entry) => entry.reasoning_effort === "high",
        ),
      "独立 reasoning analytics 接口未返回 high effort 聚合",
    );
    const reasoningAnalyzeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/analyze`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filters: {
            include_retries: true,
            include_blocked: true,
          },
          conditions: {
            reasoning_tokens: [516],
            final_answer_only: true,
            commentary_not_observed: true,
            time_normalization_deviation: "high",
          },
        }),
      },
    );
    const reasoningAnalyzePayload = await reasoningAnalyzeResponse.json();
    assert(
      reasoningAnalyzeResponse.status === 200,
      `reasoning 特征分析接口失败: ${reasoningAnalyzeResponse.status}`,
    );
    assert(
      reasoningAnalyzePayload.analysis_profile === "516_candidate_review_v1",
      `reasoning 特征分析 profile 不正确: ${JSON.stringify(reasoningAnalyzePayload)}`,
    );
    assert(
      reasoningAnalyzePayload.analysis_value === "valuable",
      `reasoning 特征分析应有分析价值: ${JSON.stringify(reasoningAnalyzePayload)}`,
    );
    assert(
      reasoningAnalyzePayload.field_coverage?.reasoning_tokens > 0 &&
        reasoningAnalyzePayload.field_coverage?.final_answer_only > 0 &&
        reasoningAnalyzePayload.field_coverage?.commentary_observed > 0,
      "reasoning 特征分析缺少核心字段覆盖率",
    );
    assert(
      Number(reasoningAnalyzePayload.candidate_summary?.candidate_count || 0) > 0,
      `reasoning 特征分析未定位候选样本: ${JSON.stringify(reasoningAnalyzePayload.candidate_summary)}`,
    );
    assert(
      [
        "candidate",
        "strong_candidate",
        "high_false_positive_risk",
      ].includes(reasoningAnalyzePayload.conclusion),
      `reasoning 特征分析结论等级不正确: ${reasoningAnalyzePayload.conclusion}`,
    );
    const reasoningItemResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          messages: [{ role: "user", content: "reasoning item sample" }],
          test_reasoning_tokens: 128,
          test_include_reasoning_item: true,
        }),
      },
    );
    assert(
      reasoningItemResponse.status === 200,
      `带 reasoning item 的响应应正常透传: ${reasoningItemResponse.status}`,
    );
    const historicalFixtures = await createHistoricalImportFixtures(tempRoot);
    const importRunResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/run`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source_paths: {
            cc_switch_db: historicalFixtures.ccSwitchDbPath,
            codex_logs_db: historicalFixtures.codexLogsDbPath,
            codex_sessions_root: historicalFixtures.sessionsRoot,
          },
        }),
      },
    );
    const importRunPayload = await importRunResponse.json();
    assert(
      importRunResponse.status === 202,
      `历史导入分析应创建后台任务: ${importRunResponse.status}`,
    );
    assert(
      importRunPayload.import_job?.job_id,
      `历史导入分析缺少任务信息: ${JSON.stringify(importRunPayload)}`,
    );
    const importJobId = importRunPayload.import_job.job_id;
    let importJob = importRunPayload.import_job;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (importJob.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const importJobResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/jobs/${encodeURIComponent(importJobId)}`,
      );
      assert(
        importJobResponse.status === 200,
        `历史导入任务查询失败: ${importJobResponse.status}`,
      );
      const importJobPayload = await importJobResponse.json();
      importJob = importJobPayload.import_job;
    }
    assert(
      importJob.status === "completed",
      `历史导入分析任务未完成: ${JSON.stringify(importJob)}`,
    );
    assert(
      importJob.summary?.total_requests === 2,
      `历史导入 CC Switch 请求总数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.summary?.failed_requests === 1,
      `历史导入失败请求数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.summary?.codex_log_rows === 2,
      `历史导入 Codex 日志行数不正确: ${JSON.stringify(importJob.summary)}`,
    );
    assert(
      importJob.preflight?.analysis_value === "no_analysis_value",
      `历史导入缺核心字段时应标记无分析价值: ${JSON.stringify(importJob.preflight)}`,
    );
    assert(
      importJob.preflight?.missing_core_fields?.includes("reasoning_tokens") &&
        importJob.preflight?.missing_core_fields?.includes("final_answer_only") &&
        importJob.preflight?.missing_core_fields?.includes("commentary_observed"),
      `历史导入 preflight 缺少核心字段缺失列表: ${JSON.stringify(importJob.preflight)}`,
    );
    assert(
      importJob.feature_analysis?.conclusion === "no_analysis_value",
      `历史导入 feature_analysis 应停止在无价值结论: ${JSON.stringify(importJob.feature_analysis)}`,
    );
    const historicalAnalyzeResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/analyze`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: importJobId }),
      },
    );
    const historicalAnalyzePayload = await historicalAnalyzeResponse.json();
    assert(
      historicalAnalyzeResponse.status === 200,
      `历史导入分析接口失败: ${historicalAnalyzeResponse.status}`,
    );
    assert(
      historicalAnalyzePayload.analysis_profile === "516_candidate_review_v1" &&
        historicalAnalyzePayload.analysis_value === "no_analysis_value" &&
        historicalAnalyzePayload.conclusion === "no_analysis_value",
      `历史导入分析接口应返回无分析价值: ${JSON.stringify(historicalAnalyzePayload)}`,
    );
    assert(
      historicalAnalyzePayload.field_coverage?.reasoning_tokens === 0,
      "历史导入分析接口应暴露缺失字段覆盖率",
    );
    const latestImportPayload = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/imports/latest`,
    ).then((response) => response.json());
    assert(
      latestImportPayload.import_job?.job_id === importJobId,
      "历史导入 latest 接口未返回最近任务",
    );
    const degradedAnalyticsResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning?date_from=2026-01-01&date_to=2026-03-15`,
    );
    const degradedAnalyticsPayload = await degradedAnalyticsResponse.json();
    assert(
      degradedAnalyticsResponse.status === 200,
      `大范围 reasoning analytics 查询应返回降级响应: ${degradedAnalyticsResponse.status}`,
    );
    assert(
      degradedAnalyticsPayload.degraded === true &&
        degradedAnalyticsPayload.degrade_reason === "date_range_too_large",
      `大范围 reasoning analytics 查询缺少降级信号: ${JSON.stringify(degradedAnalyticsPayload)}`,
    );
    assert(
      Array.isArray(degradedAnalyticsPayload.recent_samples) &&
        degradedAnalyticsPayload.recent_samples.length === 0,
      "大范围 reasoning analytics 降级响应不应全量返回明细样本",
    );
    const exportJsonResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json`,
    );
    const exportJsonPayload = await exportJsonResponse.json();
    assert(
      exportJsonResponse.status === 200,
      `reasoning JSON 导出失败: ${exportJsonResponse.status}`,
    );
    assert(
      exportJsonPayload.analytics_ready === true,
      "reasoning JSON 导出缺少 analytics_ready",
    );
    assert(
      Array.isArray(exportJsonPayload.samples) &&
        exportJsonPayload.samples.length >= 8,
      "reasoning JSON 导出未包含样本",
    );
    assert(
      Array.isArray(exportJsonPayload.by_model_family) &&
        exportJsonPayload.by_model_family.some(
          (entry) =>
            entry.model_family === "gpt-5.4" &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "reasoning JSON 导出未包含按模型家族聚合",
    );
    assert(
      Array.isArray(exportJsonPayload.by_reasoning_effort) &&
        exportJsonPayload.by_reasoning_effort.some(
          (entry) =>
            entry.reasoning_effort === "medium" &&
            entry.commentary_observed_ratio === entry.commentary_present_ratio,
        ),
      "reasoning JSON 导出未包含按思考等级聚合",
    );
    assert(
      Array.isArray(exportJsonPayload.by_model_family_and_effort) &&
        exportJsonPayload.by_model_family_and_effort.some(
          (entry) => entry.group_key,
        ),
      "reasoning JSON 导出未包含按模型家族+思考等级聚合",
    );
    const backgroundExportResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=json&date_from=2026-01-01&date_to=2026-03-15`,
    );
    const backgroundExportPayload = await backgroundExportResponse.json();
    assert(
      backgroundExportResponse.status === 202,
      `大范围 reasoning JSON 导出应创建后台任务: ${backgroundExportResponse.status}`,
    );
    assert(
      backgroundExportPayload?.export_job?.job_id &&
        backgroundExportPayload.export_job.status,
      `大范围 reasoning JSON 导出缺少后台任务信息: ${JSON.stringify(backgroundExportPayload)}`,
    );
    const exportJobId = backgroundExportPayload.export_job.job_id;
    let exportJobStatus = backgroundExportPayload.export_job;
    for (let pollIndex = 0; pollIndex < 20; pollIndex += 1) {
      if (exportJobStatus.status === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      const pollResponse = await fetch(
        `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export/jobs/${encodeURIComponent(exportJobId)}`,
      );
      assert(
        pollResponse.status === 200,
        `后台 reasoning 导出任务状态查询失败: ${pollResponse.status}`,
      );
      const pollPayload = await pollResponse.json();
      exportJobStatus = pollPayload.export_job;
    }
    assert(
      exportJobStatus.status === "completed",
      `后台 reasoning 导出任务未完成: ${JSON.stringify(exportJobStatus)}`,
    );
    assert(
      exportJobStatus.progress?.processed_days === exportJobStatus.progress?.total_days,
      `后台 reasoning 导出进度不正确: ${JSON.stringify(exportJobStatus.progress)}`,
    );
    assert(
      exportJobStatus.download_url &&
        exportJobStatus.download_url.includes("/api/analytics/reasoning/export/jobs/"),
      `后台 reasoning 导出缺少下载链接: ${JSON.stringify(exportJobStatus)}`,
    );
    const backgroundDownloadResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}${exportJobStatus.download_url}`,
    );
    assert(
      backgroundDownloadResponse.status === 200,
      `后台 reasoning 导出下载失败: ${backgroundDownloadResponse.status}`,
    );
    const blockedReasoningSample = exportJsonPayload.samples.find(
      (sample) => sample.blocked_by_gateway && sample.request_reasoning_effort,
    );
    assert(
      blockedReasoningSample,
      "reasoning 导出缺少被拦截且带思考等级的样本",
    );
    assert(
      blockedReasoningSample?.request_summary?.body_bytes >= 0 &&
        typeof blockedReasoningSample?.request_summary?.body_sha256 ===
          "string",
      "reasoning 导出样本缺少请求摘要",
    );
    assert(
      typeof blockedReasoningSample?.request_payload_excerpt === "string" &&
        blockedReasoningSample.request_payload_excerpt.includes(
          "blocked sample",
        ),
      "reasoning 导出样本缺少请求体摘要",
    );
    assert(
      blockedReasoningSample?.client_http_status === 502,
      "被拦截样本应记录客户端状态 502",
    );
    assert(
      blockedReasoningSample?.commentary_observed ===
        blockedReasoningSample?.has_commentary,
      "reasoning JSON 导出样本缺少 commentary_observed 采集别名",
    );
    const failedReasoningSample = exportJsonPayload.samples.find(
      (sample) => sample.final_action === "upstream_fetch_failed",
    );
    assert(failedReasoningSample, "reasoning 导出缺少上游失败样本");
    assert(
      failedReasoningSample?.failure_summary?.code ===
        "upstream_fetch_failed" ||
        failedReasoningSample?.failure_summary?.message,
      "上游失败样本缺少失败摘要",
    );
    const sampleWithReasoningItem = exportJsonPayload.samples.find(
      (sample) => sample.has_reasoning_item && sample.has_final_answer,
    );
    assert(
      sampleWithReasoningItem,
      "reasoning 导出缺少同时包含 reasoning item 与最终答案的样本",
    );
    assert(
      sampleWithReasoningItem.final_answer_only === false,
      "带 reasoning item 的响应不应判定为 final_answer_only",
    );
    const exportCsvResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning/export?format=csv`,
    );
    const exportCsvText = await exportCsvResponse.text();
    assert(
      exportCsvResponse.status === 200,
      `reasoning CSV 导出失败: ${exportCsvResponse.status}`,
    );
    assert(
      exportCsvText.includes("sample_id") &&
        exportCsvText.includes("gateway_request_id") &&
        exportCsvText.includes("request_reasoning_effort") &&
        exportCsvText.includes("commentary_observed") &&
        exportCsvText.includes("client_http_status"),
      "reasoning CSV 导出缺少表头",
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const analyticsFiles = await readdir(path.join(tempRoot, "analytics"));
    assert(
      analyticsFiles.some(
        (name) =>
          name.startsWith("reasoning-behavior-") && name.endsWith(".json"),
      ),
      `未生成 reasoning analytics 日文件: ${JSON.stringify(analyticsFiles)}`,
    );
    const dayFilePath = path.join(
      tempRoot,
      "analytics",
      analyticsFiles.find(
        (name) =>
          name.startsWith("reasoning-behavior-") && name.endsWith(".json"),
      ),
    );
    const dayFilePayload = JSON.parse(await readFile(dayFilePath, "utf8"));
    assert(
      dayFilePayload.schema_version === 2,
      "reasoning 日文件 schema_version 未升级",
    );
    assert(
      Array.isArray(dayFilePayload.samples) &&
        dayFilePayload.samples.some((sample) => sample.gateway_request_id),
      "reasoning 日文件样本缺少 gateway_request_id",
    );
    assert(
      Array.isArray(dayFilePayload.samples) &&
        dayFilePayload.samples.some(
          (sample) => sample.final_action === "request_rejected",
        ),
      "reasoning 日文件缺少请求体超限样本",
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
    const invalidInterceptConfigPayload =
      await invalidInterceptConfigResponse.json();
    assert(
      invalidInterceptConfigResponse.status === 400,
      `流式与非流式都关闭时后端应拒绝: ${invalidInterceptConfigResponse.status}`,
    );
    assert(
      `${invalidInterceptConfigPayload?.error?.message || ""}`.includes(
        "流式与非流式至少选择一个",
      ),
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
    assert(
      streamOnlyConfigResponse.status === 200,
      `切换仅流式拦截失败: ${streamOnlyConfigResponse.status}`,
    );
    const nonBlockedNonStreamResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
          test_reasoning_tokens: 516,
        }),
      },
    );
    const nonBlockedNonStreamBody = await nonBlockedNonStreamResponse.json();
    assert(
      nonBlockedNonStreamResponse.status === 200,
      `仅流式模式下非流式命中应透传: ${nonBlockedNonStreamResponse.status}`,
    );
    assert(
      nonBlockedNonStreamBody?.usage?.output_tokens_details
        ?.reasoning_tokens === 516,
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
    assert(
      observedOnlyStream.status === 200,
      `仅非流式模式下流式命中应透传: ${observedOnlyStream.status}`,
    );
    assert(
      observedOnlyStream.text.includes("hello"),
      "仅非流式模式下流式命中应保留正常 chunk",
    );
    assert(
      observedOnlyStream.text.includes("[DONE]"),
      "仅非流式模式下流式命中应完整结束",
    );
    assert(
      !observedOnlyStream.closedByError,
      "仅非流式模式下流式命中不应异常断开",
    );
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
        (sample) =>
          sample.path === "/responses" &&
          sample.anomaly_type === "single_request_rebuild_suspected",
      ),
      "仅非流式模式下正常观察流式 516 不应生成 single_request_rebuild_suspected 可疑样本",
    );

    const finalOnlyModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "final_answer_only_high_xhigh",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 0,
        }),
      },
    );
    assert(
      finalOnlyModeConfigResponse.status === 200,
      `切换 final answer only 拦截模式失败: ${finalOnlyModeConfigResponse.status}`,
    );
    const finalOnlyModeStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      finalOnlyModeStatus.config?.intercept_rule_mode ===
        "final_answer_only_high_xhigh",
      "final answer only 拦截模式未在状态接口生效",
    );
    const finalOnlyModeLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      finalOnlyModeLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[config] updated intercept_rule_mode=final_answer_only_high_xhigh",
        ),
      ),
      "保存 final answer only 模式后，配置日志应明确显示 intercept_rule_mode",
    );

    const finalOnlyHighResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighResponse.status === 502,
      `high final answer only 应被拦截: ${finalOnlyHighResponse.status}`,
    );
    const compactionFinalOnlyZeroResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      compactionFinalOnlyZeroResponse.status === 200,
      `remote_compaction_v2 reasoning_tokens=0 不应被 final only 模式拦截: ${compactionFinalOnlyZeroResponse.status}`,
    );
    const compactionFinalOnlyNullResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-codex-beta-features": "remote_compaction_v2",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          input: [{ role: "user", content: "compact the current conversation" }],
          test_omit_reasoning_tokens: true,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      compactionFinalOnlyNullResponse.status === 200,
      `remote_compaction_v2 reasoning_tokens=null 不应被 final only 模式拦截: ${compactionFinalOnlyNullResponse.status}`,
    );
    const compactionAnalytics = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/analytics/reasoning`,
    ).then((response) => response.json());
    const compactionSamples = (compactionAnalytics.recent_samples || []).filter(
      (sample) => sample.request_kind === "context_compaction",
    );
    assert(
      compactionSamples.length >= 2,
      `remote_compaction_v2 样本应以 context_compaction 落盘: ${JSON.stringify(compactionSamples)}`,
    );
    assert(
      compactionSamples.some((sample) => sample.reasoning_tokens === 0) &&
        compactionSamples.some((sample) => sample.reasoning_tokens === null),
      `context_compaction 样本应覆盖 reasoning_tokens=0/null: ${JSON.stringify(compactionSamples)}`,
    );
    assert(
      compactionSamples.every(
        (sample) =>
          sample.final_action === "passed" &&
          sample.client_http_status === 200 &&
          sample.matched_current_rule === false &&
          sample.blocked_by_gateway === false &&
          sample.intercept_exempt_reason === "context_compaction",
      ),
      `context_compaction 样本不应计入拦截命中或实际拦截: ${JSON.stringify(compactionSamples)}`,
    );
    const finalOnlyHighStreamResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "high" },
          stream: true,
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyHighStreamResponse.status === 502,
      `流式 high final answer only 应被拦截: ${finalOnlyHighStreamResponse.status}`,
    );
    const finalOnlyMediumResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "medium" },
          test_reasoning_tokens: 0,
          test_include_final_answer_only: true,
        }),
      },
    );
    assert(
      finalOnlyMediumResponse.status === 200,
      `medium final answer only 不应被 final only 模式拦截: ${finalOnlyMediumResponse.status}`,
    );
    const tokenOnlyResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          reasoning: { effort: "xhigh" },
          test_reasoning_tokens: 516,
          test_include_reasoning_item: true,
        }),
      },
    );
    assert(
      tokenOnlyResponse.status === 200,
      `final only 模式下 516 非 final_answer_only 不应被拦截: ${tokenOnlyResponse.status}`,
    );

    const bothModeConfigResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          intercept_rule_mode: "reasoning_tokens",
          intercept_streaming: true,
          intercept_non_streaming: true,
          guard_retry_attempts: 3,
        }),
      },
    );
    assert(
      bothModeConfigResponse.status === 200,
      `恢复双开拦截失败: ${bothModeConfigResponse.status}`,
    );

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
    const zeroRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: zeroRetryKey,
          test_reasoning_sequence: [516],
        }),
      },
    );
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
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === zeroRetryKey,
      ).length === 1,
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
    const nonStreamRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
          test_sequence_key: nonStreamRetryKey,
          test_reasoning_sequence: [516, 128],
        }),
      },
    );
    const nonStreamRetryBody = await nonStreamRetryResponse.json();
    assert(
      nonStreamRetryResponse.status === 200,
      `非流式命中后应由网关内部重试恢复为 200: ${nonStreamRetryResponse.status}`,
    );
    assert(
      nonStreamRetryBody?.usage?.output_tokens_details?.reasoning_tokens ===
        128,
      "非流式命中后内部重试未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === nonStreamRetryKey,
      ).length === 2,
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
    const upstreamErrorResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
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
      },
    );
    const upstreamErrorBody = await upstreamErrorResponse.json();
    assert(
      upstreamErrorResponse.status === 429,
      `上游真实 429 应透传: ${upstreamErrorResponse.status}`,
    );
    assert(
      upstreamErrorBody?.error?.type === "rate_limit_error",
      "上游真实 429 响应体应透传",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === upstreamErrorKey,
      ).length === 1,
      "上游真实 429 不应触发规则内部重试",
    );

    const capacityRetryKey = "upstream-capacity-then-ok";
    const capacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_sequence_key: capacityRetryKey,
          test_capacity_error_once: true,
        }),
      },
    );
    const capacityRetryBody = await capacityRetryResponse.json();
    assert(
      capacityRetryResponse.status === 200,
      `开启 capacity 错误内重试后应恢复为 200: ${capacityRetryResponse.status}`,
    );
    assert(
      capacityRetryBody?.usage?.output_tokens_details?.reasoning_tokens === 128,
      "capacity 错误内重试后未返回第二次正常响应",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === capacityRetryKey,
      ).length === 2,
      "capacity 错误内重试应向上游请求 2 次",
    );
    const capacityRetryLogs = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/logs`,
    ).then((response) => response.json());
    assert(
      capacityRetryLogs.entries.some((entry) =>
        `${entry.message || ""}`.includes(
          "[upstream-capacity] non-stream path=/responses status=429 action=internal_retry remaining=1",
        ),
      ),
      "capacity 错误内重试日志应标记为 internal_retry",
    );

    const disableCapacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retry_upstream_capacity_errors: false,
        }),
      },
    );
    assert(
      disableCapacityRetryResponse.status === 200,
      `关闭 capacity 错误内重试失败: ${disableCapacityRetryResponse.status}`,
    );
    const disabledCapacityStatus = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      disabledCapacityStatus.config?.retry_upstream_capacity_errors === false,
      "关闭 capacity 错误内重试后状态接口未生效",
    );
    const capacityPassthroughKey = "upstream-capacity-passthrough";
    const capacityPassthroughResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: capacityPassthroughKey,
          test_capacity_error_once: true,
        }),
      },
    );
    const capacityPassthroughBody = await capacityPassthroughResponse.json();
    assert(
      capacityPassthroughResponse.status === 429,
      `关闭 capacity 错误内重试后应透传上游状态: ${capacityPassthroughResponse.status}`,
    );
    assert(
      capacityPassthroughBody?.error?.message ===
        "Selected model is at capacity. Please try a different model.",
      "关闭 capacity 错误内重试后响应体应原样透传",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === capacityPassthroughKey,
      ).length === 1,
      "关闭 capacity 错误内重试后不应追加上游请求",
    );
    const restoreCapacityRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/config`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          retry_upstream_capacity_errors: true,
        }),
      },
    );
    assert(
      restoreCapacityRetryResponse.status === 200,
      `恢复 capacity 错误内重试失败: ${restoreCapacityRetryResponse.status}`,
    );

    const statusBeforeExceededGuardRetry = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    const exceededRetryKey = "non-stream-516-then-516";
    const exceededRetryResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          test_sequence_key: exceededRetryKey,
          test_reasoning_sequence: [516, 516],
        }),
      },
    );
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
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === exceededRetryKey,
      ).length === 2,
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
    assert(
      streamRetryResponse.text.includes("[DONE]"),
      "流式内部重试未返回第二次正常 SSE",
    );
    assert(
      !streamRetryResponse.text.includes("reasoning_guard_triggered"),
      "流式内部重试不应暴露首次拦截体",
    );
    assert(
      upstream.responseRequests.filter(
        (entry) => entry.body?.test_sequence_key === streamRetryKey,
      ).length === 2,
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

    const recoveredResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_fail_before_response_once: true }),
      },
    );
    const recoveredBody = await recoveredResponse.json();
    assert(
      recoveredResponse.status === 200,
      `首次 fetch failed 后未自动恢复: ${recoveredResponse.status}`,
    );
    assert(
      recoveredBody?.retry_attempt === 2,
      "首次 fetch failed 后未命中第二次上游请求",
    );

    const failedResponsesProxy = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test_fail_before_response_always: true }),
      },
    );
    const failedResponsesProxyBody = await failedResponsesProxy.json();
    assert(
      failedResponsesProxy.status === 502,
      `连续上游 fetch failed 后应返回 502: ${failedResponsesProxy.status}`,
    );
    assert(
      failedResponsesProxyBody?.error?.type === "upstream_error" &&
        failedResponsesProxyBody?.error?.code === "upstream_fetch_failed",
      `连续上游 fetch failed 后应返回 upstream_error 摘要: ${JSON.stringify(failedResponsesProxyBody)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedResponsesProxyLogText = await readFile(logPath, "utf8");
    assert(
      failedResponsesProxyLogText.includes(
        "[upstream-error] fetch failed after retry path=/responses",
      ),
      "连续 /responses 上游 fetch failed 应记录 upstream-error 摘要日志",
    );
    assert(
      !failedResponsesProxyLogText.includes("[error] TypeError: fetch failed"),
      "连续 /responses 上游 fetch failed 不应记录 gateway 内部 error 堆栈",
    );

    const familyMatchedResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4",
        }),
      },
    );
    assert(
      familyMatchedResponse.status === 200,
      `gpt-5.4 一致声明请求失败: ${familyMatchedResponse.status}`,
    );

    const familyMatched55Response = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.5",
          test_response_model: "gpt-5.5",
        }),
      },
    );
    assert(
      familyMatched55Response.status === 200,
      `gpt-5.5 一致声明请求失败: ${familyMatched55Response.status}`,
    );

    const familyMismatchResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          test_response_model: "gpt-5.4-mini",
        }),
      },
    );
    assert(
      familyMismatchResponse.status === 200,
      `模型声明不一致请求失败: ${familyMismatchResponse.status}`,
    );

    const lowContextResponse = await fetch(
      `http://127.0.0.1:${gatewayPort}/responses`,
      {
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
      },
    );
    assert(
      lowContextResponse.status === 400,
      `400K 家族异常未保留上游状态: ${lowContextResponse.status}`,
    );

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
      assert(
        blockedStream.status === 502,
        `${streamPath} 516 未返回 502: ${blockedStream.status}`,
      );
      assert(
        !blockedStream.text.includes("hello"),
        `${streamPath} 严格 502 模式不应先透传正常 chunk`,
      );
      assert(
        !blockedStream.text.includes("[DONE]"),
        `${streamPath} 严格 502 模式不应回放 DONE`,
      );
      const blockedStreamBody = JSON.parse(blockedStream.text);
      assert(
        blockedStreamBody?.error?.code === "reasoning_guard_triggered",
        `${streamPath} 流式 516 返回体不正确`,
      );

      const okStream = await readSseUntilClose(
        `http://127.0.0.1:${gatewayPort}${streamPath}`,
        { stream: true, test_reasoning_tokens: 128 },
      );
      assert(
        okStream.status === 200,
        `${streamPath} 128 首状态异常: ${okStream.status}`,
      );
      assert(
        okStream.text.includes("[DONE]"),
        `${streamPath} 流式 128 未完整结束`,
      );
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
      statusAfterBlockedStream.model_insights.single_request_anomalies
        ?.rebuild_suspected_count === 0,
      "正常拦截 516 不应计入疑似请求内重建/重试",
    );
    assert(
      !statusAfterBlockedStream.model_insights.suspicious_samples?.some(
        (sample) =>
          sample.path === "/responses" &&
          sample.anomaly_type === "single_request_rebuild_suspected",
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
    assert(
      driftedStream.status === 200,
      `单请求模型漂移流未透传成功: ${driftedStream.status}`,
    );

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
    assert(
      terminatedStream.status === 502,
      `/responses 上游半路断流未返回 502: ${terminatedStream.status}`,
    );

    const statusWithModelInsights = await fetch(
      `http://127.0.0.1:${gatewayPort}/__codex_retry_gateway/api/status`,
    ).then((response) => response.json());
    assert(
      statusWithModelInsights.model_insights,
      "status 缺少 model_insights",
    );
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
      statusWithModelInsights.model_insights.anomalies
        ?.low_context_family_count >= 1,
      "400K 家族异常统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies
        ?.model_drift_count >= 1,
      "单请求模型漂移统计未记录",
    );
    assert(
      statusWithModelInsights.model_insights.single_request_anomalies
        ?.rebuild_suspected_count >= 1,
      "疑似请求内重建/重试统计未记录",
    );
    assert(
      Array.isArray(
        statusWithModelInsights.model_insights.suspicious_samples,
      ) &&
        statusWithModelInsights.model_insights.suspicious_samples.length >= 3,
      "可疑样本未保留",
    );
    assert(
      statusWithModelInsights.model_insights.suspicious_samples.some(
        (sample) =>
          Array.isArray(sample.evidence_logs) &&
          sample.evidence_logs.length > 0,
      ),
      "可疑样本未保留日志证据",
    );
    const familyBreakdown =
      statusWithModelInsights.model_insights.family_breakdown;
    assert(familyBreakdown, "status 缺少 family_breakdown");
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.total_checked === 18,
      `gpt-5.4 家族 total_checked 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.total_checked}`,
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.matched === 15,
      `gpt-5.4 家族 matched 统计不正确: ${familyBreakdown["gpt-5.4"]?.consistency?.matched}`,
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.mismatched === 1,
      "gpt-5.4 家族 mismatched 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.consistency?.unknown === 2,
      "gpt-5.4 家族 unknown 统计不正确",
    );
    assert(
      Math.abs(familyBreakdown["gpt-5.4"]?.consistency?.match_ratio - 15 / 16) <
        1e-9,
      "gpt-5.4 家族声明一致率应排除 unknown",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.anomalies?.low_context_family_count === 1,
      "gpt-5.4 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.model_drift_count === 0,
      "gpt-5.4 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.fingerprint_drift_count === 0,
      "gpt-5.4 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.4"]?.single_request_anomalies
        ?.rebuild_suspected_count === 0,
      "gpt-5.4 家族 rebuild_suspected_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.total_checked === 15,
      `gpt-5.5 家族 total_checked 统计不正确: ${familyBreakdown["gpt-5.5"]?.consistency?.total_checked}`,
    );
    assert(
      familyBreakdown["gpt-5.5"]?.consistency?.matched === 14,
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
      Math.abs(familyBreakdown["gpt-5.5"]?.consistency?.match_ratio - 14 / 15) <
        1e-9,
      "gpt-5.5 家族声明一致率统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.anomalies?.low_context_family_count === 0,
      "gpt-5.5 家族 400K 异常统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.model_drift_count === 1,
      "gpt-5.5 家族 model_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.fingerprint_drift_count === 1,
      "gpt-5.5 家族 fingerprint_drift_count 统计不正确",
    );
    assert(
      familyBreakdown["gpt-5.5"]?.single_request_anomalies
        ?.rebuild_suspected_count === 1,
      "gpt-5.5 家族 rebuild_suspected_count 统计不正确",
    );

    await mkdir(probeConfigDir, { recursive: true });
    await writeFile(
      probeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(probeConfigDir, "state.json"),
      `${JSON.stringify({ codex_config_path: probeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(probeConfigDir, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
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
    await writeFile(
      probeConfigPath,
      JSON.stringify(probeConfig, null, 2),
      "utf8",
    );
    probeGateway = startGateway(probeConfigPath, probeLogPath);
    await waitForHealth(
      `http://127.0.0.1:${probeGatewayPort}${config.health_path}`,
    );
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
      probeStatus.active_probe.violation_type_counts
        ?.probe_low_context_family_violation === 1,
      "主动长上下文探针未记录 probe_low_context_family_violation",
    );
    assert(
      probeStatus.active_probe.violation_type_counts
        ?.probe_image_input_violation === 1,
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
      longContextProbeSample.evidence_logs.some((entry) =>
        `${entry.message || ""}`.includes("target_input_tokens=450000"),
      ),
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
      initialBudgetProbeRequests.every(
        (entry) => Number(entry.units) >= 400000,
      ),
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
    const primedResponse = await fetch(
      `http://127.0.0.1:${probeGatewayPort}/responses`,
      {
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
      },
    );
    assert(
      primedResponse.status === 200,
      `主动探针画像预热请求失败: ${primedResponse.status}`,
    );
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
    assert(
      manualDualProbeResponse.status === 202,
      `双模型手动探针触发失败: ${manualDualProbeResponse.status}`,
    );
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
    const dualProbeSamples = dualProbeStatus.active_probe.recent_samples.slice(
      0,
      4,
    );
    assert(
      dualProbeSamples.length === 4,
      `双模型手动探针最近样本应为 4 条，实际 ${dualProbeSamples.length}`,
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.4" &&
          sample.probe_type === "long_context",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.4 long_context 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.4" &&
          sample.probe_type === "image_input",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.4 image_input 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.5" &&
          sample.probe_type === "long_context",
      ).length === 1,
      "双模型手动探针缺少 gpt-5.5 long_context 样本",
    );
    assert(
      dualProbeSamples.filter(
        (sample) =>
          sample.target_model === "gpt-5.5" &&
          sample.probe_type === "image_input",
      ).length === 1,
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
    const inheritedProbeRequests = upstream.probeRequests.slice(
      probeRequestCountBeforeManualDualRun,
    );
    assert(
      inheritedProbeRequests.length >= 8,
      `双模型手动探针请求数过少: ${inheritedProbeRequests.length}`,
    );
    assert(
      inheritedProbeRequests.every(
        (entry) => entry.headers.userAgent === primedProbeUserAgent,
      ),
      `主动探针未继承最近真实请求的 User-Agent: ${JSON.stringify(inheritedProbeRequests.map((entry) => entry.headers.userAgent))}`,
    );
    assert(
      inheritedProbeRequests.every(
        (entry) => entry.body?.reasoning?.effort === "high",
      ),
      `主动探针未继承最近真实请求的 reasoning.effort: ${JSON.stringify(inheritedProbeRequests.map((entry) => entry.body?.reasoning?.effort ?? null))}`,
    );
    const inheritedBudgetProbeRequests = inheritedProbeRequests.filter(
      (entry) =>
        entry.probeType === "long_context" &&
        `${entry.phase || ""}`.startsWith("budget"),
    );
    assert(
      inheritedBudgetProbeRequests.length >= 2,
      "双模型手动探针缺少长上下文预算请求",
    );
    assert(
      inheritedBudgetProbeRequests.every(
        (entry) => Number(entry.units) >= 400000,
      ),
      `双模型手动探针预算请求 unit_count 过小: ${JSON.stringify(inheritedBudgetProbeRequests.map((entry) => entry.units))}`,
    );

    await mkdir(warningProbeConfigDir, { recursive: true });
    await writeFile(
      warningProbeCodexConfigPath,
      'model = "gpt-5.5"\n[model_providers.fake]\nrequires_openai_auth = true\n',
      "utf8",
    );
    await writeFile(
      path.join(warningProbeRoot, "state.json"),
      `${JSON.stringify({ codex_config_path: warningProbeCodexConfigPath, provider_name: "fake" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(warningProbeConfigDir, "auth.json"),
      `${JSON.stringify({ OPENAI_API_KEY: "sk-probe-test" }, null, 2)}\n`,
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
    warningProbeGateway = startGateway(
      warningProbeConfigPath,
      warningProbeLogPath,
    );
    await waitForHealth(
      `http://127.0.0.1:${warningProbeGatewayPort}${config.health_path}`,
    );
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
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_response_structure_warning === 1,
      "响应结构辅助探针未记录 probe_response_structure_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_identity_consistency_warning === 1,
      "身份一致性辅助探针未记录 probe_identity_consistency_warning",
    );
    assert(
      warningProbeStatus.active_probe.warning_type_counts
        ?.probe_knowledge_cutoff_warning === 1,
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
      assert(
        blockedProbeResponse.status === 202,
        `上游阻断探针触发失败: ${blockedProbeResponse.status}`,
      );
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
      const blockedProbeSamples =
        blockedProbeStatus.active_probe.recent_samples.slice(0, 2);
      assert(
        blockedProbeSamples.length === 2,
        `上游阻断探针最近样本应为 2 条，实际 ${blockedProbeSamples.length}`,
      );
      assert(
        blockedProbeSamples.every(
          (sample) => sample.result === "transport_error",
        ),
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
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("finish type="),
            ) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("detail=upstream_error"),
            ),
        ),
        "上游阻断探针样本应保留结束日志和 upstream_error 细节",
      );
    } finally {
      await writeFile(probeAuthPath, probeAuthBackupContent, "utf8");
    }

    const unauthProbeGatewayPort = await getFreePort();
    const unauthProbeConfigDir = path.join(tempRoot, "unauth-probe", "config");
    const unauthProbeConfigPath = path.join(
      unauthProbeConfigDir,
      "config.json",
    );
    const unauthProbeLogPath = path.join(
      tempRoot,
      "unauth-probe",
      "gateway.log",
    );
    const unauthProbeCodexConfigPath = path.join(
      tempRoot,
      "unauth-probe",
      "codex-config.toml",
    );
    const unauthProbeStatePath = path.join(
      tempRoot,
      "unauth-probe",
      "state.json",
    );
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
      unauthProbeGateway = startGateway(
        unauthProbeConfigPath,
        unauthProbeLogPath,
      );
      await waitForHealth(
        `http://127.0.0.1:${unauthProbeGatewayPort}${config.health_path}`,
      );
      const unauthProbeStatus = await waitForStatusCondition(
        `http://127.0.0.1:${unauthProbeGatewayPort}/__codex_retry_gateway/api/status`,
        (payload) =>
          Number(payload?.active_probe?.total_runs) >= 1 &&
          Array.isArray(payload?.active_probe?.recent_samples) &&
          payload.active_probe.recent_samples.length >= 2,
        5000,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.http_status === 401,
        ),
        `缺鉴权时主动探针状态码应为 401，实际 ${JSON.stringify(unauthProbeStatus.active_probe.recent_samples.map((sample) => sample.http_status))}`,
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.result === "indeterminate",
        ),
        "缺鉴权时主动探针结果应为 indeterminate",
      );
      assert(
        unauthProbeStatus.active_probe.recent_samples.every(
          (sample) => sample.confidence == null,
        ),
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
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("finish type="),
            ) &&
            sample.evidence_logs.some((entry) =>
              String(entry?.message || "").includes("detail="),
            ),
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
    limitGateway.child.kill();
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
