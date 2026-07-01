#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const REASONING_BEHAVIOR_API_PATH = `${ADMIN_BASE_PATH}/api/analytics/reasoning`;
const REASONING_BEHAVIOR_EXPORT_API_PATH = `${ADMIN_BASE_PATH}/api/analytics/reasoning/export`;
const HISTORICAL_IMPORT_API_PATH = `${ADMIN_BASE_PATH}/api/analytics/imports`;
const PROBE_RUN_API_PATH = `${ADMIN_BASE_PATH}/api/probe/run`;
const RESTORE_API_PATH = `${ADMIN_BASE_PATH}/api/restore`;
const FAVICON_PATH = "/favicon.ico";
const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 100 * 1024 * 1024;
const LEGACY_REQUEST_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const REASONING_BEHAVIOR_SCHEMA_VERSION = 2;
const REASONING_BEHAVIOR_RECENT_SAMPLE_LIMIT = 500;
const REASONING_BEHAVIOR_MAX_INLINE_RANGE_DAYS = 7;
const REASONING_BEHAVIOR_MAX_EXPORT_RANGE_DAYS = 31;
const REASONING_BEHAVIOR_BACKGROUND_EXPORT_MIN_DAYS = 32;
const REASONING_BEHAVIOR_EXPORT_JOB_LIMIT = 5;
const HISTORICAL_IMPORT_JOB_LIMIT = 5;
const HISTORICAL_IMPORT_SESSION_FILE_LIMIT = 2000;
const REASONING_ANALYSIS_PROFILE_NAME = "516_candidate_review_v1";
const INTERCEPT_RULE_MODE_REASONING_TOKENS = "reasoning_tokens";
const INTERCEPT_RULE_MODE_FINAL_ONLY_HIGH_XHIGH = "final_answer_only_high_xhigh";
const INTERCEPT_RULE_MODES = new Set([
  INTERCEPT_RULE_MODE_REASONING_TOKENS,
  INTERCEPT_RULE_MODE_FINAL_ONLY_HIGH_XHIGH,
]);
const FINAL_ONLY_INTERCEPT_EFFORTS = new Set(["high", "xhigh"]);
const REQUEST_KIND_NORMAL = "normal";
const REQUEST_KIND_CONTEXT_COMPACTION = "context_compaction";
const CONTEXT_COMPACTION_MARKERS = [
  "remote_compaction",
  "context_compaction",
];
const UPSTREAM_CAPACITY_ERROR_MESSAGE =
  "Selected model is at capacity. Please try a different model.";
const REASONING_ANALYSIS_CORE_FIELDS = [
  "reasoning_tokens",
  "final_answer_only",
  "commentary_observed",
];
const REASONING_ANALYSIS_FIELDS = [
  ...REASONING_ANALYSIS_CORE_FIELDS,
  "duration_total_ms",
  "output_tokens",
  "model_family",
  "reasoning_effort",
  "status",
  "retry_status",
  "blocked_status",
];

const DEFAULT_CONFIG = {
  listen_host: "127.0.0.1",
  listen_port: 4610,
  upstream_base_url: "",
  request_body_limit_bytes: DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
  intercept_rule_mode: INTERCEPT_RULE_MODE_REASONING_TOKENS,
  reasoning_equals: [516, 1034, 1552],
  intercept_streaming: true,
  intercept_non_streaming: true,
  non_stream_status_code: 502,
  guard_retry_attempts: 3,
  retry_upstream_capacity_errors: true,
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
const OUTPUT_TOKEN_POINTERS = [
  "/usage/output_tokens",
  "/usage/completion_tokens",
  "/response/usage/output_tokens",
  "/response/usage/completion_tokens",
];
const TOTAL_TOKEN_POINTERS = [
  "/usage/total_tokens",
  "/response/usage/total_tokens",
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
const LOG_ENTRY_LIMIT = 2000;
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

function extractOutputTokens(payload) {
  for (const pointer of OUTPUT_TOKEN_POINTERS) {
    const raw = jsonPointerGet(payload, pointer);
    if (Number.isInteger(raw)) {
      return raw;
    }
  }
  return null;
}

function extractTotalTokens(payload) {
  for (const pointer of TOTAL_TOKEN_POINTERS) {
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

function normalizeInterceptRuleMode(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return INTERCEPT_RULE_MODES.has(normalized)
    ? normalized
    : INTERCEPT_RULE_MODE_REASONING_TOKENS;
}

function normalizeNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
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

function normalizeRequestBodyLimitBytes(value, fallback = DEFAULT_REQUEST_BODY_LIMIT_BYTES) {
  const normalized = normalizePositiveInteger(value, fallback);
  if (normalized === LEGACY_REQUEST_BODY_LIMIT_BYTES) {
    return DEFAULT_REQUEST_BODY_LIMIT_BYTES;
  }
  return normalized;
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

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function toLocalDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function normalizeDateKeyInput(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isDateKeyWithinRange(dateKey, dateFrom, dateTo) {
  if (!dateKey) {
    return false;
  }
  if (dateFrom && dateKey < dateFrom) {
    return false;
  }
  if (dateTo && dateKey > dateTo) {
    return false;
  }
  return true;
}

function toIsoStringOrNull(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function roundMetric(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(digits));
}

function averageMetric(values, selector) {
  let total = 0;
  let count = 0;
  for (const value of values) {
    const numeric = Number(selector(value));
    if (Number.isFinite(numeric)) {
      total += numeric;
      count += 1;
    }
  }
  return count === 0 ? null : total / count;
}

function truncateText(value, maxLength = 320) {
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

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sanitizeRequestHeaders(headers = {}) {
  const sanitized = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = `${rawKey || ""}`.trim().toLowerCase();
    if (!key) {
      continue;
    }
    if (
      key === "authorization" ||
      key === "cookie" ||
      key === "set-cookie" ||
      key === "host" ||
      key === "content-length" ||
      key === "connection" ||
      key === "transfer-encoding"
    ) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      sanitized[key] = rawValue
        .map((value) => `${value ?? ""}`.trim())
        .filter(Boolean)
        .join(", ");
      continue;
    }
    const value = `${rawValue ?? ""}`.trim();
    if (!value) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function getHeaderValue(headers = {}, targetKey) {
  const normalizedTarget = `${targetKey || ""}`.trim().toLowerCase();
  if (!normalizedTarget) {
    return "";
  }
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    if (`${rawKey || ""}`.trim().toLowerCase() !== normalizedTarget) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      return rawValue.map((value) => `${value ?? ""}`.trim()).filter(Boolean).join(", ");
    }
    return `${rawValue ?? ""}`.trim();
  }
  return "";
}

function includesAnyContextCompactionMarker(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return Boolean(normalized) && CONTEXT_COMPACTION_MARKERS.some((marker) => normalized.includes(marker));
}

function stringifyRequestKindSignal(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : `${value}`;
}

function detectRequestKind(headers = {}, requestJson = null) {
  const headerSignals = [
    getHeaderValue(headers, "x-codex-beta-features"),
    getHeaderValue(headers, "openai-beta"),
    getHeaderValue(headers, "x-codex-request-kind"),
    getHeaderValue(headers, "x-codex-purpose"),
  ].join(" ");
  if (includesAnyContextCompactionMarker(headerSignals)) {
    return REQUEST_KIND_CONTEXT_COMPACTION;
  }

  const metadataSignals = [
    requestJson?.metadata,
    requestJson?.codex_request_kind,
    requestJson?.request_kind,
    requestJson?.purpose,
  ]
    .map(stringifyRequestKindSignal)
    .join(" ");
  return includesAnyContextCompactionMarker(metadataSignals)
    ? REQUEST_KIND_CONTEXT_COMPACTION
    : REQUEST_KIND_NORMAL;
}

function createReasoningBehaviorState() {
  return {
    started_at: new Date().toISOString(),
    next_sample_sequence: 1,
    next_request_sequence: 1,
    next_export_job_sequence: 1,
    recent_samples: [],
    daily_buffers: new Map(),
    flush_timers: new Map(),
    export_jobs: new Map(),
    last_flush_at: null,
    last_flush_error: null,
  };
}

function createHistoricalImportState() {
  return {
    next_job_sequence: 1,
    jobs: new Map(),
    last_summary: null,
  };
}

function nextReasoningSampleId(state) {
  const sequence = state.next_sample_sequence;
  state.next_sample_sequence += 1;
  return `reasoning_sample_${Date.now()}_${sequence}`;
}

function nextGatewayRequestId(state) {
  const sequence = state.next_request_sequence;
  state.next_request_sequence += 1;
  return `gateway_request_${Date.now()}_${sequence}`;
}

function createStructureAccumulator() {
  return {
    event_type_counts: {},
    response_item_type_counts: {},
    has_commentary: false,
    has_final_answer: false,
    has_tool_call: false,
    has_output_text: false,
    has_reasoning_item: false,
  };
}

function incrementObjectCounter(counter, key) {
  if (!key) {
    return;
  }
  counter[key] = (counter[key] || 0) + 1;
}

function markVisibleContent(structure) {
  structure.has_final_answer = true;
  structure.has_output_text = true;
}

function inspectContentEntryForStructure(entry, structure) {
  const contentType = normalizeNonEmptyString(entry?.type);
  if (contentType) {
    if (contentType.includes("commentary")) {
      structure.has_commentary = true;
    }
    if (contentType.includes("tool_call") || contentType.includes("function_call")) {
      structure.has_tool_call = true;
    }
    if (contentType.includes("output_text") || contentType.includes("text")) {
      const textValue =
        typeof entry?.text === "string"
          ? entry.text
          : typeof entry?.output_text === "string"
            ? entry.output_text
            : typeof entry?.content === "string"
              ? entry.content
              : null;
      if (textValue && textValue.trim()) {
        markVisibleContent(structure);
      }
    }
  }
  if (typeof entry?.text === "string" && entry.text.trim()) {
    markVisibleContent(structure);
  }
  if (typeof entry?.output_text === "string" && entry.output_text.trim()) {
    markVisibleContent(structure);
  }
}

function inspectOutputItemForStructure(item, structure) {
  const itemType = normalizeNonEmptyString(item?.type) || "unknown";
  incrementObjectCounter(structure.response_item_type_counts, itemType);
  if (itemType.includes("reasoning")) {
    structure.has_reasoning_item = true;
  }
  if (itemType.includes("commentary")) {
    structure.has_commentary = true;
  }
  if (
    itemType.includes("tool_call") ||
    itemType.includes("function_call") ||
    itemType.includes("tool")
  ) {
    structure.has_tool_call = true;
  }
  if (typeof item?.text === "string" && item.text.trim()) {
    markVisibleContent(structure);
  }
  if (typeof item?.output_text === "string" && item.output_text.trim()) {
    markVisibleContent(structure);
  }
  if (Array.isArray(item?.content)) {
    for (const contentEntry of item.content) {
      inspectContentEntryForStructure(contentEntry, structure);
    }
  }
}

function applyStructureSignalsFromPayload(payload, structure, { fromStream = false } = {}) {
  const eventType = normalizeNonEmptyString(payload?.type);
  if (fromStream && eventType) {
    incrementObjectCounter(structure.event_type_counts, eventType);
  }
  if (eventType && eventType.includes("commentary")) {
    structure.has_commentary = true;
  }
  if (
    eventType &&
    (eventType.includes("tool_call") || eventType.includes("function_call"))
  ) {
    structure.has_tool_call = true;
  }
  if (
    eventType &&
    (eventType.includes("output_text.delta") ||
      eventType.includes("message.delta") ||
      eventType.includes("content.delta"))
  ) {
    const deltaText =
      typeof payload?.delta === "string"
        ? payload.delta
        : typeof payload?.text === "string"
          ? payload.text
          : typeof payload?.content === "string"
            ? payload.content
            : payload?.choices?.some((choice) => typeof choice?.delta?.content === "string")
              ? payload.choices.map((choice) => choice?.delta?.content || "").join("")
              : "";
    if (deltaText.trim()) {
      markVisibleContent(structure);
    }
  }
  if (Array.isArray(payload?.choices)) {
    for (const choice of payload.choices) {
      if (typeof choice?.delta?.content === "string" && choice.delta.content.trim()) {
        markVisibleContent(structure);
      }
      if (typeof choice?.message?.content === "string" && choice.message.content.trim()) {
        markVisibleContent(structure);
      }
    }
  }
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    markVisibleContent(structure);
  }
  const outputCollections = [payload?.output, payload?.response?.output];
  for (const outputItems of outputCollections) {
    if (!Array.isArray(outputItems)) {
      continue;
    }
    for (const item of outputItems) {
      inspectOutputItemForStructure(item, structure);
    }
  }
}

function finalizeStructureSignals(sample, structure) {
  sample.event_type_counts = { ...structure.event_type_counts };
  sample.response_item_type_counts = { ...structure.response_item_type_counts };
  sample.has_commentary = Boolean(structure.has_commentary);
  sample.commentary_observed = sample.has_commentary;
  sample.commentary_not_observed = !sample.commentary_observed;
  sample.has_final_answer = Boolean(structure.has_final_answer);
  sample.has_tool_call = Boolean(structure.has_tool_call);
  sample.has_output_text = Boolean(structure.has_output_text);
  sample.has_reasoning_item = Boolean(structure.has_reasoning_item);
  sample.final_answer_only =
    sample.has_final_answer &&
    !sample.has_commentary &&
    !sample.has_tool_call &&
    !sample.has_reasoning_item;
}

function buildRequestSummary(bodyBuffer, headers) {
  return {
    body_bytes: bodyBuffer.length,
    body_sha256: sha256Buffer(bodyBuffer),
    sanitized_headers: sanitizeRequestHeaders(headers),
  };
}

function buildRequestPayloadExcerpt(bodyBuffer) {
  return truncateText(bodyBuffer.toString("utf8"), 500);
}

function buildFailureSummary(error, responsePayload = null) {
  if (responsePayload?.error && typeof responsePayload.error === "object") {
    const errorType = normalizeNonEmptyString(responsePayload.error.type);
    const errorCode = normalizeNonEmptyString(responsePayload.error.code);
    const errorMessage = normalizeNonEmptyString(responsePayload.error.message);
    if (errorType || errorCode || errorMessage) {
      return {
        type: errorType,
        code: errorCode,
        message: errorMessage,
      };
    }
  }
  return {
    type: normalizeNonEmptyString(error?.errorType || error?.name),
    code: normalizeNonEmptyString(error?.code),
    message: truncateText(`${error?.message || error || ""}`),
  };
}

function responsePayloadIncludesText(payload, bodyBuffer, predicate) {
  const parts = [];
  if (payload) {
    try {
      parts.push(JSON.stringify(payload));
    } catch {
      // ignore circular or non-serializable test payloads
    }
  }
  if (bodyBuffer?.length) {
    parts.push(bodyBuffer.toString("utf8"));
  }
  return parts.some((part) => predicate(String(part).toLowerCase()));
}

function isUpstreamCapacityErrorResponse(upstreamResponse, parsedPayload, bodyBuffer) {
  if (!upstreamResponse || upstreamResponse.status < 400) {
    return false;
  }
  const exactMessage = UPSTREAM_CAPACITY_ERROR_MESSAGE.toLowerCase();
  return responsePayloadIncludesText(parsedPayload, bodyBuffer, (text) =>
    text.includes(exactMessage) ||
    (
      text.includes("selected model is at capacity") &&
      text.includes("try a different model")
    ),
  );
}

function markReasoningSampleFirstChunk(sample, timestampMs = Date.now()) {
  if (!sample || Number.isFinite(sample.first_stream_chunk_at_ms)) {
    return;
  }
  sample.first_stream_chunk_at_ms = timestampMs;
  sample.first_stream_chunk_at = toIsoStringOrNull(timestampMs);
}

function markReasoningSampleFirstContent(sample, timestampMs = Date.now()) {
  if (!sample || Number.isFinite(sample.first_content_at_ms)) {
    return;
  }
  sample.first_content_at_ms = timestampMs;
  sample.first_content_at = toIsoStringOrNull(timestampMs);
}

function markReasoningSampleFinalChunk(sample, timestampMs = Date.now()) {
  if (!sample) {
    return;
  }
  sample.final_chunk_at_ms = timestampMs;
  sample.final_chunk_at = toIsoStringOrNull(timestampMs);
}

function payloadHasVisibleContent(payload) {
  const structure = createStructureAccumulator();
  applyStructureSignalsFromPayload(payload, structure, { fromStream: true });
  return Boolean(structure.has_output_text || structure.has_final_answer);
}

function completeReasoningBehaviorSample({
  runtime,
  sample,
  structure,
  modelContext,
  finalAction,
  clientHttpStatus = null,
  matchedCurrentRule = false,
  blockedByGateway = false,
  failureSummary = null,
}) {
  applyModelContextToReasoningSample(sample, modelContext);
  finalizeReasoningBehaviorSample(sample, structure, {
    final_action: finalAction,
    client_http_status: clientHttpStatus,
    matched_current_rule: matchedCurrentRule,
    blocked_by_gateway: blockedByGateway,
    failure_summary: failureSummary,
    latest_log_seq: runtime.monitor.next_log_seq - 1,
  });
  recordReasoningBehaviorSample(runtime, sample);
}

function buildReasoningBehaviorAttemptSample(runtime, requestTracking, attemptIndex, requestIsStream) {
  const startedAtMs = Date.now();
  const requestModel = normalizeNonEmptyString(requestTracking?.requestJson?.model);
  const localConfigModel = normalizeNonEmptyString(requestTracking?.localConfigModel);
  const effectiveLocalModel = requestModel || localConfigModel;
  return {
    sample_id: nextReasoningSampleId(runtime.reasoningBehavior),
    gateway_request_id: requestTracking.gateway_request_id,
    request_id: requestTracking.gateway_request_id,
    attempt_id: `${requestTracking.gateway_request_id}:attempt:${attemptIndex + 1}`,
    ts: new Date(startedAtMs).toISOString(),
    date_key: toLocalDateKey(startedAtMs),
    path: requestTracking.pathname,
    method: requestTracking.method,
    is_streaming: Boolean(requestIsStream),
    request_kind: requestTracking.request_kind || REQUEST_KIND_NORMAL,
    intercept_exempt_reason: requestTracking.intercept_exempt_reason || null,
    request_model: requestModel,
    request_model_family: normalizeModelFamily(requestModel),
    local_config_model: localConfigModel,
    effective_local_model: effectiveLocalModel,
    effective_local_model_family: normalizeModelFamily(effectiveLocalModel),
    request_reasoning_effort:
      normalizeReasoningEffort(requestTracking?.requestJson?.reasoning?.effort) ||
      requestTracking?.active_probe_reasoning_effort ||
      null,
    request_summary: requestTracking.request_summary || null,
    request_payload_excerpt: requestTracking.request_payload_excerpt || null,
    request_started_at: new Date(startedAtMs).toISOString(),
    request_started_at_ms: startedAtMs,
    upstream_fetch_started_at: null,
    upstream_fetch_started_at_ms: null,
    upstream_headers_at: null,
    upstream_headers_at_ms: null,
    first_stream_chunk_at: null,
    first_stream_chunk_at_ms: null,
    first_content_at: null,
    first_content_at_ms: null,
    final_chunk_at: null,
    final_chunk_at_ms: null,
    request_finished_at: null,
    request_finished_at_ms: null,
    duration_total_ms: null,
    upstream_wait_ms: null,
    time_to_first_chunk_ms: null,
    time_to_first_content_ms: null,
    stream_duration_ms: null,
    input_tokens: null,
    reasoning_tokens: null,
    output_tokens: null,
    total_tokens: null,
    output_tps: null,
    visible_output_tps: null,
    total_observed_tps: null,
    reasoning_adjusted_tps: null,
    time_normalization_deviation: null,
    has_commentary: false,
    has_final_answer: false,
    final_answer_only: false,
    has_tool_call: false,
    has_reasoning_item: false,
    has_output_text: false,
    event_type_counts: {},
    response_item_type_counts: {},
    matched_current_rule: false,
    blocked_by_gateway: false,
    upstream_stream_terminated: false,
    internal_retry_attempt_index: attemptIndex,
    internal_retry_remaining: null,
    final_action: "pending",
    upstream_http_status: null,
    client_http_status: null,
    upstream_model: null,
    stream_model: null,
    final_response_model: null,
    system_fingerprint: null,
    service_tier: null,
    failure_summary: null,
    evidence_log_seq_range: null,
  };
}

function applyModelContextToReasoningSample(sample, modelContext) {
  sample.upstream_model = modelContext?.upstreamModel || sample.upstream_model;
  sample.stream_model = modelContext?.streamModel || sample.stream_model;
  sample.final_response_model = modelContext?.finalResponseModel || sample.final_response_model;
  sample.system_fingerprint = modelContext?.systemFingerprint || sample.system_fingerprint;
  sample.service_tier = modelContext?.serviceTier || sample.service_tier;
}

function applyParsedUsageToReasoningSample(sample, parsed) {
  const inputTokens = extractInputTokens(parsed);
  const reasoningTokens = extractReasoningTokens(parsed);
  const outputTokens = extractOutputTokens(parsed);
  const totalTokens = extractTotalTokens(parsed);
  if (Number.isInteger(inputTokens)) {
    sample.input_tokens = inputTokens;
  }
  if (Number.isInteger(reasoningTokens)) {
    sample.reasoning_tokens = reasoningTokens;
  }
  if (Number.isInteger(outputTokens)) {
    sample.output_tokens = outputTokens;
  }
  if (Number.isInteger(totalTokens)) {
    sample.total_tokens = totalTokens;
  } else {
    const computedTotal =
      Number(sample.input_tokens || 0) +
      Number(sample.reasoning_tokens || 0) +
      Number(sample.output_tokens || 0);
    sample.total_tokens = computedTotal > 0 ? computedTotal : null;
  }
  sample.system_fingerprint =
    extractPayloadSystemFingerprint(parsed) || sample.system_fingerprint;
  sample.service_tier = extractPayloadServiceTier(parsed) || sample.service_tier;
}

function finalizeReasoningBehaviorSample(sample, structure, overrides = {}) {
  finalizeStructureSignals(sample, structure);
  const finishedAtMs = Number.isFinite(overrides.request_finished_at_ms)
    ? overrides.request_finished_at_ms
    : Date.now();
  sample.request_finished_at_ms = finishedAtMs;
  sample.request_finished_at = new Date(finishedAtMs).toISOString();
  if (Number.isFinite(sample.request_started_at_ms)) {
    sample.duration_total_ms = Math.max(0, finishedAtMs - sample.request_started_at_ms);
  }
  if (
    Number.isFinite(sample.upstream_fetch_started_at_ms) &&
    Number.isFinite(sample.upstream_headers_at_ms)
  ) {
    sample.upstream_wait_ms = Math.max(
      0,
      sample.upstream_headers_at_ms - sample.upstream_fetch_started_at_ms,
    );
  }
  if (
    Number.isFinite(sample.upstream_fetch_started_at_ms) &&
    Number.isFinite(sample.first_stream_chunk_at_ms)
  ) {
    sample.time_to_first_chunk_ms = Math.max(
      0,
      sample.first_stream_chunk_at_ms - sample.upstream_fetch_started_at_ms,
    );
  }
  if (
    Number.isFinite(sample.upstream_fetch_started_at_ms) &&
    Number.isFinite(sample.first_content_at_ms)
  ) {
    sample.time_to_first_content_ms = Math.max(
      0,
      sample.first_content_at_ms - sample.upstream_fetch_started_at_ms,
    );
  }
  if (
    Number.isFinite(sample.first_stream_chunk_at_ms) &&
    Number.isFinite(sample.final_chunk_at_ms)
  ) {
    sample.stream_duration_ms = Math.max(
      0,
      sample.final_chunk_at_ms - sample.first_stream_chunk_at_ms,
    );
  }
  const outputTokens = Number(sample.output_tokens || 0);
  const reasoningTokens = Number(sample.reasoning_tokens || 0);
  const observedTokens = Number(sample.total_tokens || 0) || reasoningTokens + outputTokens;
  if (Number.isFinite(sample.duration_total_ms) && sample.duration_total_ms > 0) {
    sample.output_tps = roundMetric((outputTokens * 1000) / sample.duration_total_ms, 4);
    sample.total_observed_tps = roundMetric(
      (observedTokens * 1000) / sample.duration_total_ms,
      4,
    );
  }
  if (Number.isFinite(sample.stream_duration_ms) && sample.stream_duration_ms > 0) {
    sample.visible_output_tps = roundMetric(
      (outputTokens * 1000) / sample.stream_duration_ms,
      4,
    );
  }
  if (
    Number.isFinite(sample.request_finished_at_ms) &&
    Number.isFinite(sample.upstream_headers_at_ms)
  ) {
    const adjustedDurationMs = sample.request_finished_at_ms - sample.upstream_headers_at_ms;
    if (adjustedDurationMs >= 250) {
      sample.reasoning_adjusted_tps = roundMetric(
        ((reasoningTokens + outputTokens) * 1000) / adjustedDurationMs,
        4,
      );
    }
  }
  if (
    Number.isFinite(sample.duration_total_ms) &&
    sample.duration_total_ms > 0 &&
    observedTokens > 0
  ) {
    const msPerToken = sample.duration_total_ms / observedTokens;
    const baselineMsPerToken = 35;
    sample.time_normalization_deviation = roundMetric(
      Math.max(0, (baselineMsPerToken - msPerToken) / baselineMsPerToken),
      4,
    );
  }
  sample.internal_retry_remaining =
    overrides.internal_retry_remaining ?? sample.internal_retry_remaining;
  sample.matched_current_rule =
    overrides.matched_current_rule ?? sample.matched_current_rule;
  sample.blocked_by_gateway =
    overrides.blocked_by_gateway ?? sample.blocked_by_gateway;
  sample.final_action = overrides.final_action || sample.final_action;
  sample.client_http_status =
    overrides.client_http_status === undefined
      ? sample.client_http_status
      : overrides.client_http_status;
  sample.upstream_http_status =
    overrides.upstream_http_status === undefined
      ? sample.upstream_http_status
      : overrides.upstream_http_status;
  sample.failure_summary = overrides.failure_summary || sample.failure_summary;
  sample.evidence_log_seq_range = overrides.evidence_log_seq_range || {
    from: sample.evidence_log_seq_range?.from ?? null,
    to: overrides.latest_log_seq ?? null,
  };
  return sample;
}

function clonePlainSample(sample) {
  const commentaryObserved = Boolean(sample.commentary_observed ?? sample.has_commentary);
  return {
    ...sample,
    commentary_observed: commentaryObserved,
    commentary_not_observed: !commentaryObserved,
    request_summary: sample.request_summary
      ? {
          ...sample.request_summary,
          sanitized_headers: {
            ...(sample.request_summary.sanitized_headers || {}),
          },
        }
      : null,
    failure_summary: sample.failure_summary ? { ...sample.failure_summary } : null,
    event_type_counts: { ...(sample.event_type_counts || {}) },
    response_item_type_counts: { ...(sample.response_item_type_counts || {}) },
    evidence_log_seq_range: sample.evidence_log_seq_range
      ? { ...sample.evidence_log_seq_range }
      : null,
  };
}

function mergeSamplesById(samples) {
  const merged = new Map();
  for (const sample of samples) {
    if (!sample || !sample.sample_id) {
      continue;
    }
    merged.set(sample.sample_id, clonePlainSample(sample));
  }
  return [...merged.values()].sort((left, right) =>
    `${left.ts || ""}`.localeCompare(`${right.ts || ""}`),
  );
}

function topReasoningTokensForSamples(samples, limit = 5) {
  const counts = new Map();
  for (const sample of samples) {
    if (!Number.isInteger(sample?.reasoning_tokens)) {
      continue;
    }
    const value = sample.reasoning_tokens;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const total = samples.length || 1;
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) {
        return right[1] - left[1];
      }
      return left[0] - right[0];
    })
    .slice(0, limit)
    .map(([value, count]) => ({
      value,
      count,
      ratio: roundMetric(count / total, 6),
    }));
}

function repeatedReasoningTokensForSamples(samples, limit = 3) {
  return topReasoningTokensForSamples(samples, samples.length)
    .filter((entry) => entry.count > 1)
    .slice(0, limit);
}

function buildOutputTpsBuckets(samples) {
  const buckets = [
    { label: "0-5", min: 0, max: 5, count: 0 },
    { label: "5-15", min: 5, max: 15, count: 0 },
    { label: "15-30", min: 15, max: 30, count: 0 },
    { label: "30+", min: 30, max: Number.POSITIVE_INFINITY, count: 0 },
  ];
  for (const sample of samples) {
    const value = Number(sample?.output_tps);
    if (!Number.isFinite(value)) {
      continue;
    }
    const bucket = buckets.find((item) => value >= item.min && value < item.max);
    if (bucket) {
      bucket.count += 1;
    }
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}

function summarizeGroupedSamples(groupEntries, totalCount) {
  const entries = [...groupEntries.entries()].map(([key, samples]) => {
    const count = samples.length;
    return {
      key,
      count,
      ratio: totalCount === 0 ? 0 : count / totalCount,
      final_answer_only_ratio:
        count === 0
          ? 0
          : samples.filter((sample) => sample.final_answer_only).length / count,
      commentary_present_ratio:
        count === 0
          ? 0
          : samples.filter((sample) => sample.has_commentary).length / count,
      commentary_observed_ratio:
        count === 0
          ? 0
          : samples.filter((sample) => sample.has_commentary).length / count,
      avg_duration_total_ms: roundMetric(
        averageMetric(samples, (sample) => sample.duration_total_ms) ?? 0,
        2,
      ),
      avg_output_tps: roundMetric(
        averageMetric(samples, (sample) => sample.output_tps) ?? 0,
        4,
      ),
      avg_reasoning_adjusted_tps: roundMetric(
        averageMetric(samples, (sample) => sample.reasoning_adjusted_tps) ?? 0,
        4,
      ),
      top_reasoning_tokens: repeatedReasoningTokensForSamples(samples, 3).map((entry) => ({
        value: entry.value,
        count: entry.count,
      })),
    };
  });
  return entries.sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return `${left.key}`.localeCompare(`${right.key}`);
  });
}

function buildReasoningBehaviorSnapshotFromSamples(samples, options = {}) {
  const recentLimit = Number.isInteger(options.recent_limit) ? options.recent_limit : 50;
  const sortedSamples = [...(Array.isArray(samples) ? samples : [])].sort((left, right) =>
    `${right.ts || ""}`.localeCompare(`${left.ts || ""}`),
  );
  const totalSamples = sortedSamples.length;
  const finalAnswerOnlyCount = sortedSamples.filter((sample) => sample.final_answer_only).length;
  const commentaryPresentCount = sortedSamples.filter((sample) => sample.has_commentary).length;
  const byModelFamilyGroups = new Map();
  const byReasoningEffortGroups = new Map();
  const byFamilyEffortGroups = new Map();
  const byReasoningTokenGroups = new Map();
  const candidatePatternGroups = new Map();

  for (const sample of sortedSamples) {
    const modelFamily =
      sample.effective_local_model_family ||
      sample.request_model_family ||
      normalizeModelFamily(sample.request_model || sample.upstream_model || sample.final_response_model);
    const reasoningEffort = sample.request_reasoning_effort || "unknown";
    if (!byModelFamilyGroups.has(modelFamily)) {
      byModelFamilyGroups.set(modelFamily, []);
    }
    byModelFamilyGroups.get(modelFamily).push(sample);

    if (!byReasoningEffortGroups.has(reasoningEffort)) {
      byReasoningEffortGroups.set(reasoningEffort, []);
    }
    byReasoningEffortGroups.get(reasoningEffort).push(sample);

    const familyEffortKey = `${modelFamily}|${reasoningEffort}`;
    if (!byFamilyEffortGroups.has(familyEffortKey)) {
      byFamilyEffortGroups.set(familyEffortKey, []);
    }
    byFamilyEffortGroups.get(familyEffortKey).push(sample);

    if (Number.isInteger(sample.reasoning_tokens)) {
      const reasoningKey = String(sample.reasoning_tokens);
      if (!byReasoningTokenGroups.has(reasoningKey)) {
        byReasoningTokenGroups.set(reasoningKey, []);
      }
      byReasoningTokenGroups.get(reasoningKey).push(sample);

      if (
        sample.final_answer_only &&
        !sample.has_commentary &&
        Number(sample.time_normalization_deviation || 0) >= 0
      ) {
        const patternKey = `reasoning=${sample.reasoning_tokens}|final_answer_only|commentary_not_observed`;
        if (!candidatePatternGroups.has(patternKey)) {
          candidatePatternGroups.set(patternKey, []);
        }
        candidatePatternGroups.get(patternKey).push(sample);
      }
    }
  }

  const byModelFamily = summarizeGroupedSamples(byModelFamilyGroups, totalSamples).map((entry) => ({
    model_family: entry.key,
    count: entry.count,
    ratio: roundMetric(entry.ratio, 6),
    final_answer_only_ratio: roundMetric(entry.final_answer_only_ratio, 6),
    commentary_present_ratio: roundMetric(entry.commentary_present_ratio, 6),
    commentary_observed_ratio: roundMetric(entry.commentary_observed_ratio, 6),
    avg_duration_total_ms: entry.avg_duration_total_ms,
    avg_output_tps: entry.avg_output_tps,
    top_reasoning_tokens: entry.top_reasoning_tokens,
  }));

  const byReasoningEffort = summarizeGroupedSamples(byReasoningEffortGroups, totalSamples).map((entry) => ({
    reasoning_effort: entry.key,
    count: entry.count,
    ratio: roundMetric(entry.ratio, 6),
    final_answer_only_ratio: roundMetric(entry.final_answer_only_ratio, 6),
    commentary_present_ratio: roundMetric(entry.commentary_present_ratio, 6),
    commentary_observed_ratio: roundMetric(entry.commentary_observed_ratio, 6),
    avg_duration_total_ms: entry.avg_duration_total_ms,
    avg_reasoning_adjusted_tps: entry.avg_reasoning_adjusted_tps,
    top_reasoning_tokens: entry.top_reasoning_tokens,
  }));

  const byModelFamilyAndEffort = summarizeGroupedSamples(
    byFamilyEffortGroups,
    totalSamples,
  ).map((entry) => {
    const [modelFamily, reasoningEffort] = `${entry.key}`.split("|");
    return {
      group_key: entry.key,
      group_label: `${modelFamily} / ${reasoningEffort}`,
      model_family: modelFamily,
      reasoning_effort: reasoningEffort,
      count: entry.count,
      ratio: roundMetric(entry.ratio, 6),
      final_answer_only_ratio: roundMetric(entry.final_answer_only_ratio, 6),
      commentary_present_ratio: roundMetric(entry.commentary_present_ratio, 6),
      commentary_observed_ratio: roundMetric(entry.commentary_observed_ratio, 6),
      avg_duration_total_ms: entry.avg_duration_total_ms,
      avg_output_tps: entry.avg_output_tps,
      top_reasoning_tokens: entry.top_reasoning_tokens,
    };
  });

  const byReasoningToken = [...byReasoningTokenGroups.entries()]
    .map(([value, tokenSamples]) => ({
      value: Number.parseInt(value, 10),
      count: tokenSamples.length,
      final_answer_only_ratio: roundMetric(
        tokenSamples.filter((sample) => sample.final_answer_only).length / tokenSamples.length,
        6,
      ),
      commentary_present_ratio: roundMetric(
        tokenSamples.filter((sample) => sample.has_commentary).length / tokenSamples.length,
        6,
      ),
      commentary_observed_ratio: roundMetric(
        tokenSamples.filter((sample) => sample.has_commentary).length / tokenSamples.length,
        6,
      ),
      avg_duration_total_ms: roundMetric(
        averageMetric(tokenSamples, (sample) => sample.duration_total_ms) ?? 0,
        2,
      ),
      avg_output_tps: roundMetric(
        averageMetric(tokenSamples, (sample) => sample.output_tps) ?? 0,
        4,
      ),
      avg_time_normalization_deviation: roundMetric(
        averageMetric(tokenSamples, (sample) => sample.time_normalization_deviation) ?? 0,
        4,
      ),
      last_seen_at: tokenSamples
        .map((sample) => sample.ts)
        .sort()
        .slice(-1)[0] || null,
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return left.value - right.value;
    });

  const candidatePatterns = [...candidatePatternGroups.entries()]
    .map(([patternKey, patternSamples]) => ({
      pattern_key: patternKey,
      count: patternSamples.length,
      ratio: roundMetric(patternSamples.length / totalSamples, 6),
      avg_duration_total_ms: roundMetric(
        averageMetric(patternSamples, (sample) => sample.duration_total_ms) ?? 0,
        2,
      ),
      avg_output_tps: roundMetric(
        averageMetric(patternSamples, (sample) => sample.output_tps) ?? 0,
        4,
      ),
      avg_time_normalization_deviation: roundMetric(
        averageMetric(patternSamples, (sample) => sample.time_normalization_deviation) ?? 0,
        4,
      ),
      last_seen_at: patternSamples
        .map((sample) => sample.ts)
        .sort()
        .slice(-1)[0] || null,
      status: "observe_only",
    }))
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }
      return `${left.pattern_key}`.localeCompare(`${right.pattern_key}`);
    });

  return {
    schema_version: REASONING_BEHAVIOR_SCHEMA_VERSION,
    analytics_ready: true,
    summary: {
      total_samples: totalSamples,
      final_answer_only_ratio:
        totalSamples === 0 ? 0 : roundMetric(finalAnswerOnlyCount / totalSamples, 6),
      commentary_present_ratio:
        totalSamples === 0 ? 0 : roundMetric(commentaryPresentCount / totalSamples, 6),
      commentary_observed_ratio:
        totalSamples === 0 ? 0 : roundMetric(commentaryPresentCount / totalSamples, 6),
      avg_duration_total_ms: roundMetric(
        averageMetric(sortedSamples, (sample) => sample.duration_total_ms) ?? 0,
        2,
      ),
      avg_output_tps: roundMetric(
        averageMetric(sortedSamples, (sample) => sample.output_tps) ?? 0,
        4,
      ),
      avg_reasoning_adjusted_tps: roundMetric(
        averageMetric(sortedSamples, (sample) => sample.reasoning_adjusted_tps) ?? 0,
        4,
      ),
      wording:
        "统计结果只表示可观测结构信号，用于发现候选异常特征，不代表最终归因，也不证明模型内部没有思考。final answer only / commentary observed 不是互补关系，剩余样本可能是 tool call、reasoning item 或普通 output 组合。",
    },
    top_reasoning_tokens: topReasoningTokensForSamples(sortedSamples, 8),
    output_tps_buckets: buildOutputTpsBuckets(sortedSamples),
    by_model_family: byModelFamily,
    by_reasoning_effort: byReasoningEffort,
    by_model_family_and_effort: byModelFamilyAndEffort,
    by_reasoning_token: byReasoningToken,
    candidate_patterns: candidatePatterns,
    recent_samples: sortedSamples.slice(0, recentLimit).map(clonePlainSample),
  };
}

