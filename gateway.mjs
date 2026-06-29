#!/usr/bin/env node

import http from "node:http";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMIN_BASE_PATH = "/__codex_retry_gateway";
const UI_PATH = `${ADMIN_BASE_PATH}/ui`;
const STATUS_API_PATH = `${ADMIN_BASE_PATH}/api/status`;
const CONFIG_API_PATH = `${ADMIN_BASE_PATH}/api/config`;
const LOGS_API_PATH = `${ADMIN_BASE_PATH}/api/logs`;
const PROBE_RUN_API_PATH = `${ADMIN_BASE_PATH}/api/probe/run`;
const RESTORE_API_PATH = `${ADMIN_BASE_PATH}/api/restore`;
const FAVICON_PATH = "/favicon.ico";

const DEFAULT_CONFIG = {
  listen_host: "127.0.0.1",
  listen_port: 4610,
  upstream_base_url: "",
  request_body_limit_bytes: 10 * 1024 * 1024,
  endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
  reasoning_equals: [516, 1034, 1552],
  intercept_streaming: true,
  intercept_non_streaming: true,
  non_stream_status_code: 502,
  guard_retry_attempts: 3,
  stream_action: "strict_502",
  log_match: true,
  health_path: "/__codex_retry_gateway/health",
  active_probe: {
    enabled: false,
    interval_ms: 15 * 60 * 1000,
    startup_delay_ms: 60 * 1000,
    timeout_ms: 120 * 1000,
    target_families: [],
    endpoint_candidates: ["/responses", "/v1/responses"],
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
      target_input_tokens: 460000,
    },
  },
};

const INPUT_TOKEN_POINTERS = [
  "/usage/input_tokens",
  "/response/usage/input_tokens",
];
const REASONING_POINTERS = [
  "/usage/output_tokens_details/reasoning_tokens",
  "/usage/completion_tokens_details/reasoning_tokens",
  "/response/usage/output_tokens_details/reasoning_tokens",
  "/response/usage/completion_tokens_details/reasoning_tokens",
];
const TRACKED_LOCAL_MODEL_FAMILIES = new Set(["gpt-5.4", "gpt-5.5"]);
const SUSPICIOUS_SAMPLE_LIMIT = 50;
const SUSPICIOUS_SAMPLE_EVIDENCE_LIMIT = 6;
const LONG_CONTEXT_PROBE_FILLER_UNIT = " a";
const LONG_CONTEXT_PROBE_SEED_UNIT_COUNT = 8192;
const LONG_CONTEXT_PROBE_TOKEN_TOLERANCE = 1024;
const LONG_CONTEXT_PROBE_MAX_BUDGET_ATTEMPTS = 2;
const DEFAULT_ACTIVE_PROBE_REASONING_EFFORT = "medium";
const DEFAULT_ACTIVE_PROBE_USER_AGENT = "codex-retry-gateway/active-probe";
const SUPPORTED_REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const PROBE_IMAGE_DATA_URL =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGwSURBVHhe7ZdRjoMwDEQ5Xg6U4+QuXIWbZLWifHQyZhfIuKrsJ+XHpRV+nkC69OAsWIhGCsBCNFIAFqKRArAQjRSAhWikACxEIwVgIRopAAvRSAFYULO10pdlMVbpbcNvaHEWsPY6NP2+irMBXwFrHRoeVmndU4GrgLWShofluw0cBbD4116JFM9t4CeAxb+uxkOx9hW/L8JNAIt//e1ya70MAl6fOeAkgMd/73HrreBnezo88BFgxP/gk9vAQQCf8NuAP7gN9AJoczhdLsljG8gF0HiTxuh1g6j5iAXwyZL+jaQY105EK4A2ZU2Vy2JpmYlUAI31SUP0evHRWCiAT/SkfyMx2qOxTgB795vxP+DSlP8QZQLY0ff+0m0DkQB29H22VNtAI4DG/+ESbQOJgLnxP5ZmGwgE8PifPv0Rx7fBfAE0/n89/RG/t8FkAcaNXxr/Dj8UXUzSP5grwIjurZs2fuuOzDOmCuBTuxr/AyNNt3+PM1GAccMPJsaF3kyUwUQB30kKwEI0UgAWopECsBCNFICFaKQALEQjBWAhGikAC9FIAViIRgrAQjTCC/gBCi0Q+LleBhsAAAAASUVORK5CYII=";
const KNOWLEDGE_CUTOFF_PROBE_QUESTIONS = [
  {
    id: "self_cutoff",
    prompt:
      '__crg_knowledge_cutoff_probe__:self_cutoff 请只输出 JSON：{"claims_cutoff":"YYYY-MM-DD or unknown"}',
  },
  {
    id: "anchor_1",
    prompt:
      "__crg_knowledge_cutoff_probe__:anchor_1 2025-01-20 就任的美国总统是谁？只回答人名。",
    validate: (text) => /donald trump|特朗普/i.test(text),
  },
  {
    id: "anchor_2",
    prompt:
      "__crg_knowledge_cutoff_probe__:anchor_2 唐纳德·特朗普再次就任美国总统的年份是几？只回答四位数字年份。",
    validate: (text) => /\b2025\b/.test(text),
  },
];

function parseArgs(argv) {
  const args = { config: null, log: null };
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--config") {
      args.config = argv[i + 1];
      i += 1;
    } else if (current === "--log") {
      args.log = argv[i + 1];
      i += 1;
    } else if (current === "--help" || current === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "用法:",
      "  node gateway.mjs --config <config.json> [--log <gateway.log>]",
      "",
      "说明:",
      "  独立 Codex 本地重试网关。",
      "  非流式命中 reasoning_tokens 命中默认集合 516/1034/1552 时返回 502。",
      "  流式命中时默认缓存并返回 502，避免半截流返回。",
      "",
    ].join("\n"),
  );
}

function normalizePath(inputPath) {
  const [withoutQuery] = `${inputPath || "/"}`.split("?");
  const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, "") : withoutQuery;
  return trimmed || "/";
}

function flattenValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenValues(item));
  }
  return [value];
}

function isJsonContentType(contentType) {
  return `${contentType || ""}`.toLowerCase().includes("application/json");
}

function isSseContentType(contentType) {
  return `${contentType || ""}`.toLowerCase().includes("text/event-stream");
}

function jsonPointerGet(value, pointer) {
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((current, segment) => {
      if (current === null || current === undefined) {
        return undefined;
      }
      return current[segment];
    }, value);
}

function extractReasoningTokens(payload) {
  for (const pointer of REASONING_POINTERS) {
    const raw = jsonPointerGet(payload, pointer);
    if (Number.isInteger(raw)) {
      return raw;
    }
  }
  return null;
}

function extractInputTokens(payload) {
  for (const pointer of INPUT_TOKEN_POINTERS) {
    const raw = jsonPointerGet(payload, pointer);
    if (Number.isInteger(raw)) {
      return raw;
    }
  }
  return null;
}

function extractTopLevelModel(content) {
  const [topLevelBlock] = `${content || ""}`.split(/^\[/m);
  const match = topLevelBlock.match(/^\s*model\s*=\s*"([^"]+)"\s*$/m);
  return match ? match[1] : null;
}

function extractProviderConfigSection(content, providerName) {
  if (!content || !providerName) {
    return null;
  }

  const lines = `${content}`.split(/\r?\n/);
  const header = `[model_providers.${providerName}]`;
  const collected = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (trimmed === header) {
        inSection = true;
        collected.push(line);
      }
      continue;
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      break;
    }
    collected.push(line);
  }

  return collected.length > 0 ? collected.join("\n") : null;
}

function extractProviderBooleanSetting(content, providerName, key) {
  const section = extractProviderConfigSection(content, providerName);
  if (!section || !key) {
    return null;
  }
  const settingPattern = new RegExp(
    String.raw`^\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*=\s*(true|false)\s*$`,
    "mi",
  );
  const match = section.match(settingPattern);
  if (!match) {
    return null;
  }
  return match[1].toLowerCase() === "true";
}

function normalizeModelFamily(modelName) {
  if (!modelName) {
    return "unknown";
  }

  const value = `${modelName}`.trim().toLowerCase();
  if (!value) {
    return "unknown";
  }
  if (value.startsWith("gpt-5.4-mini")) {
    return "gpt-5.4-mini";
  }
  if (value.startsWith("gpt-5.5-mini")) {
    return "gpt-5.5-mini";
  }
  if (value.startsWith("gpt-5.4-nano")) {
    return "gpt-5.4-nano";
  }
  if (value.startsWith("gpt-5.5-nano")) {
    return "gpt-5.5-nano";
  }
  if (value.startsWith("gpt-5.4")) {
    return "gpt-5.4";
  }
  if (value.startsWith("gpt-5.5")) {
    return "gpt-5.5";
  }
  if (value.includes("mini")) {
    return "mini";
  }
  if (value.includes("nano")) {
    return "nano";
  }
  return "other";
}

function incrementStringCount(counter, value) {
  if (!value) {
    return;
  }
  const key = `${value}`;
  counter[key] = (counter[key] || 0) + 1;
}

function extractPayloadModels(payload) {
  const models = [];
  if (typeof payload?.model === "string") {
    models.push(payload.model);
  }
  if (typeof payload?.response?.model === "string") {
    models.push(payload.response.model);
  }
  return [...new Set(models)];
}

function extractPayloadSystemFingerprint(payload) {
  if (typeof payload?.system_fingerprint === "string") {
    return payload.system_fingerprint;
  }
  if (typeof payload?.response?.system_fingerprint === "string") {
    return payload.response.system_fingerprint;
  }
  return null;
}

function extractPayloadServiceTier(payload) {
  if (typeof payload?.service_tier === "string") {
    return payload.service_tier;
  }
  if (typeof payload?.response?.service_tier === "string") {
    return payload.response.service_tier;
  }
  return null;
}

function normalizeReasoningEffort(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  if (!SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    return null;
  }
  return normalized;
}

function sanitizeActiveProbeProfileHeaders(profileHeaders = {}) {
  const sanitized = {};
  for (const [key, value] of Object.entries(profileHeaders || {})) {
    const headerName = `${key || ""}`.trim().toLowerCase();
    if (!headerName) {
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    const headerValue = value.trim();
    if (!headerValue) {
      continue;
    }
    if (headerName === "authorization" || headerName === "content-length" || headerName === "host") {
      continue;
    }
    sanitized[headerName] = headerValue;
  }
  return sanitized;
}

function extractRequestReasoningProfile(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const effort = normalizeReasoningEffort(payload?.reasoning?.effort);
  if (!effort) {
    return null;
  }
  return {
    effort,
  };
}

function buildActiveProbeRequestProfile(runtime, payload) {
  const current = runtime.activeProbeRequestProfile || {};
  const nextHeaders = sanitizeActiveProbeProfileHeaders({
    ...current.headers,
    "user-agent":
      typeof runtime.lastClientUserAgent === "string" && runtime.lastClientUserAgent.trim()
        ? runtime.lastClientUserAgent.trim()
        : current.headers?.["user-agent"] || DEFAULT_ACTIVE_PROBE_USER_AGENT,
  });
  const nextReasoning = extractRequestReasoningProfile(payload) || current.reasoning || null;
  runtime.activeProbeRequestProfile = {
    headers: nextHeaders,
    reasoning: nextReasoning,
    captured_at: new Date().toISOString(),
  };
}

function extractPayloadResponseId(payload, options = {}) {
  if (typeof payload?.response?.id === "string") {
    return payload.response.id;
  }
  if (options.allowTopLevelId && typeof payload?.id === "string") {
    return payload.id;
  }
  return null;
}

function looksLikeLowContextFamilyError(payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("400000") ||
    text.includes("400k") ||
    text.includes("context_length_exceeded")
  );
}

function looksLikeImageInputUnsupported(payload) {
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("unsupported_image_input") ||
    text.includes("does not support image input") ||
    text.includes("image input is not supported") ||
    text.includes("vision is not supported")
  );
}

function extractProbeTextFromChoices(choices) {
  if (!Array.isArray(choices)) {
    return [];
  }
  const fragments = [];
  for (const choice of choices) {
    if (typeof choice?.text === "string") {
      fragments.push(choice.text);
    }
    if (typeof choice?.message?.content === "string") {
      fragments.push(choice.message.content);
    }
  }
  return fragments;
}

function extractProbeTextFromOutputItems(outputItems) {
  if (!Array.isArray(outputItems)) {
    return [];
  }
  const fragments = [];
  for (const item of outputItems) {
    if (typeof item?.text === "string") {
      fragments.push(item.text);
    }
    if (typeof item?.output_text === "string") {
      fragments.push(item.output_text);
    }
    if (Array.isArray(item?.content)) {
      for (const contentItem of item.content) {
        if (typeof contentItem?.text === "string") {
          fragments.push(contentItem.text);
        }
        if (typeof contentItem?.output_text === "string") {
          fragments.push(contentItem.output_text);
        }
      }
    }
  }
  return fragments;
}

function extractProbeResponseText(payload) {
  const fragments = [];
  if (typeof payload?.output_text === "string") {
    fragments.push(payload.output_text);
  }
  if (typeof payload?.response?.output_text === "string") {
    fragments.push(payload.response.output_text);
  }
  if (typeof payload?.text === "string") {
    fragments.push(payload.text);
  }
  fragments.push(...extractProbeTextFromOutputItems(payload?.output));
  fragments.push(...extractProbeTextFromOutputItems(payload?.response?.output));
  fragments.push(...extractProbeTextFromChoices(payload?.choices));
  return fragments.filter(Boolean).join("\n").trim();
}