function buildReasoningBehaviorMetadata(runtime) {
  return {
    schema_version: REASONING_BEHAVIOR_SCHEMA_VERSION,
    analytics_ready: true,
    analytics_started_at: runtime?.reasoningBehavior?.started_at || null,
    analytics_state_root: runtime?.paths?.analyticsRoot || null,
    analytics_last_flush_at: runtime?.reasoningBehavior?.last_flush_at || null,
    analytics_last_flush_error: runtime?.reasoningBehavior?.last_flush_error || null,
  };
}

function countInclusiveDateRangeDays(dateFrom, dateTo) {
  const normalizedFrom = normalizeDateKeyInput(dateFrom);
  const normalizedTo = normalizeDateKeyInput(dateTo);
  if (!normalizedFrom || !normalizedTo) {
    return null;
  }
  const fromMs = Date.parse(`${normalizedFrom}T00:00:00.000Z`);
  const toMs = Date.parse(`${normalizedTo}T00:00:00.000Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return null;
  }
  return Math.floor((toMs - fromMs) / 86400000) + 1;
}

function buildReasoningRangeDegradePayload(runtime, dateFrom, dateTo, maxDays) {
  return {
    ok: true,
    ...buildReasoningBehaviorMetadata(runtime),
    date_from: dateFrom,
    date_to: dateTo,
    degraded: true,
    degrade_reason: "date_range_too_large",
    max_inline_range_days: maxDays,
    message: "时间段过大，已跳过明细读取；请缩小时间段或使用分片/压缩包导出。",
    summary: {
      total_samples: 0,
      wording: "统计结果用于发现候选复盘特征，不代表最终归因。",
    },
    top_reasoning_tokens: [],
    output_tps_buckets: [],
    by_model_family: [],
    by_reasoning_effort: [],
    by_model_family_and_effort: [],
    by_reasoning_token: [],
    candidate_patterns: [],
    recent_samples: [],
  };
}

function addDaysToDateKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function listInclusiveDateKeys(dateFrom, dateTo) {
  const totalDays = countInclusiveDateRangeDays(dateFrom, dateTo);
  if (!Number.isInteger(totalDays) || totalDays <= 0) {
    return [];
  }
  const dates = [];
  for (let index = 0; index < totalDays; index += 1) {
    dates.push(addDaysToDateKey(dateFrom, index));
  }
  return dates;
}

function buildReasoningExportJobPublic(job) {
  if (!job) {
    return null;
  }
  return {
    job_id: job.job_id,
    status: job.status,
    format: job.format,
    date_from: job.date_from,
    date_to: job.date_to,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error_message: job.error_message,
    output_path: job.output_path,
    download_url:
      job.status === "completed"
        ? `${REASONING_BEHAVIOR_EXPORT_API_PATH}/jobs/${encodeURIComponent(job.job_id)}/download`
        : null,
    progress: {
      total_days: job.total_days,
      processed_days: job.processed_days,
      sample_count: job.sample_count,
      percent:
        job.total_days > 0
          ? roundMetric(Math.min(1, job.processed_days / job.total_days), 4)
          : 0,
    },
  };
}

function nextReasoningExportJobId(state) {
  const sequence = state.next_export_job_sequence;
  state.next_export_job_sequence += 1;
  return `reasoning_export_${Date.now()}_${sequence}`;
}

function trimReasoningExportJobs(state) {
  const jobs = [...state.export_jobs.values()].sort((left, right) =>
    `${right.created_at || ""}`.localeCompare(`${left.created_at || ""}`),
  );
  for (const job of jobs.slice(REASONING_BEHAVIOR_EXPORT_JOB_LIMIT)) {
    if (job.status === "running" || job.status === "queued") {
      continue;
    }
    state.export_jobs.delete(job.job_id);
  }
}

async function writeReasoningExportJobFile(runtime, job, samples) {
  const exportRoot = path.join(runtime.paths.analyticsRoot, "exports", job.job_id);
  await mkdir(exportRoot, { recursive: true });
  const extension = job.format === "csv" ? "csv" : "json";
  const outputPath = path.join(exportRoot, `reasoning-export.${extension}`);
  if (job.format === "csv") {
    await writeFile(outputPath, buildReasoningBehaviorCsv(samples), "utf8");
  } else {
    const snapshot = buildReasoningBehaviorSnapshotFromSamples(samples, {
      recent_limit: Math.min(samples.length, 200),
    });
    const payload = {
      ok: true,
      exported_at: new Date().toISOString(),
      ...buildReasoningBehaviorMetadata(runtime),
      date_from: job.date_from,
      date_to: job.date_to,
      schema_version: REASONING_BEHAVIOR_SCHEMA_VERSION,
      background_export: true,
      export_job_id: job.job_id,
      ...snapshot,
      samples,
    };
    await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
  return outputPath;
}

async function readReasoningBehaviorSamplesByDateKey(runtime, dateKey) {
  const combinedSamples = [];
  const fileSamples = await readReasoningBehaviorDayFile(runtime, dateKey);
  combinedSamples.push(...fileSamples);
  const bufferedSamples = runtime.reasoningBehavior.daily_buffers.get(dateKey) || [];
  combinedSamples.push(...bufferedSamples);
  return mergeSamplesById(combinedSamples);
}

async function runReasoningExportJob(runtime, job) {
  job.status = "running";
  job.started_at = new Date().toISOString();
  const samples = [];
  try {
    for (const dateKey of job.date_keys) {
      const daySamples = await readReasoningBehaviorSamplesByDateKey(runtime, dateKey);
      samples.push(...daySamples);
      job.processed_days += 1;
      job.sample_count = samples.length;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const mergedSamples = mergeSamplesById(samples).sort((left, right) =>
      `${right.ts || ""}`.localeCompare(`${left.ts || ""}`),
    );
    job.sample_count = mergedSamples.length;
    job.output_path = await writeReasoningExportJobFile(runtime, job, mergedSamples);
    job.status = "completed";
    job.finished_at = new Date().toISOString();
  } catch (error) {
    job.status = "failed";
    job.error_message = `${error?.message || error}`;
    job.finished_at = new Date().toISOString();
    runtime.logger(
      `[analytics-error] reasoning background export failed job=${job.job_id} message=${job.error_message}`,
    );
  }
}

function startReasoningExportJob(runtime, { format, dateFrom, dateTo }) {
  const dateKeys = listInclusiveDateKeys(dateFrom, dateTo);
  const job = {
    job_id: nextReasoningExportJobId(runtime.reasoningBehavior),
    status: "queued",
    format: format === "csv" ? "csv" : "json",
    date_from: dateFrom,
    date_to: dateTo,
    date_keys: dateKeys,
    total_days: dateKeys.length,
    processed_days: 0,
    sample_count: 0,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    output_path: null,
    error_message: null,
  };
  runtime.reasoningBehavior.export_jobs.set(job.job_id, job);
  trimReasoningExportJobs(runtime.reasoningBehavior);
  setImmediate(() => {
    runReasoningExportJob(runtime, job);
  });
  return job;
}

function buildReasoningBehaviorDayFilePath(runtime, dateKey) {
  return path.join(runtime.paths.analyticsRoot, `reasoning-behavior-${dateKey}.json`);
}

async function readReasoningBehaviorDayFile(runtime, dateKey) {
  const filePath = buildReasoningBehaviorDayFilePath(runtime, dateKey);
  const payload = await readOptionalJson(filePath);
  const samples = Array.isArray(payload?.samples) ? payload.samples : [];
  return samples;
}

async function flushReasoningBehaviorDay(runtime, dateKey) {
  const bufferedSamples = runtime.reasoningBehavior.daily_buffers.get(dateKey) || [];
  const existingSamples = await readReasoningBehaviorDayFile(runtime, dateKey);
  const mergedSamples = mergeSamplesById([...existingSamples, ...bufferedSamples]);
  await mkdir(runtime.paths.analyticsRoot, { recursive: true });
  const snapshot = buildReasoningBehaviorSnapshotFromSamples(mergedSamples, {
    recent_limit: Math.min(REASONING_BEHAVIOR_RECENT_SAMPLE_LIMIT, 50),
  });
  const payload = {
    date: dateKey,
    schema_version: REASONING_BEHAVIOR_SCHEMA_VERSION,
    generated_by: "codex-retry-gateway",
    samples: mergedSamples,
    daily_summary: snapshot.summary,
  };
  await writeFile(
    buildReasoningBehaviorDayFilePath(runtime, dateKey),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  runtime.reasoningBehavior.last_flush_at = new Date().toISOString();
  runtime.reasoningBehavior.last_flush_error = null;
}

function scheduleReasoningBehaviorFlush(runtime, dateKey) {
  const existingTimer = runtime.reasoningBehavior.flush_timers.get(dateKey);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  const timer = setTimeout(() => {
    runtime.reasoningBehavior.flush_timers.delete(dateKey);
    flushReasoningBehaviorDay(runtime, dateKey).catch((error) => {
      runtime.reasoningBehavior.last_flush_error = `${error?.message || error}`;
      runtime.logger(
        `[analytics-error] reasoning flush failed date=${dateKey} message=${error?.message || error}`,
      );
    });
  }, 30);
  timer.unref?.();
  runtime.reasoningBehavior.flush_timers.set(dateKey, timer);
}

function recordReasoningBehaviorSample(runtime, sample) {
  const normalizedSample = clonePlainSample(sample);
  runtime.reasoningBehavior.recent_samples.unshift(normalizedSample);
  if (runtime.reasoningBehavior.recent_samples.length > REASONING_BEHAVIOR_RECENT_SAMPLE_LIMIT) {
    runtime.reasoningBehavior.recent_samples.length = REASONING_BEHAVIOR_RECENT_SAMPLE_LIMIT;
  }
  const dateKey = normalizedSample.date_key || toLocalDateKey(normalizedSample.ts || Date.now());
  const bufferedSamples = runtime.reasoningBehavior.daily_buffers.get(dateKey) || [];
  bufferedSamples.push(normalizedSample);
  runtime.reasoningBehavior.daily_buffers.set(dateKey, bufferedSamples);
  scheduleReasoningBehaviorFlush(runtime, dateKey);
}

async function readReasoningBehaviorSamplesByDateRange(runtime, dateFrom, dateTo) {
  const normalizedFrom = normalizeDateKeyInput(dateFrom);
  const normalizedTo = normalizeDateKeyInput(dateTo);
  const combinedSamples = [];

  try {
    const fileNames = await readdir(runtime.paths.analyticsRoot);
    for (const fileName of fileNames) {
      const match = fileName.match(/^reasoning-behavior-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) {
        continue;
      }
      const dateKey = match[1];
      if (!isDateKeyWithinRange(dateKey, normalizedFrom, normalizedTo)) {
        continue;
      }
      const payload = await readOptionalJson(path.join(runtime.paths.analyticsRoot, fileName));
      if (Array.isArray(payload?.samples)) {
        combinedSamples.push(...payload.samples);
      }
    }
  } catch {
    // analytics dir may not exist yet
  }

  for (const [dateKey, bufferedSamples] of runtime.reasoningBehavior.daily_buffers.entries()) {
    if (!isDateKeyWithinRange(dateKey, normalizedFrom, normalizedTo)) {
      continue;
    }
    combinedSamples.push(...bufferedSamples);
  }

  return mergeSamplesById(combinedSamples).sort((left, right) =>
    `${right.ts || ""}`.localeCompare(`${left.ts || ""}`),
  );
}

function buildReasoningBehaviorCsv(samples) {
  const headers = [
    "sample_id",
    "gateway_request_id",
    "attempt_id",
    "ts",
    "path",
    "method",
    "request_kind",
    "intercept_exempt_reason",
    "request_model",
    "effective_local_model_family",
    "request_reasoning_effort",
    "reasoning_tokens",
    "output_tokens",
    "total_tokens",
    "duration_total_ms",
    "output_tps",
    "reasoning_adjusted_tps",
    "final_answer_only",
    "has_commentary",
    "commentary_observed",
    "has_final_answer",
    "has_tool_call",
    "has_reasoning_item",
    "time_to_first_chunk_ms",
    "time_to_first_content_ms",
    "stream_duration_ms",
    "matched_current_rule",
    "blocked_by_gateway",
    "upstream_stream_terminated",
    "internal_retry_attempt_index",
    "internal_retry_remaining",
    "final_action",
    "upstream_http_status",
    "client_http_status",
    "body_bytes",
    "body_sha256",
    "request_payload_excerpt",
    "failure_code",
    "failure_message",
  ];
  const lines = [headers.join(",")];
  for (const sample of samples) {
    const values = [
      sample.sample_id,
      sample.gateway_request_id,
      sample.attempt_id,
      sample.ts,
      sample.path,
      sample.method,
      sample.request_kind,
      sample.intercept_exempt_reason,
      sample.request_model,
      sample.effective_local_model_family,
      sample.request_reasoning_effort,
      sample.reasoning_tokens,
      sample.output_tokens,
      sample.total_tokens,
      sample.duration_total_ms,
      sample.output_tps,
      sample.reasoning_adjusted_tps,
      sample.final_answer_only,
      sample.has_commentary,
      sample.commentary_observed ?? sample.has_commentary,
      sample.has_final_answer,
      sample.has_tool_call,
      sample.has_reasoning_item,
      sample.time_to_first_chunk_ms,
      sample.time_to_first_content_ms,
      sample.stream_duration_ms,
      sample.matched_current_rule,
      sample.blocked_by_gateway,
      sample.upstream_stream_terminated,
      sample.internal_retry_attempt_index,
      sample.internal_retry_remaining,
      sample.final_action,
      sample.upstream_http_status,
      sample.client_http_status,
      sample.request_summary?.body_bytes,
      sample.request_summary?.body_sha256,
      sample.request_payload_excerpt,
      sample.failure_summary?.code,
      sample.failure_summary?.message,
    ].map((value) => {
      const text = value === null || value === undefined ? "" : `${value}`;
      return `"${text.replaceAll('"', '""')}"`;
    });
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