function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractEmbeddedJsonObject(text) {
  const normalized = `${text || ""}`.trim();
  if (!normalized) {
    return null;
  }
  const exact = parseJsonText(normalized);
  if (exact && typeof exact === "object") {
    return exact;
  }
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  const candidate = normalized.slice(firstBrace, lastBrace + 1);
  const parsed = parseJsonText(candidate);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function isExpectedResponseStructurePayload(parsed) {
  return (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray(parsed.items) &&
    parsed.items.length === 3 &&
    parsed.items[0]?.key === "a" &&
    parsed.items[0]?.value === 1 &&
    parsed.items[1]?.key === "b" &&
    parsed.items[1]?.value === 2 &&
    parsed.items[2]?.key === "c" &&
    parsed.items[2]?.value === 3
  );
}

function parseProbeReport(text) {
  const parsed = extractEmbeddedJsonObject(text);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function buildAggregateProbeContext(targetModel) {
  return {
    upstreamModel: null,
    streamModel: null,
    finalResponseModel: null,
    observedModels: new Set(),
    observedFingerprints: new Set(),
  };
}

function mergeAggregateProbeAttempt(context, attempt) {
  if (!context || !attempt?.modelContext) {
    return;
  }
  if (attempt.modelContext.upstreamModel) {
    context.upstreamModel = attempt.modelContext.upstreamModel;
  }
  if (attempt.modelContext.streamModel) {
    context.streamModel = attempt.modelContext.streamModel;
  }
  if (attempt.modelContext.finalResponseModel) {
    context.finalResponseModel = attempt.modelContext.finalResponseModel;
  }
  for (const modelName of attempt.modelContext.observedModels || []) {
    context.observedModels.add(modelName);
  }
  for (const fingerprint of attempt.modelContext.observedFingerprints || []) {
    context.observedFingerprints.add(fingerprint);
  }
}

function buildAggregateProbeSample(options) {
  const {
    probeType,
    targetModel,
    targetFamily,
    endpointPath,
    classified,
    attempts,
    aggregateContext,
    probeLogs,
  } = options;
  const lastAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  const durationMs = attempts.reduce(
    (total, attempt) => total + Number(attempt?.duration_ms || 0),
    0,
  );
  const firstError = attempts.find((attempt) => attempt?.requestError)?.requestError;
  return {
    probe_type: probeType,
    target_model: targetModel,
    target_family: targetFamily,
    endpoint_path: endpointPath,
    result: classified.result,
    result_type: classified.resultType || null,
    confidence: classified.confidence ?? null,
    http_status: lastAttempt?.responseStatus ?? null,
    duration_ms: durationMs,
    error_excerpt:
      classified.errorExcerpt ||
      lastAttempt?.responseBodyExcerpt ||
      (firstError ? `${firstError?.message || firstError}` : null),
    upstream_model: aggregateContext.upstreamModel,
    stream_model: aggregateContext.streamModel,
    final_response_model: aggregateContext.finalResponseModel,
    observed_models: [...aggregateContext.observedModels],
    observed_fingerprints: [...aggregateContext.observedFingerprints],
    evidence_logs: collectProbeEvidenceLogs(probeLogs, probeType),
  };
}

function buildProbeSampleFromAttempt(options) {
  const {
    probeType,
    targetModel,
    targetFamily,
    endpointPath,
    classified,
    attempt,
    probeLogs,
  } = options;
  return {
    probe_type: probeType,
    target_model: targetModel,
    target_family: targetFamily,
    endpoint_path: endpointPath,
    result: classified.result,
    result_type: classified.resultType || null,
    confidence: classified.confidence ?? null,
    http_status: attempt.responseStatus,
    duration_ms: attempt.duration_ms,
    error_excerpt:
      attempt.requestError
        ? `${attempt.requestError?.message || attempt.requestError}`
        : attempt.responseBodyExcerpt,
    upstream_model: attempt.modelContext.upstreamModel,
    stream_model: attempt.modelContext.streamModel,
    final_response_model: attempt.modelContext.finalResponseModel,
    observed_models: [...attempt.modelContext.observedModels],
    observed_fingerprints: [...attempt.modelContext.observedFingerprints],
    evidence_logs: collectProbeEvidenceLogs(probeLogs, probeType),
  };
}

function normalizeIntegerList(values, fallback = []) {
  const source = values === undefined || values === null ? fallback : values;
  const normalized = flattenValues(source)
    .flatMap((value) => {
      if (typeof value === "string") {
        return value.split(/[\s,]+/).filter(Boolean);
      }
      return [value];
    })
    .map((value) => Number.parseInt(`${value}`, 10))
    .filter((value) => Number.isInteger(value));

  return [...new Set(normalized)];
}

function normalizeStringList(values, fallback = []) {
  const source = values === undefined || values === null ? fallback : values;
  const normalized = flattenValues(source)
    .flatMap((value) => `${value ?? ""}`.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(normalized)];
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(`${value}`, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeGuardRetryAttempts(value) {
  const text = `${value ?? ""}`.trim();
  if (text === "") {
    throw new Error("guard_retry_attempts 必须是大于等于 0 的整数");
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== text || parsed < 0) {
    throw new Error("guard_retry_attempts 必须是大于等于 0 的整数");
  }
  return parsed;
}

function normalizeTrackedFamilyList(values, fallback = []) {
  const normalized = normalizeStringList(values, fallback)
    .map((value) => normalizeModelFamily(value))
    .filter((value) => TRACKED_LOCAL_MODEL_FAMILIES.has(value));
  return [...new Set(normalized)];
}

function normalizeActiveProbeConfig(input = {}) {
  const defaults = DEFAULT_CONFIG.active_probe;
  const targetFamilies = normalizeTrackedFamilyList(input?.target_families, defaults.target_families);
  const requestedEnabled = Boolean(input?.enabled);
  return {
    enabled: requestedEnabled && targetFamilies.length > 0,
    interval_ms: normalizePositiveInteger(input?.interval_ms, defaults.interval_ms),
    startup_delay_ms: normalizePositiveInteger(input?.startup_delay_ms, defaults.startup_delay_ms),
    timeout_ms: normalizePositiveInteger(input?.timeout_ms, defaults.timeout_ms),
    target_families: targetFamilies,
    endpoint_candidates: normalizeStringList(
      input?.endpoint_candidates,
      defaults.endpoint_candidates,
    ).map(normalizePath),
    image_input: {
      enabled: input?.image_input?.enabled !== false,
    },
    response_structure: {
      enabled: Boolean(input?.response_structure?.enabled),
      repeat_count: normalizePositiveInteger(
        input?.response_structure?.repeat_count,
        defaults.response_structure.repeat_count,
      ),
    },
    identity_consistency: {
      enabled: Boolean(input?.identity_consistency?.enabled),
      repeat_count: normalizePositiveInteger(
        input?.identity_consistency?.repeat_count,
        defaults.identity_consistency.repeat_count,
      ),
    },
    knowledge_cutoff: {
      enabled: Boolean(input?.knowledge_cutoff?.enabled),
      max_questions: normalizePositiveInteger(
        input?.knowledge_cutoff?.max_questions,
        defaults.knowledge_cutoff.max_questions,
      ),
    },
    long_context: {
      enabled: input?.long_context?.enabled !== false,
      target_input_tokens: normalizePositiveInteger(
        input?.long_context?.target_input_tokens ?? input?.long_context?.target_word_count,
        defaults.long_context.target_input_tokens,
      ),
    },
  };
}

function createFamilyBreakdownEntry() {
  return {
    consistency: {
      total_checked: 0,
      matched: 0,
      mismatched: 0,
      unknown: 0,
    },
    anomalies: {
      low_context_family_count: 0,
    },
    single_request_anomalies: {
      model_drift_count: 0,
      fingerprint_drift_count: 0,
      rebuild_suspected_count: 0,
    },
  };
}

function createTrackedFamilyBreakdown() {
  const breakdown = {};
  for (const family of TRACKED_LOCAL_MODEL_FAMILIES) {
    breakdown[family] = createFamilyBreakdownEntry();
  }
  return breakdown;
}

function calculateConsistencyMatchRatio(consistency) {
  const matched = Number(consistency?.matched || 0);
  const mismatched = Number(consistency?.mismatched || 0);
  const declaredChecked = matched + mismatched;
  return declaredChecked === 0 ? 0 : matched / declaredChecked;
}

function getFamilyBreakdownEntry(monitor, family) {
  if (!TRACKED_LOCAL_MODEL_FAMILIES.has(family)) {
    return null;
  }
  if (!monitor.family_breakdown[family]) {
    monitor.family_breakdown[family] = createFamilyBreakdownEntry();
  }
  return monitor.family_breakdown[family];
}

function buildBlockedBody(pathname, reasoning, statusCode) {
  return JSON.stringify({
    error: {
      message: `codex retry gateway blocked suspicious reasoning response on ${pathname}`,
      type: "codex_retry_gateway",
      code: "reasoning_guard_triggered",
      reasoning_tokens: reasoning,
      status_code: statusCode,
    },
  });
}

function buildGatewayErrorBody(message) {
  return JSON.stringify({
    error: {
      message,
      type: "codex_retry_gateway_error",
      code: "gateway_error",
    },
  });
}

function parseSsePayloads(state, chunk) {
  const decoded = state.decoder.decode(chunk, { stream: true });
  state.buffer += decoded;

  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() ?? "";
  const payloads = [];

  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const dataLines = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.replace(/^data:\s?/, ""));

    if (dataLines.length === 0) {
      continue;
    }
    const payloadText = dataLines.join("\n");
    if (payloadText === "[DONE]") {
      continue;
    }
    try {
      payloads.push(JSON.parse(payloadText));
    } catch {
      // ignore malformed SSE payloads
    }
  }

  return payloads;
}

function createMonitor() {
  return {
    started_at: new Date().toISOString(),
    next_log_seq: 1,
    log_entries: [],
    total_proxy_request_count: 0,
    inspected_response_count: 0,
    bypassed_proxy_request_count: 0,
    bypassed_proxy_path_counts: {},
    failed_proxy_request_count: 0,
    active_proxy_request_count: 0,
    active_proxy_path_counts: {},
    matched_response_count: 0,
    matched_streaming_count: 0,
    matched_non_streaming_count: 0,
    blocked_response_count: 0,
    blocked_streaming_count: 0,
    blocked_non_streaming_count: 0,
    observed_reasoning_counts: {},
    local_model_counts: {},
    upstream_model_counts: {},
    stream_model_counts: {},
    model_consistency: {
      total_checked: 0,
      matched: 0,
      mismatched: 0,
      unknown: 0,
    },
    model_family_anomalies: {
      low_context_family_count: 0,
    },
    single_request_anomalies: {
      model_drift_count: 0,
      fingerprint_drift_count: 0,
      rebuild_suspected_count: 0,
    },
    family_breakdown: createTrackedFamilyBreakdown(),
    suspicious_model_samples: [],
  };
}

function createProbeMonitor() {
  return {
    enabled: false,
    running: false,
    last_started_at: null,
    last_finished_at: null,
    last_target_model: null,
    last_target_family: null,
    total_runs: 0,
    skipped_runs: 0,
    pass_count: 0,
    warning_count: 0,
    violation_count: 0,
    transport_error_count: 0,
    indeterminate_count: 0,
    endpoint_success_counts: {},
    probe_type_counts: {
      long_context: 0,
      image_input: 0,
      response_structure: 0,
      identity_consistency: 0,
      knowledge_cutoff: 0,
    },
    warning_type_counts: {
      probe_response_structure_warning: 0,
      probe_identity_consistency_warning: 0,
      probe_knowledge_cutoff_warning: 0,
    },
    violation_type_counts: {
      probe_low_context_family_violation: 0,
      probe_image_input_violation: 0,
    },
    last_successful_endpoint: null,
    recent_samples: [],
  };
}

function createMonitorRecorder(monitor) {
  return (message) => {
    const entry = {
      seq: monitor.next_log_seq,
      at: new Date().toISOString(),
      message,
    };
    monitor.next_log_seq += 1;
    monitor.log_entries.push(entry);
    return entry;
  };
}

function createLogger(logPath, recordEntry) {
  if (!logPath) {
    return (message) => {
      const entry = recordEntry ? recordEntry(message) : { at: new Date().toISOString(), message };
      process.stdout.write(`${entry.at} ${entry.message}\n`);
    };
  }

  const stream = fs.createWriteStream(logPath, { flags: "a" });
  return (message) => {
    const entry = recordEntry ? recordEntry(message) : { at: new Date().toISOString(), message };
    const line = `${entry.at} ${entry.message}\n`;
    stream.write(line);
    process.stdout.write(line);
  };
}

function incrementReasoningCount(counter, reasoning) {
  if (!Number.isInteger(reasoning)) {
    return;
  }
  const key = `${reasoning}`;
  counter[key] = (counter[key] || 0) + 1;
}

function recordInspectedResponse(monitor, reasoning, matched, streamKind = null) {
  monitor.inspected_response_count += 1;
  incrementReasoningCount(monitor.observed_reasoning_counts, reasoning);
  if (matched) {
    monitor.matched_response_count += 1;
    if (streamKind === "stream") {
      monitor.matched_streaming_count += 1;
    } else if (streamKind === "non-stream") {
      monitor.matched_non_streaming_count += 1;
    }
  }
}

function recordBlockedResponse(monitor, streamKind) {
  monitor.blocked_response_count += 1;
  if (streamKind === "stream") {
    monitor.blocked_streaming_count += 1;
  } else if (streamKind === "non-stream") {
    monitor.blocked_non_streaming_count += 1;
  }
}

function recordBypassedProxyRequest(monitor, pathname) {
  monitor.bypassed_proxy_request_count += 1;
  incrementStringCount(monitor.bypassed_proxy_path_counts, pathname || "(unknown)");
}

function recordActiveProxyRequestStart(monitor, pathname) {
  monitor.active_proxy_request_count += 1;
  incrementStringCount(monitor.active_proxy_path_counts, pathname || "(unknown)");
}

function recordActiveProxyRequestEnd(monitor, pathname) {
  monitor.active_proxy_request_count = Math.max(0, monitor.active_proxy_request_count - 1);
  const key = pathname || "(unknown)";
  const nextCount = (monitor.active_proxy_path_counts[key] || 0) - 1;
  if (nextCount > 0) {
    monitor.active_proxy_path_counts[key] = nextCount;
  } else {
    delete monitor.active_proxy_path_counts[key];
  }
}

function setRequestTrackingOutcome(requestTracking, outcome) {
  if (!requestTracking) {
    return;
  }
  requestTracking.outcome = outcome;
  if (requestTracking.req) {
    requestTracking.req.__codexRetryGatewayProxyOutcome = outcome;
  }
}

function createRequestModelContext(localConfigModel, requestModel) {
  return {
    localConfigModel: localConfigModel || null,
    localRequestModel: requestModel || null,
    effectiveLocalModel: requestModel || localConfigModel || null,
    upstreamModel: null,
    streamModel: null,
    finalResponseModel: null,
    serviceTier: null,
    systemFingerprint: null,
    responseId: null,
    firstObservedModel: null,
    lastObservedModel: null,
    observedModels: new Set(),
    observedModelFamilies: new Set(),
    observedFingerprints: new Set(),
    observedResponseIds: new Set(),
  };
}

function recordObservedModel(context, modelName) {
  if (!modelName) {
    return;
  }
  const normalized = `${modelName}`;
  context.observedModels.add(normalized);
  context.observedModelFamilies.add(normalizeModelFamily(normalized));
  if (!context.firstObservedModel) {
    context.firstObservedModel = normalized;
  }
  context.lastObservedModel = normalized;
}

function recordObservedFingerprint(context, fingerprint) {
  if (!fingerprint) {
    return;
  }
  const normalized = `${fingerprint}`;
  context.observedFingerprints.add(normalized);
  context.systemFingerprint = normalized;
}

function recordObservedResponseId(context, responseId) {
  if (!responseId) {
    return;
  }
  const normalized = `${responseId}`;
  context.observedResponseIds.add(normalized);
  context.responseId = normalized;
}

function collectSuspiciousSampleEvidenceLogs(monitor, pathname, context, anomalyType, confidence) {
  const relatedEntries = monitor.log_entries
    .filter((entry) => entry?.message?.includes(`path=${pathname}`))
    .slice(-(SUSPICIOUS_SAMPLE_EVIDENCE_LIMIT - 1))
    .map((entry) => ({
      seq: entry.seq,
      at: entry.at,
      message: entry.message,
    }));

  const summaryEntry = {
    seq: null,
    at: new Date().toISOString(),
    message:
      `[sample] path=${pathname} anomaly=${anomalyType} confidence=${confidence} ` +
      `local=${context.effectiveLocalModel || "-"} upstream=${context.upstreamModel || "-"} ` +
      `stream=${context.streamModel || "-"} first=${context.firstObservedModel || "-"} ` +
      `last=${context.lastObservedModel || "-"} models=${[...context.observedModels].join("|") || "-"} ` +
      `fingerprints=${[...context.observedFingerprints].join("|") || "-"}`,
  };

  return [...relatedEntries, summaryEntry];
}

function applyPayloadModelSignals(context, payload, options = {}) {
  const models = extractPayloadModels(payload);
  for (const modelName of models) {
    recordObservedModel(context, modelName);
  }

  const fingerprint = extractPayloadSystemFingerprint(payload);
  if (fingerprint) {
    recordObservedFingerprint(context, fingerprint);
  }

  const serviceTier = extractPayloadServiceTier(payload);
  if (serviceTier) {
    context.serviceTier = `${serviceTier}`;
  }

  const responseId = extractPayloadResponseId(payload, {
    allowTopLevelId: !options.fromStream,
  });
  if (responseId) {
    recordObservedResponseId(context, responseId);
  }

  if (options.fromStream && models.length > 0) {
    context.streamModel = models[models.length - 1];
  }
  if (options.fromFinalResponse && models.length > 0) {
    context.finalResponseModel = models[models.length - 1];
  }
  if (!options.fromStream && models.length > 0) {
    context.upstreamModel = models[models.length - 1];
  }
}

function pushSuspiciousModelSample(monitor, pathname, context, anomalyType, confidence) {
  monitor.suspicious_model_samples.unshift({
    ts: new Date().toISOString(),
    path: pathname,
    local_config_model: context.localConfigModel,
    local_request_model: context.localRequestModel,
    effective_local_model: context.effectiveLocalModel,
    upstream_model: context.upstreamModel,
    stream_model: context.streamModel,
    first_observed_model: context.firstObservedModel,
    last_observed_model: context.lastObservedModel,
    observed_models: [...context.observedModels],
    observed_model_families: [...context.observedModelFamilies],
    system_fingerprint: context.systemFingerprint,
    observed_fingerprints: [...context.observedFingerprints],
    service_tier: context.serviceTier,
    anomaly_type: anomalyType,
    confidence,
    evidence_logs: collectSuspiciousSampleEvidenceLogs(
      monitor,
      pathname,
      context,
      anomalyType,
      confidence,
    ),
  });
  if (monitor.suspicious_model_samples.length > SUSPICIOUS_SAMPLE_LIMIT) {
    monitor.suspicious_model_samples.length = SUSPICIOUS_SAMPLE_LIMIT;
  }
}

function finalizeModelInsights(monitor, pathname, context, errorPayload = null) {
  const effectiveLocalModel = context.effectiveLocalModel;
  const effectiveFamily = normalizeModelFamily(effectiveLocalModel);
  const familyBreakdown = getFamilyBreakdownEntry(monitor, effectiveFamily);

  if (effectiveLocalModel) {
    incrementStringCount(monitor.local_model_counts, effectiveLocalModel);
  }
  if (context.upstreamModel) {
    incrementStringCount(monitor.upstream_model_counts, context.upstreamModel);
  }
  if (context.streamModel) {
    incrementStringCount(monitor.stream_model_counts, context.streamModel);
  }

  if (TRACKED_LOCAL_MODEL_FAMILIES.has(effectiveFamily)) {
    monitor.model_consistency.total_checked += 1;
    familyBreakdown.consistency.total_checked += 1;
    const declaredModel = context.upstreamModel || context.streamModel || context.finalResponseModel;
    const declaredFamily = normalizeModelFamily(declaredModel);
    if (declaredFamily === "unknown") {
      monitor.model_consistency.unknown += 1;
      familyBreakdown.consistency.unknown += 1;
    } else if (declaredFamily === effectiveFamily) {
      monitor.model_consistency.matched += 1;
      familyBreakdown.consistency.matched += 1;
    } else {
      monitor.model_consistency.mismatched += 1;
      familyBreakdown.consistency.mismatched += 1;
      pushSuspiciousModelSample(monitor, pathname, context, "model_family_mismatch", "high");
    }
  }

  if (looksLikeLowContextFamilyError(errorPayload)) {
    monitor.model_family_anomalies.low_context_family_count += 1;
    if (familyBreakdown) {
      familyBreakdown.anomalies.low_context_family_count += 1;
    }
    pushSuspiciousModelSample(monitor, pathname, context, "low_context_family_behavior", "high");
  }

  if (context.observedModelFamilies.size > 1) {
    monitor.single_request_anomalies.model_drift_count += 1;
    if (familyBreakdown) {
      familyBreakdown.single_request_anomalies.model_drift_count += 1;
    }
    pushSuspiciousModelSample(monitor, pathname, context, "single_request_model_drift", "high");
  } else if (context.observedFingerprints.size > 1) {
    monitor.single_request_anomalies.fingerprint_drift_count += 1;
    monitor.single_request_anomalies.rebuild_suspected_count += 1;
    if (familyBreakdown) {
      familyBreakdown.single_request_anomalies.fingerprint_drift_count += 1;
      familyBreakdown.single_request_anomalies.rebuild_suspected_count += 1;
    }
    pushSuspiciousModelSample(monitor, pathname, context, "single_request_rebuild_suspected", "high");
  } else if (
    context.finalResponseModel &&
    context.streamModel &&
    normalizeModelFamily(context.finalResponseModel) !== normalizeModelFamily(context.streamModel)
  ) {
    monitor.single_request_anomalies.rebuild_suspected_count += 1;
    if (familyBreakdown) {
      familyBreakdown.single_request_anomalies.rebuild_suspected_count += 1;
    }
    pushSuspiciousModelSample(monitor, pathname, context, "single_request_rebuild_suspected", "high");
  } else if (context.observedResponseIds.size > 1) {
    monitor.single_request_anomalies.rebuild_suspected_count += 1;
    if (familyBreakdown) {
      familyBreakdown.single_request_anomalies.rebuild_suspected_count += 1;
    }
    pushSuspiciousModelSample(monitor, pathname, context, "single_request_rebuild_suspected", "high");
  }
}

function buildMetricsSnapshot(monitor) {
  const reasoning516Count = monitor.observed_reasoning_counts["516"] || 0;
  const inspectedResponseCount = monitor.inspected_response_count;
  return {
    started_at: monitor.started_at,
    total_proxy_request_count: monitor.total_proxy_request_count,
    inspected_response_count: inspectedResponseCount,
    bypassed_proxy_request_count: monitor.bypassed_proxy_request_count,
    bypassed_proxy_path_counts: { ...monitor.bypassed_proxy_path_counts },
    failed_proxy_request_count: monitor.failed_proxy_request_count,
    active_proxy_request_count: monitor.active_proxy_request_count,
    active_proxy_path_counts: { ...monitor.active_proxy_path_counts },
    matched_response_count: monitor.matched_response_count,
    matched_streaming_count: monitor.matched_streaming_count,
    matched_non_streaming_count: monitor.matched_non_streaming_count,
    blocked_response_count: monitor.blocked_response_count,
    blocked_streaming_count: monitor.blocked_streaming_count,
    blocked_non_streaming_count: monitor.blocked_non_streaming_count,
    reasoning_516_count: reasoning516Count,
    reasoning_516_ratio:
      inspectedResponseCount === 0 ? 0 : reasoning516Count / inspectedResponseCount,
    observed_reasoning_counts: { ...monitor.observed_reasoning_counts },
  };
}

function buildModelInsightsSnapshot(runtime) {
  const consistency = runtime.monitor.model_consistency;
  const familyBreakdown = {};
  for (const family of TRACKED_LOCAL_MODEL_FAMILIES) {
    const bucket = runtime.monitor.family_breakdown?.[family] || createFamilyBreakdownEntry();
    const bucketConsistency = bucket.consistency || createFamilyBreakdownEntry().consistency;
    familyBreakdown[family] = {
      consistency: {
        ...bucketConsistency,
        match_ratio: calculateConsistencyMatchRatio(bucketConsistency),
      },
      anomalies: { ...(bucket.anomalies || createFamilyBreakdownEntry().anomalies) },
      single_request_anomalies: {
        ...(bucket.single_request_anomalies || createFamilyBreakdownEntry().single_request_anomalies),
      },
    };
  }
  return {
    local_config_model: runtime.localConfigModelCache || null,
    local_config_family: normalizeModelFamily(runtime.localConfigModelCache),
    local_model_counts: { ...runtime.monitor.local_model_counts },
    upstream_model_counts: { ...runtime.monitor.upstream_model_counts },
    stream_model_counts: { ...runtime.monitor.stream_model_counts },
    consistency: {
      ...consistency,
      match_ratio: calculateConsistencyMatchRatio(consistency),
    },
    anomalies: { ...runtime.monitor.model_family_anomalies },
    single_request_anomalies: { ...runtime.monitor.single_request_anomalies },
    family_breakdown: familyBreakdown,
    suspicious_samples: runtime.monitor.suspicious_model_samples.map((sample) => ({
      ...sample,
      evidence_logs: Array.isArray(sample.evidence_logs)
        ? sample.evidence_logs.map((entry) => ({ ...entry }))
        : [],
    })),
  };
}

function buildActiveProbeSnapshot(runtime) {
  const probeMonitor = runtime.probeMonitor || createProbeMonitor();
  return {
    ...probeMonitor,
    enabled: Boolean(runtime.config?.active_probe?.enabled),
    interval_ms: runtime.config?.active_probe?.interval_ms ?? DEFAULT_CONFIG.active_probe.interval_ms,
    target_families: Array.isArray(runtime.config?.active_probe?.target_families)
      ? [...runtime.config.active_probe.target_families]
      : [],
    endpoint_success_counts: { ...probeMonitor.endpoint_success_counts },
    probe_type_counts: { ...probeMonitor.probe_type_counts },
    warning_type_counts: { ...probeMonitor.warning_type_counts },
    violation_type_counts: { ...probeMonitor.violation_type_counts },
    recent_samples: Array.isArray(probeMonitor.recent_samples)
      ? probeMonitor.recent_samples.map((sample) => ({ ...sample }))
      : [],
  };
}

function pushProbeSample(probeMonitor, sample) {
  probeMonitor.recent_samples.unshift({
    ts: new Date().toISOString(),
    ...sample,
  });
  if (probeMonitor.recent_samples.length > SUSPICIOUS_SAMPLE_LIMIT) {
    probeMonitor.recent_samples.length = SUSPICIOUS_SAMPLE_LIMIT;
  }
}

function applyProbeResultCounters(probeMonitor, sample) {
  if (!sample) {
    return;
  }
  incrementStringCount(probeMonitor.probe_type_counts, sample.probe_type);
  if (sample.result === "pass") {
    probeMonitor.pass_count += 1;
  } else if (sample.result === "warning") {
    probeMonitor.warning_count += 1;
    incrementStringCount(probeMonitor.warning_type_counts, sample.result_type);
  } else if (sample.result === "violation") {
    probeMonitor.violation_count += 1;
    incrementStringCount(probeMonitor.violation_type_counts, sample.result_type);
  } else if (sample.result === "transport_error") {
    probeMonitor.transport_error_count += 1;
  } else if (sample.result === "indeterminate") {
    probeMonitor.indeterminate_count += 1;
  }
}

function buildLogsSnapshot(monitor, sinceSeq = null) {
  const entries = Number.isInteger(sinceSeq)
    ? monitor.log_entries.filter((entry) => entry.seq > sinceSeq)
    : monitor.log_entries;

  return {
    total_entries: monitor.log_entries.length,
    latest_seq: monitor.next_log_seq - 1,
    entries,
  };
}

function buildProbeRequestUrl(baseUrl, endpointPath) {
  const requestUrl = new URL(`http://127.0.0.1${normalizePath(endpointPath)}`);
  return buildUpstreamUrl(baseUrl, requestUrl);
}

async function buildActiveProbeAuthHeaders(runtime) {
  const state = await readOptionalJson(runtime.paths.statePath);
  const codexConfigPath = state?.codex_config_path;
  const providerName = state?.provider_name;
  if (!codexConfigPath || !providerName) {
    return new Headers();
  }

  let requiresOpenaiAuth = false;
  try {
    const codexConfig = await readFile(codexConfigPath, "utf8");
    requiresOpenaiAuth =
      extractProviderBooleanSetting(codexConfig, providerName, "requires_openai_auth") === true;
  } catch {
    requiresOpenaiAuth = false;
  }

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
  });

  if (!requiresOpenaiAuth) {
    return headers;
  }

  const authPathCandidates = [
    path.join(path.dirname(codexConfigPath), "auth.json"),
    path.join(runtime.paths.stateRoot, "auth.json"),
  ];
  try {
    for (const authPath of authPathCandidates) {
      try {
        const authContent = await readFile(authPath, "utf8");
        const authPayload = JSON.parse(authContent);
        const openaiApiKey = typeof authPayload?.OPENAI_API_KEY === "string"
          ? authPayload.OPENAI_API_KEY.trim()
          : "";
        if (openaiApiKey) {
          headers.set("authorization", `Bearer ${openaiApiKey}`);
          break;
        }
      } catch {
        // continue to next candidate
      }
    }
  } catch {
    // keep probe unauthenticated; downstream classification will surface missing evidence
  }

  return headers;
}

function getActiveProbeRequestProfile(runtime) {
  const profile = runtime.activeProbeRequestProfile || {};
  const profileHeaders = sanitizeActiveProbeProfileHeaders(profile.headers || {});
  if (!profileHeaders["user-agent"]) {
    profileHeaders["user-agent"] = DEFAULT_ACTIVE_PROBE_USER_AGENT;
  }
  return {
    headers: profileHeaders,
    reasoning: profile.reasoning || { effort: DEFAULT_ACTIVE_PROBE_REASONING_EFFORT },
  };
}

async function readLocalConfigModel(runtime) {
  const state = await readOptionalJson(runtime.paths.statePath);
  const configPath = state?.codex_config_path;
  if (!configPath) {
    return null;
  }

  try {
    const content = await readFile(configPath, "utf8");
    return extractTopLevelModel(content);
  } catch {
    return null;
  }
}

async function getLocalConfigModel(runtime) {
  const model = await readLocalConfigModel(runtime);
  runtime.localConfigModelCache = model;
  return model;
}

async function loadConfig(configPath) {
  const content = await readFile(configPath, "utf8");
  const loaded = JSON.parse(content);
  const config = { ...DEFAULT_CONFIG, ...loaded };
  config.endpoints = normalizeStringList(config.endpoints, DEFAULT_CONFIG.endpoints).map(normalizePath);
  config.reasoning_equals = normalizeIntegerList(
    config.reasoning_equals,
    DEFAULT_CONFIG.reasoning_equals,
  );
  config.intercept_streaming = config.intercept_streaming !== false;
  config.intercept_non_streaming = config.intercept_non_streaming !== false;
  config.guard_retry_attempts = normalizeGuardRetryAttempts(config.guard_retry_attempts);
  if (!config.intercept_streaming && !config.intercept_non_streaming) {
    throw new Error("流式与非流式至少选择一个拦截目标");
  }
  config.active_probe = normalizeActiveProbeConfig(loaded.active_probe);
  if (!config.upstream_base_url) {
    throw new Error("配置缺少 upstream_base_url");
  }
  return config;
}

function buildLongContextProbeText(unitCount, phase = "budget") {
  const safeUnitCount = Math.max(0, Number(unitCount) || 0);
  const filler =
    safeUnitCount > 0
      ? LONG_CONTEXT_PROBE_FILLER_UNIT.repeat(safeUnitCount).slice(LONG_CONTEXT_PROBE_FILLER_UNIT.startsWith(" ") ? 1 : 0)
      : "";
  return [
    `__crg_long_context_probe__ phase=${phase} units=${safeUnitCount}`,
    filler,
    "只回复OK",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLongContextProbePayload(targetModel, unitCount, phase = "budget", profile = null) {
  const payload = {
    model: targetModel,
    max_output_tokens: 4,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: buildLongContextProbeText(unitCount, phase) }],
      },
    ],
  };
  return applyActiveProbePayloadProfile(payload, profile);
}

function combineProbeDetail(primary, secondary) {
  const parts = [primary, secondary]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return truncateProbeText(parts.join(" | "), 320);
}

function estimateLongContextUnitCount(baseInputTokens, measuredInputTokens, measuredUnitCount, targetInputTokens) {
  const numerator = Number(measuredInputTokens) - Number(baseInputTokens);
  const denominator = Number(measuredUnitCount);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return null;
  }
  const tokensPerUnit = numerator / denominator;
  if (!Number.isFinite(tokensPerUnit) || tokensPerUnit <= 0) {
    return null;
  }
  return Math.max(1, Math.ceil((Number(targetInputTokens) - Number(baseInputTokens)) / tokensPerUnit));
}