function hasOwnValue(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeAnalysisStringList(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeNonEmptyString(entry))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((entry) => normalizeNonEmptyString(entry))
      .filter(Boolean);
  }
  return [];
}

function normalizeNumberList(value) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : value === null || value === undefined
        ? []
        : [value];
  return rawValues
    .map((entry) => Number.parseInt(`${entry}`.trim(), 10))
    .filter((entry) => Number.isInteger(entry));
}

function sampleModelFamily(sample) {
  return (
    normalizeNonEmptyString(sample?.effective_local_model_family) ||
    normalizeNonEmptyString(sample?.request_model_family) ||
    normalizeModelFamily(
      sample?.request_model || sample?.effective_local_model || sample?.model || sample?.upstream_model,
    )
  );
}

function sampleReasoningEffort(sample) {
  return (
    normalizeReasoningEffort(sample?.request_reasoning_effort) ||
    normalizeReasoningEffort(sample?.reasoning_effort) ||
    null
  );
}

function sampleHasAnalysisField(sample, field) {
  if (!sample) {
    return false;
  }
  if (field === "reasoning_tokens") {
    return Number.isFinite(Number(sample.reasoning_tokens));
  }
  if (field === "final_answer_only") {
    return hasOwnValue(sample, "final_answer_only");
  }
  if (field === "commentary_observed") {
    return hasOwnValue(sample, "commentary_observed") || hasOwnValue(sample, "has_commentary");
  }
  if (field === "duration_total_ms") {
    return Number.isFinite(Number(sample.duration_total_ms));
  }
  if (field === "output_tokens") {
    return Number.isFinite(Number(sample.output_tokens)) || Number.isFinite(Number(sample.total_tokens));
  }
  if (field === "model_family") {
    return Boolean(sampleModelFamily(sample));
  }
  if (field === "reasoning_effort") {
    return Boolean(sampleReasoningEffort(sample));
  }
  if (field === "status") {
    return (
      Boolean(sample.final_action) ||
      Number.isFinite(Number(sample.client_http_status)) ||
      Number.isFinite(Number(sample.upstream_http_status))
    );
  }
  if (field === "retry_status") {
    return (
      hasOwnValue(sample, "internal_retry_attempt_index") ||
      hasOwnValue(sample, "internal_retry_remaining")
    );
  }
  if (field === "blocked_status") {
    return hasOwnValue(sample, "blocked_by_gateway");
  }
  return false;
}

function calculateFieldCoverage(samples) {
  const entries = Array.isArray(samples) ? samples : [];
  const total = entries.length;
  const coverage = {};
  for (const field of REASONING_ANALYSIS_FIELDS) {
    const count = entries.filter((sample) => sampleHasAnalysisField(sample, field)).length;
    coverage[field] = total === 0 ? 0 : roundMetric(count / total, 6);
  }
  return coverage;
}

function decideReasoningAnalysisValue(fieldCoverage, sampleCount) {
  const missingCoreFields = REASONING_ANALYSIS_CORE_FIELDS.filter(
    (field) => Number(fieldCoverage?.[field] || 0) <= 0,
  );
  if (sampleCount <= 0) {
    return {
      analysis_value: "no_analysis_value",
      can_build_reasoning_features: false,
      can_build_candidate_patterns: false,
      missing_core_fields: REASONING_ANALYSIS_CORE_FIELDS,
      decision_reason: "没有可用于 reasoning 行为分析的结构化样本。",
    };
  }
  if (missingCoreFields.length > 0) {
    return {
      analysis_value: "no_analysis_value",
      can_build_reasoning_features: false,
      can_build_candidate_patterns: false,
      missing_core_fields: missingCoreFields,
      decision_reason: `缺少核心字段：${missingCoreFields.join(", ")}。`,
    };
  }
  const missingSupportFields = [
    "duration_total_ms",
    "output_tokens",
    "model_family",
    "reasoning_effort",
  ].filter((field) => Number(fieldCoverage?.[field] || 0) <= 0);
  if (missingSupportFields.length > 0) {
    return {
      analysis_value: "partial",
      can_build_reasoning_features: true,
      can_build_candidate_patterns: false,
      missing_core_fields: [],
      decision_reason: `辅助字段不足：${missingSupportFields.join(", ")}；只能展示覆盖率，不能给强候选结论。`,
    };
  }
  return {
    analysis_value: "valuable",
    can_build_reasoning_features: true,
    can_build_candidate_patterns: true,
    missing_core_fields: [],
    decision_reason: "核心字段覆盖率足够，可以进入特征分析。",
  };
}

function buildReasoningAnalysisProfile(payload = {}, dataSource = "runtime") {
  const filters = payload?.filters || {};
  const conditions = payload?.conditions || {};
  const reasoningTokens = normalizeNumberList(
    conditions.reasoning_tokens ?? filters.reasoning_tokens ?? [516],
  );
  return {
    name: REASONING_ANALYSIS_PROFILE_NAME,
    data_source: dataSource,
    filters: {
      date_from: normalizeDateKeyInput(filters.date_from ?? payload?.date_from) || null,
      date_to: normalizeDateKeyInput(filters.date_to ?? payload?.date_to) || null,
      model_family: normalizeAnalysisStringList(filters.model_family),
      model: normalizeAnalysisStringList(filters.model),
      reasoning_effort: normalizeAnalysisStringList(filters.reasoning_effort),
      status: normalizeNonEmptyString(filters.status) || "any",
      include_retries: filters.include_retries !== false,
      include_blocked: filters.include_blocked !== false,
    },
    conditions: {
      reasoning_tokens: reasoningTokens.length > 0 ? reasoningTokens : [516],
      reasoning_tokens_mode:
        normalizeNonEmptyString(conditions.reasoning_tokens_mode) || "equals_or_outlier",
      final_answer_only:
        conditions.final_answer_only === undefined ? true : Boolean(conditions.final_answer_only),
      commentary_not_observed:
        conditions.commentary_not_observed === undefined
          ? true
          : Boolean(conditions.commentary_not_observed),
      time_normalization_deviation:
        normalizeNonEmptyString(conditions.time_normalization_deviation) || "high",
    },
    baseline: {
      group_by: ["model_family", "reasoning_effort", "token_scale_bucket"],
      compare_with_non_candidate_samples: true,
    },
  };
}

function sampleMatchesReasoningAnalysisFilters(sample, profile) {
  const filters = profile?.filters || {};
  const modelFamilies = normalizeAnalysisStringList(filters.model_family);
  if (modelFamilies.length > 0 && !modelFamilies.includes(sampleModelFamily(sample))) {
    return false;
  }
  const models = normalizeAnalysisStringList(filters.model);
  if (
    models.length > 0 &&
    !models.includes(sample?.request_model) &&
    !models.includes(sample?.effective_local_model)
  ) {
    return false;
  }
  const efforts = normalizeAnalysisStringList(filters.reasoning_effort);
  if (efforts.length > 0 && !efforts.includes(sampleReasoningEffort(sample))) {
    return false;
  }
  if (filters.include_retries === false && Number(sample?.internal_retry_attempt_index || 0) > 0) {
    return false;
  }
  if (filters.include_blocked === false && sample?.blocked_by_gateway) {
    return false;
  }
  const status = normalizeNonEmptyString(filters.status) || "any";
  if (status !== "any") {
    if (status === "blocked" && !sample?.blocked_by_gateway) {
      return false;
    }
    if (status === "success" && Number(sample?.client_http_status || 0) >= 400) {
      return false;
    }
    if (status === "upstream_failed" && sample?.final_action !== "upstream_fetch_failed") {
      return false;
    }
    if (status === "gateway_rejected" && sample?.final_action !== "request_rejected") {
      return false;
    }
  }
  return true;
}

function sampleHasHighTimeNormalizationDeviation(sample, profile) {
  const condition = profile?.conditions?.time_normalization_deviation || "high";
  if (condition !== "high") {
    return true;
  }
  return Number(sample?.time_normalization_deviation || 0) >= 0.5;
}

function sampleMatchesCandidateProfile(sample, profile) {
  const conditions = profile?.conditions || {};
  const tokens = normalizeNumberList(conditions.reasoning_tokens);
  if (tokens.length > 0 && !tokens.includes(Number(sample?.reasoning_tokens))) {
    return false;
  }
  if (conditions.final_answer_only === true && sample?.final_answer_only !== true) {
    return false;
  }
  const commentaryObserved = Boolean(sample?.commentary_observed ?? sample?.has_commentary);
  if (conditions.commentary_not_observed === true && commentaryObserved) {
    return false;
  }
  return sampleHasHighTimeNormalizationDeviation(sample, profile);
}

function averageForSamples(samples, getter) {
  return roundMetric(averageMetric(samples, getter) ?? 0, 6);
}

function buildAnalysisSamplesPreview(samples) {
  return (Array.isArray(samples) ? samples : []).slice(0, 20).map((sample) => ({
    sample_id: sample.sample_id || null,
    ts: sample.ts || null,
    request_model: sample.request_model || sample.effective_local_model || sample.model || null,
    model_family: sampleModelFamily(sample) || null,
    reasoning_effort: sampleReasoningEffort(sample) || null,
    reasoning_tokens: Number.isFinite(Number(sample.reasoning_tokens))
      ? Number(sample.reasoning_tokens)
      : null,
    output_tokens: Number.isFinite(Number(sample.output_tokens)) ? Number(sample.output_tokens) : null,
    total_tokens: Number.isFinite(Number(sample.total_tokens)) ? Number(sample.total_tokens) : null,
    duration_total_ms: Number.isFinite(Number(sample.duration_total_ms))
      ? Number(sample.duration_total_ms)
      : null,
    output_tps: Number.isFinite(Number(sample.output_tps)) ? Number(sample.output_tps) : null,
    time_normalization_deviation: Number.isFinite(Number(sample.time_normalization_deviation))
      ? Number(sample.time_normalization_deviation)
      : null,
    final_answer_only: Boolean(sample.final_answer_only),
    commentary_observed: Boolean(sample.commentary_observed ?? sample.has_commentary),
    final_action: sample.final_action || null,
    client_http_status: Number.isFinite(Number(sample.client_http_status))
      ? Number(sample.client_http_status)
      : null,
    matched_current_rule: Boolean(sample.matched_current_rule),
    blocked_by_gateway: Boolean(sample.blocked_by_gateway),
    internal_retry_attempt_index: Number.isFinite(Number(sample.internal_retry_attempt_index))
      ? Number(sample.internal_retry_attempt_index)
      : null,
  }));
}

function buildFeatureAnalysisFromSamples(samples, profile) {
  const allSamples = (Array.isArray(samples) ? samples : []).map(clonePlainSample);
  const filteredSamples = allSamples.filter((sample) =>
    sampleMatchesReasoningAnalysisFilters(sample, profile),
  );
  const fieldCoverage = calculateFieldCoverage(filteredSamples);
  const valueDecision = decideReasoningAnalysisValue(fieldCoverage, filteredSamples.length);
  const baseResult = {
    ok: true,
    analysis_profile: profile?.name || REASONING_ANALYSIS_PROFILE_NAME,
    analysis_profile_detail: profile,
    analysis_value: valueDecision.analysis_value,
    conclusion:
      valueDecision.analysis_value === "no_analysis_value"
        ? "no_analysis_value"
        : valueDecision.analysis_value === "partial"
          ? "insufficient_fields"
          : "not_observed",
    field_coverage: fieldCoverage,
    missing_core_fields: valueDecision.missing_core_fields,
    decision_reason: valueDecision.decision_reason,
    sample_count: filteredSamples.length,
    candidate_summary: {
      candidate_count: 0,
      candidate_ratio: 0,
      reasoning_516_count: filteredSamples.filter((sample) => Number(sample.reasoning_tokens) === 516).length,
      commentary_not_observed_count: filteredSamples.filter(
        (sample) => !(sample.commentary_observed ?? sample.has_commentary),
      ).length,
      high_time_normalization_deviation_count: filteredSamples.filter((sample) =>
        sampleHasHighTimeNormalizationDeviation(sample, profile),
      ).length,
      last_seen_at: null,
    },
    baseline_comparison: {
      baseline_count: 0,
      candidate_avg_time_normalization_deviation: 0,
      baseline_avg_time_normalization_deviation: 0,
      candidate_final_answer_only_ratio: 0,
      baseline_final_answer_only_ratio: 0,
      candidate_commentary_not_observed_ratio: 0,
      baseline_commentary_not_observed_ratio: 0,
    },
    samples_preview: buildAnalysisSamplesPreview(filteredSamples),
  };
  if (valueDecision.analysis_value !== "valuable") {
    return baseResult;
  }

  const candidateSamples = filteredSamples.filter((sample) =>
    sampleMatchesCandidateProfile(sample, profile),
  );
  const candidateIds = new Set(candidateSamples.map((sample) => sample.sample_id || sample.attempt_id));
  const baselineSamples = filteredSamples.filter(
    (sample) => !candidateIds.has(sample.sample_id || sample.attempt_id),
  );
  const candidateCount = candidateSamples.length;
  const baselineCount = baselineSamples.length;
  const candidateRatio =
    filteredSamples.length === 0 ? 0 : roundMetric(candidateCount / filteredSamples.length, 6);
  const baselineFinalOnlyRatio =
    baselineCount === 0
      ? 0
      : roundMetric(
          baselineSamples.filter((sample) => sample.final_answer_only).length / baselineCount,
          6,
        );
  const baselineCommentaryNotObservedRatio =
    baselineCount === 0
      ? 0
      : roundMetric(
          baselineSamples.filter((sample) => !(sample.commentary_observed ?? sample.has_commentary))
            .length / baselineCount,
          6,
        );
  let conclusion = "not_observed";
  if (candidateCount > 0) {
    if (
      baselineCount > 0 &&
      baselineFinalOnlyRatio >= 0.5 &&
      baselineCommentaryNotObservedRatio >= 0.5
    ) {
      conclusion = "high_false_positive_risk";
    } else if (candidateCount >= 3) {
      conclusion = "strong_candidate";
    } else {
      conclusion = "candidate";
    }
  }
  return {
    ...baseResult,
    conclusion,
    candidate_summary: {
      candidate_count: candidateCount,
      candidate_ratio: candidateRatio,
      reasoning_516_count: candidateSamples.filter((sample) => Number(sample.reasoning_tokens) === 516)
        .length,
      final_answer_only_count: candidateSamples.filter((sample) => sample.final_answer_only).length,
      commentary_not_observed_count: candidateSamples.filter(
        (sample) => !(sample.commentary_observed ?? sample.has_commentary),
      ).length,
      high_time_normalization_deviation_count: candidateSamples.filter((sample) =>
        sampleHasHighTimeNormalizationDeviation(sample, profile),
      ).length,
      last_seen_at:
        candidateSamples
          .map((sample) => sample.ts)
          .filter(Boolean)
          .sort()
          .slice(-1)[0] || null,
    },
    baseline_comparison: {
      baseline_count: baselineCount,
      candidate_avg_time_normalization_deviation: averageForSamples(
        candidateSamples,
        (sample) => sample.time_normalization_deviation,
      ),
      baseline_avg_time_normalization_deviation: averageForSamples(
        baselineSamples,
        (sample) => sample.time_normalization_deviation,
      ),
      candidate_final_answer_only_ratio:
        candidateCount === 0
          ? 0
          : roundMetric(
              candidateSamples.filter((sample) => sample.final_answer_only).length / candidateCount,
              6,
            ),
      baseline_final_answer_only_ratio: baselineFinalOnlyRatio,
      candidate_commentary_not_observed_ratio:
        candidateCount === 0
          ? 0
          : roundMetric(
              candidateSamples.filter((sample) => !(sample.commentary_observed ?? sample.has_commentary))
                .length / candidateCount,
              6,
            ),
      baseline_commentary_not_observed_ratio: baselineCommentaryNotObservedRatio,
    },
    samples_preview: buildAnalysisSamplesPreview(
      candidateSamples.length > 0 ? candidateSamples : filteredSamples,
    ),
  };
}

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
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

function normalizeOptionalPath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? path.resolve(text) : null;
}