function buildLongContextBudgetDetail(options) {
  const parts = [];
  if (Number.isInteger(options?.targetInputTokens)) {
    parts.push(`target_input_tokens=${options.targetInputTokens}`);
  }
  if (Number.isInteger(options?.observedInputTokens)) {
    parts.push(`observed_input_tokens=${options.observedInputTokens}`);
  }
  if (Number.isInteger(options?.estimatedInputTokens)) {
    parts.push(`estimated_input_tokens=${options.estimatedInputTokens}`);
  }
  if (Number.isInteger(options?.baselineInputTokens)) {
    parts.push(`baseline_input_tokens=${options.baselineInputTokens}`);
  }
  if (Number.isInteger(options?.seedInputTokens)) {
    parts.push(`seed_input_tokens=${options.seedInputTokens}`);
  }
  if (Number.isInteger(options?.unitCount)) {
    parts.push(`unit_count=${options.unitCount}`);
  }
  if (Number.isInteger(options?.calibrationRounds)) {
    parts.push(`calibration_rounds=${options.calibrationRounds}`);
  }
  if (options?.tokenBudgetSource) {
    parts.push(`budget_source=${options.tokenBudgetSource}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function truncateProbeText(value, maxLength = 220) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function extractProbeBodyExcerpt(parsedBody) {
  if (!parsedBody || typeof parsedBody !== "object") {
    return null;
  }
  const errorType = typeof parsedBody?.error?.type === "string" ? parsedBody.error.type.trim() : "";
  const errorCode = typeof parsedBody?.error?.code === "string" ? parsedBody.error.code.trim() : "";
  const errorMessage = typeof parsedBody?.error?.message === "string"
    ? parsedBody.error.message.trim()
    : "";
  const errorParts = [errorType, errorCode, errorMessage].filter(Boolean);
  if (errorParts.length > 0) {
    return truncateProbeText(errorParts.join(" | "));
  }
  return truncateProbeText(extractProbeResponseText(parsedBody));
}

function appendProbeOutcomeEvidenceLogs(probeLog, sample, errorExcerpt) {
  if (typeof probeLog !== "function" || !sample) {
    return;
  }
  probeLog(
    `finish type=${sample.probe_type} family=${sample.target_family} status=${sample.http_status ?? "-"} result=${sample.result} result_type=${sample.result_type || "-"} confidence=${sample.confidence ?? "-"}`,
  );
  if (errorExcerpt) {
    probeLog(`evidence type=${sample.probe_type} family=${sample.target_family} detail=${errorExcerpt}`);
  }
}

function collectProbeEvidenceLogs(loggerEntries, probeType) {
  return loggerEntries
    .slice(-4)
    .map((entry) => ({
      seq: null,
      at: new Date().toISOString(),
      message: `[probe:${probeType}] ${entry}`,
    }));
}

function applyActiveProbeRequestProfileHeaders(headers, profile) {
  for (const [key, value] of Object.entries(profile?.headers || {})) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    headers.set(key, value.trim());
  }
}

function applyActiveProbePayloadProfile(payload, profile) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const clonedPayload = {
    ...payload,
  };
  const effort = normalizeReasoningEffort(profile?.reasoning?.effort) || DEFAULT_ACTIVE_PROBE_REASONING_EFFORT;
  clonedPayload.reasoning = {
    ...(payload.reasoning && typeof payload.reasoning === "object" ? payload.reasoning : {}),
    effort,
  };
  return clonedPayload;
}

async function executeProbeRequest(runtime, options) {
  const {
    probeType,
    endpointPath,
    payload,
    targetModel,
    targetFamily,
    classifyResult,
  } = options;
  const startedAt = Date.now();
  const modelContext = createRequestModelContext(targetModel, payload?.model ?? null);
  const probeLogs = [];
  const probeLog = (message) => {
    const line = `[probe] ${message}`;
    probeLogs.push(line);
    runtime.logger(line);
  };
  probeLog(`start type=${probeType} family=${targetFamily} endpoint=${endpointPath}`);

  const upstreamUrl = buildProbeRequestUrl(runtime.config.upstream_base_url, endpointPath);
  const probeHeaders = await buildActiveProbeAuthHeaders(runtime);
  const requestProfile = getActiveProbeRequestProfile(runtime);
  applyActiveProbeRequestProfileHeaders(probeHeaders, requestProfile);
  const profiledPayload = applyActiveProbePayloadProfile(payload, requestProfile);
  let responseStatus = null;
  let parsedBody = null;
  let requestError = null;

  try {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, runtime.config.active_probe.timeout_ms);
    timeoutHandle.unref?.();

    try {
      const upstreamResponse = await fetchUpstreamWithRetry(
        upstreamUrl,
        {
          method: "POST",
          headers: probeHeaders,
          body: JSON.stringify(profiledPayload),
          signal: abortController.signal,
        },
        runtime.logger,
      );
      responseStatus = upstreamResponse.status;
      const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
      parsedBody = isJsonContentType(upstreamResponse.headers.get("content-type"))
        ? parseJsonSafely(bodyBuffer)
        : null;
      if (parsedBody) {
        applyPayloadModelSignals(modelContext, parsedBody, { fromFinalResponse: true });
      }
      if (endpointPath) {
        incrementStringCount(runtime.probeMonitor.endpoint_success_counts, endpointPath);
        runtime.probeMonitor.last_successful_endpoint = endpointPath;
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    requestError = error;
  }

  const classified = classifyResult(responseStatus, parsedBody, requestError);
  const responseBodyExcerpt = extractProbeBodyExcerpt(parsedBody);
  const sample = {
    probe_type: probeType,
    target_model: targetModel,
    target_family: targetFamily,
    endpoint_path: endpointPath,
    result: classified.result,
    result_type: classified.resultType || null,
    confidence: classified.confidence ?? null,
    http_status: responseStatus,
    duration_ms: Date.now() - startedAt,
    error_excerpt: requestError ? `${requestError?.message || requestError}` : responseBodyExcerpt,
    upstream_model: modelContext.upstreamModel,
    stream_model: modelContext.streamModel,
    final_response_model: modelContext.finalResponseModel,
    observed_models: [...modelContext.observedModels],
    observed_fingerprints: [...modelContext.observedFingerprints],
    evidence_logs: [],
  };
  appendProbeOutcomeEvidenceLogs(probeLog, sample, sample.error_excerpt);
  sample.evidence_logs = collectProbeEvidenceLogs(probeLogs, probeType);
  pushProbeSample(runtime.probeMonitor, sample);
  applyProbeResultCounters(runtime.probeMonitor, sample);
  return sample;
}

async function executeProbeAttempt(runtime, options) {
  const {
    endpointPath,
    payload,
    targetModel,
  } = options;
  const startedAt = Date.now();
  const modelContext = createRequestModelContext(targetModel, payload?.model ?? null);
  const upstreamUrl = buildProbeRequestUrl(runtime.config.upstream_base_url, endpointPath);
  const probeHeaders = await buildActiveProbeAuthHeaders(runtime);
  const requestProfile = getActiveProbeRequestProfile(runtime);
  applyActiveProbeRequestProfileHeaders(probeHeaders, requestProfile);
  const profiledPayload = applyActiveProbePayloadProfile(payload, requestProfile);
  let responseStatus = null;
  let parsedBody = null;
  let requestError = null;

  try {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, runtime.config.active_probe.timeout_ms);
    timeoutHandle.unref?.();

    try {
      const upstreamResponse = await fetchUpstreamWithRetry(
        upstreamUrl,
        {
          method: "POST",
          headers: probeHeaders,
          body: JSON.stringify(profiledPayload),
          signal: abortController.signal,
        },
        runtime.logger,
      );
      responseStatus = upstreamResponse.status;
      const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
      parsedBody = isJsonContentType(upstreamResponse.headers.get("content-type"))
        ? parseJsonSafely(bodyBuffer)
        : null;
      if (parsedBody) {
        applyPayloadModelSignals(modelContext, parsedBody, { fromFinalResponse: true });
      }
      if (endpointPath) {
        incrementStringCount(runtime.probeMonitor.endpoint_success_counts, endpointPath);
        runtime.probeMonitor.last_successful_endpoint = endpointPath;
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (error) {
    requestError = error;
  }

  return {
    responseStatus,
    parsedBody,
    requestError,
    duration_ms: Date.now() - startedAt,
    inputTokens: extractInputTokens(parsedBody),
    responseText: extractProbeResponseText(parsedBody),
    responseBodyExcerpt: extractProbeBodyExcerpt(parsedBody),
    modelContext,
  };
}

function classifyLongContextProbeResult(responseStatus, parsedBody, requestError) {
  if (requestError) {
    return { result: "transport_error", confidence: null };
  }
  if (Number(responseStatus) >= 500) {
    return { result: "transport_error", confidence: null };
  }
  if (looksLikeLowContextFamilyError(parsedBody)) {
    return {
      result: "violation",
      resultType: "probe_low_context_family_violation",
      confidence: "high",
    };
  }
  if (responseStatus >= 200 && responseStatus < 300) {
    return { result: "pass", confidence: "medium" };
  }
  return { result: "indeterminate", confidence: null };
}

function classifyResponseStructureProbeResult(attempts) {
  const transportAttempt = attempts.find(
    (attempt) => attempt.requestError || Number(attempt.responseStatus) >= 500,
  );
  if (transportAttempt) {
    return { result: "transport_error", confidence: null };
  }
  const invalidCount = attempts.reduce((total, attempt) => {
    const text = attempt.responseText;
    const parsed = extractEmbeddedJsonObject(text);
    const exactJson = parseJsonText(`${text || ""}`.trim());
    const hasExtraText = Boolean(text) && exactJson === null && parsed !== null;
    const invalid =
      !text ||
      !parsed ||
      !isExpectedResponseStructurePayload(parsed) ||
      hasExtraText;
    return total + (invalid ? 1 : 0);
  }, 0);
  if (invalidCount >= 2) {
    return {
      result: "warning",
      resultType: "probe_response_structure_warning",
      confidence: "medium",
    };
  }
  if (invalidCount === 0) {
    return { result: "pass", confidence: "medium" };
  }
  return { result: "indeterminate", confidence: null };
}

function classifyIdentityConsistencyProbeResult(attempts) {
  const transportAttempt = attempts.find(
    (attempt) => attempt.requestError || Number(attempt.responseStatus) >= 500,
  );
  if (transportAttempt) {
    return { result: "transport_error", confidence: null };
  }
  const reports = attempts
    .map((attempt) => parseProbeReport(attempt.responseText))
    .filter(Boolean);
  if (reports.length !== attempts.length) {
    return { result: "indeterminate", confidence: null };
  }
  const families = new Set(
    reports
      .map((report) => `${report?.self_reported_family || ""}`.trim().toLowerCase())
      .filter(Boolean),
  );
  if (families.size > 1) {
    return {
      result: "warning",
      resultType: "probe_identity_consistency_warning",
      confidence: "medium",
    };
  }
  return { result: "pass", confidence: "low" };
}

function normalizeCutoffText(value) {
  return `${value || ""}`.trim().toLowerCase();
}

function classifyKnowledgeCutoffProbeResult(results) {
  const transportAttempt = results.find(
    (item) => item.attempt.requestError || Number(item.attempt.responseStatus) >= 500,
  );
  if (transportAttempt) {
    return { result: "transport_error", confidence: null };
  }
  const selfCutoffResult = results.find((item) => item.id === "self_cutoff");
  const selfReport = parseProbeReport(selfCutoffResult?.attempt?.responseText);
  const claimsCutoff = normalizeCutoffText(selfReport?.claims_cutoff);
  const claimsEarlyCutoff =
    claimsCutoff &&
    claimsCutoff !== "unknown" &&
    claimsCutoff < "2025-01-01";
  const anchorFailureCount = results
    .filter((item) => item.id !== "self_cutoff")
    .reduce((total, item) => total + (item.validate?.(item.attempt.responseText || "") ? 0 : 1), 0);
  if (claimsEarlyCutoff && anchorFailureCount >= 1) {
    return {
      result: "warning",
      resultType: "probe_knowledge_cutoff_warning",
      confidence: "low",
    };
  }
  if (!claimsEarlyCutoff && anchorFailureCount === 0) {
    return { result: "pass", confidence: "low" };
  }
  return { result: "indeterminate", confidence: null };
}

function classifyImageProbeResult(responseStatus, parsedBody, requestError) {
  if (requestError) {
    return { result: "transport_error", confidence: null };
  }
  if (Number(responseStatus) >= 500) {
    return { result: "transport_error", confidence: null };
  }
  if (looksLikeImageInputUnsupported(parsedBody)) {
    return {
      result: "violation",
      resultType: "probe_image_input_violation",
      confidence: "high",
    };
  }
  if (responseStatus >= 200 && responseStatus < 300) {
    return { result: "pass", confidence: "medium" };
  }
  return { result: "indeterminate", confidence: null };
}

async function runLongContextProbe(runtime, targetModel, targetFamily) {
  const endpointPath =
    runtime.probeMonitor.last_successful_endpoint ||
    runtime.config.active_probe.endpoint_candidates[0] ||
    "/responses";
  const targetInputTokens = runtime.config.active_probe.long_context.target_input_tokens;
  const probeLogs = [];
  const probeLog = (message) => {
    const line = `[probe] ${message}`;
    probeLogs.push(line);
    runtime.logger(line);
  };
  probeLog(
    `start type=long_context family=${targetFamily} endpoint=${endpointPath} target_input_tokens=${targetInputTokens} budget_source=response_usage`,
  );
  const requestProfile = getActiveProbeRequestProfile(runtime);
  probeLog(
    `profile type=long_context family=${targetFamily} user_agent=${requestProfile.headers["user-agent"] || "-"} reasoning_effort=${requestProfile.reasoning?.effort || "-"}`,
  );

  const finalizeSample = (classified, attempt, extra = {}) => {
    const budgetDetail = buildLongContextBudgetDetail({
      targetInputTokens,
      observedInputTokens: extra.observedInputTokens ?? attempt?.inputTokens ?? null,
      estimatedInputTokens: extra.estimatedInputTokens ?? null,
      baselineInputTokens: extra.baselineInputTokens ?? null,
      seedInputTokens: extra.seedInputTokens ?? null,
      unitCount: extra.unitCount ?? null,
      calibrationRounds: extra.calibrationRounds ?? null,
      tokenBudgetSource: "response_usage",
    });
    const primaryExcerpt = attempt?.requestError
      ? `${attempt.requestError?.message || attempt.requestError}`
      : attempt?.responseBodyExcerpt;
    const errorExcerpt = combineProbeDetail(primaryExcerpt, budgetDetail);
    const modelContext = attempt?.modelContext || createRequestModelContext(targetModel, targetModel);
    const sample = {
      probe_type: "long_context",
      target_model: targetModel,
      target_family: targetFamily,
      endpoint_path: endpointPath,
      result: classified.result,
      result_type: classified.resultType || null,
      confidence: classified.confidence ?? null,
      http_status: attempt?.responseStatus ?? null,
      duration_ms: attempt?.duration_ms ?? 0,
      error_excerpt: errorExcerpt,
      upstream_model: modelContext.upstreamModel,
      stream_model: modelContext.streamModel,
      final_response_model: modelContext.finalResponseModel,
      observed_models: [...modelContext.observedModels],
      observed_fingerprints: [...modelContext.observedFingerprints],
      requested_input_tokens: targetInputTokens,
      observed_input_tokens: extra.observedInputTokens ?? attempt?.inputTokens ?? null,
      estimated_input_tokens: extra.estimatedInputTokens ?? null,
      token_budget_source: "response_usage",
      calibration_rounds: extra.calibrationRounds ?? null,
      evidence_logs: [],
    };
    appendProbeOutcomeEvidenceLogs(probeLog, sample, sample.error_excerpt);
    sample.evidence_logs = collectProbeEvidenceLogs(probeLogs, "long_context");
    pushProbeSample(runtime.probeMonitor, sample);
    applyProbeResultCounters(runtime.probeMonitor, sample);
    return sample;
  };

  const runBudgetAttempt = async (unitCount, phase) =>
    executeProbeAttempt(runtime, {
      endpointPath,
      payload: buildLongContextProbePayload(targetModel, unitCount, phase, requestProfile),
      targetModel,
    });

  const baselineAttempt = await runBudgetAttempt(0, "baseline");
  const baselineClassified = classifyLongContextProbeResult(
    baselineAttempt.responseStatus,
    baselineAttempt.parsedBody,
    baselineAttempt.requestError,
  );
  if (baselineClassified.result !== "pass") {
    return finalizeSample(baselineClassified, baselineAttempt, {
      calibrationRounds: 1,
      unitCount: 0,
    });
  }
  if (!Number.isInteger(baselineAttempt.inputTokens)) {
    return finalizeSample(
      { result: "indeterminate", confidence: null },
      baselineAttempt,
      {
        calibrationRounds: 1,
        unitCount: 0,
      },
    );
  }

  const seedUnitCount = Math.max(
    1024,
    Math.min(LONG_CONTEXT_PROBE_SEED_UNIT_COUNT, targetInputTokens),
  );
  const seedAttempt = await runBudgetAttempt(seedUnitCount, "seed");
  const seedClassified = classifyLongContextProbeResult(
    seedAttempt.responseStatus,
    seedAttempt.parsedBody,
    seedAttempt.requestError,
  );
  if (seedClassified.result !== "pass") {
    return finalizeSample(seedClassified, seedAttempt, {
      baselineInputTokens: baselineAttempt.inputTokens,
      calibrationRounds: 2,
      unitCount: seedUnitCount,
    });
  }
  if (!Number.isInteger(seedAttempt.inputTokens) || seedAttempt.inputTokens <= baselineAttempt.inputTokens) {
    return finalizeSample(
      { result: "indeterminate", confidence: null },
      seedAttempt,
      {
        baselineInputTokens: baselineAttempt.inputTokens,
        calibrationRounds: 2,
        unitCount: seedUnitCount,
      },
    );
  }

  let unitCount = estimateLongContextUnitCount(
    baselineAttempt.inputTokens,
    seedAttempt.inputTokens,
    seedUnitCount,
    targetInputTokens,
  );
  if (!Number.isInteger(unitCount) || unitCount <= 0) {
    return finalizeSample(
      { result: "indeterminate", confidence: null },
      seedAttempt,
      {
        baselineInputTokens: baselineAttempt.inputTokens,
        seedInputTokens: seedAttempt.inputTokens,
        calibrationRounds: 2,
        unitCount: seedUnitCount,
      },
    );
  }

  let finalAttempt = seedAttempt;
  let estimatedInputTokens = null;
  let calibrationRounds = 2;

  for (let attemptIndex = 0; attemptIndex < LONG_CONTEXT_PROBE_MAX_BUDGET_ATTEMPTS; attemptIndex += 1) {
    estimatedInputTokens =
      baselineAttempt.inputTokens +
      Math.max(0, seedAttempt.inputTokens - baselineAttempt.inputTokens) *
        (unitCount / seedUnitCount);
    probeLog(
      `budget type=long_context family=${targetFamily} target_input_tokens=${targetInputTokens} baseline_input_tokens=${baselineAttempt.inputTokens} seed_input_tokens=${seedAttempt.inputTokens} unit_count=${unitCount} estimated_input_tokens=${Math.round(estimatedInputTokens)}`,
    );
    finalAttempt = await runBudgetAttempt(
      unitCount,
      attemptIndex === 0 ? "budget" : `budget_refine_${attemptIndex}`,
    );
    calibrationRounds += 1;
    const finalClassified = classifyLongContextProbeResult(
      finalAttempt.responseStatus,
      finalAttempt.parsedBody,
      finalAttempt.requestError,
    );
    if (finalClassified.result !== "pass") {
      return finalizeSample(finalClassified, finalAttempt, {
        baselineInputTokens: baselineAttempt.inputTokens,
        seedInputTokens: seedAttempt.inputTokens,
        estimatedInputTokens: Math.round(estimatedInputTokens),
        calibrationRounds,
        unitCount,
      });
    }
    if (
      Number.isInteger(finalAttempt.inputTokens) &&
      finalAttempt.inputTokens >= targetInputTokens - LONG_CONTEXT_PROBE_TOKEN_TOLERANCE
    ) {
      return finalizeSample(finalClassified, finalAttempt, {
        observedInputTokens: finalAttempt.inputTokens,
        baselineInputTokens: baselineAttempt.inputTokens,
        seedInputTokens: seedAttempt.inputTokens,
        estimatedInputTokens: Math.round(estimatedInputTokens),
        calibrationRounds,
        unitCount,
      });
    }
    if (!Number.isInteger(finalAttempt.inputTokens)) {
      break;
    }
    const remainingTokens = targetInputTokens - finalAttempt.inputTokens;
    if (remainingTokens <= LONG_CONTEXT_PROBE_TOKEN_TOLERANCE) {
      return finalizeSample(finalClassified, finalAttempt, {
        observedInputTokens: finalAttempt.inputTokens,
        baselineInputTokens: baselineAttempt.inputTokens,
        seedInputTokens: seedAttempt.inputTokens,
        estimatedInputTokens: Math.round(estimatedInputTokens),
        calibrationRounds,
        unitCount,
      });
    }
    const nextUnitCount = unitCount + Math.max(1, Math.ceil(
      remainingTokens /
        ((seedAttempt.inputTokens - baselineAttempt.inputTokens) / seedUnitCount),
    ));
    if (!Number.isInteger(nextUnitCount) || nextUnitCount <= unitCount) {
      break;
    }
    unitCount = nextUnitCount;
  }

  return finalizeSample(
    { result: "indeterminate", confidence: null },
    finalAttempt,
    {
      observedInputTokens: finalAttempt.inputTokens ?? null,
      baselineInputTokens: baselineAttempt.inputTokens,
      seedInputTokens: seedAttempt.inputTokens,
      estimatedInputTokens: estimatedInputTokens === null ? null : Math.round(estimatedInputTokens),
      calibrationRounds,
      unitCount,
    },
  );
}

async function runImageInputProbe(runtime, targetModel, targetFamily) {
  const endpointPath =
    runtime.probeMonitor.last_successful_endpoint ||
    runtime.config.active_probe.endpoint_candidates[0] ||
    "/responses";
  const payload = {
    model: targetModel,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "__crg_image_input_probe__ 请只回答图片里的大写字母。",
          },
          {
            type: "input_image",
            image_url: PROBE_IMAGE_DATA_URL,
          },
        ],
      },
    ],
  };
  return executeProbeRequest(runtime, {
    probeType: "image_input",
    endpointPath,
    payload,
    targetModel,
    targetFamily,
    classifyResult: classifyImageProbeResult,
  });
}

async function runResponseStructureProbe(runtime, targetModel, targetFamily) {
  const endpointPath =
    runtime.probeMonitor.last_successful_endpoint ||
    runtime.config.active_probe.endpoint_candidates[0] ||
    "/responses";
  const probeLogs = [];
  const probeLog = (message) => {
    const line = `[probe] ${message}`;
    probeLogs.push(line);
    runtime.logger(line);
  };
  probeLog(`start type=response_structure family=${targetFamily} endpoint=${endpointPath}`);
  const attempts = [];
  const repeatCount = runtime.config.active_probe.response_structure.repeat_count;
  for (let index = 0; index < repeatCount; index += 1) {
    const payload = {
      model: targetModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                '__crg_response_structure_probe__ 请只输出 JSON，不要额外文本。把 a=1,b=2,c=3 转成 {"items":[{"key":"a","value":1},{"key":"b","value":2},{"key":"c","value":3}]}',
            },
          ],
        },
      ],
    };
    attempts.push(
      await executeProbeAttempt(runtime, {
        endpointPath,
        payload,
        targetModel,
      }),
    );
  }
  const classified = classifyResponseStructureProbeResult(attempts);
  const aggregateContext = buildAggregateProbeContext(targetModel);
  for (const attempt of attempts) {
    mergeAggregateProbeAttempt(aggregateContext, attempt);
  }
  const sample = buildAggregateProbeSample({
    probeType: "response_structure",
    targetModel,
    targetFamily,
    endpointPath,
    classified,
    attempts,
    aggregateContext,
    probeLogs,
  });
  appendProbeOutcomeEvidenceLogs(probeLog, sample, sample.error_excerpt);
  sample.evidence_logs = collectProbeEvidenceLogs(probeLogs, "response_structure");
  pushProbeSample(runtime.probeMonitor, sample);
  applyProbeResultCounters(runtime.probeMonitor, sample);
  return sample;
}

async function runIdentityConsistencyProbe(runtime, targetModel, targetFamily) {
  const endpointPath =
    runtime.probeMonitor.last_successful_endpoint ||
    runtime.config.active_probe.endpoint_candidates[0] ||
    "/responses";
  const probeLogs = [];
  const probeLog = (message) => {
    const line = `[probe] ${message}`;
    probeLogs.push(line);
    runtime.logger(line);
  };
  probeLog(`start type=identity_consistency family=${targetFamily} endpoint=${endpointPath}`);
  const attempts = [];
  const repeatCount = runtime.config.active_probe.identity_consistency.repeat_count;
  for (let index = 0; index < repeatCount; index += 1) {
    const payload = {
      model: targetModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                '__crg_identity_probe__ 请只输出 JSON：{"self_reported_model":"...","self_reported_family":"...","claims_image_input":true,"claims_cutoff":"YYYY-MM-DD or unknown"}',
            },
          ],
        },
      ],
    };
    attempts.push(
      await executeProbeAttempt(runtime, {
        endpointPath,
        payload,
        targetModel,
      }),
    );
  }
  const classified = classifyIdentityConsistencyProbeResult(attempts);
  const aggregateContext = buildAggregateProbeContext(targetModel);
  for (const attempt of attempts) {
    mergeAggregateProbeAttempt(aggregateContext, attempt);
  }
  const sample = buildAggregateProbeSample({
    probeType: "identity_consistency",
    targetModel,
    targetFamily,
    endpointPath,
    classified,
    attempts,
    aggregateContext,
    probeLogs,
  });
  appendProbeOutcomeEvidenceLogs(probeLog, sample, sample.error_excerpt);
  sample.evidence_logs = collectProbeEvidenceLogs(probeLogs, "identity_consistency");
  pushProbeSample(runtime.probeMonitor, sample);
  applyProbeResultCounters(runtime.probeMonitor, sample);
  return sample;
}

async function runKnowledgeCutoffProbe(runtime, targetModel, targetFamily) {
  const endpointPath =
    runtime.probeMonitor.last_successful_endpoint ||
    runtime.config.active_probe.endpoint_candidates[0] ||
    "/responses";
  const probeLogs = [];
  const probeLog = (message) => {
    const line = `[probe] ${message}`;
    probeLogs.push(line);
    runtime.logger(line);
  };
  probeLog(`start type=knowledge_cutoff family=${targetFamily} endpoint=${endpointPath}`);
  const maxQuestions = Math.max(1, runtime.config.active_probe.knowledge_cutoff.max_questions);
  const selectedQuestions = KNOWLEDGE_CUTOFF_PROBE_QUESTIONS.slice(0, maxQuestions);
  const results = [];
  for (const question of selectedQuestions) {
    const payload = {
      model: targetModel,
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: question.prompt }],
        },
      ],
    };
    results.push({
      id: question.id,
      validate: question.validate,
      attempt: await executeProbeAttempt(runtime, {
        endpointPath,
        payload,
        targetModel,
      }),
    });
  }
  const classified = classifyKnowledgeCutoffProbeResult(results);
  const aggregateContext = buildAggregateProbeContext(targetModel);
  for (const result of results) {
    mergeAggregateProbeAttempt(aggregateContext, result.attempt);
  }
  const sample = buildAggregateProbeSample({
    probeType: "knowledge_cutoff",
    targetModel,
    targetFamily,
    endpointPath,
    classified,
    attempts: results.map((item) => item.attempt),
    aggregateContext,
    probeLogs,
  });
  appendProbeOutcomeEvidenceLogs(probeLog, sample, sample.error_excerpt);
  sample.evidence_logs = collectProbeEvidenceLogs(probeLogs, "knowledge_cutoff");
  pushProbeSample(runtime.probeMonitor, sample);
  applyProbeResultCounters(runtime.probeMonitor, sample);
  return sample;
}

function buildTargetModelForFamily(localModel, targetFamily) {
  const normalizedFamily = normalizeModelFamily(targetFamily);
  if (!TRACKED_LOCAL_MODEL_FAMILIES.has(normalizedFamily)) {
    return null;
  }
  const localValue = `${localModel || ""}`.trim();
  if (localValue && normalizeModelFamily(localValue) === normalizedFamily) {
    return localValue;
  }
  return normalizedFamily;
}

function resolveActiveProbeTargets(config, localModel) {
  const selectedFamilies = normalizeTrackedFamilyList(config?.active_probe?.target_families, []);
  if (selectedFamilies.length > 0) {
    return selectedFamilies
      .map((family) => ({
        family,
        model: buildTargetModelForFamily(localModel, family),
      }))
      .filter((entry) => entry.model);
  }
  const localFamily = normalizeModelFamily(localModel);
  if (!TRACKED_LOCAL_MODEL_FAMILIES.has(localFamily)) {
    return [];
  }
  return [{ family: localFamily, model: localModel }];
}

async function runActiveProbeOnce(runtime) {
  const localModel = await getLocalConfigModel(runtime);
  const targets = resolveActiveProbeTargets(runtime.config, localModel);
  runtime.probeMonitor.total_runs += 1;

  if (targets.length === 0) {
    runtime.probeMonitor.last_target_model = localModel;
    runtime.probeMonitor.last_target_family = normalizeModelFamily(localModel);
    runtime.probeMonitor.skipped_runs += 1;
    runtime.logger(
      `[probe] skip reason=untracked_family family=${normalizeModelFamily(localModel)}`,
    );
    return;
  }

  for (const target of targets) {
    const targetModel = target.model;
    const targetFamily = target.family;
    runtime.probeMonitor.last_target_model = targetModel;
    runtime.probeMonitor.last_target_family = targetFamily;

    if (runtime.config.active_probe.long_context.enabled) {
      await runLongContextProbe(runtime, targetModel, targetFamily);
    }
    if (runtime.config.active_probe.image_input.enabled) {
      await runImageInputProbe(runtime, targetModel, targetFamily);
    }
    if (runtime.config.active_probe.response_structure.enabled) {
      await runResponseStructureProbe(runtime, targetModel, targetFamily);
    }
    if (runtime.config.active_probe.identity_consistency.enabled) {
      await runIdentityConsistencyProbe(runtime, targetModel, targetFamily);
    }
    if (runtime.config.active_probe.knowledge_cutoff.enabled) {
      await runKnowledgeCutoffProbe(runtime, targetModel, targetFamily);
    }
  }
}

async function safeRunActiveProbeOnce(runtime, options = {}) {
  const manual = Boolean(options?.manual);
  const overrideActiveProbeConfig = options?.activeProbeConfig || null;
  if (!runtime.config.active_probe.enabled && !manual) {
    return;
  }
  if (runtime.probeMonitor.running) {
    runtime.logger("[probe] skip reason=already_running");
    return false;
  }
  runtime.probeMonitor.running = true;
  runtime.probeMonitor.last_started_at = new Date().toISOString();
  const previousActiveProbeConfig = runtime.config.active_probe;
  try {
    if (overrideActiveProbeConfig) {
      runtime.config = {
        ...runtime.config,
        active_probe: overrideActiveProbeConfig,
      };
    }
    await runActiveProbeOnce(runtime);
    return true;
  } catch (error) {
    runtime.logger(`[probe-error] ${error?.stack || error}`);
  } finally {
    if (overrideActiveProbeConfig) {
      runtime.config = {
        ...runtime.config,
        active_probe: previousActiveProbeConfig,
      };
    }
    runtime.probeMonitor.running = false;
    runtime.probeMonitor.last_finished_at = new Date().toISOString();
  }
  return false;
}

function clearActiveProbeSchedule(runtime) {
  if (runtime.probeStartupTimer) {
    clearTimeout(runtime.probeStartupTimer);
    runtime.probeStartupTimer = null;
  }
  if (runtime.probeTimer) {
    clearInterval(runtime.probeTimer);
    runtime.probeTimer = null;
  }
}

function scheduleActiveProbes(runtime) {
  clearActiveProbeSchedule(runtime);
  if (!runtime.config.active_probe.enabled) {
    return;
  }
  const startupDelayMs = runtime.config.active_probe.startup_delay_ms;
  runtime.probeStartupTimer = setTimeout(() => {
    safeRunActiveProbeOnce(runtime).catch(() => {});
    runtime.probeTimer = setInterval(() => {
      safeRunActiveProbeOnce(runtime).catch(() => {});
    }, runtime.config.active_probe.interval_ms);
    runtime.probeTimer?.unref?.();
  }, startupDelayMs);
  runtime.probeStartupTimer?.unref?.();
}

function buildRuntimePaths(configPath, logPath) {
  const configDirectory = path.dirname(configPath);
  const stateRoot = path.dirname(configDirectory);
  return {
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    pidPath: path.join(stateRoot, "gateway.pid"),
    configPath,
    logPath,
  };
}

async function readOptionalJson(jsonPath) {
  try {
    const content = await readFile(jsonPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function writeConfig(configPath, config) {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function extractProviderBaseUrl(content, providerName) {
  if (!content || !providerName) {
    return null;
  }

  const sectionPattern = new RegExp(
    String.raw`^\[model_providers\.${providerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\]\s*$[\s\S]*?(?=^\[|\Z)`,
    "m",
  );
  const sectionMatch = content.match(sectionPattern);
  if (!sectionMatch) {
    return null;
  }

  const baseUrlMatch = sectionMatch[0].match(/^\s*base_url\s*=\s*"([^"]+)"\s*$/m);
  return baseUrlMatch ? baseUrlMatch[1] : null;
}

async function readRuntimeState(runtime) {
  const state = await readOptionalJson(runtime.paths.statePath);
  if (!state) {
    return null;
  }

  let codexCurrentBaseUrl = null;
  if (state.codex_config_path && state.provider_name) {
    try {
      const codexConfig = await readFile(state.codex_config_path, "utf8");
      codexCurrentBaseUrl = extractProviderBaseUrl(codexConfig, state.provider_name);
    } catch {
      codexCurrentBaseUrl = null;
    }
  }

  return {
    ...state,
    codex_current_base_url: codexCurrentBaseUrl,
  };
}

async function restoreRuntimeState(runtime, state) {
  const backupPath = state?.latest_backup_path;
  const codexConfigPath = state?.codex_config_path;

  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(`未找到可恢复备份: ${backupPath || "unknown"}`);
  }
  if (!codexConfigPath) {
    throw new Error("安装状态里缺少 codex_config_path");
  }

  await copyFile(backupPath, codexConfigPath);
  await Promise.all([
    rm(runtime.paths.statePath, { force: true }),
    rm(runtime.paths.pidPath, { force: true }),
  ]);
}

function jsonResponse(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function htmlResponse(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
  });
  res.end(html);
}

function buildEditableConfig(currentConfig, payload) {
  const nextReasoning = normalizeIntegerList(payload.reasoning_equals, currentConfig.reasoning_equals);
  const nextEndpoints = normalizeStringList(payload.endpoints, currentConfig.endpoints).map(normalizePath);
  const nextStatusCode =
    payload.non_stream_status_code === undefined
      ? currentConfig.non_stream_status_code
      : Number.parseInt(`${payload.non_stream_status_code}`, 10);
  const nextInterceptStreaming =
    payload.intercept_streaming === undefined
      ? currentConfig.intercept_streaming !== false
      : Boolean(payload.intercept_streaming);
  const nextInterceptNonStreaming =
    payload.intercept_non_streaming === undefined
      ? currentConfig.intercept_non_streaming !== false
      : Boolean(payload.intercept_non_streaming);
  const nextGuardRetryAttempts =
    payload.guard_retry_attempts === undefined
      ? currentConfig.guard_retry_attempts
      : normalizeGuardRetryAttempts(payload.guard_retry_attempts);
  const nextActiveProbe =
    payload.active_probe === undefined
      ? currentConfig.active_probe
      : normalizeActiveProbeConfig({
          ...currentConfig.active_probe,
          ...payload.active_probe,
        });
  const requestedActiveProbeEnabled =
    payload.active_probe === undefined
      ? Boolean(currentConfig.active_probe?.enabled)
      : payload.active_probe?.enabled === undefined
        ? Boolean(currentConfig.active_probe?.enabled)
        : Boolean(payload.active_probe.enabled);

  if (nextReasoning.length === 0) {
    throw new Error("reasoning_equals 不能为空");
  }
  if (nextEndpoints.length === 0) {
    throw new Error("endpoints 不能为空");
  }
  if (!Number.isInteger(nextStatusCode) || nextStatusCode < 100 || nextStatusCode > 599) {
    throw new Error("non_stream_status_code 必须是 100-599 的整数");
  }
  if (!nextInterceptStreaming && !nextInterceptNonStreaming) {
    throw new Error("流式与非流式至少选择一个拦截目标");
  }
  if (requestedActiveProbeEnabled && nextActiveProbe.target_families.length === 0) {
    throw new Error("开启自动探测前，至少选择一个探测目标模型");
  }

  return {
    ...currentConfig,
    reasoning_equals: nextReasoning,
    endpoints: nextEndpoints,
    intercept_streaming: nextInterceptStreaming,
    intercept_non_streaming: nextInterceptNonStreaming,
    non_stream_status_code: nextStatusCode,
    guard_retry_attempts: nextGuardRetryAttempts,
    log_match: payload.log_match === undefined ? currentConfig.log_match : Boolean(payload.log_match),
    active_probe: nextActiveProbe,
  };
}

function buildManagementHtml() {
  const uiConfig = {
    statusPath: STATUS_API_PATH,
    configPath: CONFIG_API_PATH,
    logsPath: LOGS_API_PATH,
    restorePath: RESTORE_API_PATH,
  };

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Retry Gateway</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f2ede3;
        --panel: rgba(255, 251, 245, 0.9);
        --panel-strong: #fffdf8;
        --ink: #1f1d1a;
        --muted: #6c655c;
        --accent: #1f6f5f;
        --accent-soft: #d9efe9;
        --warn: #a2512f;
        --line: rgba(31, 29, 26, 0.12);
        --shadow: 0 18px 40px rgba(47, 34, 14, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Segoe UI Variable", "Bahnschrift", "Segoe UI", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(31, 111, 95, 0.22), transparent 34%),
          radial-gradient(circle at top right, rgba(162, 81, 47, 0.18), transparent 26%),
          linear-gradient(180deg, #f8f4ec 0%, var(--bg) 100%);
      }

      .shell {
        max-width: 1080px;
        margin: 0 auto;
        padding: 28px 18px 60px;
      }

      .hero {
        padding: 26px;
        border: 1px solid var(--line);
        border-radius: 28px;
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.78), rgba(249, 242, 228, 0.92));
        box-shadow: var(--shadow);
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 13px;
        font-weight: 700;
      }

      .hero-heading {
        display: flex;
        align-items: center;
        gap: 28px;
        flex-wrap: wrap;
        margin: 16px 0 8px;
      }

      h1 {
        margin: 0;
        font-size: clamp(30px, 6vw, 48px);
        line-height: 1.05;
      }

      .tg-link {
        display: inline-flex;
        align-items: center;
        min-height: 34px;
        padding: 7px 12px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.62);
        color: var(--accent);
        font-size: 14px;
        font-weight: 700;
        text-decoration: none;
        word-break: break-word;
      }

      .tg-link:hover {
        border-color: rgba(31, 111, 95, 0.42);
        background: var(--accent-soft);
      }

      .lead {
        margin: 0;
        max-width: 720px;
        font-size: 16px;
        line-height: 1.7;
        color: var(--muted);
      }

      .grid {
        display: grid;
        gap: 18px;
        margin-top: 22px;
      }

      @media (min-width: 900px) {
        .grid {
          grid-template-columns: 1.1fr 0.9fr;
        }
      }

      .card {
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(10px);
      }

      .card-inner {
        padding: 22px;
      }

      .card h2 {
        margin: 0 0 14px;
        font-size: 18px;
      }

      .stats {
        display: grid;
        gap: 12px;
      }

      @media (min-width: 640px) {
        .stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      .stat {
        padding: 14px;
        border-radius: 18px;
        background: var(--panel-strong);
        border: 1px solid rgba(31, 29, 26, 0.08);
      }

      .stat label {
        display: block;
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
        margin-bottom: 6px;
      }

      .stat strong,
      .stat span {
        display: block;
        font-size: 15px;
        line-height: 1.5;
        word-break: break-word;
      }

      form {
        display: grid;
        gap: 16px;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      .field label {
        font-weight: 700;
        font-size: 14px;
      }

      .hint {
        font-size: 12px;
        color: var(--muted);
        line-height: 1.5;
      }

      input,
      textarea,
      select {
        width: 100%;
        border: 1px solid rgba(31, 29, 26, 0.14);
        border-radius: 16px;
        padding: 12px 14px;
        font: inherit;
        color: var(--ink);
        background: #fffdfa;
      }

      textarea {
        min-height: 132px;
        resize: vertical;
      }

      .inline-toggle {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--panel-strong);
        border: 1px solid rgba(31, 29, 26, 0.08);
      }

      .inline-toggle input[type="checkbox"] {
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        flex: 0 0 auto;
      }

      .inline-toggle label {
        margin: 0;
        cursor: pointer;
      }

      .checkbox-group {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .checkbox-chip {
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr);
        align-items: center;
        gap: 8px;
        min-height: 56px;
        padding: 10px 14px;
        border-radius: 14px;
        border: 1px solid rgba(31, 29, 26, 0.08);
        background: var(--panel-strong);
      }

      .checkbox-chip input[type="checkbox"] {
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        flex: 0 0 auto;
      }

      .compact-field input {
        max-width: none;
      }

      .probe-control-card {
        display: grid;
        gap: 14px;
      }

      .probe-control-title {
        font-size: 12px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
        margin: 0;
      }

      .probe-control-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(220px, 1fr);
        gap: 16px;
        align-items: stretch;
      }

      @media (max-width: 899px) {
        .probe-control-grid {
          grid-template-columns: 1fr;
        }
      }

      .probe-control-side {
        display: grid;
        gap: 12px;
        align-content: start;
      }

      .probe-control-side .field {
        gap: 6px;
      }

      .probe-control-side .field label,
      .probe-control-side .inline-toggle label {
        font-size: 13px;
      }

      .probe-control-side .inline-toggle {
        padding: 10px 12px;
      }

      .probe-control-side.actions-side {
        grid-template-rows: auto 1fr;
      }

      .probe-control-side.actions-side .field {
        align-content: start;
      }

      .probe-control-action {
        display: flex;
        align-items: flex-end;
        justify-content: flex-end;
        min-height: 100%;
      }

      .probe-control-action .primary {
        min-width: 0;
        width: 100%;
      }

      @media (max-width: 899px) {
        .probe-control-action {
          justify-content: stretch;
        }
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      button {
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        font: inherit;
        font-weight: 700;
        cursor: pointer;
      }

      .primary {
        color: white;
        background: linear-gradient(135deg, #236e60, #184f45);
      }

      .secondary {
        color: var(--warn);
        background: #fff4ee;
        border: 1px solid rgba(162, 81, 47, 0.2);
      }

      .message {
        min-height: 24px;
        font-size: 14px;
        line-height: 1.6;
      }

      .message[data-tone="error"] {
        color: #9e2f21;
      }

      .message[data-tone="success"] {
        color: var(--accent);
      }

      .footnote {
        margin-top: 12px;
        font-size: 13px;
        line-height: 1.6;
        color: var(--muted);
      }

      .wide-card {
        grid-column: 1 / -1;
      }

      .live-meta {
        margin: 0 0 12px;
        font-size: 13px;
        line-height: 1.6;
        color: var(--muted);
      }

      .log-output {
        margin: 0;
        min-height: 320px;
        max-height: 420px;
        overflow: auto;
        padding: 16px;
        border-radius: 18px;
        border: 1px solid rgba(31, 29, 26, 0.08);
        background: #1e1d1a;
        color: #f4efe7;
        font-family: "Cascadia Code", "Consolas", monospace;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .distribution {
        display: grid;
        gap: 12px;
      }

      .distribution-item {
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--panel-strong);
        border: 1px solid rgba(31, 29, 26, 0.08);
      }

      .distribution-item strong {
        display: block;
        margin-bottom: 4px;
      }

      .table-wrap {
        overflow-x: auto;
        border-radius: 18px;
        border: 1px solid rgba(31, 29, 26, 0.08);
        background: var(--panel-strong);
      }

      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 900px;
      }

      th,
      td {
        padding: 12px 14px;
        border-bottom: 1px solid rgba(31, 29, 26, 0.08);
        text-align: left;
        vertical-align: top;
        font-size: 13px;
        line-height: 1.5;
      }

      th {
        background: rgba(31, 111, 95, 0.08);
      }

      .risk-note {
        margin: 0 0 14px;
        padding: 12px 14px;
        border-radius: 16px;
        background: #fff8ef;
        border: 1px solid rgba(162, 81, 47, 0.18);
        color: #6b3b1f;
        font-size: 13px;
        line-height: 1.7;
      }

      .evidence-details {
        min-width: 220px;
      }

      .evidence-details summary {
        cursor: pointer;
        color: var(--accent);
        font-weight: 700;
      }

      .evidence-log-output {
        margin: 8px 0 0;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(31, 29, 26, 0.04);
        white-space: pre-wrap;
        word-break: break-word;
        font-family: "Cascadia Code", "Consolas", monospace;
        font-size: 12px;
        line-height: 1.6;
      }

      code {
        font-family: "Cascadia Code", "Consolas", monospace;
        font-size: 0.92em;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="hero">
        <div class="eyebrow">本地管理页</div>
        <div class="hero-heading">
          <h1>Codex Retry Gateway</h1>
          <a class="tg-link" href="https://t.me/AI_INPUT_IM" target="_blank" rel="noopener noreferrer">TG群：https://t.me/AI_INPUT_IM</a>
        </div>
        <p class="lead">
          这个页面直接挂在正在运行的 gateway 上。你可以在这里查看当前接管状态、修改 reasoning 拦截条件，并一键恢复 Codex 原设置。
        </p>
      </section>

      <div class="grid">
        <section class="card">
          <div class="card-inner">
            <h2>运行状态</h2>
            <div class="stats">
              <div class="stat"><label>监听地址</label><strong id="listenValue">-</strong></div>
              <div class="stat"><label>真实上游</label><span id="upstreamValue">-</span></div>
              <div class="stat"><label>当前 Provider</label><span id="providerValue">-</span></div>
              <div class="stat"><label>当前 Codex Base URL</label><span id="codexBaseUrlValue">-</span></div>
              <div class="stat"><label>Config 文件</label><span id="configPathValue">-</span></div>
              <div class="stat"><label>备份文件</label><span id="backupPathValue">-</span></div>
              <div class="stat"><label>本次启动时间</label><span id="startedAtValue">-</span></div>
              <div class="stat"><label>代理请求总数</label><strong id="proxyRequestCountValue">0</strong></div>
              <div class="stat"><label>被检查响应总数</label><strong id="inspectedCountValue">0</strong></div>
              <div class="stat"><label>当前规则命中总数</label><strong id="matchedCountValue">0</strong></div>
              <div class="stat"><label>实际拦截总数</label><strong id="blockedCountValue">0</strong></div>
              <div class="stat"><label>实际拦截占比</label><strong id="blockedRatioValue">0.00%</strong></div>
              <div class="stat"><label>流式规则命中</label><strong id="matchedStreamingCountValue">0</strong></div>
              <div class="stat"><label>非流式规则命中</label><strong id="matchedNonStreamingCountValue">0</strong></div>
              <div class="stat"><label>流式实际拦截</label><strong id="blockedStreamingCountValue">0</strong></div>
              <div class="stat"><label>非流式实际拦截</label><strong id="blockedNonStreamingCountValue">0</strong></div>
            </div>
            <p class="footnote" id="statsFootnote">
              如果“当前 Codex Base URL”已经是本机监听地址，就说明当前 Codex 已经被这个 gateway 接管。统计口径按本次 gateway 启动以来累计。
            </p>
          </div>
        </section>

        <section class="card">
          <div class="card-inner">
            <h2>拦截规则</h2>
            <form id="configForm">
              <div class="field">
                <label for="reasoningInput">reasoning_equals</label>
                <input id="reasoningInput" name="reasoning_equals" type="text" placeholder="例如：516, 1034, 1552" />
                <div class="hint">多个值用英文逗号或空格分隔。</div>
              </div>

              <div class="field">
                <label>拦截目标</label>
                <div class="inline-toggle">
                  <input id="interceptStreamingInput" name="intercept_streaming" type="checkbox" />
                  <label for="interceptStreamingInput">拦截流式</label>
                </div>
                <div class="inline-toggle">
                  <input id="interceptNonStreamingInput" name="intercept_non_streaming" type="checkbox" />
                  <label for="interceptNonStreamingInput">拦截非流式</label>
                </div>
                <div class="hint">当前模式：<strong id="interceptModeValue">流式+非流式</strong></div>
              </div>

              <div class="field">
                <label for="endpointsInput">endpoints</label>
                <textarea id="endpointsInput" name="endpoints" placeholder="/responses"></textarea>
                <div class="hint">每行一个路径。默认建议同时保留 root 与 /v1 两套路径。</div>
              </div>

              <div class="field">
                <label for="statusCodeInput">non_stream_status_code</label>
                <input id="statusCodeInput" name="non_stream_status_code" type="number" min="100" max="599" />
              </div>

              <div class="field">
                <label for="guardRetryAttemptsInput">网关内重试次数</label>
                <input id="guardRetryAttemptsInput" name="guard_retry_attempts" type="number" min="0" step="1" required />
                <div class="hint">仅对命中拦截规则的响应生效；上游 429/502 等真实错误会直接透传。</div>
              </div>

              <div class="inline-toggle">
                <input id="logMatchInput" name="log_match" type="checkbox" />
                <label for="logMatchInput">log_match 命中时写日志</label>
              </div>

              <div class="actions">
                <button class="primary" id="saveButton" type="submit">保存并立即生效</button>
                <button class="secondary" id="restoreButton" type="button">恢复 Codex 原设置并关闭网关</button>
              </div>
            </form>
            <div class="message" id="messageBox"></div>
            <p class="footnote">
              点击“恢复”后，gateway 会停掉，所以这个页面会失联。这是预期行为，不是报错。
            </p>
          </div>
        </section>

        <section class="card wide-card">
          <div class="card-inner">
            <h2>实时日志</h2>
            <p class="live-meta" id="logsMeta">正在读取日志...</p>
            <pre class="log-output" id="logsOutput">正在读取日志...</pre>
          </div>
        </section>

        <section class="card wide-card">
          <div class="card-inner">
            <h2>模型家族一致性（被动探针）</h2>
            <p class="risk-note">
              本地模型表示本机配置或请求声明；上游模型表示上游自报。声明一致不等于已证明真实运行一致。
              声明一致率只按拿到上游声明的样本计算，未声明样本不会计入分母。
              400K 家族异常只表示行为上疑似不符合 1M 家族。单请求模型漂移与疑似请求内重建/重试都按高风险展示，
              但仍然只能基于响应信号推断，不能直接确认缓存重建。
            </p>
            <div class="stats">
              <div class="stat"><label>声明一致率</label><strong id="modelMatchRatioValue">0.00%</strong></div>
              <div class="stat"><label>声明不一致次数</label><strong id="modelMismatchCountValue">0</strong></div>
              <div class="stat"><label>400K 家族异常</label><strong id="lowContextFamilyCountValue">0</strong></div>
              <div class="stat"><label>单请求模型漂移</label><strong id="modelDriftCountValue">0</strong></div>
              <div class="stat"><label>指纹漂移次数</label><strong id="fingerprintDriftCountValue">0</strong></div>
              <div class="stat"><label>疑似请求内重建/重试</label><strong id="rebuildSuspectedCountValue">0</strong></div>
            </div>
            <h2 style="margin-top: 18px;">最近可疑样本</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>路径</th>
                    <th>本地期望</th>
                    <th>上游声明</th>
                    <th>流式声明</th>
                    <th>首个模型</th>
                    <th>最后模型</th>
                    <th>模型集合</th>
                    <th>指纹集合</th>
                    <th>异常类型</th>
                    <th>可信度</th>
                    <th>日志证据</th>
                  </tr>
                </thead>
                <tbody id="suspiciousSamplesBody">
                  <tr><td colspan="12">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="card wide-card">
          <div class="card-inner">
            <h2>主动探针</h2>
            <p class="risk-note">
              主动探针只验证声明契约。warning 代表辅助异常，不代表硬违约；violation
              也不代表已经识别出真实底层模型，transport_error 不计入违约。
            </p>
            <div class="stats">
              <div class="stat"><label>主动探针状态</label><strong id="probeEnabledValue">-</strong></div>
              <div class="stat"><label>最近目标模型</label><span id="probeTargetModelValue">-</span></div>
              <div class="stat"><label>最近一次运行</label><span id="probeLastRunValue">-</span></div>
              <div class="stat"><label>通过次数</label><strong id="probePassCountValue">0</strong></div>
              <div class="stat"><label>warning 次数</label><strong id="probeWarningCountValue">0</strong></div>
              <div class="stat"><label>违约次数</label><strong id="probeViolationCountValue">0</strong></div>
              <div class="stat"><label>传输错误</label><strong id="probeTransportErrorCountValue">0</strong></div>
              <div class="stat">
                <div class="probe-control-card">
                  <p class="probe-control-title">主动探针控制</p>
                  <div class="probe-control-grid">
                    <div class="probe-control-side">
                      <div class="field">
                        <label>探测目标模型</label>
                        <div class="checkbox-group">
                          <label class="checkbox-chip" for="probeTargetFamily54Input">
                            <input id="probeTargetFamily54Input" type="checkbox" />
                            <span>gpt-5.4</span>
                          </label>
                          <label class="checkbox-chip" for="probeTargetFamily55Input">
                            <input id="probeTargetFamily55Input" type="checkbox" />
                            <span>gpt-5.5</span>
                          </label>
                        </div>
                      </div>
                      <div class="inline-toggle">
                        <input id="probeAutoEnabledInput" type="checkbox" />
                        <label for="probeAutoEnabledInput">开启自动探测</label>
                      </div>
                    </div>
                    <div class="probe-control-side actions-side">
                      <div class="field compact-field">
                        <label for="probeIntervalMinutesInput">探测频率（分钟）</label>
                        <input id="probeIntervalMinutesInput" type="number" min="1" step="1" />
                      </div>
                      <div class="probe-control-action">
                        <button class="primary" id="probeRunButton" type="button">现在探测一次</button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <h2 style="margin-top: 18px;">最近主动探针样本</h2>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>探针类型</th>
                    <th>目标模型</th>
                    <th>endpoint</th>
                    <th>结果</th>
                    <th>结果类型</th>
                    <th>可信度</th>
                    <th>状态码</th>
                    <th>耗时</th>
                    <th>上游模型</th>
                    <th>指纹集合</th>
                    <th>日志证据</th>
                  </tr>
                </thead>
                <tbody id="probeSamplesBody">
                  <tr><td colspan="12">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>

    <script>
      const ui = ${JSON.stringify(uiConfig)};
      const refs = {
        form: document.getElementById('configForm'),
        reasoningInput: document.getElementById('reasoningInput'),
        interceptStreamingInput: document.getElementById('interceptStreamingInput'),
        interceptNonStreamingInput: document.getElementById('interceptNonStreamingInput'),
        interceptModeValue: document.getElementById('interceptModeValue'),
        endpointsInput: document.getElementById('endpointsInput'),
        statusCodeInput: document.getElementById('statusCodeInput'),
        guardRetryAttemptsInput: document.getElementById('guardRetryAttemptsInput'),
        logMatchInput: document.getElementById('logMatchInput'),
        probeTargetFamily54Input: document.getElementById('probeTargetFamily54Input'),
        probeTargetFamily55Input: document.getElementById('probeTargetFamily55Input'),
        probeAutoEnabledInput: document.getElementById('probeAutoEnabledInput'),
        probeIntervalMinutesInput: document.getElementById('probeIntervalMinutesInput'),
        saveButton: document.getElementById('saveButton'),
        probeRunButton: document.getElementById('probeRunButton'),
        restoreButton: document.getElementById('restoreButton'),
        messageBox: document.getElementById('messageBox'),
        listenValue: document.getElementById('listenValue'),
        upstreamValue: document.getElementById('upstreamValue'),
        providerValue: document.getElementById('providerValue'),
        codexBaseUrlValue: document.getElementById('codexBaseUrlValue'),
        configPathValue: document.getElementById('configPathValue'),
        backupPathValue: document.getElementById('backupPathValue'),
        startedAtValue: document.getElementById('startedAtValue'),
        proxyRequestCountValue: document.getElementById('proxyRequestCountValue'),
        inspectedCountValue: document.getElementById('inspectedCountValue'),
        matchedCountValue: document.getElementById('matchedCountValue'),
        blockedCountValue: document.getElementById('blockedCountValue'),
        blockedRatioValue: document.getElementById('blockedRatioValue'),
        matchedStreamingCountValue: document.getElementById('matchedStreamingCountValue'),
        matchedNonStreamingCountValue: document.getElementById('matchedNonStreamingCountValue'),
        blockedStreamingCountValue: document.getElementById('blockedStreamingCountValue'),
        blockedNonStreamingCountValue: document.getElementById('blockedNonStreamingCountValue'),
        modelMatchRatioValue: document.getElementById('modelMatchRatioValue'),
        modelMismatchCountValue: document.getElementById('modelMismatchCountValue'),
        lowContextFamilyCountValue: document.getElementById('lowContextFamilyCountValue'),
        modelDriftCountValue: document.getElementById('modelDriftCountValue'),
        fingerprintDriftCountValue: document.getElementById('fingerprintDriftCountValue'),
        rebuildSuspectedCountValue: document.getElementById('rebuildSuspectedCountValue'),
        probeEnabledValue: document.getElementById('probeEnabledValue'),
        probeTargetModelValue: document.getElementById('probeTargetModelValue'),
        probeLastRunValue: document.getElementById('probeLastRunValue'),
        probePassCountValue: document.getElementById('probePassCountValue'),
        probeWarningCountValue: document.getElementById('probeWarningCountValue'),
        probeViolationCountValue: document.getElementById('probeViolationCountValue'),
        probeTransportErrorCountValue: document.getElementById('probeTransportErrorCountValue'),
        probeSamplesBody: document.getElementById('probeSamplesBody'),
        suspiciousSamplesBody: document.getElementById('suspiciousSamplesBody'),
        statsFootnote: document.getElementById('statsFootnote'),
        logsMeta: document.getElementById('logsMeta'),
        logsOutput: document.getElementById('logsOutput'),
      };
      let hasLoadedForm = false;
      let lastLogSeq = 0;
      let lastGatewayStartedAt = null;
      let logsNeedFullReload = false;
      let pollTimer = null;
      let stoppedByRestore = false;
      let reloadingForGatewayRestart = false;
      let suspiciousSamplesSignature = '';
      let probeSamplesSignature = '';
      const openSuspiciousEvidenceSampleKeys = new Set();
      const openProbeEvidenceSampleKeys = new Set();

      function buildProbeSampleKey(sample) {
        return JSON.stringify({
          scope: 'probe',
          ts: sample?.ts || '',
          probe_type: sample?.probe_type || '',
          target_model: sample?.target_model || '',
          endpoint_path: sample?.endpoint_path || '',
          result: sample?.result || '',
          result_type: sample?.result_type || '',
        });
      }

      function setMessage(text, tone) {
        refs.messageBox.textContent = text || '';
        refs.messageBox.dataset.tone = tone || '';
      }

      function formatTimestamp(value) {
        if (!value) {
          return '-';
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
          return value;
        }
        return date.toLocaleString('zh-CN', { hour12: false });
      }

      function formatPercent(value) {
        return Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '0.00%';
      }

      function formatPathCounts(pathCounts) {
        const entries = Object.entries(pathCounts || {})
          .filter((entry) => Number(entry[1]) > 0)
          .sort((left, right) => Number(right[1]) - Number(left[1]));
        if (entries.length === 0) {
          return '无';
        }
        return entries.map((entry) => entry[0] + ' x' + String(entry[1])).join('，');
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function buildSampleKey(sample) {
        return JSON.stringify({
          ts: sample?.ts || '',
          path: sample?.path || '',
          local: sample?.effective_local_model || '',
          first: sample?.first_observed_model || '',
          last: sample?.last_observed_model || '',
          anomaly: sample?.anomaly_type || '',
          confidence: sample?.confidence || '',
        });
      }

      function parseReasoningInput() {
        return refs.reasoningInput.value
          .split(/[\\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isInteger(value));
      }

      function parseEndpointsInput() {
        return refs.endpointsInput.value
          .split(/\\r?\\n/)
          .map((value) => value.trim())
          .filter(Boolean);
      }

      function describeInterceptMode(interceptStreaming, interceptNonStreaming) {
        if (interceptStreaming && interceptNonStreaming) {
          return '流式+非流式';
        }
        if (interceptStreaming) {
          return '仅流式';
        }
        if (interceptNonStreaming) {
          return '仅非流式';
        }
        return '未选择';
      }

      function syncInterceptModeValueFromForm() {
        refs.interceptModeValue.textContent = describeInterceptMode(
          refs.interceptStreamingInput.checked,
          refs.interceptNonStreamingInput.checked,
        );
      }

      function collectInterceptPayloadFromForm() {
        const interceptStreaming = Boolean(refs.interceptStreamingInput.checked);
        const interceptNonStreaming = Boolean(refs.interceptNonStreamingInput.checked);
        if (!interceptStreaming && !interceptNonStreaming) {
          throw new Error('流式与非流式至少选择一个拦截目标。');
        }
        return {
          intercept_streaming: interceptStreaming,
          intercept_non_streaming: interceptNonStreaming,
        };
      }

      function collectActiveProbeFormPayload() {
        const targetFamilies = [];
        if (refs.probeTargetFamily54Input.checked) {
          targetFamilies.push('gpt-5.4');
        }
        if (refs.probeTargetFamily55Input.checked) {
          targetFamilies.push('gpt-5.5');
        }
        const intervalMinutes = Number.parseInt(refs.probeIntervalMinutesInput.value, 10);
        const safeMinutes = Number.isInteger(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 15;
        return {
          enabled: refs.probeAutoEnabledInput.checked,
          interval_ms: safeMinutes * 60 * 1000,
          target_families: targetFamilies,
        };
      }

      function setProbeEnabledValue(enabled) {
        refs.probeEnabledValue.textContent = enabled ? '已开启' : '未开启';
      }

      function syncProbeEnabledValueFromForm() {
        setProbeEnabledValue(Boolean(refs.probeAutoEnabledInput.checked));
      }

      function hasSelectedProbeTargetFamilies() {
        return refs.probeTargetFamily54Input.checked || refs.probeTargetFamily55Input.checked;
      }

      async function persistActiveProbeConfigFromControls() {
        const activeProbePayload = collectActiveProbeFormPayload();
        if (activeProbePayload.enabled && activeProbePayload.target_families.length === 0) {
          throw new Error('开启自动探测前，至少选择一个探测目标模型。');
        }
        const response = await fetch(ui.configPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            active_probe: activeProbePayload,
          }),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '保存主动探针配置失败');
        }
        fillStatus(payload, { preferFormEnabled: false });
        fillForm(payload.config || {});
        hasLoadedForm = true;
        await loadLogs(false);
        return payload;
      }

      function fillStatus(payload, options) {
        refs.listenValue.textContent = payload.listen || '-';
        refs.upstreamValue.textContent = payload.config?.upstream_base_url || '-';
        refs.providerValue.textContent = payload.state?.provider_name || '未检测到安装状态';
        refs.codexBaseUrlValue.textContent = payload.state?.codex_current_base_url || '-';
        refs.configPathValue.textContent = payload.paths?.config_path || '-';
        refs.backupPathValue.textContent = payload.state?.latest_backup_path || '-';
        fillMetrics(payload.metrics || {});
        fillModelInsights(payload.model_insights || {});
        fillActiveProbe(payload.active_probe || {}, options);
      }

      function fillMetrics(metrics) {
        const totalProxyRequestCount = Number(metrics.total_proxy_request_count ?? 0);
        const inspectedResponseCount = Number(metrics.inspected_response_count ?? 0);
        const bypassedProxyRequestCount = Number(metrics.bypassed_proxy_request_count ?? 0);
        const failedProxyRequestCount = Number(metrics.failed_proxy_request_count ?? 0);
        const activeProxyRequestCount = Number(metrics.active_proxy_request_count ?? 0);
        refs.startedAtValue.textContent = formatTimestamp(metrics.started_at);
        refs.proxyRequestCountValue.textContent = String(totalProxyRequestCount);
        refs.inspectedCountValue.textContent = String(inspectedResponseCount);
        refs.matchedCountValue.textContent = String(metrics.matched_response_count ?? 0);
        refs.blockedCountValue.textContent = String(metrics.blocked_response_count ?? 0);
        refs.blockedRatioValue.textContent = formatPercent(
          inspectedResponseCount === 0 ? 0 : Number(metrics.blocked_response_count ?? 0) / inspectedResponseCount,
        );
        refs.matchedStreamingCountValue.textContent = String(metrics.matched_streaming_count ?? 0);
        refs.matchedNonStreamingCountValue.textContent = String(metrics.matched_non_streaming_count ?? 0);
        refs.blockedStreamingCountValue.textContent = String(metrics.blocked_streaming_count ?? 0);
        refs.blockedNonStreamingCountValue.textContent = String(metrics.blocked_non_streaming_count ?? 0);
        const statsDifference = Math.max(0, totalProxyRequestCount - inspectedResponseCount);
        const footnoteParts = [
          '如果“当前 Codex Base URL”已经是本机监听地址，就说明当前 Codex 已经被这个 gateway 接管。统计口径按本次 gateway 启动以来累计。',
          '代理请求总数 = 被检查响应总数 + 未纳入检查的透传请求 + 失败请求 + 进行中的代理请求。',
        ];
        if (
          statsDifference > 0 ||
          bypassedProxyRequestCount > 0 ||
          failedProxyRequestCount > 0 ||
          activeProxyRequestCount > 0
        ) {
          footnoteParts.push(
            '当前差值 ' +
              String(statsDifference) +
              '，其中未纳入检查的透传请求 ' +
              String(bypassedProxyRequestCount) +
              '（' +
              formatPathCounts(metrics.bypassed_proxy_path_counts) +
              '），失败请求 ' +
              String(failedProxyRequestCount) +
              '，进行中的代理请求 ' +
              String(activeProxyRequestCount) +
              '（' +
              formatPathCounts(metrics.active_proxy_path_counts) +
              '）' +
              '。',
          );
        }
        refs.statsFootnote.textContent = footnoteParts.join(' ');
      }

      function fillForm(config) {
        refs.reasoningInput.value = Array.isArray(config?.reasoning_equals) ? config.reasoning_equals.join(', ') : '';
        refs.interceptStreamingInput.checked = config?.intercept_streaming !== false;
        refs.interceptNonStreamingInput.checked = config?.intercept_non_streaming !== false;
        syncInterceptModeValueFromForm();
        refs.endpointsInput.value = Array.isArray(config?.endpoints) ? config.endpoints.join('\\n') : '';
        refs.statusCodeInput.value = config?.non_stream_status_code ?? 502;
        refs.guardRetryAttemptsInput.value = String(config?.guard_retry_attempts ?? 3);
        refs.logMatchInput.checked = Boolean(config?.log_match);
        const activeProbe = config?.active_probe || {};
        const targetFamilies = Array.isArray(activeProbe?.target_families) ? activeProbe.target_families : [];
        refs.probeTargetFamily54Input.checked = targetFamilies.includes('gpt-5.4');
        refs.probeTargetFamily55Input.checked = targetFamilies.includes('gpt-5.5');
        refs.probeAutoEnabledInput.checked = Boolean(activeProbe?.enabled);
        const intervalMs = Number(activeProbe?.interval_ms ?? 15 * 60 * 1000);
        refs.probeIntervalMinutesInput.value = String(
          Math.max(1, Math.round(intervalMs / 60000) || 15),
        );
        syncProbeEnabledValueFromForm();
      }

      function renderEvidenceLogs(evidenceLogs, sampleKey, isOpen) {
        const entries = Array.isArray(evidenceLogs) ? evidenceLogs : [];
        if (entries.length === 0) {
          return '-';
        }
        const lines = entries
          .map((entry) => {
            const prefix = entry?.seq ? '#' + entry.seq + ' ' : '';
            const at = entry?.at ? formatTimestamp(entry.at) : '-';
            const message = entry?.message ? entry.message : '';
            return prefix + at + ' ' + message;
          })
          .join('\\n');
        return '<details class="evidence-details" data-sample-key="' +
          escapeHtml(sampleKey) +
          '"' +
          (isOpen ? ' open' : '') +
          '><summary>查看 ' +
          String(entries.length) +
          ' 条</summary><pre class="evidence-log-output">' +
          escapeHtml(lines) +
          '</pre></details>';
      }

      function collectOpenEvidenceSampleKeys(container) {
        const keys = new Set();
        if (!container || typeof container.querySelectorAll !== 'function') {
          return keys;
        }
        const nodes = container.querySelectorAll('.evidence-details[data-sample-key][open]');
        for (const node of nodes) {
          const sampleKey = typeof node?.getAttribute === 'function'
            ? node.getAttribute('data-sample-key')
            : null;
          if (sampleKey) {
            keys.add(sampleKey);
          }
        }
        return keys;
      }

      function rememberEvidenceSummaryIntent(event, openKeySet) {
        const summary = event?.target && typeof event.target.closest === 'function'
          ? event.target.closest('summary')
          : null;
        if (!summary) {
          return;
        }
        const details = summary.parentElement;
        if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('evidence-details')) {
          return;
        }
        const sampleKey = typeof details.getAttribute === 'function'
          ? details.getAttribute('data-sample-key')
          : null;
        if (!sampleKey) {
          return;
        }
        if (details.open) {
          openKeySet.delete(sampleKey);
        } else {
          openKeySet.add(sampleKey);
        }
      }

      function renderSuspiciousSamples(samples) {
        const rows = Array.isArray(samples) ? samples : [];
        const signature = JSON.stringify(rows);
        if (signature === suspiciousSamplesSignature) {
          return;
        }
        const openKeysFromDom = collectOpenEvidenceSampleKeys(refs.suspiciousSamplesBody);
        openKeysFromDom.forEach((key) => {
          openSuspiciousEvidenceSampleKeys.add(key);
        });

        const validKeys = new Set(rows.map((sample) => buildSampleKey(sample)));
        openSuspiciousEvidenceSampleKeys.forEach((key) => {
          if (!validKeys.has(key)) {
            openSuspiciousEvidenceSampleKeys.delete(key);
          }
        });

        if (rows.length === 0) {
          refs.suspiciousSamplesBody.innerHTML = '<tr><td colspan="12">暂无数据</td></tr>';
          suspiciousSamplesSignature = signature;
          return;
        }
        refs.suspiciousSamplesBody.innerHTML = rows
          .map((sample) => {
            const sampleKey = buildSampleKey(sample);
            return '<tr>' +
            '<td>' + formatTimestamp(sample.ts) + '</td>' +
            '<td>' + (sample.path || '-') + '</td>' +
            '<td>' + (sample.effective_local_model || '-') + '</td>' +
            '<td>' + (sample.upstream_model || '-') + '</td>' +
            '<td>' + (sample.stream_model || '-') + '</td>' +
            '<td>' + (sample.first_observed_model || '-') + '</td>' +
            '<td>' + (sample.last_observed_model || '-') + '</td>' +
            '<td>' + ((sample.observed_models || []).join(', ') || '-') + '</td>' +
            '<td>' + ((sample.observed_fingerprints || []).join(', ') || '-') + '</td>' +
            '<td>' + (sample.anomaly_type || '-') + '</td>' +
            '<td>' + (sample.confidence || '-') + '</td>' +
            '<td>' + renderEvidenceLogs(sample.evidence_logs, sampleKey, openSuspiciousEvidenceSampleKeys.has(sampleKey)) + '</td>' +
          '</tr>';
          })
          .join('');
        suspiciousSamplesSignature = signature;
      }

      function renderProbeSamples(samples) {
        const rows = Array.isArray(samples) ? samples : [];
        const signature = JSON.stringify(rows);
        if (signature === probeSamplesSignature) {
          return;
        }
        const openKeysFromDom = collectOpenEvidenceSampleKeys(refs.probeSamplesBody);
        openKeysFromDom.forEach((key) => {
          openProbeEvidenceSampleKeys.add(key);
        });
        const validKeys = new Set(rows.map((sample) => buildProbeSampleKey(sample)));
        openProbeEvidenceSampleKeys.forEach((key) => {
          if (!validKeys.has(key)) {
            openProbeEvidenceSampleKeys.delete(key);
          }
        });
        if (rows.length === 0) {
          refs.probeSamplesBody.innerHTML = '<tr><td colspan="12">暂无数据</td></tr>';
          probeSamplesSignature = signature;
          return;
        }
        refs.probeSamplesBody.innerHTML = rows
          .map((sample) => {
            const sampleKey = buildProbeSampleKey(sample);
            return '<tr>' +
              '<td>' + formatTimestamp(sample.ts) + '</td>' +
              '<td>' + (sample.probe_type || '-') + '</td>' +
              '<td>' + (sample.target_model || '-') + '</td>' +
              '<td>' + (sample.endpoint_path || '-') + '</td>' +
              '<td>' + (sample.result || '-') + '</td>' +
              '<td>' + (sample.result_type || '-') + '</td>' +
              '<td>' + (sample.confidence || '-') + '</td>' +
              '<td>' + (sample.http_status ?? '-') + '</td>' +
              '<td>' + ((sample.duration_ms ?? '-') + ' ms') + '</td>' +
              '<td>' + (sample.upstream_model || '-') + '</td>' +
              '<td>' + ((sample.observed_fingerprints || []).join(', ') || '-') + '</td>' +
              '<td>' + renderEvidenceLogs(sample.evidence_logs, sampleKey, openProbeEvidenceSampleKeys.has(sampleKey)) + '</td>' +
            '</tr>';
          })
          .join('');
        probeSamplesSignature = signature;
      }

      function fillModelInsights(modelInsights) {
        refs.modelMatchRatioValue.textContent = formatPercent(modelInsights?.consistency?.match_ratio ?? 0);
        refs.modelMismatchCountValue.textContent = String(modelInsights?.consistency?.mismatched ?? 0);
        refs.lowContextFamilyCountValue.textContent = String(modelInsights?.anomalies?.low_context_family_count ?? 0);
        refs.modelDriftCountValue.textContent = String(modelInsights?.single_request_anomalies?.model_drift_count ?? 0);
        refs.fingerprintDriftCountValue.textContent = String(modelInsights?.single_request_anomalies?.fingerprint_drift_count ?? 0);
        refs.rebuildSuspectedCountValue.textContent = String(modelInsights?.single_request_anomalies?.rebuild_suspected_count ?? 0);
        renderSuspiciousSamples(modelInsights?.suspicious_samples || []);
      }

      function fillActiveProbe(probe, options) {
        const preferFormEnabled = Boolean(options?.preferFormEnabled);
        setProbeEnabledValue(preferFormEnabled ? refs.probeAutoEnabledInput.checked : probe?.enabled);
        refs.probeTargetModelValue.textContent = probe?.last_target_model || '-';
        refs.probeLastRunValue.textContent = formatTimestamp(probe?.last_finished_at);
        refs.probePassCountValue.textContent = String(probe?.pass_count ?? 0);
        refs.probeWarningCountValue.textContent = String(probe?.warning_count ?? 0);
        refs.probeViolationCountValue.textContent = String(probe?.violation_count ?? 0);
        refs.probeTransportErrorCountValue.textContent = String(probe?.transport_error_count ?? 0);
        renderProbeSamples(probe?.recent_samples || []);
      }

      function renderLogs(payload, replaceAll) {
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        const rendered = entries
          .map((entry) => {
            const at = entry?.at ? formatTimestamp(entry.at) : '-';
            const message = entry?.message ? entry.message : '';
            return at + ' ' + message;
          })
          .join('\\n');

        if (replaceAll) {
          refs.logsOutput.textContent = rendered || '当前还没有日志。';
        } else if (rendered) {
          const current = refs.logsOutput.textContent.trim();
          refs.logsOutput.textContent = current ? current + '\\n' + rendered : rendered;
        }

        if (!rendered && replaceAll) {
          refs.logsOutput.textContent = '当前还没有日志。';
        }

        refs.logsMeta.textContent =
          '已载入 ' +
          String(payload?.total_entries ?? entries.length) +
          ' 条日志，最新序号 ' +
          String(payload?.latest_seq ?? lastLogSeq) +
          '。';
        refs.logsOutput.scrollTop = refs.logsOutput.scrollHeight;
        if (Number.isInteger(payload?.latest_seq)) {
          lastLogSeq = payload.latest_seq;
        }
      }

      async function loadLogs(incremental) {
        const shouldReplaceAll = !incremental || lastLogSeq === 0 || logsNeedFullReload;
        const url = new URL(ui.logsPath, window.location.origin);
        const requestedSinceSeq = shouldReplaceAll ? null : lastLogSeq;
        if (requestedSinceSeq !== null) {
          url.searchParams.set('since_seq', String(lastLogSeq));
        }
        const response = await fetch(url.toString(), { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取日志失败');
        }
        if (
          requestedSinceSeq !== null &&
          Number.isInteger(payload?.latest_seq) &&
          payload.latest_seq < requestedSinceSeq
        ) {
          lastLogSeq = 0;
          logsNeedFullReload = false;
          await loadLogs(false);
          return;
        }
        renderLogs(payload, shouldReplaceAll);
        logsNeedFullReload = false;
      }

      async function loadStatus(options) {
        const refreshForm = Boolean(options?.refreshForm);
        const response = await fetch(ui.statusPath, { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取状态失败');
        }
        const nextStartedAt = payload.metrics?.started_at || null;
        if (lastGatewayStartedAt && nextStartedAt && nextStartedAt !== lastGatewayStartedAt) {
          if (!reloadingForGatewayRestart && typeof window.location?.reload === 'function') {
            reloadingForGatewayRestart = true;
            window.location.reload();
            return;
          }
        }
        lastGatewayStartedAt = nextStartedAt;
        fillStatus(payload, {
          preferFormEnabled: hasLoadedForm && !refreshForm,
        });
        if (refreshForm || !hasLoadedForm) {
          fillForm(payload.config || {});
          hasLoadedForm = true;
        }
      }

      async function saveConfig(event) {
        event.preventDefault();
        refs.saveButton.disabled = true;
        setMessage('正在保存配置...', '');

        try {
          const interceptPayload = collectInterceptPayloadFromForm();
          const response = await fetch(ui.configPath, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reasoning_equals: parseReasoningInput(),
              endpoints: parseEndpointsInput(),
              ...interceptPayload,
              non_stream_status_code: Number.parseInt(refs.statusCodeInput.value, 10),
              guard_retry_attempts: Number.parseInt(refs.guardRetryAttemptsInput.value, 10),
              log_match: refs.logMatchInput.checked,
              active_probe: collectActiveProbeFormPayload(),
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || '保存失败');
          }
          fillStatus(payload);
          fillForm(payload.config || {});
          hasLoadedForm = true;
          await loadLogs(false);
          setMessage('配置已保存，并已对当前 gateway 立即生效。', 'success');
        } catch (error) {
          setMessage(error?.message || String(error), 'error');
        } finally {
          refs.saveButton.disabled = false;
        }
      }

      async function runProbeNow() {
        refs.probeRunButton.disabled = true;
        setMessage('正在触发主动探针...', '');
        try {
          const response = await fetch('${PROBE_RUN_API_PATH}', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              active_probe: collectActiveProbeFormPayload(),
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || '触发主动探针失败');
          }
          await loadStatus({ refreshForm: false });
          await loadLogs(false);
          setMessage('主动探针已触发。', 'success');
        } catch (error) {
          setMessage(error?.message || String(error), 'error');
        } finally {
          refs.probeRunButton.disabled = false;
        }
      }

      async function restoreConfig() {
        if (!window.confirm('恢复后会关闭当前 gateway，并把 Codex 配置切回原上游。确定继续吗？')) {
          return;
        }

        refs.restoreButton.disabled = true;
        stoppedByRestore = true;
        if (pollTimer) {
          window.clearInterval(pollTimer);
        }
        setMessage('正在触发恢复，页面很快会失联...', '');

        try {
          const response = await fetch(ui.restorePath, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || '恢复失败');
          }
          setMessage('恢复脚本已启动，等待 gateway 关闭。', 'success');
        } catch (error) {
          setMessage(error?.message || String(error), 'error');
          refs.restoreButton.disabled = false;
          return;
        }

        window.setTimeout(async () => {
          try {
            await fetch(ui.statusPath, { cache: 'no-store' });
          } catch {
            setMessage('gateway 已关闭，Codex 原设置应已恢复。', 'success');
          }
        }, 1200);
      }

      async function refreshLiveData() {
        if (stoppedByRestore) {
          return;
        }
        await loadStatus({ refreshForm: false });
        await loadLogs(true);
      }

      refs.form.addEventListener('submit', saveConfig);
      refs.interceptStreamingInput.addEventListener('change', () => {
        syncInterceptModeValueFromForm();
        if (!refs.interceptStreamingInput.checked && !refs.interceptNonStreamingInput.checked) {
          setMessage('流式与非流式至少选择一个拦截目标。', 'error');
        }
      });
      refs.interceptNonStreamingInput.addEventListener('change', () => {
        syncInterceptModeValueFromForm();
        if (!refs.interceptStreamingInput.checked && !refs.interceptNonStreamingInput.checked) {
          setMessage('流式与非流式至少选择一个拦截目标。', 'error');
        }
      });
      refs.probeAutoEnabledInput.addEventListener('change', async () => {
        if (refs.probeAutoEnabledInput.checked && !hasSelectedProbeTargetFamilies()) {
          refs.probeAutoEnabledInput.checked = false;
          syncProbeEnabledValueFromForm();
          setMessage('开启自动探测前，至少选择一个探测目标模型。', 'error');
          return;
        }
        syncProbeEnabledValueFromForm();
        refs.probeAutoEnabledInput.disabled = true;
        setMessage('正在保存主动探针配置...', '');
        try {
          await persistActiveProbeConfigFromControls();
          setMessage('主动探针配置已保存，并已对当前 gateway 立即生效。', 'success');
        } catch (error) {
          refs.probeAutoEnabledInput.checked = !refs.probeAutoEnabledInput.checked;
          syncProbeEnabledValueFromForm();
          setMessage(error?.message || String(error), 'error');
        } finally {
          refs.probeAutoEnabledInput.disabled = false;
        }
      });
      refs.probeRunButton.addEventListener('click', runProbeNow);
      refs.restoreButton.addEventListener('click', restoreConfig);
      refs.suspiciousSamplesBody.addEventListener('click', (event) => {
        rememberEvidenceSummaryIntent(event, openSuspiciousEvidenceSampleKeys);
      });
      refs.suspiciousSamplesBody.addEventListener('toggle', (event) => {
        const details = event.target;
        if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('evidence-details')) {
          return;
        }
        const sampleKey = details.getAttribute('data-sample-key');
        if (!sampleKey) {
          return;
        }
        if (details.open) {
          openSuspiciousEvidenceSampleKeys.add(sampleKey);
        } else {
          openSuspiciousEvidenceSampleKeys.delete(sampleKey);
        }
      });
      refs.probeSamplesBody.addEventListener('click', (event) => {
        rememberEvidenceSummaryIntent(event, openProbeEvidenceSampleKeys);
      });
      refs.probeSamplesBody.addEventListener('toggle', (event) => {
        const details = event.target;
        if (!details || details.tagName !== 'DETAILS' || !details.classList.contains('evidence-details')) {
          return;
        }
        const sampleKey = details.getAttribute('data-sample-key');
        if (!sampleKey) {
          return;
        }
        if (details.open) {
          openProbeEvidenceSampleKeys.add(sampleKey);
        } else {
          openProbeEvidenceSampleKeys.delete(sampleKey);
        }
      });

      loadStatus({ refreshForm: true })
        .then(() => loadLogs(false))
        .then(() => {
          pollTimer = window.setInterval(() => {
            refreshLiveData().catch((error) => {
              if (!stoppedByRestore) {
                setMessage(error?.message || String(error), 'error');
              }
            });
          }, 2000);
        })
        .catch((error) => {
          setMessage(error?.message || String(error), 'error');
        });
    </script>
  </body>
</html>`;
}

async function handleManagementRequest(runtime, req, res, requestUrl) {
  const pathname = normalizePath(requestUrl.pathname);

  if (pathname === FAVICON_PATH) {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (pathname === UI_PATH) {
    htmlResponse(res, buildManagementHtml());
    return true;
  }

  if (pathname === STATUS_API_PATH && req.method === "GET") {
    const state = await readRuntimeState(runtime);
    await getLocalConfigModel(runtime);
    jsonResponse(res, 200, {
      ok: true,
      listen: `${runtime.config.listen_host}:${runtime.config.listen_port}`,
      config: runtime.config,
      state,
      paths: {
        config_path: runtime.configPath,
        state_path: runtime.paths.statePath,
        state_root: runtime.paths.stateRoot,
        log_path: runtime.logPath,
      },
      metrics: buildMetricsSnapshot(runtime.monitor),
      model_insights: buildModelInsightsSnapshot(runtime),
      active_probe: buildActiveProbeSnapshot(runtime),
    });
    return true;
  }

  if (pathname === LOGS_API_PATH && req.method === "GET") {
    const sinceSeqRaw = requestUrl.searchParams.get("since_seq");
    const sinceSeq = sinceSeqRaw === null ? null : Number.parseInt(sinceSeqRaw, 10);
    jsonResponse(res, 200, {
      ok: true,
      ...buildLogsSnapshot(runtime.monitor, Number.isInteger(sinceSeq) ? sinceSeq : null),
    });
    return true;
  }

  if (pathname === CONFIG_API_PATH && req.method === "POST") {
    const body = await readRequestBody(req, runtime.config.request_body_limit_bytes);
    const payload = parseJsonSafely(body);
    if (!payload) {
      jsonResponse(res, 400, {
        error: {
          message: "配置保存请求必须是有效 JSON",
          code: "invalid_json",
        },
      });
      return true;
    }

    let nextConfig;
    try {
      nextConfig = buildEditableConfig(runtime.config, payload);
    } catch (error) {
      jsonResponse(res, 400, {
        error: {
          message: error?.message || String(error),
          code: "invalid_config",
        },
      });
      return true;
    }
    await writeConfig(runtime.configPath, nextConfig);
    runtime.config = nextConfig;
    scheduleActiveProbes(runtime);
    runtime.logger(
      `[config] updated reasoning_equals=${nextConfig.reasoning_equals.join(",")} endpoints=${nextConfig.endpoints.join(",")}`,
    );
    const state = await readRuntimeState(runtime);
    jsonResponse(res, 200, {
      ok: true,
      message: "配置已保存并立即生效",
      config: runtime.config,
      state,
      paths: {
        config_path: runtime.configPath,
        state_path: runtime.paths.statePath,
        state_root: runtime.paths.stateRoot,
        log_path: runtime.logPath,
      },
      metrics: buildMetricsSnapshot(runtime.monitor),
      model_insights: buildModelInsightsSnapshot(runtime),
      active_probe: buildActiveProbeSnapshot(runtime),
    });
    return true;
  }

  if (pathname === PROBE_RUN_API_PATH && req.method === "POST") {
    const body = await readRequestBody(req, runtime.config.request_body_limit_bytes);
    const payload = body.length > 0 ? parseJsonSafely(body) : {};
    if (body.length > 0 && !payload) {
      jsonResponse(res, 400, {
        error: {
          message: "主动探针请求必须是有效 JSON",
          code: "invalid_json",
        },
      });
      return true;
    }
    const nextActiveProbe =
      payload?.active_probe === undefined
        ? runtime.config.active_probe
        : normalizeActiveProbeConfig({
            ...runtime.config.active_probe,
            ...payload.active_probe,
          });
    if (runtime.probeMonitor.running) {
      const state = await readRuntimeState(runtime);
      jsonResponse(res, 409, {
        ok: false,
        message: "主动探针正在运行中，请稍后再试",
        config: runtime.config,
        state,
        paths: {
          config_path: runtime.configPath,
          state_path: runtime.paths.statePath,
          state_root: runtime.paths.stateRoot,
          log_path: runtime.logPath,
        },
        metrics: buildMetricsSnapshot(runtime.monitor),
        model_insights: buildModelInsightsSnapshot(runtime),
        active_probe: buildActiveProbeSnapshot(runtime),
      });
      return true;
    }
    safeRunActiveProbeOnce(runtime, {
      manual: true,
      activeProbeConfig: nextActiveProbe,
    }).catch((error) => {
      runtime.logger(`[probe-error] ${error?.stack || error}`);
    });
    const state = await readRuntimeState(runtime);
    jsonResponse(res, 202, {
      ok: true,
      message: "主动探针已开始，请稍后查看状态",
      config: runtime.config,
      state,
      paths: {
        config_path: runtime.configPath,
        state_path: runtime.paths.statePath,
        state_root: runtime.paths.stateRoot,
        log_path: runtime.logPath,
      },
      metrics: buildMetricsSnapshot(runtime.monitor),
      model_insights: buildModelInsightsSnapshot(runtime),
      active_probe: buildActiveProbeSnapshot(runtime),
    });
    return true;
  }

  if (pathname === RESTORE_API_PATH && req.method === "POST") {
    const state = await readRuntimeState(runtime);
    if (!state) {
      jsonResponse(res, 409, {
        error: {
          message: "当前未检测到安装状态，无法恢复 Codex 原设置",
          code: "state_not_found",
        },
      });
      return true;
    }

    await restoreRuntimeState(runtime, state);
    runtime.logger(`[restore] restored via UI state_root=${runtime.paths.stateRoot}`);
    jsonResponse(res, 202, {
      ok: true,
      message: "原设置已恢复，gateway 即将关闭",
    });
    res.on("finish", () => {
      const exitTimer = setTimeout(() => {
        if (runtime.server) {
          runtime.server.close(() => {
            process.exit(0);
          });
        } else {
          process.exit(0);
        }

        const hardExitTimer = setTimeout(() => {
          process.exit(0);
        }, 600);
        hardExitTimer.unref();
      }, 120);
      exitTimer.unref();
    });
    return true;
  }

  return false;
}

function buildUpstreamUrl(baseUrl, requestUrl) {
  const upstream = new URL(baseUrl);
  const normalizedBasePath = upstream.pathname.endsWith("/")
    ? upstream.pathname.slice(0, -1)
    : upstream.pathname;
  const incomingPath = requestUrl.pathname;

  let finalPath = incomingPath;
  if (normalizedBasePath && normalizedBasePath !== "/") {
    if (incomingPath.startsWith(`${normalizedBasePath}/`) || incomingPath === normalizedBasePath) {
      finalPath = incomingPath;
    } else if (normalizedBasePath.endsWith("/v1") && incomingPath.startsWith("/v1/")) {
      finalPath = `${normalizedBasePath}${incomingPath.slice(3)}`;
    } else {
      finalPath = `${normalizedBasePath}${incomingPath}`;
    }
  }

  upstream.pathname = finalPath;
  upstream.search = requestUrl.search;
  return upstream.toString();
}

function cloneHeadersForUpstream(headers) {
  const outgoing = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding"
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        outgoing.append(key, item);
      }
    } else {
      outgoing.set(key, value);
    }
  }
  return outgoing;
}

function copyHeadersToClient(sourceHeaders, target) {
  for (const [key, value] of sourceHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "content-length" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "content-encoding" ||
      lowerKey === "connection"
    ) {
      continue;
    }
    target.setHeader(key, value);
  }
}

async function readRequestBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error(`请求体超过限制: ${limitBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJsonSafely(buffer) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

function matchPath(config, pathname) {
  return config.endpoints.includes(normalizePath(pathname));
}

function reasoningMatched(config, reasoning) {
  return reasoning !== null && config.reasoning_equals.includes(reasoning);
}

function isExpectedStreamTermination(error) {
  if (!error) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  return error instanceof TypeError && error.message === "terminated";
}

function isRetryableUpstreamFetchError(error) {
  if (!error) {
    return false;
  }
  return error instanceof TypeError && error.message === "fetch failed";
}

function getRequestPathname(req) {
  try {
    return normalizePath(new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).pathname);
  } catch {
    return "(unknown)";
  }
}

function logUpstreamFetchFailure(logger, req, error) {
  const pathname = getRequestPathname(req);
  logger?.(`[upstream-error] fetch failed after retry path=${pathname} message=${error?.message || error}`);
}

async function fetchUpstreamWithRetry(upstreamUrl, init, logger) {
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetch(upstreamUrl, init);
    } catch (error) {
      lastError = error;
      if (!isRetryableUpstreamFetchError(error) || attempt === maxAttempts) {
        break;
      }
      logger?.(`[retry] upstream fetch failed attempt=${attempt} url=${upstreamUrl}`);
    }
  }

  throw lastError;
}

function inspectSseChunk(state, chunk) {
  const payloads = parseSsePayloads(state, chunk);
  let reasoning = null;
  for (const payload of payloads) {
    const extracted = extractReasoningTokens(payload);
    if (extracted !== null) {
      reasoning = extracted;
    }
  }
  return { reasoning, payloads };
}

async function handleNonStreaming({
  config,
  logger,
  monitor,
  pathname,
  requestTracking,
  modelContext,
  upstreamResponse,
  res,
}) {
  const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  const parsed = isJsonContentType(upstreamResponse.headers.get("content-type"))
    ? parseJsonSafely(bodyBuffer)
    : null;
  if (parsed) {
    applyPayloadModelSignals(modelContext, parsed, { fromFinalResponse: true });
    modelContext.upstreamModel = modelContext.upstreamModel || modelContext.finalResponseModel;
  }
  const reasoning = parsed ? extractReasoningTokens(parsed) : null;
  const matched = reasoningMatched(config, reasoning);

  recordInspectedResponse(monitor, reasoning, matched, "non-stream");
  setRequestTrackingOutcome(requestTracking, "inspected");

  if (matched) {
    const shouldIntercept = config.intercept_non_streaming !== false;
    const canGuardRetry = shouldIntercept && requestTracking?.guardRetryRemaining > 0;
    if (config.log_match) {
      const action = !shouldIntercept
        ? "observe_only"
        : canGuardRetry
          ? `internal_retry remaining=${requestTracking.guardRetryRemaining}`
          : `return_status_${config.non_stream_status_code}`;
      logger(
        `[match] non-stream path=${pathname} reasoning_tokens=${reasoning} action=${action}`,
      );
    }
    if (shouldIntercept) {
      recordBlockedResponse(monitor, "non-stream");
      finalizeModelInsights(
        monitor,
        pathname,
        modelContext,
        upstreamResponse.status >= 400 ? parsed : null,
      );
      if (canGuardRetry) {
        return { guardRetry: true };
      }
      const blockedBody = buildBlockedBody(pathname, reasoning, config.non_stream_status_code);
      res.writeHead(config.non_stream_status_code, {
        "content-type": "application/json; charset=utf-8",
        "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
      });
      res.end(blockedBody);
      return { handled: true };
    }
  }

  finalizeModelInsights(
    monitor,
    pathname,
    modelContext,
    upstreamResponse.status >= 400 ? parsed : null,
  );
  copyHeadersToClient(upstreamResponse.headers, res);
  res.writeHead(upstreamResponse.status);
  res.end(bodyBuffer);
  return { handled: true };
}

async function handleStreaming({
  config,
  logger,
  monitor,
  pathname,
  requestTracking,
  modelContext,
  upstreamResponse,
  res,
  abortController,
}) {
  const strict502Mode = config.stream_action !== "disconnect";
  const reader = upstreamResponse.body.getReader();
  const sseState = {
    decoder: new TextDecoder("utf8"),
    buffer: "",
  };

  let wroteAnyChunk = false;
  let observedReasoning = null;
  let inspectedRecorded = false;
  const bufferedChunks = [];

  if (!strict502Mode) {
    copyHeadersToClient(upstreamResponse.headers, res);
    res.writeHead(upstreamResponse.status);
  }

  while (true) {
    let readResult;
    try {
      readResult = await reader.read();
    } catch (error) {
      if (isExpectedStreamTermination(error)) {
        if (!inspectedRecorded) {
          recordInspectedResponse(monitor, observedReasoning, false, "stream");
          inspectedRecorded = true;
        }
        setRequestTrackingOutcome(requestTracking, "inspected");
        finalizeModelInsights(monitor, pathname, modelContext);
        if (strict502Mode) {
          logger?.(`[stream] upstream terminated before completion path=${pathname} action=status_502`);
          res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
          res.end(buildGatewayErrorBody("upstream stream terminated before completion"));
        } else {
          res.end();
        }
        return;
      }
      throw error;
    }

    const { done, value } = readResult;
    if (done) {
      if (!inspectedRecorded) {
        recordInspectedResponse(monitor, observedReasoning, false, "stream");
        inspectedRecorded = true;
      }
      setRequestTrackingOutcome(requestTracking, "inspected");
      finalizeModelInsights(monitor, pathname, modelContext);
      if (strict502Mode) {
        copyHeadersToClient(upstreamResponse.headers, res);
        res.writeHead(upstreamResponse.status);
        res.end(Buffer.concat(bufferedChunks));
      } else {
        res.end();
      }
      return;
    }

    const chunkBuffer = Buffer.from(value);
    const { reasoning, payloads } = inspectSseChunk(sseState, value);
    for (const payload of payloads) {
      applyPayloadModelSignals(modelContext, payload, {
        fromStream: true,
        fromFinalResponse: payload?.type === "response.completed",
      });
    }
    if (Number.isInteger(reasoning)) {
      observedReasoning = reasoning;
    }
    if (reasoningMatched(config, reasoning)) {
      if (!inspectedRecorded) {
        recordInspectedResponse(monitor, reasoning, true, "stream");
        inspectedRecorded = true;
      }
      setRequestTrackingOutcome(requestTracking, "inspected");
      const shouldIntercept = config.intercept_streaming !== false;
      const canGuardRetry =
        shouldIntercept && (strict502Mode || !wroteAnyChunk) && requestTracking?.guardRetryRemaining > 0;
      if (config.log_match) {
        const action = !shouldIntercept
          ? "observe_only"
          : canGuardRetry
            ? `internal_retry remaining=${requestTracking.guardRetryRemaining}`
            : strict502Mode || !wroteAnyChunk
              ? `return_status_${config.non_stream_status_code}`
              : "disconnect";
        logger(
          `[match] stream path=${pathname} reasoning_tokens=${reasoning} action=${action}`,
        );
      }

      if (!shouldIntercept) {
        if (strict502Mode) {
          bufferedChunks.push(chunkBuffer);
        } else {
          wroteAnyChunk = true;
          res.write(chunkBuffer);
        }
        continue;
      }

      recordBlockedResponse(monitor, "stream");
      if (strict502Mode || !wroteAnyChunk) {
        abortController.abort();
        reader.cancel().catch(() => {});
        finalizeModelInsights(monitor, pathname, modelContext);
        if (canGuardRetry) {
          return { guardRetry: true };
        }
        const blockedBody = buildBlockedBody(pathname, reasoning, config.non_stream_status_code);
        res.writeHead(config.non_stream_status_code, {
          "content-type": "application/json; charset=utf-8",
          "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
        });
        res.end(blockedBody);
      } else {
        abortController.abort();
        reader.cancel().catch(() => {});
        res.socket?.destroy();
        finalizeModelInsights(monitor, pathname, modelContext);
      }
      return { handled: true };
    }

    if (strict502Mode) {
      bufferedChunks.push(chunkBuffer);
    } else {
      wroteAnyChunk = true;
      res.write(chunkBuffer);
    }
  }
}

async function proxyRequest(runtime, req, res) {
  const { logger } = runtime;
  const config = runtime.config;
  const incomingUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = normalizePath(incomingUrl.pathname);
  const requestTracking = {
    outcome: null,
    req,
  };

  if (pathname === config.health_path) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        listen: `${config.listen_host}:${config.listen_port}`,
        upstream_base_url: config.upstream_base_url,
        ui_path: UI_PATH,
      }),
    );
    return;
  }

  if (await handleManagementRequest(runtime, req, res, incomingUrl)) {
    return;
  }

  req.__codexRetryGatewayProxyTracked = true;

  const requestBody = await readRequestBody(req, config.request_body_limit_bytes);
  const requestJson = isJsonContentType(req.headers["content-type"])
    ? parseJsonSafely(requestBody)
    : null;
  runtime.lastClientUserAgent =
    typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].trim() : "";
  buildActiveProbeRequestProfile(runtime, requestJson);
  const localConfigModel = await getLocalConfigModel(runtime);
  const requestIsStream = Boolean(requestJson?.stream);
  const upstreamUrl = buildUpstreamUrl(config.upstream_base_url, incomingUrl);
  const shouldInspect = matchPath(config, pathname);
  let guardRetryAttemptsUsed = 0;

  while (true) {
    runtime.monitor.total_proxy_request_count += 1;
    recordActiveProxyRequestStart(runtime.monitor, pathname);
    const abortController = new AbortController();
    const modelContext = createRequestModelContext(localConfigModel, requestJson?.model ?? null);
    requestTracking.guardRetryRemaining = Math.max(
      0,
      Number(config.guard_retry_attempts || 0) - guardRetryAttemptsUsed,
    );

    try {
      const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl, {
        method: req.method,
        headers: cloneHeadersForUpstream(req.headers),
        body: requestBody.length > 0 ? requestBody : undefined,
        signal: abortController.signal,
      }, logger);

      const responseIsStream =
        requestIsStream || isSseContentType(upstreamResponse.headers.get("content-type"));

      if (!shouldInspect) {
        const body = Buffer.from(await upstreamResponse.arrayBuffer());
        if (isJsonContentType(upstreamResponse.headers.get("content-type"))) {
          const parsed = parseJsonSafely(body);
          if (parsed) {
            applyPayloadModelSignals(modelContext, parsed, { fromFinalResponse: true });
          }
        }
        finalizeModelInsights(
          runtime.monitor,
          pathname,
          modelContext,
          upstreamResponse.status >= 400 && isJsonContentType(upstreamResponse.headers.get("content-type"))
            ? parseJsonSafely(body)
            : null,
        );
        copyHeadersToClient(upstreamResponse.headers, res);
        res.writeHead(upstreamResponse.status);
        res.end(body);
        recordBypassedProxyRequest(runtime.monitor, pathname);
        setRequestTrackingOutcome(requestTracking, "bypassed");
        return;
      }

      const handlerResult = responseIsStream
        ? await handleStreaming({
            config,
            logger,
            monitor: runtime.monitor,
            pathname,
            requestTracking,
            modelContext,
            upstreamResponse,
            res,
            abortController,
          })
        : await handleNonStreaming({
            config,
            logger,
            monitor: runtime.monitor,
            pathname,
            requestTracking,
            modelContext,
            upstreamResponse,
            res,
          });

      if (handlerResult?.guardRetry && guardRetryAttemptsUsed < Number(config.guard_retry_attempts || 0)) {
        guardRetryAttemptsUsed += 1;
        continue;
      }
      return;
    } finally {
      recordActiveProxyRequestEnd(runtime.monitor, pathname);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(__dirname, "config.json");
  const config = await loadConfig(configPath);
  const monitor = createMonitor();
  const probeMonitor = createProbeMonitor();

  if (args.log) {
    await mkdir(path.dirname(args.log), { recursive: true });
  }
  const logger = createLogger(args.log, createMonitorRecorder(monitor));
  const runtime = {
    config,
    configPath,
    logPath: args.log || null,
    logger,
    monitor,
    probeMonitor,
    paths: buildRuntimePaths(configPath, args.log || null),
    localConfigModelCache: null,
    server: null,
    probeTimer: null,
  };

  const server = http.createServer(async (req, res) => {
    try {
      await proxyRequest(runtime, req, res);
    } catch (error) {
      if (req.__codexRetryGatewayProxyTracked && !req.__codexRetryGatewayProxyOutcome) {
        runtime.monitor.failed_proxy_request_count += 1;
      }
      const upstreamFetchFailure = isRetryableUpstreamFetchError(error);
      if (upstreamFetchFailure) {
        logUpstreamFetchFailure(logger, req, error);
      } else {
        logger(`[error] ${error?.stack || error}`);
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              message: upstreamFetchFailure ? "upstream fetch failed" : `${error?.message || error}`,
              type: upstreamFetchFailure ? "upstream_error" : "codex_retry_gateway_error",
              code: upstreamFetchFailure ? "upstream_fetch_failed" : "gateway_error",
            },
          }),
        );
      } else {
        res.socket?.destroy();
      }
    }
  });
  runtime.server = server;

  server.listen(config.listen_port, config.listen_host, () => {
    logger(
      `[start] codex retry gateway listening on http://${config.listen_host}:${config.listen_port} -> ${config.upstream_base_url}`,
    );
    scheduleActiveProbes(runtime);
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