function buildHistoricalImportSources(payload = {}) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const requested = payload?.source_paths || {};
  const hasRequestedSources = Object.keys(requested).length > 0;
  const sources = [];
  const pushSource = (sourceType, sourcePath) => {
    if (!sourcePath) {
      return;
    }
    sources.push({
      source_type: sourceType,
      path: sourcePath,
      status: fs.existsSync(sourcePath) ? "pending" : "missing",
    });
  };
  pushSource(
    "cc_switch_sqlite",
    normalizeOptionalPath(requested.cc_switch_db) ||
      (!hasRequestedSources && home ? path.join(home, ".cc-switch", "cc-switch.db") : null),
  );
  pushSource(
    "codex_logs_sqlite",
    normalizeOptionalPath(requested.codex_logs_db) ||
      (!hasRequestedSources && home ? path.join(home, ".codex", "sqlite", "logs_2.sqlite") : null),
  );
  pushSource(
    "codex_logs_sqlite",
    normalizeOptionalPath(requested.codex_logs_db_alt) ||
      (!hasRequestedSources && home ? path.join(home, ".codex", "logs_2.sqlite") : null),
  );
  pushSource(
    "codex_sessions_jsonl",
    normalizeOptionalPath(requested.codex_sessions_root) ||
      (!hasRequestedSources && home ? path.join(home, ".codex", "sessions") : null),
  );
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.source_type}|${source.path}`.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function sqliteJsonRows(databasePath, sql) {
  const stdout = await execFileText("sqlite3", ["-json", databasePath, sql], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

async function sqliteJsonRowsSafe(databasePath, sql) {
  try {
    return await sqliteJsonRows(databasePath, sql);
  } catch {
    return [];
  }
}

async function sqliteTableColumns(databasePath, tableName) {
  const rows = await sqliteJsonRowsSafe(databasePath, `PRAGMA table_info(${tableName});`);
  return rows.map((row) => normalizeNonEmptyString(row.name)).filter(Boolean);
}

function columnsIncludeAny(columnSet, aliases) {
  return aliases.some((alias) => columnSet.has(alias.toLowerCase()));
}

function buildFieldCoverageFromSqlColumns(columnRows) {
  const totalRows = columnRows.reduce((sum, row) => sum + Number(row.row_count || 0), 0);
  const coveredRows = Object.fromEntries(REASONING_ANALYSIS_FIELDS.map((field) => [field, 0]));
  const aliases = {
    reasoning_tokens: ["reasoning_tokens", "output_reasoning_tokens"],
    final_answer_only: ["final_answer_only"],
    commentary_observed: ["commentary_observed", "has_commentary"],
    duration_total_ms: ["duration_total_ms", "duration_ms", "latency_ms"],
    output_tokens: ["output_tokens", "completion_tokens", "total_tokens"],
    model_family: ["model_family", "effective_local_model_family", "model", "request_model"],
    reasoning_effort: ["reasoning_effort", "request_reasoning_effort"],
    status: ["status_code", "client_http_status", "upstream_http_status", "final_action"],
    retry_status: ["retry_count", "internal_retry_attempt_index", "internal_retry_remaining"],
    blocked_status: ["blocked_by_gateway"],
  };
  for (const row of columnRows) {
    const rowCount = Number(row.row_count || 0);
    const columnSet = new Set((row.columns || []).map((column) => `${column}`.toLowerCase()));
    for (const field of REASONING_ANALYSIS_FIELDS) {
      if (columnsIncludeAny(columnSet, aliases[field] || [field])) {
        coveredRows[field] += rowCount;
      }
    }
  }
  return Object.fromEntries(
    REASONING_ANALYSIS_FIELDS.map((field) => [
      field,
      totalRows === 0 ? 0 : roundMetric(coveredRows[field] / totalRows, 6),
    ]),
  );
}

function createEmptyHistoricalImportResult(sourceCount = 0) {
  return {
    summary: {
      source_count: sourceCount,
      total_requests: 0,
      successful_requests: 0,
      failed_requests: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      avg_latency_ms: 0,
      codex_log_rows: 0,
      session_file_count: 0,
      session_total_bytes: 0,
    },
    sources: [],
    cc_switch: { by_model: [], by_status: [], by_provider: [], recent_daily: [] },
    codex_logs: { by_level: [], by_target: [], keyword_hits: [] },
    sessions: { file_count: 0, total_bytes: 0, top_files: [] },
    preflight: null,
    feature_analysis: null,
  };
}

async function preflightCcSwitchSource(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: {},
      column_row: { row_count: 0, columns: [] },
    };
  }
  const columns = await sqliteTableColumns(source.path, "proxy_request_logs");
  const summaryRows = await sqliteJsonRowsSafe(
    source.path,
    "SELECT count(*) AS total_requests, " +
      "sum(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS successful_requests, " +
      "sum(CASE WHEN status_code >= 400 OR status_code IS NULL THEN 1 ELSE 0 END) AS failed_requests, " +
      "sum(COALESCE(input_tokens,0)) AS total_input_tokens, " +
      "sum(COALESCE(output_tokens,0)) AS total_output_tokens, " +
      "avg(COALESCE(duration_ms, latency_ms)) AS avg_latency_ms " +
      "FROM proxy_request_logs;",
  );
  const summary = summaryRows[0] || {};
  const rowCount = Number(summary.total_requests || 0);
  return {
    source: {
      ...source,
      status: "preflight_completed",
      row_count: rowCount,
      columns,
    },
    summary: {
      total_requests: rowCount,
      successful_requests: Number(summary.successful_requests || 0),
      failed_requests: Number(summary.failed_requests || 0),
      total_input_tokens: Number(summary.total_input_tokens || 0),
      total_output_tokens: Number(summary.total_output_tokens || 0),
      avg_latency_ms: roundMetric(Number(summary.avg_latency_ms), 2),
    },
    column_row: { row_count: rowCount, columns },
  };
}

async function preflightCodexLogsSource(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: {},
      keyword_hits: [],
    };
  }
  const columns = await sqliteTableColumns(source.path, "logs");
  const totalRows = await sqliteJsonRowsSafe(source.path, "SELECT count(*) AS row_count FROM logs;");
  const keywordHits = await sqliteJsonRowsSafe(
    source.path,
    "SELECT 'reasoning_tokens' AS keyword, count(*) AS count FROM logs WHERE feedback_log_body LIKE '%reasoning_tokens%' " +
      "UNION ALL SELECT 'final_answer', count(*) FROM logs WHERE feedback_log_body LIKE '%final_answer%' " +
      "UNION ALL SELECT 'commentary', count(*) FROM logs WHERE feedback_log_body LIKE '%commentary%' " +
      "UNION ALL SELECT '502', count(*) FROM logs WHERE feedback_log_body LIKE '%502%';",
  );
  const rowCount = Number(totalRows[0]?.row_count || 0);
  return {
    source: {
      ...source,
      status: "preflight_completed",
      row_count: rowCount,
      columns,
    },
    summary: { codex_log_rows: rowCount },
    keyword_hits: keywordHits,
  };
}

async function preflightSessionSource(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: {},
      sessions: { file_count: 0, total_bytes: 0, top_files: [] },
    };
  }
  const files = await walkSessionFiles(source.path);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const topFiles = [...files]
    .sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0))
    .slice(0, 20);
  return {
    source: {
      ...source,
      status: "preflight_completed",
      row_count: files.length,
    },
    summary: {
      session_file_count: files.length,
      session_total_bytes: totalBytes,
    },
    sessions: {
      file_count: files.length,
      total_bytes: totalBytes,
      scanned_file_limit: HISTORICAL_IMPORT_SESSION_FILE_LIMIT,
      top_files: topFiles,
    },
  };
}

async function buildHistoricalImportPreflight(sources) {
  const result = createEmptyHistoricalImportResult(sources.length);
  const columnRows = [];
  const keywordHits = [];
  for (const source of sources) {
    let part;
    if (source.source_type === "cc_switch_sqlite") {
      part = await preflightCcSwitchSource(source);
      columnRows.push(part.column_row);
    } else if (source.source_type === "codex_logs_sqlite") {
      part = await preflightCodexLogsSource(source);
      keywordHits.push(...(part.keyword_hits || []));
    } else if (source.source_type === "codex_sessions_jsonl") {
      part = await preflightSessionSource(source);
      result.sessions = part.sessions || result.sessions;
    } else {
      part = { source: { ...source, status: "skipped" }, summary: {} };
    }
    result.sources.push(part.source);
    for (const [key, value] of Object.entries(part.summary || {})) {
      if (typeof value === "number") {
        result.summary[key] = roundMetric(Number(result.summary[key] || 0) + value, 2);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  result.codex_logs.keyword_hits = keywordHits;
  const fieldCoverage = buildFieldCoverageFromSqlColumns(columnRows);
  const valueDecision = decideReasoningAnalysisValue(
    fieldCoverage,
    columnRows.reduce((sum, row) => sum + Number(row?.row_count || 0), 0),
  );
  const preflight = {
    analysis_value: valueDecision.analysis_value,
    can_build_reasoning_features: valueDecision.can_build_reasoning_features,
    can_build_candidate_patterns: valueDecision.can_build_candidate_patterns,
    field_coverage: fieldCoverage,
    missing_core_fields: valueDecision.missing_core_fields,
    decision_reason: valueDecision.decision_reason,
    sources: result.sources,
  };
  result.preflight = preflight;
  result.feature_analysis = buildHistoricalFeatureAnalysisFromPreflight(preflight);
  return result;
}

function buildHistoricalFeatureAnalysisFromPreflight(preflight) {
  return {
    ok: true,
    analysis_profile: REASONING_ANALYSIS_PROFILE_NAME,
    analysis_value: preflight?.analysis_value || "no_analysis_value",
    conclusion:
      preflight?.analysis_value === "valuable"
        ? "not_observed"
        : preflight?.analysis_value === "partial"
          ? "insufficient_fields"
          : "no_analysis_value",
    field_coverage: preflight?.field_coverage || {},
    missing_core_fields: preflight?.missing_core_fields || [],
    decision_reason: preflight?.decision_reason || "历史数据缺少 reasoning 行为分析字段。",
    candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
    baseline_comparison: { baseline_count: 0 },
    samples_preview: [],
  };
}

function buildHistoricalFeatureAnalysisFromJob(job, payload = {}) {
  if (!job) {
    return buildHistoricalFeatureAnalysisFromPreflight({
      analysis_value: "no_analysis_value",
      field_coverage: {},
      missing_core_fields: REASONING_ANALYSIS_CORE_FIELDS,
      decision_reason: "没有可分析的历史导入任务。",
    });
  }
  if (job.result?.feature_analysis || job.feature_analysis) {
    return job.result?.feature_analysis || job.feature_analysis;
  }
  const preflight = job.result?.preflight || job.preflight;
  if (!preflight || preflight.analysis_value !== "valuable") {
    return buildHistoricalFeatureAnalysisFromPreflight(preflight);
  }
  const profile = buildReasoningAnalysisProfile(payload, "historical_import");
  return buildFeatureAnalysisFromSamples(job.result?.analysis_samples || [], profile);
}

async function analyzeCcSwitchDatabase(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: { total_requests: 0, successful_requests: 0, failed_requests: 0 },
      cc_switch: { by_model: [], by_status: [], by_provider: [], recent_daily: [] },
    };
  }
  const countRows = await sqliteJsonRows(
    source.path,
    "SELECT count(*) AS total_requests, " +
      "sum(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS successful_requests, " +
      "sum(CASE WHEN status_code >= 400 OR status_code IS NULL THEN 1 ELSE 0 END) AS failed_requests, " +
      "sum(COALESCE(input_tokens,0)) AS total_input_tokens, " +
      "sum(COALESCE(output_tokens,0)) AS total_output_tokens, " +
      "avg(COALESCE(duration_ms, latency_ms)) AS avg_latency_ms " +
      "FROM proxy_request_logs;",
  );
  const byModel = await sqliteJsonRows(
    source.path,
    "SELECT COALESCE(NULLIF(model,''), NULLIF(request_model,''), 'unknown') AS model, " +
      "count(*) AS count, " +
      "sum(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_count, " +
      "sum(CASE WHEN status_code >= 400 OR status_code IS NULL THEN 1 ELSE 0 END) AS failure_count, " +
      "sum(COALESCE(input_tokens,0)) AS input_tokens, " +
      "sum(COALESCE(output_tokens,0)) AS output_tokens, " +
      "avg(COALESCE(duration_ms, latency_ms)) AS avg_duration_ms " +
      "FROM proxy_request_logs GROUP BY model ORDER BY count DESC LIMIT 20;",
  );
  const byStatus = await sqliteJsonRows(
    source.path,
    "SELECT COALESCE(status_code, -1) AS status_code, count(*) AS count " +
      "FROM proxy_request_logs GROUP BY status_code ORDER BY count DESC LIMIT 20;",
  );
  const byProvider = await sqliteJsonRows(
    source.path,
    "SELECT COALESCE(NULLIF(provider_id,''), NULLIF(provider_type,''), 'unknown') AS provider, " +
      "count(*) AS count, avg(COALESCE(duration_ms, latency_ms)) AS avg_duration_ms " +
      "FROM proxy_request_logs GROUP BY provider ORDER BY count DESC LIMIT 20;",
  );
  const recentDaily = await sqliteJsonRows(
    source.path,
    "SELECT substr(created_at, 1, 10) AS date, count(*) AS count, " +
      "sum(COALESCE(input_tokens,0)) AS input_tokens, sum(COALESCE(output_tokens,0)) AS output_tokens, " +
      "avg(COALESCE(duration_ms, latency_ms)) AS avg_duration_ms " +
      "FROM proxy_request_logs WHERE created_at IS NOT NULL GROUP BY date ORDER BY date DESC LIMIT 31;",
  );
  const summary = countRows[0] || {};
  return {
    source: {
      ...source,
      status: "completed",
      row_count: Number(summary.total_requests || 0),
    },
    summary: {
      total_requests: Number(summary.total_requests || 0),
      successful_requests: Number(summary.successful_requests || 0),
      failed_requests: Number(summary.failed_requests || 0),
      total_input_tokens: Number(summary.total_input_tokens || 0),
      total_output_tokens: Number(summary.total_output_tokens || 0),
      avg_latency_ms: roundMetric(Number(summary.avg_latency_ms), 2),
    },
    cc_switch: {
      by_model: byModel,
      by_status: byStatus,
      by_provider: byProvider,
      recent_daily: recentDaily,
    },
  };
}

async function analyzeCodexLogsDatabase(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: { codex_log_rows: 0 },
      codex_logs: { by_level: [], by_target: [], keyword_hits: [] },
    };
  }
  const totalRows = await sqliteJsonRows(source.path, "SELECT count(*) AS row_count FROM logs;");
  const byLevel = await sqliteJsonRows(
    source.path,
    "SELECT COALESCE(NULLIF(level,''), 'unknown') AS level, count(*) AS count " +
      "FROM logs GROUP BY level ORDER BY count DESC LIMIT 20;",
  );
  const byTarget = await sqliteJsonRows(
    source.path,
    "SELECT COALESCE(NULLIF(target,''), 'unknown') AS target, count(*) AS count " +
      "FROM logs GROUP BY target ORDER BY count DESC LIMIT 20;",
  );
  const keywordRows = await sqliteJsonRows(
    source.path,
    "SELECT 'reasoning_tokens' AS keyword, count(*) AS count FROM logs WHERE feedback_log_body LIKE '%reasoning_tokens%' " +
      "UNION ALL SELECT 'final_answer', count(*) FROM logs WHERE feedback_log_body LIKE '%final_answer%' " +
      "UNION ALL SELECT 'commentary', count(*) FROM logs WHERE feedback_log_body LIKE '%commentary%' " +
      "UNION ALL SELECT '502', count(*) FROM logs WHERE feedback_log_body LIKE '%502%';",
  );
  const rowCount = Number(totalRows[0]?.row_count || 0);
  return {
    source: {
      ...source,
      status: "completed",
      row_count: rowCount,
    },
    summary: {
      codex_log_rows: rowCount,
    },
    codex_logs: {
      by_level: byLevel,
      by_target: byTarget,
      keyword_hits: keywordRows,
    },
  };
}

async function walkSessionFiles(rootPath, limit = HISTORICAL_IMPORT_SESSION_FILE_LIMIT) {
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(entryPath);
        files.push({
          path: entryPath,
          bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
        });
      } catch {
        // 文件可能在扫描时被移动，忽略即可。
      }
      if (files.length >= limit) {
        break;
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return files;
}

async function analyzeCodexSessionFiles(source) {
  if (!fs.existsSync(source.path)) {
    return {
      source: { ...source, status: "missing" },
      summary: { session_file_count: 0, session_total_bytes: 0 },
      sessions: { file_count: 0, total_bytes: 0, top_files: [] },
    };
  }
  const files = await walkSessionFiles(source.path);
  const totalBytes = files.reduce((sum, file) => sum + Number(file.bytes || 0), 0);
  const topFiles = [...files]
    .sort((left, right) => Number(right.bytes || 0) - Number(left.bytes || 0))
    .slice(0, 20);
  return {
    source: {
      ...source,
      status: "completed",
      row_count: files.length,
    },
    summary: {
      session_file_count: files.length,
      session_total_bytes: totalBytes,
    },
    sessions: {
      file_count: files.length,
      total_bytes: totalBytes,
      scanned_file_limit: HISTORICAL_IMPORT_SESSION_FILE_LIMIT,
      top_files: topFiles,
    },
  };
}

function mergeHistoricalImportResult(base, part) {
  base.sources.push(part.source);
  for (const [key, value] of Object.entries(part.summary || {})) {
    if (typeof value === "number") {
      base.summary[key] = roundMetric(Number(base.summary[key] || 0) + value, 2);
    }
  }
  if (part.cc_switch) {
    base.cc_switch = part.cc_switch;
  }
  if (part.codex_logs) {
    if (!base.codex_logs) {
      base.codex_logs = part.codex_logs;
    } else {
      base.codex_logs.by_level.push(...(part.codex_logs.by_level || []));
      base.codex_logs.by_target.push(...(part.codex_logs.by_target || []));
      base.codex_logs.keyword_hits.push(...(part.codex_logs.keyword_hits || []));
    }
  }
  if (part.sessions) {
    base.sessions = part.sessions;
  }
}

function buildHistoricalImportJobPublic(job) {
  if (!job) {
    return null;
  }
  return {
    job_id: job.job_id,
    status: job.status,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error_message: job.error_message,
    output_path: job.output_path,
    progress: {
      total_sources: job.total_sources,
      processed_sources: job.processed_sources,
      percent:
        job.total_sources > 0
          ? roundMetric(Math.min(1, job.processed_sources / job.total_sources), 4)
          : 0,
      current_step: job.current_step,
    },
    summary: job.result?.summary || job.summary || null,
    preflight: job.result?.preflight || job.preflight || null,
    feature_analysis: job.result?.feature_analysis || job.feature_analysis || null,
    sources: job.result?.sources || [],
    cc_switch: job.result?.cc_switch || { by_model: [], by_status: [], by_provider: [], recent_daily: [] },
    codex_logs: job.result?.codex_logs || { by_level: [], by_target: [], keyword_hits: [] },
    sessions: job.result?.sessions || { file_count: 0, total_bytes: 0, top_files: [] },
  };
}

function nextHistoricalImportJobId(state) {
  const sequence = state.next_job_sequence;
  state.next_job_sequence += 1;
  return `historical_import_${Date.now()}_${sequence}`;
}

function trimHistoricalImportJobs(state) {
  const jobs = [...state.jobs.values()].sort((left, right) =>
    `${right.created_at || ""}`.localeCompare(`${left.created_at || ""}`),
  );
  for (const job of jobs.slice(HISTORICAL_IMPORT_JOB_LIMIT)) {
    if (job.status === "running" || job.status === "queued") {
      continue;
    }
    state.jobs.delete(job.job_id);
  }
}

async function writeHistoricalImportSummary(runtime, job) {
  const outputRoot = path.join(runtime.paths.analyticsRoot, "imports", job.job_id);
  await mkdir(outputRoot, { recursive: true });
  const outputPath = path.join(outputRoot, "summary.json");
  const payload = {
    ok: true,
    generated_at: new Date().toISOString(),
    import_job: buildHistoricalImportJobPublic(job),
  };
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return outputPath;
}

async function runHistoricalImportJob(runtime, job) {
  job.status = "running";
  job.started_at = new Date().toISOString();
  try {
    job.current_step = "preflight";
    const preflightResult = await buildHistoricalImportPreflight(job.sources);
    job.preflight = preflightResult.preflight;
    job.feature_analysis = preflightResult.feature_analysis;
    job.processed_sources = job.sources.length;
    if (job.preflight?.analysis_value === "no_analysis_value") {
      job.current_step = "no_analysis_value";
      job.result = preflightResult;
      job.summary = preflightResult.summary;
      job.output_path = await writeHistoricalImportSummary(runtime, job);
      job.status = "completed";
      job.finished_at = new Date().toISOString();
      runtime.historicalImports.last_summary = buildHistoricalImportJobPublic(job);
      return;
    }

    const result = {
      ...createEmptyHistoricalImportResult(job.sources.length),
      preflight: job.preflight,
      feature_analysis: job.feature_analysis,
    };
    job.processed_sources = 0;
    for (const source of job.sources) {
      job.current_step = source.source_type;
      let part;
      if (source.source_type === "cc_switch_sqlite") {
        part = await analyzeCcSwitchDatabase(source);
      } else if (source.source_type === "codex_logs_sqlite") {
        part = await analyzeCodexLogsDatabase(source);
      } else if (source.source_type === "codex_sessions_jsonl") {
        part = await analyzeCodexSessionFiles(source);
      } else {
        part = { source: { ...source, status: "skipped" }, summary: {} };
      }
      mergeHistoricalImportResult(result, part);
      job.processed_sources += 1;
      job.result = result;
      await new Promise((resolve) => setImmediate(resolve));
    }
    result.preflight = job.preflight;
    result.feature_analysis = buildHistoricalFeatureAnalysisFromJob(
      { ...job, result },
      { filters: {}, conditions: {} },
    );
    job.current_step = "completed";
    job.result = result;
    job.summary = result.summary;
    job.feature_analysis = result.feature_analysis;
    job.output_path = await writeHistoricalImportSummary(runtime, job);
    job.status = "completed";
    job.finished_at = new Date().toISOString();
    runtime.historicalImports.last_summary = buildHistoricalImportJobPublic(job);
  } catch (error) {
    job.status = "failed";
    job.error_message = `${error?.message || error}`;
    job.finished_at = new Date().toISOString();
    runtime.logger(
      `[analytics-error] historical import failed job=${job.job_id} message=${job.error_message}`,
    );
  }
}

function startHistoricalImportJob(runtime, payload = {}) {
  const sources = buildHistoricalImportSources(payload);
  const job = {
    job_id: nextHistoricalImportJobId(runtime.historicalImports),
    status: "queued",
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    error_message: null,
    output_path: null,
    sources,
    total_sources: sources.length,
    processed_sources: 0,
    current_step: "queued",
    summary: null,
    result: null,
  };
  runtime.historicalImports.jobs.set(job.job_id, job);
  trimHistoricalImportJobs(runtime.historicalImports);
  setImmediate(() => {
    runHistoricalImportJob(runtime, job);
  });
  return job;
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
    if (monitor.log_entries.length > LOG_ENTRY_LIMIT) {
      monitor.log_entries.splice(0, monitor.log_entries.length - LOG_ENTRY_LIMIT);
    }
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

function buildReasoningBehaviorRuntimeSnapshot(runtime) {
  return {
    ...buildReasoningBehaviorMetadata(runtime),
    ...buildReasoningBehaviorSnapshotFromSamples(
    runtime?.reasoningBehavior?.recent_samples || [],
    {
      recent_limit: 50,
    },
    ),
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
  config.request_body_limit_bytes = normalizeRequestBodyLimitBytes(
    loaded.request_body_limit_bytes,
    DEFAULT_CONFIG.request_body_limit_bytes,
  );
  config.endpoints = normalizeStringList(config.endpoints, DEFAULT_CONFIG.endpoints).map(normalizePath);
  config.reasoning_equals = normalizeIntegerList(
    config.reasoning_equals,
    DEFAULT_CONFIG.reasoning_equals,
  );
  config.intercept_rule_mode = normalizeInterceptRuleMode(config.intercept_rule_mode);
  config.intercept_streaming = config.intercept_streaming !== false;
  config.intercept_non_streaming = config.intercept_non_streaming !== false;
  config.guard_retry_attempts = normalizeGuardRetryAttempts(config.guard_retry_attempts);
  config.retry_upstream_capacity_errors = config.retry_upstream_capacity_errors !== false;
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
  const stateRoot =
    path.basename(configDirectory).toLowerCase() === "config"
      ? path.dirname(configDirectory)
      : configDirectory;
  return {
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    pidPath: path.join(stateRoot, "gateway.pid"),
    analyticsRoot: path.join(stateRoot, "analytics"),
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
  const nextInterceptRuleMode =
    payload.intercept_rule_mode === undefined
      ? normalizeInterceptRuleMode(currentConfig.intercept_rule_mode)
      : normalizeInterceptRuleMode(payload.intercept_rule_mode);
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
  const nextRetryUpstreamCapacityErrors =
    payload.retry_upstream_capacity_errors === undefined
      ? currentConfig.retry_upstream_capacity_errors !== false
      : Boolean(payload.retry_upstream_capacity_errors);
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
    intercept_rule_mode: nextInterceptRuleMode,
    reasoning_equals: nextReasoning,
    endpoints: nextEndpoints,
    intercept_streaming: nextInterceptStreaming,
    intercept_non_streaming: nextInterceptNonStreaming,
    non_stream_status_code: nextStatusCode,
    guard_retry_attempts: nextGuardRetryAttempts,
    retry_upstream_capacity_errors: nextRetryUpstreamCapacityErrors,
    log_match: payload.log_match === undefined ? currentConfig.log_match : Boolean(payload.log_match),
    active_probe: nextActiveProbe,
  };
}

function buildManagementHtml() {
  const uiConfig = {
    statusPath: STATUS_API_PATH,
    reasoningBehaviorPath: REASONING_BEHAVIOR_API_PATH,
    reasoningBehaviorExportPath: REASONING_BEHAVIOR_EXPORT_API_PATH,
    reasoningBackgroundExportMinDays: REASONING_BEHAVIOR_BACKGROUND_EXPORT_MIN_DAYS,
    historicalImportPath: HISTORICAL_IMPORT_API_PATH,
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

      html {
        scroll-behavior: smooth;
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

      section[id] {
        scroll-margin-top: 20px;
      }

      .side-nav {
        position: fixed;
        z-index: 18;
        top: 28px;
        left: max(16px, calc((100vw - 1080px) / 2 - 148px));
        width: 128px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 22px;
        background:
          linear-gradient(180deg, rgba(255, 251, 245, 0.9), rgba(245, 239, 228, 0.72)),
          repeating-linear-gradient(135deg, rgba(31, 29, 26, 0.04) 0, rgba(31, 29, 26, 0.04) 1px, transparent 1px, transparent 14px);
        box-shadow: var(--shadow);
        backdrop-filter: blur(16px);
      }

      .side-nav-title {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 900;
        letter-spacing: 0.08em;
        text-align: center;
      }

      .side-nav-list {
        display: grid;
        gap: 8px;
      }

      .side-nav a {
        display: block;
        padding: 8px 9px;
        border-radius: 13px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 800;
        line-height: 1.25;
        text-decoration: none;
        text-align: center;
        border: 1px solid transparent;
      }

      .side-nav a:hover,
      .side-nav a:focus-visible {
        color: var(--accent);
        border-color: rgba(31, 111, 95, 0.2);
        background: rgba(31, 111, 95, 0.1);
        outline: none;
      }

      @media (max-width: 1339px) {
        .side-nav {
          position: static;
          width: auto;
          max-width: 1080px;
          margin: 0 auto;
          padding: 10px 18px;
          border-width: 0 0 1px;
          border-radius: 0 0 20px 20px;
          display: flex;
          align-items: center;
          gap: 10px;
          overflow-x: auto;
        }

        .side-nav-title {
          flex: 0 0 auto;
          margin: 0;
        }

        .side-nav-list {
          display: flex;
          gap: 8px;
          min-width: max-content;
        }
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

      .rule-mode-field {
        gap: 6px;
      }

      .rule-mode-toggle {
        min-height: 34px;
        padding: 7px 10px;
        border-radius: 12px;
        gap: 8px;
      }

      .rule-mode-toggle input[type="radio"] {
        width: 16px;
        height: 16px;
        margin: 0;
        padding: 0;
        flex: 0 0 auto;
      }

      .rule-mode-toggle label {
        font-size: 12px;
        line-height: 1.25;
        font-weight: 700;
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

      .range-bar {
        display: grid;
        grid-template-columns: repeat(2, minmax(150px, 1fr)) auto auto auto;
        gap: 10px;
        align-items: end;
        margin-bottom: 16px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(31, 111, 95, 0.16);
        background:
          linear-gradient(135deg, rgba(31, 111, 95, 0.11), rgba(255, 255, 255, 0.68)),
          repeating-linear-gradient(90deg, rgba(31, 111, 95, 0.06) 0, rgba(31, 111, 95, 0.06) 1px, transparent 1px, transparent 14px);
      }

      .range-bar .field {
        gap: 6px;
      }

      .range-bar button {
        min-height: 43px;
        padding: 10px 14px;
        border-radius: 14px;
      }

      .reasoning-range-toolbar {
        grid-template-columns: minmax(150px, 1fr) minmax(150px, 1fr) repeat(5, auto);
        gap: 8px;
        align-items: end;
        margin-bottom: 14px;
        padding: 12px;
        font-size: 12px;
      }

      .reasoning-range-toolbar .field {
        gap: 4px;
      }

      .reasoning-range-toolbar .field label {
        font-size: 12px;
      }

      .reasoning-range-toolbar :is(input, button) {
        min-height: 36px;
        padding: 7px 12px;
        border-radius: 13px;
        font-size: 12px;
      }

      .range-chip {
        display: inline-flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        width: fit-content;
        max-width: 100%;
        min-height: 34px;
        margin: 0 0 14px;
        padding: 6px 12px;
        border-radius: 999px;
        background: rgba(31, 111, 95, 0.1);
        color: var(--accent);
        font-size: 12px;
        font-weight: 800;
      }

      .range-status-chip {
        color: var(--muted);
        background: rgba(148, 163, 184, 0.12);
        border: 1px solid rgba(148, 163, 184, 0.2);
        box-shadow: none;
      }

      .range-chip-rail {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 14px 0;
      }

      .range-chip-rail .range-chip {
        margin: 0;
      }

      .range-chip-rail #reasoningExportProgress {
        width: min(100%, 440px);
      }

      .historical-import-control-stack {
        display: grid;
        justify-items: start;
        gap: 12px;
        margin-bottom: 16px;
      }

      .historical-import-status {
        min-width: min(100%, 520px);
        min-height: 46px;
        justify-content: center;
        padding: 10px 18px;
        line-height: 1.5;
        text-align: center;
      }

      .historical-import-status-text {
        display: block;
        width: 100%;
      }

      .historical-import-status[data-progress-active="false"] .bar-row {
        display: none;
      }

      .bar-row {
        display: block;
        width: min(420px, 70vw);
        min-height: 8px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(31, 29, 26, 0.1);
      }

      .bar-row span {
        display: block;
        min-height: 8px;
        border-radius: inherit;
        background: linear-gradient(90deg, #1f6f5f, #8ccfb7);
      }

      .chart-grid {
        display: grid;
        gap: 14px;
        margin: 16px 0;
      }

      @media (min-width: 760px) {
        .chart-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      .signal-chart {
        display: grid;
        gap: 10px;
        min-height: 142px;
        padding: 14px;
        border-radius: 18px;
        border: 1px solid rgba(31, 29, 26, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 253, 248, 0.92), rgba(247, 242, 233, 0.86)),
          repeating-linear-gradient(0deg, transparent 0, transparent 23px, rgba(31, 111, 95, 0.05) 24px);
      }

      .signal-bar {
        display: grid;
        grid-template-columns: minmax(92px, 0.36fr) minmax(120px, 1fr) auto;
        gap: 10px;
        align-items: center;
        font-size: 12px;
      }

      .signal-bar-track {
        min-height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(31, 29, 26, 0.08);
      }

      .signal-bar-fill {
        display: block;
        min-height: 10px;
        border-radius: inherit;
        background: linear-gradient(90deg, #1f6f5f, #8ccfb7);
      }

      .reasoning-subtitle {
        margin: 18px 0 10px;
        font-size: 14px;
        color: var(--muted);
      }

      .table-wrap {
        overflow-x: auto;
        border-radius: 18px;
        border: 1px solid rgba(31, 29, 26, 0.08);
        background: var(--panel-strong);
      }

      .coverage-table-wrap {
        width: 100%;
        max-width: none;
        margin: 0;
        overflow-x: hidden;
      }

      .coverage-table-wrap table {
        width: 100%;
        min-width: 0;
        table-layout: fixed;
      }

      .coverage-table-wrap :is(th, td) {
        text-align: center;
        vertical-align: middle;
      }

      .scroll-table-wrap {
        max-height: 380px;
        overflow: auto;
      }

      .scroll-table-wrap table {
        width: max-content;
        min-width: 100%;
      }

      .scroll-table-wrap :is(th, td) {
        white-space: nowrap;
      }

      .table-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 18px 0 10px;
      }

      .table-toolbar .reasoning-subtitle {
        margin: 0;
      }

      .compact-select {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 800;
        white-space: nowrap;
      }

      .compact-select select {
        min-height: 34px;
        padding: 6px 10px;
        border-radius: 10px;
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

      html[data-theme="dark"] {
        color-scheme: dark;
        --bg: #06111d;
        --panel: #132236;
        --panel-strong: #17283d;
        --ink: #f4f8ff;
        --muted: #94a3b8;
        --accent: #20e6c3;
        --accent-soft: rgba(32, 230, 195, 0.12);
        --warn: #fb7185;
        --line: rgba(148, 163, 184, 0.18);
        --shadow: none;
      }

      html[data-theme="dark"] body {
        background: #06111d;
      }

      html[data-theme="dark"] .hero,
      html[data-theme="dark"] .card {
        background: var(--panel);
        border-color: var(--line);
        box-shadow: none;
        backdrop-filter: none;
      }

      html[data-theme="dark"] .hero {
        background: #132236;
      }

      html[data-theme="dark"] .stat,
      html[data-theme="dark"] .inline-toggle,
      html[data-theme="dark"] .checkbox-chip,
      html[data-theme="dark"] .range-bar,
      html[data-theme="dark"] .signal-chart,
      html[data-theme="dark"] .table-wrap {
        background: var(--panel-strong);
        border-color: rgba(148, 163, 184, 0.16);
      }

      html[data-theme="dark"] .eyebrow,
      html[data-theme="dark"] .tg-link {
        color: var(--accent);
        background: rgba(32, 230, 195, 0.08);
        border-color: rgba(32, 230, 195, 0.2);
      }

      html[data-theme="dark"] input,
      html[data-theme="dark"] textarea,
      html[data-theme="dark"] select {
        color: var(--ink);
        background: #0b1728;
        border-color: rgba(148, 163, 184, 0.22);
      }

      html[data-theme="dark"] input:focus,
      html[data-theme="dark"] textarea:focus {
        outline: 2px solid rgba(32, 230, 195, 0.28);
        border-color: rgba(32, 230, 195, 0.5);
      }

      html[data-theme="dark"] .primary {
        color: #03131f;
        background: var(--accent);
      }

      html[data-theme="dark"] .secondary {
        color: #fecdd3;
        background: rgba(251, 113, 133, 0.12);
        border: 1px solid rgba(251, 113, 133, 0.24);
      }

      html[data-theme="dark"] .range-chip {
        color: var(--accent);
        background: rgba(32, 230, 195, 0.1);
      }

      html[data-theme="dark"] .range-status-chip {
        color: #cbd5e1;
        background: rgba(148, 163, 184, 0.12);
        border-color: rgba(148, 163, 184, 0.22);
      }

      html[data-theme="dark"] .signal-bar-track {
        background: rgba(148, 163, 184, 0.16);
      }

      html[data-theme="dark"] .log-output,
      html[data-theme="dark"] .evidence-log-output {
        background: #06111d;
        border-color: rgba(32, 230, 195, 0.16);
        color: #c7f9ef;
      }

      html[data-theme="dark"] th,
      html[data-theme="dark"] td {
        color: #cbd5e1;
        border-bottom-color: rgba(148, 163, 184, 0.12);
      }

      html[data-theme="dark"] th {
        color: var(--ink);
        background: rgba(148, 163, 184, 0.08);
      }

      html[data-theme="dark"] .risk-note {
        color: #cbd5e1;
        background: #0f1d2f;
        border-color: rgba(148, 163, 184, 0.14);
      }

      html[data-theme="dark"] .side-nav {
        background:
          linear-gradient(180deg, rgba(15, 29, 47, 0.94), rgba(11, 23, 40, 0.88)),
          repeating-linear-gradient(135deg, rgba(148, 163, 184, 0.05) 0, rgba(148, 163, 184, 0.05) 1px, transparent 1px, transparent 14px);
        border-color: rgba(148, 163, 184, 0.14);
        box-shadow: 0 20px 45px rgba(0, 0, 0, 0.26);
      }

      html[data-theme="dark"] .side-nav-title {
        color: #9fb2c8;
      }

      html[data-theme="dark"] .side-nav a {
        color: #9aaabc;
      }

      html[data-theme="dark"] .side-nav a:hover,
      html[data-theme="dark"] .side-nav a:focus-visible {
        color: var(--accent);
        background: rgba(32, 230, 195, 0.08);
        border-color: rgba(32, 230, 195, 0.18);
      }

      html[data-theme="dark"] .message[data-tone="error"] {
        color: #fb7185;
      }

      .theme-toggle {
        position: fixed;
        left: 18px;
        bottom: 18px;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 42px;
        padding: 0 14px;
        border-radius: 12px;
        border: 1px solid rgba(31, 29, 26, 0.12);
        background: rgba(255, 251, 245, 0.94);
        color: var(--ink);
        box-shadow: 0 10px 28px rgba(47, 34, 14, 0.16);
        font-size: 14px;
        font-weight: 800;
      }

      html[data-theme="dark"] .theme-toggle {
        color: #e2e8f0;
        background: #101827;
        border-color: rgba(148, 163, 184, 0.14);
        box-shadow: none;
      }

      .theme-toggle-icon {
        color: #f59e0b;
        font-size: 17px;
        line-height: 1;
      }

      @media (max-width: 720px) {
        .range-bar {
          grid-template-columns: 1fr;
        }

        .theme-toggle {
          left: 12px;
          bottom: 12px;
          min-height: 38px;
          padding: 0 12px;
        }
      }
    </style>
  </head>
  <body>
    <nav class="side-nav" id="sideNav" aria-label="快速导航">
      <p class="side-nav-title">快速导航</p>
      <div class="side-nav-list">
        <a href="#topSection">顶部</a>
        <a href="#statusSection">运行状态</a>
        <a href="#rulesSection">拦截规则</a>
        <a href="#reasoningBehaviorSection">行为统计</a>
        <a href="#historicalImportSection">历史导入</a>
        <a href="#modelSection">被动探针</a>
        <a href="#probeSection">主动探针</a>
        <a href="#logsSection">实时日志</a>
      </div>
    </nav>
    <div class="shell">
      <section class="hero" id="topSection">
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
        <section class="card" id="statusSection">
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

        <section class="card" id="rulesSection">
          <div class="card-inner">
            <h2>拦截规则</h2>
            <form id="configForm">
              <div class="field rule-mode-field">
                <label>拦截规则模式</label>
                <div class="inline-toggle rule-mode-toggle">
                  <input id="interceptRuleModeReasoningTokensInput" name="intercept_rule_mode" type="radio" value="reasoning_tokens" />
                  <label for="interceptRuleModeReasoningTokensInput">reasoning_tokens 长度</label>
                </div>
                <div class="inline-toggle rule-mode-toggle">
                  <input id="interceptRuleModeFinalOnlyInput" name="intercept_rule_mode" type="radio" value="final_answer_only_high_xhigh" />
                  <label for="interceptRuleModeFinalOnlyInput">final answer only</label>
                </div>
                <div class="hint">二选一；final answer only 仅 high / xhigh 模式使用，不满足 high / xhigh 时只观察不拦截。</div>
              </div>

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
                <div class="hint">命中拦截规则、或开启下方 capacity 选项后命中上游 capacity 错误时生效；0 表示不做网关内重试。</div>
              </div>

              <div class="inline-toggle">
                <input id="retryUpstreamCapacityErrorsInput" name="retry_upstream_capacity_errors" type="checkbox" />
                <label for="retryUpstreamCapacityErrorsInput">上游 capacity 错误内重试</label>
              </div>
              <div class="hint">仅匹配 “Selected model is at capacity. Please try a different model.”，普通 429 / 502 仍按原样透传。</div>

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
        <section class="card wide-card" id="logsSection">
          <div class="card-inner">
            <h2>实时日志</h2>
            <p class="live-meta" id="logsMeta">正在读取日志...</p>
            <pre class="log-output" id="logsOutput">正在读取日志...</pre>
          </div>
        </section>

        <section class="card wide-card" id="reasoningBehaviorSection">
          <div class="card-inner">
            <h2>reasoning 行为统计</h2>
            <p class="risk-note" id="reasoningExportMeta">
              统计结果只表示可观测结构信号，用于发现候选异常特征，不代表最终归因，也不证明模型内部没有思考。final answer only / commentary observed 不是互补关系，剩余样本可能是 tool call、reasoning item 或普通 output 组合。516 会被单独观察，但不会在这里被写死为异常结论。
            </p>
            <div class="range-bar reasoning-range-toolbar">
              <div class="field">
                <label for="reasoningDateFromInput">开始日期</label>
                <input id="reasoningDateFromInput" type="date" />
              </div>
              <div class="field">
                <label for="reasoningDateToInput">结束日期</label>
                <input id="reasoningDateToInput" type="date" />
              </div>
              <button class="secondary" id="reasoningRangeTodayButton" type="button">今天</button>
              <button class="secondary" id="reasoningRangeWeekButton" type="button">近 7 天</button>
              <button class="primary" id="reasoningRangeApplyButton" type="button">应用时间段</button>
              <button class="secondary" id="reasoningExportJsonButton" type="button">导出 JSON</button>
              <button class="secondary" id="reasoningExportCsvButton" type="button">导出 CSV</button>
            </div>
            <p class="reasoning-subtitle">特征分析条件</p>
            <div class="range-bar">
              <div class="field">
                <label for="reasoningAnalysisModelFamilyInput">模型家族</label>
                <input id="reasoningAnalysisModelFamilyInput" type="text" value="gpt-5.4,gpt-5.5" />
              </div>
              <div class="field">
                <label for="reasoningAnalysisEffortInput">reasoning.effort</label>
                <input id="reasoningAnalysisEffortInput" type="text" value="low,medium,high,xhigh" />
              </div>
              <div class="field">
                <label for="reasoningAnalysisTokenInput">reasoning_tokens</label>
                <input id="reasoningAnalysisTokenInput" type="text" value="516" />
              </div>
              <div class="field">
                <label for="reasoningAnalysisFinalOnlySelect">final answer only</label>
                <select id="reasoningAnalysisFinalOnlySelect">
                  <option value="true" selected>是</option>
                  <option value="false">否</option>
                  <option value="any">任意</option>
                </select>
              </div>
              <div class="field">
                <label for="reasoningAnalysisCommentarySelect">commentary observed</label>
                <select id="reasoningAnalysisCommentarySelect">
                  <option value="not_observed" selected>not observed</option>
                  <option value="observed">observed</option>
                  <option value="any">任意</option>
                </select>
              </div>
              <div class="field">
                <label for="reasoningAnalysisStatusSelect">状态</label>
                <select id="reasoningAnalysisStatusSelect">
                  <option value="any" selected>任意</option>
                  <option value="success">成功</option>
                  <option value="blocked">拦截</option>
                  <option value="upstream_failed">上游失败</option>
                  <option value="gateway_rejected">gateway 拒绝</option>
                </select>
              </div>
            </div>
            <div class="actions" style="margin-bottom: 14px;">
              <label class="inline-toggle" for="reasoningAnalysisIncludeRetriesInput">
                <input id="reasoningAnalysisIncludeRetriesInput" type="checkbox" checked />
                <span>包含 gateway 内部重试</span>
              </label>
              <label class="inline-toggle" for="reasoningAnalysisIncludeBlockedInput">
                <input id="reasoningAnalysisIncludeBlockedInput" type="checkbox" checked />
                <span>包含已拦截样本</span>
              </label>
              <button class="primary" id="reasoningAnalyzeButton" type="button">运行特征分析</button>
            </div>
            <div class="stats">
              <div class="stat"><label>analysis_value</label><strong id="reasoningAnalysisValue">-</strong></div>
              <div class="stat"><label>conclusion</label><strong id="reasoningAnalysisConclusion">-</strong></div>
              <div class="stat"><label>候选命中</label><strong id="reasoningAnalysisCandidateSummaryValue">-</strong></div>
              <div class="stat"><label>基线对比</label><span id="reasoningAnalysisBaselineValue">-</span></div>
            </div>
            <p class="reasoning-subtitle">field_coverage</p>
            <div class="table-wrap coverage-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>覆盖率</th>
                  </tr>
                </thead>
                <tbody id="reasoningAnalysisCoverageBody">
                  <tr><td colspan="2">尚未运行特征分析</td></tr>
                </tbody>
              </table>
            </div>
            <div class="range-chip-rail">
              <div class="range-chip" id="reasoningExportProgress" hidden>
                <div id="reasoningExportProgressText">后台导出准备中...</div>
                <div class="bar-row" aria-hidden="true"><span id="reasoningExportProgressFill" style="width: 0%;"></span></div>
                <a id="reasoningExportDownloadLink" href="#" target="_blank" rel="noopener noreferrer" hidden>下载导出文件</a>
              </div>
              <div class="range-chip range-status-chip" id="reasoningRangeChip">当前时间窗：默认最近窗口</div>
            </div>
            <div class="stats">
              <div class="stat"><label>样本总数</label><strong id="reasoningTotalSamplesValue">0</strong></div>
              <div class="stat"><label>final answer only</label><strong id="reasoningFinalOnlyRatioValue">0.00%</strong></div>
              <div class="stat"><label>commentary observed</label><strong id="reasoningCommentaryRatioValue">0.00%</strong></div>
              <div class="stat"><label>平均总耗时</label><strong id="reasoningAvgDurationValue">0 ms</strong></div>
              <div class="stat"><label>平均 output TPS</label><strong id="reasoningAvgOutputTpsValue">0</strong></div>
              <div class="stat"><label>平均归一化 TPS</label><strong id="reasoningAvgAdjustedTpsValue">0</strong></div>
            </div>
            <div class="chart-grid">
              <div class="signal-chart" id="reasoningTopTokensChart">暂无 reasoning token 分布</div>
              <div class="signal-chart" id="reasoningOutputTpsChart">暂无 output TPS 分布</div>
            </div>
            <p class="reasoning-subtitle">按模型家族</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>模型家族</th>
                    <th>样本</th>
                    <th>占比</th>
                    <th>final answer only</th>
                    <th>commentary observed</th>
                    <th>平均耗时</th>
                    <th>平均 TPS</th>
                    <th>重复 token</th>
                  </tr>
                </thead>
                <tbody id="reasoningByModelFamilyBody">
                  <tr><td colspan="8">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">按思考等级</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>reasoning.effort</th>
                    <th>样本</th>
                    <th>占比</th>
                    <th>final answer only</th>
                    <th>commentary observed</th>
                    <th>平均耗时</th>
                    <th>归一化 TPS</th>
                    <th>重复 token</th>
                  </tr>
                </thead>
                <tbody id="reasoningByEffortBody">
                  <tr><td colspan="8">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">模型家族 × 思考等级</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>组合</th>
                    <th>样本</th>
                    <th>占比</th>
                    <th>final answer only</th>
                    <th>commentary observed</th>
                    <th>平均耗时</th>
                    <th>平均 TPS</th>
                    <th>重复 token</th>
                  </tr>
                </thead>
                <tbody id="reasoningByFamilyEffortBody">
                  <tr><td colspan="8">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <div class="table-toolbar">
              <p class="reasoning-subtitle">按 reasoning_tokens</p>
              <label class="compact-select" for="reasoningTokenTableLimitSelect">
                显示数量
                <select id="reasoningTokenTableLimitSelect">
                  <option value="10" selected>10</option>
                  <option value="20">20</option>
                  <option value="30">30</option>
                  <option value="50">50</option>
                </select>
              </label>
            </div>
            <div class="table-wrap scroll-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>reasoning_tokens</th>
                    <th>样本</th>
                    <th>final answer only</th>
                    <th>commentary observed</th>
                    <th>平均耗时</th>
                    <th>平均 TPS</th>
                    <th>时序偏差</th>
                    <th>最近出现</th>
                  </tr>
                </thead>
                <tbody id="reasoningByTokenBody">
                  <tr><td colspan="8">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <div class="table-toolbar">
              <p class="reasoning-subtitle">候选特征组合</p>
              <label class="compact-select" for="reasoningCandidatePatternLimitSelect">
                显示数量
                <select id="reasoningCandidatePatternLimitSelect">
                  <option value="10" selected>10</option>
                  <option value="20">20</option>
                  <option value="30">30</option>
                  <option value="50">50</option>
                </select>
              </label>
            </div>
            <div class="table-wrap scroll-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>特征组合</th>
                    <th>样本</th>
                    <th>占比</th>
                    <th>平均耗时</th>
                    <th>平均 TPS</th>
                    <th>时序偏差</th>
                    <th>最近出现</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody id="reasoningCandidatePatternsBody">
                  <tr><td colspan="8">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <div class="table-toolbar">
              <p class="reasoning-subtitle">最近样本</p>
              <label class="compact-select" for="reasoningRecentSamplesLimitSelect">
                显示数量
                <select id="reasoningRecentSamplesLimitSelect">
                  <option value="10" selected>10</option>
                  <option value="20">20</option>
                  <option value="30">30</option>
                  <option value="50">50</option>
                </select>
              </label>
            </div>
            <div class="table-wrap scroll-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>路径</th>
                    <th>模型</th>
                    <th>模型家族</th>
                    <th>思考等级</th>
                    <th>reasoning</th>
                    <th>output</th>
                    <th>耗时</th>
                    <th>TPS</th>
                    <th>final answer only</th>
                    <th>commentary observed</th>
                    <th>命中/拦截</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody id="reasoningRecentSamplesBody">
                  <tr><td colspan="13">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="card wide-card" id="historicalImportSection">
          <div class="card-inner">
            <h2>历史导入分析</h2>
            <p class="risk-note">
              面向本机 CC Switch、Codex SQLite 日志和 Codex session JSONL 的后台聚合分析。大文件只做摘要和文件级索引，不读取完整 prompt / answer，不进入实时代理链路。
            </p>
            <div class="historical-import-control-stack">
              <button class="primary" id="historicalImportRunButton" type="button">预检并分析</button>
              <div class="range-chip historical-import-status" id="historicalImportProgress" data-progress-active="false">
                <div class="historical-import-status-text" id="historicalImportProgressText">历史导入分析未开始，可以后台慢慢跑，不影响 gateway 正常代理。</div>
                <div class="bar-row" aria-hidden="true"><span id="historicalImportProgressFill" style="width: 0%;"></span></div>
              </div>
            </div>
            <p class="footnote" id="historicalImportSummaryValue">历史导入分析尚无结果。</p>
            <p class="reasoning-subtitle">特征分析大盘</p>
            <div class="stats">
              <div class="stat"><label>analysis_value</label><strong id="historicalImportAnalysisValue">-</strong></div>
              <div class="stat"><label>conclusion</label><strong id="historicalImportAnalysisConclusion">-</strong></div>
              <div class="stat"><label>候选命中</label><strong id="historicalImportCandidateSummaryValue">-</strong></div>
              <div class="stat"><label>基线对比</label><span id="historicalImportBaselineValue">-</span></div>
            </div>
            <p class="reasoning-subtitle">field_coverage</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>字段</th>
                    <th>覆盖率</th>
                  </tr>
                </thead>
                <tbody id="historicalImportCoverageBody">
                  <tr><td colspan="2">历史导入尚未完成预检</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">历史数据源</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>类型</th>
                    <th>状态</th>
                    <th>行/文件数</th>
                    <th>路径</th>
                  </tr>
                </thead>
                <tbody id="historicalImportSourcesBody">
                  <tr><td colspan="4">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">CC Switch 按模型聚合</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>请求数</th>
                    <th>成功</th>
                    <th>失败</th>
                    <th>输入 token</th>
                    <th>输出 token</th>
                    <th>平均耗时</th>
                  </tr>
                </thead>
                <tbody id="historicalImportCcModelsBody">
                  <tr><td colspan="7">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">Codex 日志关键词</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>关键词 / 等级</th>
                    <th>次数</th>
                  </tr>
                </thead>
                <tbody id="historicalImportCodexLogsBody">
                  <tr><td colspan="2">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
            <p class="reasoning-subtitle">Codex session 大文件索引</p>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>文件</th>
                    <th>大小</th>
                    <th>修改时间</th>
                  </tr>
                </thead>
                <tbody id="historicalImportSessionsBody">
                  <tr><td colspan="3">暂无数据</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="card wide-card" id="modelSection">
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

        <section class="card wide-card" id="probeSection">
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
    <button class="theme-toggle" id="themeToggleButton" type="button" aria-label="切换深浅色模式">
      <span class="theme-toggle-icon" id="themeToggleIcon">☾</span>
      <span id="themeToggleText">深色模式</span>
    </button>

    <script>
      const ui = ${JSON.stringify(uiConfig)};
      const refs = {
        form: document.getElementById('configForm'),
        reasoningInput: document.getElementById('reasoningInput'),
        interceptRuleModeReasoningTokensInput: document.getElementById('interceptRuleModeReasoningTokensInput'),
        interceptRuleModeFinalOnlyInput: document.getElementById('interceptRuleModeFinalOnlyInput'),
        interceptStreamingInput: document.getElementById('interceptStreamingInput'),
        interceptNonStreamingInput: document.getElementById('interceptNonStreamingInput'),
        interceptModeValue: document.getElementById('interceptModeValue'),
        endpointsInput: document.getElementById('endpointsInput'),
        statusCodeInput: document.getElementById('statusCodeInput'),
        guardRetryAttemptsInput: document.getElementById('guardRetryAttemptsInput'),
        retryUpstreamCapacityErrorsInput: document.getElementById('retryUpstreamCapacityErrorsInput'),
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
        reasoningExportJsonButton: document.getElementById('reasoningExportJsonButton'),
        reasoningExportCsvButton: document.getElementById('reasoningExportCsvButton'),
        reasoningExportProgress: document.getElementById('reasoningExportProgress'),
        reasoningExportProgressFill: document.getElementById('reasoningExportProgressFill'),
        reasoningExportProgressText: document.getElementById('reasoningExportProgressText'),
        reasoningExportDownloadLink: document.getElementById('reasoningExportDownloadLink'),
        reasoningRangeTodayButton: document.getElementById('reasoningRangeTodayButton'),
        reasoningRangeWeekButton: document.getElementById('reasoningRangeWeekButton'),
        reasoningRangeApplyButton: document.getElementById('reasoningRangeApplyButton'),
        reasoningDateFromInput: document.getElementById('reasoningDateFromInput'),
        reasoningDateToInput: document.getElementById('reasoningDateToInput'),
        reasoningTotalSamplesValue: document.getElementById('reasoningTotalSamplesValue'),
        reasoningFinalOnlyRatioValue: document.getElementById('reasoningFinalOnlyRatioValue'),
        reasoningCommentaryRatioValue: document.getElementById('reasoningCommentaryRatioValue'),
        reasoningAvgDurationValue: document.getElementById('reasoningAvgDurationValue'),
        reasoningAvgOutputTpsValue: document.getElementById('reasoningAvgOutputTpsValue'),
        reasoningAvgAdjustedTpsValue: document.getElementById('reasoningAvgAdjustedTpsValue'),
        reasoningExportMeta: document.getElementById('reasoningExportMeta'),
        reasoningRangeChip: document.getElementById('reasoningRangeChip'),
        reasoningTopTokensChart: document.getElementById('reasoningTopTokensChart'),
        reasoningOutputTpsChart: document.getElementById('reasoningOutputTpsChart'),
        reasoningByModelFamilyBody: document.getElementById('reasoningByModelFamilyBody'),
        reasoningByEffortBody: document.getElementById('reasoningByEffortBody'),
        reasoningByFamilyEffortBody: document.getElementById('reasoningByFamilyEffortBody'),
        reasoningTokenTableLimitSelect: document.getElementById('reasoningTokenTableLimitSelect'),
        reasoningCandidatePatternLimitSelect: document.getElementById('reasoningCandidatePatternLimitSelect'),
        reasoningRecentSamplesLimitSelect: document.getElementById('reasoningRecentSamplesLimitSelect'),
        reasoningByTokenBody: document.getElementById('reasoningByTokenBody'),
        reasoningCandidatePatternsBody: document.getElementById('reasoningCandidatePatternsBody'),
        reasoningRecentSamplesBody: document.getElementById('reasoningRecentSamplesBody'),
        reasoningAnalysisModelFamilyInput: document.getElementById('reasoningAnalysisModelFamilyInput'),
        reasoningAnalysisEffortInput: document.getElementById('reasoningAnalysisEffortInput'),
        reasoningAnalysisTokenInput: document.getElementById('reasoningAnalysisTokenInput'),
        reasoningAnalysisFinalOnlySelect: document.getElementById('reasoningAnalysisFinalOnlySelect'),
        reasoningAnalysisCommentarySelect: document.getElementById('reasoningAnalysisCommentarySelect'),
        reasoningAnalysisStatusSelect: document.getElementById('reasoningAnalysisStatusSelect'),
        reasoningAnalysisIncludeRetriesInput: document.getElementById('reasoningAnalysisIncludeRetriesInput'),
        reasoningAnalysisIncludeBlockedInput: document.getElementById('reasoningAnalysisIncludeBlockedInput'),
        reasoningAnalyzeButton: document.getElementById('reasoningAnalyzeButton'),
        reasoningAnalysisValue: document.getElementById('reasoningAnalysisValue'),
        reasoningAnalysisConclusion: document.getElementById('reasoningAnalysisConclusion'),
        reasoningAnalysisCoverageBody: document.getElementById('reasoningAnalysisCoverageBody'),
        reasoningAnalysisCandidateSummaryValue: document.getElementById('reasoningAnalysisCandidateSummaryValue'),
        reasoningAnalysisBaselineValue: document.getElementById('reasoningAnalysisBaselineValue'),
        historicalImportRunButton: document.getElementById('historicalImportRunButton'),
        historicalImportProgress: document.getElementById('historicalImportProgress'),
        historicalImportProgressFill: document.getElementById('historicalImportProgressFill'),
        historicalImportProgressText: document.getElementById('historicalImportProgressText'),
        historicalImportSummaryValue: document.getElementById('historicalImportSummaryValue'),
        historicalImportAnalysisValue: document.getElementById('historicalImportAnalysisValue'),
        historicalImportAnalysisConclusion: document.getElementById('historicalImportAnalysisConclusion'),
        historicalImportCoverageBody: document.getElementById('historicalImportCoverageBody'),
        historicalImportCandidateSummaryValue: document.getElementById('historicalImportCandidateSummaryValue'),
        historicalImportBaselineValue: document.getElementById('historicalImportBaselineValue'),
        historicalImportSourcesBody: document.getElementById('historicalImportSourcesBody'),
        historicalImportCcModelsBody: document.getElementById('historicalImportCcModelsBody'),
        historicalImportCodexLogsBody: document.getElementById('historicalImportCodexLogsBody'),
        historicalImportSessionsBody: document.getElementById('historicalImportSessionsBody'),
        statsFootnote: document.getElementById('statsFootnote'),
        logsMeta: document.getElementById('logsMeta'),
        logsOutput: document.getElementById('logsOutput'),
        themeToggleButton: document.getElementById('themeToggleButton'),
        themeToggleIcon: document.getElementById('themeToggleIcon'),
        themeToggleText: document.getElementById('themeToggleText'),
      };
      const themeStorageKey = 'codexRetryGatewayTheme';
      let hasLoadedForm = false;
      let lastLogSeq = 0;
      let lastGatewayStartedAt = null;
      let logsNeedFullReload = false;
      let pollTimer = null;
      let stoppedByRestore = false;
      let reloadingForGatewayRestart = false;
      let suspiciousSamplesSignature = '';
      let probeSamplesSignature = '';
      let reasoningBehaviorDateFrom = null;
      let reasoningBehaviorDateTo = null;
      let latestReasoningTokenRows = [];
      let latestReasoningCandidatePatternRows = [];
      let latestReasoningRecentSampleRows = [];
      let reasoningExportPollTimer = null;
      let historicalImportPollTimer = null;
      const openSuspiciousEvidenceSampleKeys = new Set();
      const openProbeEvidenceSampleKeys = new Set();

      function applyTheme(theme) {
        const nextTheme = theme === 'dark' ? 'dark' : 'light';
        const themeRoot = document.documentElement || document.body;
        if (themeRoot?.dataset) {
          themeRoot.dataset.theme = nextTheme;
        }
        if (refs.themeToggleIcon) {
          refs.themeToggleIcon.textContent = nextTheme === 'dark' ? '☀' : '☾';
        }
        if (refs.themeToggleText) {
          refs.themeToggleText.textContent = nextTheme === 'dark' ? '浅色模式' : '深色模式';
        }
        if (refs.themeToggleButton) {
          refs.themeToggleButton.setAttribute(
            'aria-label',
            nextTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式',
          );
        }
      }

      function getStoredTheme() {
        try {
          return window.localStorage.getItem(themeStorageKey);
        } catch {
          return null;
        }
      }

      function storeTheme(theme) {
        try {
          window.localStorage.setItem(themeStorageKey, theme);
        } catch {
          // 浏览器禁用本地存储时，当前页面仍可正常切换主题。
        }
      }

      function toggleTheme() {
        const themeRoot = document.documentElement || document.body;
        const currentTheme = themeRoot?.dataset?.theme === 'dark' ? 'dark' : 'light';
        const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
        applyTheme(nextTheme);
        storeTheme(nextTheme);
      }

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

      function formatNumber(value, digits) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
          return '0';
        }
        if (Number.isInteger(digits)) {
          return number.toFixed(digits);
        }
        return String(number);
      }

      function formatMs(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number.toFixed(0) + ' ms' : '-';
      }

      function formatReasoningTokens(entries) {
        const tokens = (Array.isArray(entries) ? entries : [])
          .filter((entry) => Number(entry?.count || 0) > 1);
        if (tokens.length === 0) {
          return '无重复 token';
        }
        return tokens
          .map((entry) => String(entry?.value ?? '-') + ' x' + String(entry?.count ?? 0))
          .join('，');
      }

      function formatPathCounts(pathCounts) {
        const entries = Object.entries(pathCounts || {})
          .filter((entry) => Number(entry[1]) > 0)
          .sort((left, right) => Number(right[1]) - Number(left[1]));
        if (entries.length === 0) {
          return '无';
        }
        const visibleEntries = entries.slice(0, 3);
        const hiddenCount = entries.length - visibleEntries.length;
        const visibleText = visibleEntries
          .map((entry) => entry[0] + ' x' + String(entry[1]))
          .join('，');
        if (hiddenCount <= 0) {
          return visibleText;
        }
        return visibleText + '，其余 ' + String(hiddenCount) + ' 项';
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function toLocalDateInputValue(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return year + '-' + month + '-' + day;
      }

      function setReasoningBehaviorDateRange(dateFrom, dateTo) {
        reasoningBehaviorDateFrom = dateFrom || null;
        reasoningBehaviorDateTo = dateTo || null;
        if (refs.reasoningDateFromInput) {
          refs.reasoningDateFromInput.value = reasoningBehaviorDateFrom || '';
        }
        if (refs.reasoningDateToInput) {
          refs.reasoningDateToInput.value = reasoningBehaviorDateTo || '';
        }
        if (refs.reasoningRangeChip) {
          refs.reasoningRangeChip.textContent = formatReasoningBehaviorDateRangeLabel(
            reasoningBehaviorDateFrom,
            reasoningBehaviorDateTo,
          );
        }
      }

      function getReasoningBehaviorRequestUrl(baseUrl) {
        const url = new URL(baseUrl || ui.reasoningBehaviorPath, window.location.origin);
        if (reasoningBehaviorDateFrom) {
          url.searchParams.set('date_from', reasoningBehaviorDateFrom);
        }
        if (reasoningBehaviorDateTo) {
          url.searchParams.set('date_to', reasoningBehaviorDateTo);
        }
        return url;
      }

      function formatReasoningBehaviorDateRangeLabel(dateFrom, dateTo) {
        if (dateFrom && dateTo) {
          return '当前时间窗：' + dateFrom + ' 至 ' + dateTo;
        }
        if (dateFrom) {
          return '当前时间窗：' + dateFrom + ' 起';
        }
        if (dateTo) {
          return '当前时间窗：截至 ' + dateTo;
        }
        return '当前时间窗：默认最近窗口';
      }

      function buildReasoningBehaviorExportUrl(format) {
        const url = getReasoningBehaviorRequestUrl(ui.reasoningBehaviorExportPath);
        url.searchParams.set('format', format);
        return url.toString();
      }

      function countReasoningDateRangeDays(dateFrom, dateTo) {
        if (!dateFrom || !dateTo) {
          return null;
        }
        const fromMs = Date.parse(dateFrom + 'T00:00:00.000Z');
        const toMs = Date.parse(dateTo + 'T00:00:00.000Z');
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
          return null;
        }
        return Math.floor((toMs - fromMs) / 86400000) + 1;
      }

      function shouldUseBackgroundReasoningExport() {
        const rangeDays = countReasoningDateRangeDays(
          reasoningBehaviorDateFrom,
          reasoningBehaviorDateTo,
        );
        return (
          rangeDays !== null &&
          rangeDays >= Number(ui.reasoningBackgroundExportMinDays || 32)
        );
      }

      function setReasoningExportProgress(job, message) {
        if (!refs.reasoningExportProgress) {
          return;
        }
        refs.reasoningExportProgress.hidden = false;
        const percent = Math.max(0, Math.min(1, Number(job?.progress?.percent || 0)));
        if (refs.reasoningExportProgressFill) {
          refs.reasoningExportProgressFill.style.width = String(Math.round(percent * 100)) + '%';
        }
        if (refs.reasoningExportProgressText) {
          const processed = Number(job?.progress?.processed_days || 0);
          const total = Number(job?.progress?.total_days || 0);
          const status = job?.status || 'queued';
          refs.reasoningExportProgressText.textContent =
            message ||
            '后台导出 ' + status + '：已处理 ' + String(processed) + ' / ' + String(total) + ' 天，可以继续正常使用 gateway。';
        }
        if (refs.reasoningExportDownloadLink) {
          const downloadUrl = job?.download_url || '';
          refs.reasoningExportDownloadLink.hidden = !downloadUrl;
          refs.reasoningExportDownloadLink.href = downloadUrl || '#';
        }
      }

      async function pollReasoningExportJob(jobId) {
        if (!jobId) {
          return;
        }
        const url = ui.reasoningBehaviorExportPath + '/jobs/' + encodeURIComponent(jobId);
        const response = await fetch(url, { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '后台导出任务状态查询失败');
        }
        const job = payload?.export_job;
        setReasoningExportProgress(job);
        if (job?.status === 'completed') {
          setReasoningExportProgress(job, '后台导出完成，可以下载文件。');
          return;
        }
        if (job?.status === 'failed') {
          setReasoningExportProgress(job, '后台导出失败：' + String(job?.error_message || '未知错误'));
          return;
        }
        reasoningExportPollTimer = window.setTimeout(() => {
          pollReasoningExportJob(jobId).catch((error) => setMessage(error?.message || String(error), 'error'));
        }, 800);
      }

      async function openReasoningBehaviorExport(format) {
        const url = buildReasoningBehaviorExportUrl(format);
        if (reasoningExportPollTimer) {
          window.clearTimeout(reasoningExportPollTimer);
          reasoningExportPollTimer = null;
        }
        if (!shouldUseBackgroundReasoningExport()) {
          if (refs.reasoningExportProgress) {
            refs.reasoningExportProgress.hidden = true;
          }
          if (typeof window.open === 'function') {
            window.open(url, '_blank');
          } else {
            window.location.href = url;
          }
          return;
        }
        setReasoningExportProgress(
          { status: 'queued', progress: { processed_days: 0, total_days: 0, percent: 0 } },
          '正在创建后台导出任务，可以继续正常使用 gateway。',
        );
        const response = await fetch(url, { cache: 'no-store' });
        const contentType = response.headers?.get?.('content-type') || '';
        if (response.status === 202 || contentType.includes('application/json')) {
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || '导出失败');
          }
          if (payload?.export_job?.job_id) {
            setReasoningExportProgress(payload.export_job, payload.message);
            await pollReasoningExportJob(payload.export_job.job_id);
            return;
          }
        }
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

      function getInterceptRuleModeFromForm() {
        return refs.interceptRuleModeFinalOnlyInput.checked
          ? 'final_answer_only_high_xhigh'
          : 'reasoning_tokens';
      }

      function collectInterceptPayloadFromForm() {
        const interceptStreaming = Boolean(refs.interceptStreamingInput.checked);
        const interceptNonStreaming = Boolean(refs.interceptNonStreamingInput.checked);
        if (!interceptStreaming && !interceptNonStreaming) {
          throw new Error('流式与非流式至少选择一个拦截目标。');
        }
        return {
          intercept_rule_mode: getInterceptRuleModeFromForm(),
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
        const interceptRuleMode = config?.intercept_rule_mode === 'final_answer_only_high_xhigh'
          ? 'final_answer_only_high_xhigh'
          : 'reasoning_tokens';
        refs.interceptRuleModeFinalOnlyInput.checked = interceptRuleMode === 'final_answer_only_high_xhigh';
        refs.interceptRuleModeReasoningTokensInput.checked = interceptRuleMode === 'reasoning_tokens';
        refs.interceptStreamingInput.checked = config?.intercept_streaming !== false;
        refs.interceptNonStreamingInput.checked = config?.intercept_non_streaming !== false;
        syncInterceptModeValueFromForm();
        refs.endpointsInput.value = Array.isArray(config?.endpoints) ? config.endpoints.join('\\n') : '';
        refs.statusCodeInput.value = config?.non_stream_status_code ?? 502;
        refs.guardRetryAttemptsInput.value = String(config?.guard_retry_attempts ?? 3);
        refs.retryUpstreamCapacityErrorsInput.checked = config?.retry_upstream_capacity_errors !== false;
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

      function renderReasoningBars(container, rows, options) {
        if (!container) {
          return;
        }
        const entries = Array.isArray(rows) ? rows : [];
        if (entries.length === 0) {
          container.innerHTML = options?.emptyText || '暂无数据';
          return;
        }
        const maxCount = Math.max(1, ...entries.map((entry) => Number(entry?.count || 0)));
        container.innerHTML = entries
          .map((entry) => {
            const count = Number(entry?.count || 0);
            const width = Math.max(3, Math.round((count / maxCount) * 100));
            const label = options?.label
              ? options.label(entry)
              : String(entry?.label ?? entry?.value ?? '-');
            return '<div class="signal-bar">' +
              '<span>' + escapeHtml(label) + '</span>' +
              '<span class="signal-bar-track"><span class="signal-bar-fill" style="width: ' + String(width) + '%"></span></span>' +
              '<strong>' + String(count) + '</strong>' +
            '</div>';
          })
          .join('');
      }

      function renderReasoningGroupedTable(container, rows, options) {
        const entries = Array.isArray(rows) ? rows : [];
        if (!container) {
          return;
        }
        if (entries.length === 0) {
          container.innerHTML = '<tr><td colspan="8">暂无数据</td></tr>';
          return;
        }
        container.innerHTML = entries
          .map((entry) => {
            const label = options?.label ? options.label(entry) : '-';
            const avgTps = options?.adjusted
              ? entry.avg_reasoning_adjusted_tps
              : entry.avg_output_tps;
            return '<tr>' +
              '<td>' + escapeHtml(label) + '</td>' +
              '<td>' + String(entry.count ?? 0) + '</td>' +
              '<td>' + formatPercent(Number(entry.ratio ?? 0)) + '</td>' +
              '<td>' + formatPercent(Number(entry.final_answer_only_ratio ?? 0)) + '</td>' +
              '<td>' + formatPercent(Number(entry.commentary_observed_ratio ?? entry.commentary_present_ratio ?? 0)) + '</td>' +
              '<td>' + formatMs(entry.avg_duration_total_ms) + '</td>' +
              '<td>' + formatNumber(avgTps, 2) + '</td>' +
              '<td>' + escapeHtml(formatReasoningTokens(entry.top_reasoning_tokens)) + '</td>' +
            '</tr>';
          })
          .join('');
      }

      function renderReasoningTokenTable(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        latestReasoningTokenRows = entries;
        if (entries.length === 0) {
          refs.reasoningByTokenBody.innerHTML = '<tr><td colspan="8">暂无数据</td></tr>';
          return;
        }
        const limit = Number.parseInt(refs.reasoningTokenTableLimitSelect?.value || '10', 10) || 10;
        refs.reasoningByTokenBody.innerHTML = entries.slice(0, limit)
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.value ?? '-') + '</td>' +
            '<td>' + String(entry.count ?? 0) + '</td>' +
            '<td>' + formatPercent(Number(entry.final_answer_only_ratio ?? 0)) + '</td>' +
            '<td>' + formatPercent(Number(entry.commentary_observed_ratio ?? entry.commentary_present_ratio ?? 0)) + '</td>' +
            '<td>' + formatMs(entry.avg_duration_total_ms) + '</td>' +
            '<td>' + formatNumber(entry.avg_output_tps, 2) + '</td>' +
            '<td>' + formatNumber(entry.avg_time_normalization_deviation, 3) + '</td>' +
            '<td>' + formatTimestamp(entry.last_seen_at) + '</td>' +
          '</tr>')
          .join('');
      }

      function renderReasoningCandidatePatterns(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        latestReasoningCandidatePatternRows = entries;
        if (entries.length === 0) {
          refs.reasoningCandidatePatternsBody.innerHTML = '<tr><td colspan="8">暂无数据</td></tr>';
          return;
        }
        const limit = Number.parseInt(refs.reasoningCandidatePatternLimitSelect?.value || '10', 10) || 10;
        refs.reasoningCandidatePatternsBody.innerHTML = entries.slice(0, limit)
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.pattern_key || '-') + '</td>' +
            '<td>' + String(entry.count ?? 0) + '</td>' +
            '<td>' + formatPercent(Number(entry.ratio ?? 0)) + '</td>' +
            '<td>' + formatMs(entry.avg_duration_total_ms) + '</td>' +
            '<td>' + formatNumber(entry.avg_output_tps, 2) + '</td>' +
            '<td>' + formatNumber(entry.avg_time_normalization_deviation, 3) + '</td>' +
            '<td>' + formatTimestamp(entry.last_seen_at) + '</td>' +
            '<td>' + escapeHtml(entry.status || 'observe_only') + '</td>' +
          '</tr>')
          .join('');
      }

      function renderReasoningRecentSamples(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        latestReasoningRecentSampleRows = entries;
        if (entries.length === 0) {
          refs.reasoningRecentSamplesBody.innerHTML = '<tr><td colspan="13">暂无数据</td></tr>';
          return;
        }
        const limit = Number.parseInt(refs.reasoningRecentSamplesLimitSelect?.value || '10', 10) || 10;
        refs.reasoningRecentSamplesBody.innerHTML = entries.slice(0, limit)
          .map((sample) => {
            const hitText = (sample.matched_current_rule ? '命中' : '未命中') +
              ' / ' +
              (sample.blocked_by_gateway ? '拦截' : '未拦截');
            return '<tr>' +
              '<td>' + formatTimestamp(sample.ts) + '</td>' +
              '<td>' + escapeHtml(sample.path || '-') + '</td>' +
              '<td>' + escapeHtml(sample.request_model || sample.effective_local_model || '-') + '</td>' +
              '<td>' + escapeHtml(sample.effective_local_model_family || sample.request_model_family || '-') + '</td>' +
              '<td>' + escapeHtml(sample.request_reasoning_effort || '-') + '</td>' +
              '<td>' + escapeHtml(sample.reasoning_tokens ?? '-') + '</td>' +
              '<td>' + escapeHtml(sample.output_tokens ?? '-') + '</td>' +
              '<td>' + formatMs(sample.duration_total_ms) + '</td>' +
              '<td>' + formatNumber(sample.output_tps, 2) + '</td>' +
              '<td>' + (sample.final_answer_only ? '是' : '否') + '</td>' +
              '<td>' + ((sample.commentary_observed ?? sample.has_commentary) ? '是' : '否') + '</td>' +
              '<td>' + hitText + '</td>' +
              '<td>' + escapeHtml(String(sample.client_http_status ?? '-') + ' / ' + String(sample.final_action || '-')) + '</td>' +
            '</tr>';
          })
          .join('');
      }

      function parseCsvText(value) {
        return String(value || '')
          .split(/[,\\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }

      function parseNumberCsvText(value) {
        return parseCsvText(value)
          .map((entry) => Number.parseInt(entry, 10))
          .filter((entry) => Number.isInteger(entry));
      }

      function renderFeatureCoverage(container, coverage) {
        const entries = Object.entries(coverage || {});
        if (!container) {
          return;
        }
        if (entries.length === 0) {
          container.innerHTML = '<tr><td colspan="2">暂无 field_coverage</td></tr>';
          return;
        }
        container.innerHTML = entries
          .map(([field, ratio]) => '<tr>' +
            '<td>' + escapeHtml(field) + '</td>' +
            '<td>' + formatPercent(Number(ratio || 0)) + '</td>' +
          '</tr>')
          .join('');
      }

      function fillFeatureAnalysis(payload, target) {
        const analysisValue = payload?.analysis_value || '-';
        const conclusion = payload?.conclusion || '-';
        const candidate = payload?.candidate_summary || {};
        const baseline = payload?.baseline_comparison || {};
        const valueText = analysisValue === 'no_analysis_value'
          ? 'no_analysis_value（无分析价值）'
          : analysisValue;
        target.value.textContent = valueText;
        target.conclusion.textContent = conclusion;
        target.candidate.textContent =
          '候选 ' + String(candidate.candidate_count ?? 0) +
          '，占比 ' + formatPercent(Number(candidate.candidate_ratio ?? 0)) +
          '，516 ' + String(candidate.reasoning_516_count ?? 0);
        target.baseline.textContent =
          'baseline ' + String(baseline.baseline_count ?? 0) +
          '，候选时序偏差 ' + formatNumber(baseline.candidate_avg_time_normalization_deviation, 3) +
          ' / 基线 ' + formatNumber(baseline.baseline_avg_time_normalization_deviation, 3);
        renderFeatureCoverage(target.coverage, payload?.field_coverage || {});
      }

      function fillReasoningFeatureAnalysis(payload) {
        fillFeatureAnalysis(payload, {
          value: refs.reasoningAnalysisValue,
          conclusion: refs.reasoningAnalysisConclusion,
          coverage: refs.reasoningAnalysisCoverageBody,
          candidate: refs.reasoningAnalysisCandidateSummaryValue,
          baseline: refs.reasoningAnalysisBaselineValue,
        });
      }

      function buildHistoricalAnalysisFromPreflight(preflight) {
        const analysisValue = preflight?.analysis_value || 'no_analysis_value';
        return {
          analysis_profile: '516_candidate_review_v1',
          analysis_value: analysisValue,
          conclusion:
            analysisValue === 'valuable'
              ? 'not_observed'
              : analysisValue === 'partial'
                ? 'insufficient_fields'
                : 'no_analysis_value',
          field_coverage: preflight?.field_coverage || {},
          candidate_summary: { candidate_count: 0, candidate_ratio: 0 },
          baseline_comparison: { baseline_count: 0 },
        };
      }

      function fillHistoricalFeatureAnalysis(job) {
        const payload = job?.feature_analysis || buildHistoricalAnalysisFromPreflight(job?.preflight);
        fillFeatureAnalysis(payload, {
          value: refs.historicalImportAnalysisValue,
          conclusion: refs.historicalImportAnalysisConclusion,
          coverage: refs.historicalImportCoverageBody,
          candidate: refs.historicalImportCandidateSummaryValue,
          baseline: refs.historicalImportBaselineValue,
        });
      }

      function collectReasoningAnalysisPayload() {
        const commentaryValue = refs.reasoningAnalysisCommentarySelect.value || 'not_observed';
        const finalOnlyValue = refs.reasoningAnalysisFinalOnlySelect.value || 'true';
        return {
          filters: {
            date_from: reasoningBehaviorDateFrom,
            date_to: reasoningBehaviorDateTo,
            model_family: parseCsvText(refs.reasoningAnalysisModelFamilyInput.value),
            reasoning_effort: parseCsvText(refs.reasoningAnalysisEffortInput.value),
            status: refs.reasoningAnalysisStatusSelect.value || 'any',
            include_retries: refs.reasoningAnalysisIncludeRetriesInput.checked,
            include_blocked: refs.reasoningAnalysisIncludeBlockedInput.checked,
          },
          conditions: {
            reasoning_tokens: parseNumberCsvText(refs.reasoningAnalysisTokenInput.value),
            final_answer_only: finalOnlyValue === 'any' ? undefined : finalOnlyValue === 'true',
            commentary_not_observed:
              commentaryValue === 'any' ? undefined : commentaryValue === 'not_observed',
            time_normalization_deviation: 'high',
          },
        };
      }

      async function runReasoningFeatureAnalysis() {
        refs.reasoningAnalyzeButton.disabled = true;
        try {
          const response = await fetch(ui.reasoningBehaviorPath + '/analyze', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(collectReasoningAnalysisPayload()),
            cache: 'no-store',
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || 'reasoning 特征分析失败');
          }
          fillReasoningFeatureAnalysis(payload);
        } finally {
          refs.reasoningAnalyzeButton.disabled = false;
        }
      }

      function fillReasoningBehavior(payload) {
        const summary = payload?.summary || {};
        refs.reasoningTotalSamplesValue.textContent = String(summary.total_samples ?? 0);
        refs.reasoningFinalOnlyRatioValue.textContent = formatPercent(Number(summary.final_answer_only_ratio ?? 0));
        refs.reasoningCommentaryRatioValue.textContent = formatPercent(Number(summary.commentary_observed_ratio ?? summary.commentary_present_ratio ?? 0));
        refs.reasoningAvgDurationValue.textContent = formatMs(summary.avg_duration_total_ms);
        refs.reasoningAvgOutputTpsValue.textContent = formatNumber(summary.avg_output_tps, 2);
        refs.reasoningAvgAdjustedTpsValue.textContent = formatNumber(summary.avg_reasoning_adjusted_tps, 2);
        refs.reasoningExportMeta.textContent =
          summary.wording ||
          '统计结果只表示可观测结构信号，用于发现候选异常特征，不代表最终归因，也不证明模型内部没有思考。final answer only / commentary observed 不是互补关系，剩余样本可能是 tool call、reasoning item 或普通 output 组合。';
        refs.reasoningRangeChip.textContent = formatReasoningBehaviorDateRangeLabel(
          reasoningBehaviorDateFrom,
          reasoningBehaviorDateTo,
        );
        renderReasoningBars(refs.reasoningTopTokensChart, payload?.top_reasoning_tokens || [], {
          emptyText: '暂无 reasoning token 分布',
          label: (entry) => 'token ' + String(entry?.value ?? '-'),
        });
        renderReasoningBars(refs.reasoningOutputTpsChart, payload?.output_tps_buckets || [], {
          emptyText: '暂无 output TPS 分布',
          label: (entry) => String(entry?.label ?? '-'),
        });
        renderReasoningGroupedTable(refs.reasoningByModelFamilyBody, payload?.by_model_family || [], {
          label: (entry) => entry.model_family || '-',
        });
        renderReasoningGroupedTable(refs.reasoningByEffortBody, payload?.by_reasoning_effort || [], {
          label: (entry) => entry.reasoning_effort || '-',
          adjusted: true,
        });
        renderReasoningGroupedTable(
          refs.reasoningByFamilyEffortBody,
          payload?.by_model_family_and_effort || [],
          {
            label: (entry) => entry.group_label || ((entry.model_family || '-') + ' / ' + (entry.reasoning_effort || '-')),
          },
        );
        renderReasoningTokenTable(payload?.by_reasoning_token || []);
        renderReasoningCandidatePatterns(payload?.candidate_patterns || []);
        renderReasoningRecentSamples(payload?.recent_samples || []);
      }

      function formatBytes(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number) || number <= 0) {
          return '0 B';
        }
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = number;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex += 1;
        }
        return size.toFixed(unitIndex === 0 ? 0 : 2) + ' ' + units[unitIndex];
      }

      function setHistoricalImportProgress(job, message) {
        const percent = Math.max(0, Math.min(1, Number(job?.progress?.percent || 0)));
        const hasProgress = Boolean(job && (percent > 0 || job.status === 'running' || job.status === 'completed' || job.status === 'failed'));
        if (refs.historicalImportProgress) {
          refs.historicalImportProgress.dataset.progressActive = hasProgress ? 'true' : 'false';
        }
        if (refs.historicalImportProgressFill) {
          refs.historicalImportProgressFill.style.width = String(Math.round(percent * 100)) + '%';
        }
        if (refs.historicalImportProgressText) {
          const processed = Number(job?.progress?.processed_sources || 0);
          const total = Number(job?.progress?.total_sources || 0);
          const step = job?.progress?.current_step || job?.status || 'queued';
          refs.historicalImportProgressText.textContent =
            message ||
            '历史导入 ' + String(step) + '：已处理 ' + String(processed) + ' / ' + String(total) + ' 个数据源，可以继续正常使用 gateway。';
        }
      }

      function renderHistoricalImportSources(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        if (entries.length === 0) {
          refs.historicalImportSourcesBody.innerHTML = '<tr><td colspan="4">暂无数据</td></tr>';
          return;
        }
        refs.historicalImportSourcesBody.innerHTML = entries
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.source_type || '-') + '</td>' +
            '<td>' + escapeHtml(entry.status || '-') + '</td>' +
            '<td>' + escapeHtml(entry.row_count ?? '-') + '</td>' +
            '<td>' + escapeHtml(entry.path || '-') + '</td>' +
          '</tr>')
          .join('');
      }

      function renderHistoricalImportCcModels(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        if (entries.length === 0) {
          refs.historicalImportCcModelsBody.innerHTML = '<tr><td colspan="7">暂无数据</td></tr>';
          return;
        }
        refs.historicalImportCcModelsBody.innerHTML = entries
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.model || '-') + '</td>' +
            '<td>' + escapeHtml(entry.count ?? 0) + '</td>' +
            '<td>' + escapeHtml(entry.success_count ?? 0) + '</td>' +
            '<td>' + escapeHtml(entry.failure_count ?? 0) + '</td>' +
            '<td>' + escapeHtml(entry.input_tokens ?? 0) + '</td>' +
            '<td>' + escapeHtml(entry.output_tokens ?? 0) + '</td>' +
            '<td>' + formatMs(entry.avg_duration_ms) + '</td>' +
          '</tr>')
          .join('');
      }

      function renderHistoricalImportCodexLogs(job) {
        const keywordHits = Array.isArray(job?.codex_logs?.keyword_hits)
          ? job.codex_logs.keyword_hits
          : [];
        const levelRows = Array.isArray(job?.codex_logs?.by_level)
          ? job.codex_logs.by_level.map((entry) => ({
              keyword: 'level:' + String(entry.level || '-'),
              count: entry.count,
            }))
          : [];
        const entries = [...keywordHits, ...levelRows];
        if (entries.length === 0) {
          refs.historicalImportCodexLogsBody.innerHTML = '<tr><td colspan="2">暂无数据</td></tr>';
          return;
        }
        refs.historicalImportCodexLogsBody.innerHTML = entries
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.keyword || '-') + '</td>' +
            '<td>' + escapeHtml(entry.count ?? 0) + '</td>' +
          '</tr>')
          .join('');
      }

      function renderHistoricalImportSessions(rows) {
        const entries = Array.isArray(rows) ? rows : [];
        if (entries.length === 0) {
          refs.historicalImportSessionsBody.innerHTML = '<tr><td colspan="3">暂无数据</td></tr>';
          return;
        }
        refs.historicalImportSessionsBody.innerHTML = entries
          .map((entry) => '<tr>' +
            '<td>' + escapeHtml(entry.path || '-') + '</td>' +
            '<td>' + formatBytes(entry.bytes) + '</td>' +
            '<td>' + formatTimestamp(entry.modified_at) + '</td>' +
          '</tr>')
          .join('');
      }

      function fillHistoricalImport(job) {
        if (!job) {
          setHistoricalImportProgress(
            { progress: { processed_sources: 0, total_sources: 0, percent: 0 } },
            '历史导入分析未开始，可以后台慢慢跑，不影响 gateway 正常代理。',
          );
          refs.historicalImportSummaryValue.textContent = '历史导入分析尚无结果。';
          fillHistoricalFeatureAnalysis(null);
          return;
        }
        setHistoricalImportProgress(job, job.status === 'completed' ? '历史导入分析完成。' : null);
        const summary = job.summary || {};
        refs.historicalImportSummaryValue.textContent =
          '历史导入：数据源 ' + String(summary.source_count ?? 0) +
          '，历史请求 ' + String(summary.total_requests ?? 0) +
          '，成功 ' + String(summary.successful_requests ?? 0) +
          '，失败 ' + String(summary.failed_requests ?? 0) +
          '，输入 token ' + String(summary.total_input_tokens ?? 0) +
          '，输出 token ' + String(summary.total_output_tokens ?? 0) +
          '，平均延迟 ' + formatMs(summary.avg_latency_ms) +
          '，Codex 日志 ' + String(summary.codex_log_rows ?? 0) +
          '，session 文件 ' + String(summary.session_file_count ?? 0) +
          '，session 体积 ' + formatBytes(summary.session_total_bytes) + '。';
        fillHistoricalFeatureAnalysis(job);
        renderHistoricalImportSources(job.sources || []);
        renderHistoricalImportCcModels(job.cc_switch?.by_model || []);
        renderHistoricalImportCodexLogs(job);
        renderHistoricalImportSessions(job.sessions?.top_files || []);
      }

      async function pollHistoricalImportJob(jobId) {
        if (!jobId) {
          return;
        }
        const url = ui.historicalImportPath + '/jobs/' + encodeURIComponent(jobId);
        const response = await fetch(url, { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '历史导入任务状态查询失败');
        }
        const job = payload?.import_job;
        fillHistoricalImport(job);
        if (job?.status === 'completed' || job?.status === 'failed') {
          return;
        }
        historicalImportPollTimer = window.setTimeout(() => {
          pollHistoricalImportJob(jobId).catch((error) => setMessage(error?.message || String(error), 'error'));
        }, 800);
      }

      async function runHistoricalImportAnalysis() {
        if (historicalImportPollTimer) {
          window.clearTimeout(historicalImportPollTimer);
          historicalImportPollTimer = null;
        }
        refs.historicalImportRunButton.disabled = true;
        setHistoricalImportProgress(
          { progress: { processed_sources: 0, total_sources: 0, percent: 0 } },
          '正在创建历史导入后台任务，可以继续正常使用 gateway。',
        );
        try {
          const response = await fetch(ui.historicalImportPath + '/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
            cache: 'no-store',
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload?.error?.message || '历史导入分析启动失败');
          }
          fillHistoricalImport(payload.import_job);
          if (payload?.import_job?.job_id) {
            await pollHistoricalImportJob(payload.import_job.job_id);
          }
        } finally {
          refs.historicalImportRunButton.disabled = false;
        }
      }

      async function loadReasoningBehavior() {
        const url = getReasoningBehaviorRequestUrl(ui.reasoningBehaviorPath);
        const response = await fetch(url.toString(), { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取 reasoning 行为统计失败');
        }
        fillReasoningBehavior(payload);
      }

      async function loadLatestHistoricalImport() {
        const response = await fetch(ui.historicalImportPath + '/latest', { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取历史导入分析失败');
        }
        fillHistoricalImport(payload.import_job || null);
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
              retry_upstream_capacity_errors: refs.retryUpstreamCapacityErrorsInput.checked,
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
        await loadReasoningBehavior();
        await loadLatestHistoricalImport();
        await loadLogs(true);
      }

      refs.form.addEventListener('submit', saveConfig);
      applyTheme(getStoredTheme());
      if (refs.themeToggleButton) {
        refs.themeToggleButton.addEventListener('click', toggleTheme);
      }
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
      refs.reasoningRangeTodayButton.addEventListener('click', () => {
        const today = toLocalDateInputValue(new Date());
        setReasoningBehaviorDateRange(today, today);
        loadReasoningBehavior().catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.reasoningRangeWeekButton.addEventListener('click', () => {
        const today = new Date();
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - 6);
        setReasoningBehaviorDateRange(toLocalDateInputValue(weekStart), toLocalDateInputValue(today));
        loadReasoningBehavior().catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.reasoningRangeApplyButton.addEventListener('click', () => {
        setReasoningBehaviorDateRange(
          refs.reasoningDateFromInput.value || null,
          refs.reasoningDateToInput.value || null,
        );
        loadReasoningBehavior().catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.reasoningExportJsonButton.addEventListener('click', () => {
        openReasoningBehaviorExport('json').catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.reasoningExportCsvButton.addEventListener('click', () => {
        openReasoningBehaviorExport('csv').catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.reasoningTokenTableLimitSelect.addEventListener('change', () => {
        renderReasoningTokenTable(latestReasoningTokenRows);
      });
      refs.reasoningCandidatePatternLimitSelect.addEventListener('change', () => {
        renderReasoningCandidatePatterns(latestReasoningCandidatePatternRows);
      });
      refs.reasoningRecentSamplesLimitSelect.addEventListener('change', () => {
        renderReasoningRecentSamples(latestReasoningRecentSampleRows);
      });
      refs.reasoningAnalyzeButton.addEventListener('click', () => {
        runReasoningFeatureAnalysis().catch((error) => setMessage(error?.message || String(error), 'error'));
      });
      refs.historicalImportRunButton.addEventListener('click', () => {
        runHistoricalImportAnalysis().catch((error) => setMessage(error?.message || String(error), 'error'));
      });
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
        .then(() => loadReasoningBehavior())
        .then(() => loadLatestHistoricalImport())
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
      reasoning_behavior: buildReasoningBehaviorRuntimeSnapshot(runtime),
      model_insights: buildModelInsightsSnapshot(runtime),
      active_probe: buildActiveProbeSnapshot(runtime),
    });
    return true;
  }

  if (pathname === REASONING_BEHAVIOR_API_PATH && req.method === "GET") {
    const dateFrom = normalizeDateKeyInput(requestUrl.searchParams.get("date_from"));
    const dateTo = normalizeDateKeyInput(requestUrl.searchParams.get("date_to"));
    const rangeDays = countInclusiveDateRangeDays(dateFrom, dateTo);
    if (
      rangeDays !== null &&
      rangeDays > REASONING_BEHAVIOR_MAX_INLINE_RANGE_DAYS
    ) {
      jsonResponse(
        res,
        200,
        buildReasoningRangeDegradePayload(
          runtime,
          dateFrom,
          dateTo,
          REASONING_BEHAVIOR_MAX_INLINE_RANGE_DAYS,
        ),
      );
      return true;
    }
    const samples =
      dateFrom || dateTo
        ? await readReasoningBehaviorSamplesByDateRange(runtime, dateFrom, dateTo)
        : runtime.reasoningBehavior.recent_samples;
    const snapshot = buildReasoningBehaviorSnapshotFromSamples(samples, {
      recent_limit: 50,
    });
    jsonResponse(res, 200, {
      ok: true,
      ...buildReasoningBehaviorMetadata(runtime),
      date_from: dateFrom,
      date_to: dateTo,
      ...snapshot,
    });
    return true;
  }

  if (pathname === `${REASONING_BEHAVIOR_API_PATH}/analyze` && req.method === "POST") {
    const body = await readRequestBody(req, runtime.config.request_body_limit_bytes);
    const payload = body.length > 0 ? parseJsonSafely(body) : {};
    if (body.length > 0 && !payload) {
      jsonResponse(res, 400, {
        ok: false,
        error: {
          type: "invalid_request",
          code: "invalid_json",
          message: "reasoning 特征分析请求必须是有效 JSON。",
        },
      });
      return true;
    }
    const profile = buildReasoningAnalysisProfile(payload || {}, "runtime");
    const dateFrom = profile.filters.date_from;
    const dateTo = profile.filters.date_to;
    const rangeDays = countInclusiveDateRangeDays(dateFrom, dateTo);
    if (
      rangeDays !== null &&
      rangeDays > REASONING_BEHAVIOR_MAX_INLINE_RANGE_DAYS
    ) {
      jsonResponse(res, 200, {
        ok: true,
        ...buildFeatureAnalysisFromSamples([], profile),
        analysis_value: "partial",
        conclusion: "insufficient_fields",
        decision_reason: "分析时间段过大，已跳过明细读取；请缩小时间段后再运行特征分析。",
      });
      return true;
    }
    const samples =
      dateFrom || dateTo
        ? await readReasoningBehaviorSamplesByDateRange(runtime, dateFrom, dateTo)
        : runtime.reasoningBehavior.recent_samples;
    jsonResponse(res, 200, buildFeatureAnalysisFromSamples(samples, profile));
    return true;
  }

  if (pathname === REASONING_BEHAVIOR_EXPORT_API_PATH && req.method === "GET") {
    const format = `${requestUrl.searchParams.get("format") || "json"}`.trim().toLowerCase();
    const dateFrom = normalizeDateKeyInput(requestUrl.searchParams.get("date_from"));
    const dateTo = normalizeDateKeyInput(requestUrl.searchParams.get("date_to"));
    const rangeDays = countInclusiveDateRangeDays(dateFrom, dateTo);
    if (
      rangeDays !== null &&
      rangeDays >= REASONING_BEHAVIOR_BACKGROUND_EXPORT_MIN_DAYS
    ) {
      const job = startReasoningExportJob(runtime, {
        format,
        dateFrom,
        dateTo,
      });
      jsonResponse(res, 202, {
        ok: true,
        ...buildReasoningBehaviorMetadata(runtime),
        date_from: dateFrom,
        date_to: dateTo,
        background_export: true,
        message: "已创建后台导出任务，可以继续正常使用 gateway。",
        export_job: buildReasoningExportJobPublic(job),
      });
      return true;
    }
    const samples = await readReasoningBehaviorSamplesByDateRange(runtime, dateFrom, dateTo);
    const snapshot = buildReasoningBehaviorSnapshotFromSamples(samples, {
      recent_limit: Math.min(samples.length, 200),
    });
    if (format === "csv") {
      const csvText = buildReasoningBehaviorCsv(samples);
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        pragma: "no-cache",
      });
      res.end(csvText);
      return true;
    }
    jsonResponse(res, 200, {
      ok: true,
      exported_at: new Date().toISOString(),
      ...buildReasoningBehaviorMetadata(runtime),
      date_from: dateFrom,
      date_to: dateTo,
      schema_version: REASONING_BEHAVIOR_SCHEMA_VERSION,
      ...snapshot,
      samples,
    });
    return true;
  }

  const exportJobStatusMatch = pathname.match(
    /^\/__codex_retry_gateway\/api\/analytics\/reasoning\/export\/jobs\/([^/]+)$/,
  );
  if (exportJobStatusMatch && req.method === "GET") {
    const jobId = decodeURIComponent(exportJobStatusMatch[1]);
    const job = runtime.reasoningBehavior.export_jobs.get(jobId);
    if (!job) {
      jsonResponse(res, 404, {
        ok: false,
        error: {
          type: "not_found",
          code: "reasoning_export_job_not_found",
          message: "未找到 reasoning 导出任务。",
        },
      });
      return true;
    }
    jsonResponse(res, 200, {
      ok: true,
      ...buildReasoningBehaviorMetadata(runtime),
      export_job: buildReasoningExportJobPublic(job),
    });
    return true;
  }

  const exportJobDownloadMatch = pathname.match(
    /^\/__codex_retry_gateway\/api\/analytics\/reasoning\/export\/jobs\/([^/]+)\/download$/,
  );
  if (exportJobDownloadMatch && req.method === "GET") {
    const jobId = decodeURIComponent(exportJobDownloadMatch[1]);
    const job = runtime.reasoningBehavior.export_jobs.get(jobId);
    if (!job || job.status !== "completed" || !job.output_path) {
      jsonResponse(res, 404, {
        ok: false,
        error: {
          type: "not_found",
          code: "reasoning_export_job_not_ready",
          message: "reasoning 导出任务尚未完成或文件不存在。",
        },
      });
      return true;
    }
    const content = await readFile(job.output_path, "utf8");
    const contentType =
      job.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8";
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      "content-disposition": `attachment; filename="reasoning-export-${job.date_from}-${job.date_to}.${job.format}"`,
    });
    res.end(content);
    return true;
  }

  if (pathname === `${HISTORICAL_IMPORT_API_PATH}/run` && req.method === "POST") {
    const body = await readRequestBody(req, runtime.config.request_body_limit_bytes);
    const payload = body.length > 0 ? parseJsonSafely(body) : {};
    if (body.length > 0 && !payload) {
      jsonResponse(res, 400, {
        ok: false,
        error: {
          type: "invalid_request",
          code: "invalid_json",
          message: "历史导入分析请求必须是有效 JSON。",
        },
      });
      return true;
    }
    const job = startHistoricalImportJob(runtime, payload || {});
    jsonResponse(res, 202, {
      ok: true,
      message: "历史导入分析已在后台开始，可以继续正常使用 gateway。",
      import_job: buildHistoricalImportJobPublic(job),
    });
    return true;
  }

  if (pathname === `${HISTORICAL_IMPORT_API_PATH}/analyze` && req.method === "POST") {
    const body = await readRequestBody(req, runtime.config.request_body_limit_bytes);
    const payload = body.length > 0 ? parseJsonSafely(body) : {};
    if (body.length > 0 && !payload) {
      jsonResponse(res, 400, {
        ok: false,
        error: {
          type: "invalid_request",
          code: "invalid_json",
          message: "历史导入特征分析请求必须是有效 JSON。",
        },
      });
      return true;
    }
    const requestedJobId = normalizeNonEmptyString(payload?.job_id);
    const job = requestedJobId
      ? runtime.historicalImports.jobs.get(requestedJobId)
      : [...runtime.historicalImports.jobs.values()].sort((left, right) =>
          `${right.created_at || ""}`.localeCompare(`${left.created_at || ""}`),
        )[0] || null;
    if (!job) {
      jsonResponse(res, 404, {
        ok: false,
        error: {
          type: "not_found",
          code: "historical_import_job_not_found",
          message: "未找到可分析的历史导入任务。",
        },
      });
      return true;
    }
    jsonResponse(res, 200, {
      ok: true,
      ...buildHistoricalFeatureAnalysisFromJob(job, payload || {}),
    });
    return true;
  }

  if (pathname === `${HISTORICAL_IMPORT_API_PATH}/latest` && req.method === "GET") {
    const latestJob =
      [...runtime.historicalImports.jobs.values()].sort((left, right) =>
        `${right.created_at || ""}`.localeCompare(`${left.created_at || ""}`),
      )[0] || null;
    jsonResponse(res, 200, {
      ok: true,
      import_job: latestJob
        ? buildHistoricalImportJobPublic(latestJob)
        : runtime.historicalImports.last_summary,
    });
    return true;
  }

  const importJobStatusMatch = pathname.match(
    /^\/__codex_retry_gateway\/api\/analytics\/imports\/jobs\/([^/]+)$/,
  );
  if (importJobStatusMatch && req.method === "GET") {
    const jobId = decodeURIComponent(importJobStatusMatch[1]);
    const job = runtime.historicalImports.jobs.get(jobId);
    if (!job) {
      jsonResponse(res, 404, {
        ok: false,
        error: {
          type: "not_found",
          code: "historical_import_job_not_found",
          message: "未找到历史导入分析任务。",
        },
      });
      return true;
    }
    jsonResponse(res, 200, {
      ok: true,
      import_job: buildHistoricalImportJobPublic(job),
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
    const ruleTarget =
      nextConfig.intercept_rule_mode === INTERCEPT_RULE_MODE_FINAL_ONLY_HIGH_XHIGH
        ? "final_answer_only_high_xhigh efforts=high,xhigh"
        : `reasoning_equals=${nextConfig.reasoning_equals.join(",")}`;
    runtime.logger(
      `[config] updated intercept_rule_mode=${nextConfig.intercept_rule_mode} rule_target=${ruleTarget} retry_upstream_capacity_errors=${nextConfig.retry_upstream_capacity_errors !== false} endpoints=${nextConfig.endpoints.join(",")}`,
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
      reasoning_behavior: buildReasoningBehaviorRuntimeSnapshot(runtime),
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
        reasoning_behavior: buildReasoningBehaviorRuntimeSnapshot(runtime),
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
      reasoning_behavior: buildReasoningBehaviorRuntimeSnapshot(runtime),
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

function createRequestBodyLimitExceededError(limitBytes) {
  const error = new Error(`请求体超过限制: ${limitBytes} bytes`);
  error.code = "request_body_limit_exceeded";
  error.statusCode = 413;
  error.errorType = "gateway_rejection";
  error.logCategory = "gateway-reject";
  return error;
}

async function readRequestBody(req, limitBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw createRequestBodyLimitExceededError(limitBytes);
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

function isFinalAnswerOnlyStructure(structure) {
  return (
    Boolean(structure?.has_final_answer) &&
    !structure?.has_commentary &&
    !structure?.has_tool_call &&
    !structure?.has_reasoning_item
  );
}

function buildInterceptRuleMatch(config, reasoning, reasoningSample, structure) {
  const mode = normalizeInterceptRuleMode(config?.intercept_rule_mode);
  if (reasoningSample?.request_kind === REQUEST_KIND_CONTEXT_COMPACTION) {
    return {
      mode,
      matched: false,
      reasonForLog:
        `request_kind=${REQUEST_KIND_CONTEXT_COMPACTION} ` +
        `intercept_exempt_reason=${REQUEST_KIND_CONTEXT_COMPACTION} reasoning_tokens=${reasoning}`,
      blockedReasoning: reasoning,
      exemptReason: REQUEST_KIND_CONTEXT_COMPACTION,
    };
  }
  if (mode === INTERCEPT_RULE_MODE_FINAL_ONLY_HIGH_XHIGH) {
    const effort = normalizeReasoningEffort(reasoningSample?.request_reasoning_effort);
    const finalAnswerOnly = isFinalAnswerOnlyStructure(structure);
    return {
      mode,
      matched: finalAnswerOnly && FINAL_ONLY_INTERCEPT_EFFORTS.has(effort),
      reasonForLog:
        `final_answer_only=${finalAnswerOnly ? "true" : "false"} ` +
        `effort=${effort || "unknown"} reasoning_tokens=${reasoning}`,
      blockedReasoning: reasoning,
    };
  }
  return {
    mode,
    matched: reasoningMatched(config, reasoning),
    reasonForLog: `reasoning_tokens=${reasoning}`,
    blockedReasoning: reasoning,
  };
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
  runtime,
  config,
  logger,
  monitor,
  pathname,
  requestTracking,
  modelContext,
  reasoningSample,
  structureAccumulator,
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
    applyParsedUsageToReasoningSample(reasoningSample, parsed);
    applyStructureSignalsFromPayload(parsed, structureAccumulator);
  }
  const reasoning = parsed ? extractReasoningTokens(parsed) : null;
  const ruleMatch = buildInterceptRuleMatch(config, reasoning, reasoningSample, structureAccumulator);
  const matched = ruleMatch.matched;
  const capacityRetryMatched =
    config.retry_upstream_capacity_errors !== false &&
    isUpstreamCapacityErrorResponse(upstreamResponse, parsed, bodyBuffer);

  recordInspectedResponse(monitor, reasoning, matched, "non-stream");
  setRequestTrackingOutcome(requestTracking, "inspected");

  if (capacityRetryMatched) {
    const canGuardRetry = requestTracking?.guardRetryRemaining > 0;
    if (config.log_match) {
      const action = canGuardRetry
        ? `internal_retry remaining=${requestTracking.guardRetryRemaining}`
        : "pass_through";
      logger(
        `[upstream-capacity] non-stream path=${pathname} status=${upstreamResponse.status} action=${action}`,
      );
    }
    if (canGuardRetry) {
      recordBlockedResponse(monitor, "non-stream");
      finalizeModelInsights(monitor, pathname, modelContext, parsed);
      completeReasoningBehaviorSample({
        runtime,
        sample: reasoningSample,
        structure: structureAccumulator,
        modelContext,
        finalAction: "upstream_capacity_internal_retry",
        clientHttpStatus: null,
        matchedCurrentRule: false,
        blockedByGateway: true,
        failureSummary: buildFailureSummary(null, parsed),
      });
      return { guardRetry: true, retryReason: "upstream_capacity" };
    }
  }

  if (matched) {
    const shouldIntercept = config.intercept_non_streaming !== false;
    const canGuardRetry = shouldIntercept && requestTracking?.guardRetryRemaining > 0;
    if (config.log_match) {
      const action = !shouldIntercept
        ? "observe_only"
        : canGuardRetry
          ? `internal_retry remaining=${requestTracking.guardRetryRemaining}`
          : `return_status_${config.non_stream_status_code}`;
      logger(`[match] non-stream path=${pathname} ${ruleMatch.reasonForLog} action=${action} mode=${ruleMatch.mode}`);
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
        completeReasoningBehaviorSample({
          runtime,
          sample: reasoningSample,
          structure: structureAccumulator,
          modelContext,
          finalAction: "internal_retry",
          clientHttpStatus: null,
          matchedCurrentRule: true,
          blockedByGateway: true,
        });
        return { guardRetry: true };
      }
      const blockedBody = buildBlockedBody(pathname, ruleMatch.blockedReasoning, config.non_stream_status_code);
      res.writeHead(config.non_stream_status_code, {
        "content-type": "application/json; charset=utf-8",
        "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
      });
      res.end(blockedBody);
      completeReasoningBehaviorSample({
        runtime,
        sample: reasoningSample,
        structure: structureAccumulator,
        modelContext,
        finalAction: "blocked",
        clientHttpStatus: config.non_stream_status_code,
        matchedCurrentRule: true,
        blockedByGateway: true,
      });
      return { handled: true };
    }
    completeReasoningBehaviorSample({
      runtime,
      sample: reasoningSample,
      structure: structureAccumulator,
      modelContext,
      finalAction: "observe_only",
      clientHttpStatus: upstreamResponse.status,
      matchedCurrentRule: true,
      blockedByGateway: false,
    });
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
  if (!matched) {
    completeReasoningBehaviorSample({
      runtime,
      sample: reasoningSample,
      structure: structureAccumulator,
      modelContext,
      finalAction: "passed",
      clientHttpStatus: upstreamResponse.status,
      matchedCurrentRule: false,
      blockedByGateway: false,
    });
  }
  return { handled: true };
}

async function handleStreaming({
  runtime,
  config,
  logger,
  monitor,
  pathname,
  requestTracking,
  modelContext,
  reasoningSample,
  structureAccumulator,
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
  let sampleRecorded = false;
  let observedMatchedRule = false;
  let observedOnlyMatchedRule = false;
  const bufferedChunks = [];

  const finishReasoningSample = (options = {}) => {
    if (sampleRecorded) {
      return;
    }
    sampleRecorded = true;
    completeReasoningBehaviorSample({
      runtime,
      sample: reasoningSample,
      structure: structureAccumulator,
      modelContext,
      finalAction: options.finalAction || "passed",
      clientHttpStatus: options.clientHttpStatus ?? null,
      matchedCurrentRule: Boolean(options.matchedCurrentRule),
      blockedByGateway: Boolean(options.blockedByGateway),
      failureSummary: options.failureSummary || null,
    });
  };

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
          reasoningSample.upstream_stream_terminated = true;
          finishReasoningSample({
            finalAction: "upstream_stream_terminated",
            clientHttpStatus: 502,
            failureSummary: buildFailureSummary(error),
          });
        } else {
          res.end();
          reasoningSample.upstream_stream_terminated = true;
          finishReasoningSample({
            finalAction: "upstream_stream_terminated",
            clientHttpStatus: upstreamResponse.status,
            failureSummary: buildFailureSummary(error),
          });
        }
        return;
      }
      throw error;
    }

    const { done, value } = readResult;
    if (done) {
      const finalRuleMatch = buildInterceptRuleMatch(
        config,
        observedReasoning,
        reasoningSample,
        structureAccumulator,
      );
      if (!inspectedRecorded && finalRuleMatch.matched) {
        recordInspectedResponse(monitor, observedReasoning, true, "stream");
        inspectedRecorded = true;
        setRequestTrackingOutcome(requestTracking, "inspected");
        const shouldIntercept = config.intercept_streaming !== false;
        const canReturnBlockedStatus = strict502Mode;
        const canGuardRetry =
          shouldIntercept &&
          canReturnBlockedStatus &&
          requestTracking?.guardRetryRemaining > 0;
        if (config.log_match) {
          const action = !shouldIntercept || !canReturnBlockedStatus
            ? "observe_only"
            : canGuardRetry
              ? `internal_retry remaining=${requestTracking.guardRetryRemaining}`
              : `return_status_${config.non_stream_status_code}`;
          logger(
            `[match] stream path=${pathname} ${finalRuleMatch.reasonForLog} action=${action} mode=${finalRuleMatch.mode}`,
          );
        }
        observedMatchedRule = true;
        if (shouldIntercept && canReturnBlockedStatus) {
          recordBlockedResponse(monitor, "stream");
          finalizeModelInsights(monitor, pathname, modelContext);
          if (canGuardRetry) {
            finishReasoningSample({
              finalAction: "internal_retry",
              clientHttpStatus: null,
              matchedCurrentRule: true,
              blockedByGateway: true,
            });
            return { guardRetry: true };
          }
          const blockedBody = buildBlockedBody(
            pathname,
            finalRuleMatch.blockedReasoning,
            config.non_stream_status_code,
          );
          res.writeHead(config.non_stream_status_code, {
            "content-type": "application/json; charset=utf-8",
            "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
          });
          res.end(blockedBody);
          finishReasoningSample({
            finalAction: "blocked",
            clientHttpStatus: config.non_stream_status_code,
            matchedCurrentRule: true,
            blockedByGateway: true,
          });
          return { handled: true };
        }
        observedOnlyMatchedRule = true;
      }
      if (!inspectedRecorded) {
        recordInspectedResponse(monitor, observedReasoning, false, "stream");
        inspectedRecorded = true;
      }
      setRequestTrackingOutcome(requestTracking, "inspected");
      finalizeModelInsights(monitor, pathname, modelContext);
      if (strict502Mode) {
        copyHeadersToClient(upstreamResponse.headers, res);
        res.writeHead(upstreamResponse.status);
        const finalBody = Buffer.concat(bufferedChunks);
        res.end(finalBody);
      } else {
        res.end();
      }
      finishReasoningSample({
        finalAction: observedOnlyMatchedRule ? "observe_only" : "passed",
        clientHttpStatus: upstreamResponse.status,
        matchedCurrentRule: observedMatchedRule,
        blockedByGateway: false,
      });
      return;
    }

    const nowMs = Date.now();
    const chunkBuffer = Buffer.from(value);
    markReasoningSampleFirstChunk(reasoningSample, nowMs);
    markReasoningSampleFinalChunk(reasoningSample, nowMs);
    const { reasoning, payloads } = inspectSseChunk(sseState, value);
    for (const payload of payloads) {
      applyPayloadModelSignals(modelContext, payload, {
        fromStream: true,
        fromFinalResponse: payload?.type === "response.completed",
      });
      applyParsedUsageToReasoningSample(reasoningSample, payload);
      applyStructureSignalsFromPayload(payload, structureAccumulator, { fromStream: true });
      if (payloadHasVisibleContent(payload)) {
        markReasoningSampleFirstContent(reasoningSample, nowMs);
      }
    }
    if (Number.isInteger(reasoning)) {
      observedReasoning = reasoning;
    }
    const ruleMatch = buildInterceptRuleMatch(config, reasoning, reasoningSample, structureAccumulator);
    if (
      ruleMatch.mode === INTERCEPT_RULE_MODE_REASONING_TOKENS &&
      ruleMatch.matched
    ) {
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
        logger(`[match] stream path=${pathname} ${ruleMatch.reasonForLog} action=${action} mode=${ruleMatch.mode}`);
      }

      if (!shouldIntercept) {
        observedMatchedRule = true;
        observedOnlyMatchedRule = true;
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
          finishReasoningSample({
            finalAction: "internal_retry",
            clientHttpStatus: null,
            matchedCurrentRule: true,
            blockedByGateway: true,
          });
          return { guardRetry: true };
        }
        const blockedBody = buildBlockedBody(pathname, ruleMatch.blockedReasoning, config.non_stream_status_code);
        res.writeHead(config.non_stream_status_code, {
          "content-type": "application/json; charset=utf-8",
          "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
        });
        res.end(blockedBody);
        finishReasoningSample({
          finalAction: "blocked",
          clientHttpStatus: config.non_stream_status_code,
          matchedCurrentRule: true,
          blockedByGateway: true,
        });
      } else {
        abortController.abort();
        reader.cancel().catch(() => {});
        res.socket?.destroy();
        finalizeModelInsights(monitor, pathname, modelContext);
        finishReasoningSample({
          finalAction: "disconnect",
          clientHttpStatus: null,
          matchedCurrentRule: true,
          blockedByGateway: true,
        });
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
  requestTracking.gateway_request_id = nextGatewayRequestId(runtime.reasoningBehavior);
  requestTracking.pathname = pathname;
  requestTracking.method = req.method;
  requestTracking.request_started_at_ms = Date.now();
  requestTracking.localConfigModel = null;
  requestTracking.request_kind = detectRequestKind(req.headers, null);
  requestTracking.intercept_exempt_reason =
    requestTracking.request_kind === REQUEST_KIND_CONTEXT_COMPACTION
      ? REQUEST_KIND_CONTEXT_COMPACTION
      : null;
  req.__codexRetryGatewayRequestTracking = requestTracking;

  let requestBody;
  try {
    requestBody = await readRequestBody(req, config.request_body_limit_bytes);
  } catch (error) {
    const rejectedSample = buildReasoningBehaviorAttemptSample(runtime, requestTracking, 0, false);
    rejectedSample.request_summary = {
      body_bytes: config.request_body_limit_bytes,
      body_sha256: null,
      sanitized_headers: sanitizeRequestHeaders(req.headers),
    };
    finalizeReasoningBehaviorSample(rejectedSample, createStructureAccumulator(), {
      final_action: "request_rejected",
      client_http_status: Number.isInteger(error?.statusCode) ? error.statusCode : 413,
      failure_summary: buildFailureSummary(error),
      latest_log_seq: runtime.monitor.next_log_seq - 1,
    });
    recordReasoningBehaviorSample(runtime, rejectedSample);
    throw error;
  }
  const requestJson = isJsonContentType(req.headers["content-type"])
    ? parseJsonSafely(requestBody)
    : null;
  requestTracking.requestJson = requestJson;
  requestTracking.request_kind = detectRequestKind(req.headers, requestJson);
  requestTracking.intercept_exempt_reason =
    requestTracking.request_kind === REQUEST_KIND_CONTEXT_COMPACTION
      ? REQUEST_KIND_CONTEXT_COMPACTION
      : null;
  requestTracking.request_summary = buildRequestSummary(requestBody, req.headers);
  requestTracking.request_payload_excerpt = buildRequestPayloadExcerpt(requestBody);
  runtime.lastClientUserAgent =
    typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].trim() : "";
  buildActiveProbeRequestProfile(runtime, requestJson);
  const localConfigModel = await getLocalConfigModel(runtime);
  requestTracking.localConfigModel = localConfigModel;
  const requestIsStream = Boolean(requestJson?.stream);
  const upstreamUrl = buildUpstreamUrl(config.upstream_base_url, incomingUrl);
  const shouldInspect = matchPath(config, pathname);
  let guardRetryAttemptsUsed = 0;

  while (true) {
    runtime.monitor.total_proxy_request_count += 1;
    recordActiveProxyRequestStart(runtime.monitor, pathname);
    const abortController = new AbortController();
    const modelContext = createRequestModelContext(localConfigModel, requestJson?.model ?? null);
    const reasoningSample = buildReasoningBehaviorAttemptSample(
      runtime,
      requestTracking,
      guardRetryAttemptsUsed,
      requestIsStream,
    );
    const structureAccumulator = createStructureAccumulator();
    requestTracking.guardRetryRemaining = Math.max(
      0,
      Number(config.guard_retry_attempts || 0) - guardRetryAttemptsUsed,
    );
    reasoningSample.internal_retry_remaining = requestTracking.guardRetryRemaining;
    reasoningSample.upstream_fetch_started_at_ms = Date.now();
    reasoningSample.upstream_fetch_started_at = toIsoStringOrNull(
      reasoningSample.upstream_fetch_started_at_ms,
    );

    try {
      const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl, {
        method: req.method,
        headers: cloneHeadersForUpstream(req.headers),
        body: requestBody.length > 0 ? requestBody : undefined,
        signal: abortController.signal,
      }, logger);
      reasoningSample.upstream_headers_at_ms = Date.now();
      reasoningSample.upstream_headers_at = toIsoStringOrNull(
        reasoningSample.upstream_headers_at_ms,
      );
      reasoningSample.upstream_http_status = upstreamResponse.status;

      const upstreamContentType = upstreamResponse.headers.get("content-type");
      const responseIsStream =
        isSseContentType(upstreamContentType) ||
        (requestIsStream && !isJsonContentType(upstreamContentType));

      if (!shouldInspect) {
        const body = Buffer.from(await upstreamResponse.arrayBuffer());
        if (body.length > 0) {
          reasoningSample.final_chunk_at_ms = Date.now();
          reasoningSample.final_chunk_at = toIsoStringOrNull(reasoningSample.final_chunk_at_ms);
        }
        if (isJsonContentType(upstreamResponse.headers.get("content-type"))) {
          const parsed = parseJsonSafely(body);
          if (parsed) {
            applyPayloadModelSignals(modelContext, parsed, { fromFinalResponse: true });
            applyParsedUsageToReasoningSample(reasoningSample, parsed);
            applyStructureSignalsFromPayload(parsed, structureAccumulator);
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
        applyModelContextToReasoningSample(reasoningSample, modelContext);
        finalizeReasoningBehaviorSample(reasoningSample, structureAccumulator, {
          final_action: "bypassed",
          client_http_status: upstreamResponse.status,
          latest_log_seq: runtime.monitor.next_log_seq - 1,
        });
        recordReasoningBehaviorSample(runtime, reasoningSample);
        return;
      }

      const handlerResult = responseIsStream
        ? await handleStreaming({
            runtime,
            config,
            logger,
            monitor: runtime.monitor,
            pathname,
            requestTracking,
            modelContext,
            reasoningSample,
            structureAccumulator,
            upstreamResponse,
            res,
            abortController,
          })
        : await handleNonStreaming({
            runtime,
            config,
            logger,
            monitor: runtime.monitor,
            pathname,
            requestTracking,
            modelContext,
            reasoningSample,
            structureAccumulator,
            upstreamResponse,
            res,
          });

      if (handlerResult?.guardRetry && guardRetryAttemptsUsed < Number(config.guard_retry_attempts || 0)) {
        guardRetryAttemptsUsed += 1;
        continue;
      }
      return;
    } catch (error) {
      const failureAction = isRetryableUpstreamFetchError(error)
        ? "upstream_fetch_failed"
        : error?.code === "request_body_limit_exceeded"
          ? "request_rejected"
          : "gateway_error";
      applyModelContextToReasoningSample(reasoningSample, modelContext);
      finalizeReasoningBehaviorSample(reasoningSample, structureAccumulator, {
        final_action: failureAction,
        client_http_status: isRetryableUpstreamFetchError(error)
          ? 502
          : Number.isInteger(error?.statusCode)
            ? error.statusCode
            : null,
        failure_summary: buildFailureSummary(error),
        latest_log_seq: runtime.monitor.next_log_seq - 1,
      });
      recordReasoningBehaviorSample(runtime, reasoningSample);
      throw error;
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
    reasoningBehavior: createReasoningBehaviorState(),
    historicalImports: createHistoricalImportState(),
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
      const requestBodyLimitExceeded = error?.code === "request_body_limit_exceeded";
      if (upstreamFetchFailure) {
        logUpstreamFetchFailure(logger, req, error);
      } else if (requestBodyLimitExceeded) {
        const path = typeof req?.url === "string"
          ? normalizePath(new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`).pathname)
          : "(unknown)";
        logger(
          `[gateway-reject] request body too large path=${path} limit=${runtime.config.request_body_limit_bytes} message=${error?.message || error}`,
        );
      } else {
        logger(`[error] ${error?.stack || error}`);
      }
      if (!res.headersSent) {
        const statusCode = upstreamFetchFailure
          ? 502
          : Number.isInteger(error?.statusCode)
            ? error.statusCode
            : 502;
        res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              message: upstreamFetchFailure ? "upstream fetch failed" : `${error?.message || error}`,
              type: upstreamFetchFailure ? "upstream_error" : error?.errorType || "codex_retry_gateway_error",
              code: upstreamFetchFailure ? "upstream_fetch_failed" : error?.code || "gateway_error",
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
