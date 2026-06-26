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
const RESTORE_API_PATH = `${ADMIN_BASE_PATH}/api/restore`;

const DEFAULT_CONFIG = {
  listen_host: "127.0.0.1",
  listen_port: 4610,
  upstream_base_url: "",
  request_body_limit_bytes: 10 * 1024 * 1024,
  endpoints: ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"],
  reasoning_equals: [516],
  non_stream_status_code: 502,
  stream_action: "strict_502",
  log_match: true,
  health_path: "/__codex_retry_gateway/health",
};

const REASONING_POINTERS = [
  "/usage/output_tokens_details/reasoning_tokens",
  "/usage/completion_tokens_details/reasoning_tokens",
  "/response/usage/output_tokens_details/reasoning_tokens",
  "/response/usage/completion_tokens_details/reasoning_tokens",
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
      "  非流式命中 reasoning_tokens=516 时返回 502。",
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

function createMonitor() {
  return {
    started_at: new Date().toISOString(),
    next_log_seq: 1,
    log_entries: [],
    total_proxy_request_count: 0,
    inspected_response_count: 0,
    matched_response_count: 0,
    observed_reasoning_counts: {},
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

function recordInspectedResponse(monitor, reasoning, matched) {
  monitor.inspected_response_count += 1;
  incrementReasoningCount(monitor.observed_reasoning_counts, reasoning);
  if (matched) {
    monitor.matched_response_count += 1;
  }
}

function buildMetricsSnapshot(monitor) {
  const reasoning516Count = monitor.observed_reasoning_counts["516"] || 0;
  const inspectedResponseCount = monitor.inspected_response_count;
  return {
    started_at: monitor.started_at,
    total_proxy_request_count: monitor.total_proxy_request_count,
    inspected_response_count: inspectedResponseCount,
    matched_response_count: monitor.matched_response_count,
    reasoning_516_count: reasoning516Count,
    reasoning_516_ratio:
      inspectedResponseCount === 0 ? 0 : reasoning516Count / inspectedResponseCount,
    observed_reasoning_counts: { ...monitor.observed_reasoning_counts },
  };
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

async function loadConfig(configPath) {
  const content = await readFile(configPath, "utf8");
  const loaded = JSON.parse(content);
  const config = { ...DEFAULT_CONFIG, ...loaded };
  config.endpoints = normalizeStringList(config.endpoints, DEFAULT_CONFIG.endpoints).map(normalizePath);
  config.reasoning_equals = normalizeIntegerList(
    config.reasoning_equals,
    DEFAULT_CONFIG.reasoning_equals,
  );
  if (!config.upstream_base_url) {
    throw new Error("配置缺少 upstream_base_url");
  }
  return config;
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
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function htmlResponse(res, html) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function buildEditableConfig(currentConfig, payload) {
  const nextReasoning = normalizeIntegerList(payload.reasoning_equals, currentConfig.reasoning_equals);
  const nextEndpoints = normalizeStringList(payload.endpoints, currentConfig.endpoints).map(normalizePath);
  const nextStatusCode =
    payload.non_stream_status_code === undefined
      ? currentConfig.non_stream_status_code
      : Number.parseInt(`${payload.non_stream_status_code}`, 10);

  if (nextReasoning.length === 0) {
    throw new Error("reasoning_equals 不能为空");
  }
  if (nextEndpoints.length === 0) {
    throw new Error("endpoints 不能为空");
  }
  if (!Number.isInteger(nextStatusCode) || nextStatusCode < 100 || nextStatusCode > 599) {
    throw new Error("non_stream_status_code 必须是 100-599 的整数");
  }

  return {
    ...currentConfig,
    reasoning_equals: nextReasoning,
    endpoints: nextEndpoints,
    non_stream_status_code: nextStatusCode,
    log_match: payload.log_match === undefined ? currentConfig.log_match : Boolean(payload.log_match),
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

      h1 {
        margin: 16px 0 8px;
        font-size: clamp(30px, 6vw, 48px);
        line-height: 1.05;
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
        gap: 10px;
        padding: 12px 14px;
        border-radius: 16px;
        background: var(--panel-strong);
        border: 1px solid rgba(31, 29, 26, 0.08);
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
        <h1>Codex Retry Gateway</h1>
        <p class="lead">
          这个页面直接挂在正在运行的 gateway 上。你可以在这里查看当前接管状态、修改 516 拦截条件，并一键恢复 Codex 原设置。
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
              <div class="stat"><label>516 命中次数</label><strong id="reasoning516CountValue">0</strong></div>
              <div class="stat"><label>516 占比</label><strong id="reasoning516RatioValue">0.00%</strong></div>
              <div class="stat"><label>当前规则命中总数</label><strong id="matchedCountValue">0</strong></div>
            </div>
            <p class="footnote">
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
                <input id="reasoningInput" name="reasoning_equals" type="text" placeholder="例如：516, 1024" />
                <div class="hint">多个值用英文逗号或空格分隔。</div>
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
      </div>
    </div>

    <script>
      const ui = ${JSON.stringify(uiConfig)};
      const refs = {
        form: document.getElementById('configForm'),
        reasoningInput: document.getElementById('reasoningInput'),
        endpointsInput: document.getElementById('endpointsInput'),
        statusCodeInput: document.getElementById('statusCodeInput'),
        logMatchInput: document.getElementById('logMatchInput'),
        saveButton: document.getElementById('saveButton'),
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
        reasoning516CountValue: document.getElementById('reasoning516CountValue'),
        reasoning516RatioValue: document.getElementById('reasoning516RatioValue'),
        matchedCountValue: document.getElementById('matchedCountValue'),
        logsMeta: document.getElementById('logsMeta'),
        logsOutput: document.getElementById('logsOutput'),
      };
      let hasLoadedForm = false;
      let lastLogSeq = 0;
      let pollTimer = null;
      let stoppedByRestore = false;

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

      function fillStatus(payload) {
        refs.listenValue.textContent = payload.listen || '-';
        refs.upstreamValue.textContent = payload.config?.upstream_base_url || '-';
        refs.providerValue.textContent = payload.state?.provider_name || '未检测到安装状态';
        refs.codexBaseUrlValue.textContent = payload.state?.codex_current_base_url || '-';
        refs.configPathValue.textContent = payload.paths?.config_path || '-';
        refs.backupPathValue.textContent = payload.state?.latest_backup_path || '-';
        fillMetrics(payload.metrics || {});
      }

      function fillMetrics(metrics) {
        refs.startedAtValue.textContent = formatTimestamp(metrics.started_at);
        refs.proxyRequestCountValue.textContent = String(metrics.total_proxy_request_count ?? 0);
        refs.inspectedCountValue.textContent = String(metrics.inspected_response_count ?? 0);
        refs.reasoning516CountValue.textContent = String(metrics.reasoning_516_count ?? 0);
        refs.reasoning516RatioValue.textContent = formatPercent(metrics.reasoning_516_ratio ?? 0);
        refs.matchedCountValue.textContent = String(metrics.matched_response_count ?? 0);
      }

      function fillForm(config) {
        refs.reasoningInput.value = Array.isArray(config?.reasoning_equals) ? config.reasoning_equals.join(', ') : '';
        refs.endpointsInput.value = Array.isArray(config?.endpoints) ? config.endpoints.join('\\n') : '';
        refs.statusCodeInput.value = config?.non_stream_status_code ?? 502;
        refs.logMatchInput.checked = Boolean(config?.log_match);
      }

      function renderLogs(payload, replaceAll) {
        const entries = Array.isArray(payload?.entries) ? payload.entries : [];
        const rendered = entries
          .map((entry) => {
            const at = entry?.at ? entry.at : '-';
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
        const url = new URL(ui.logsPath, window.location.origin);
        if (incremental && lastLogSeq > 0) {
          url.searchParams.set('since_seq', String(lastLogSeq));
        }
        const response = await fetch(url.toString(), { cache: 'no-store' });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取日志失败');
        }
        renderLogs(payload, !incremental || lastLogSeq === 0);
      }

      async function loadStatus(options) {
        const refreshForm = Boolean(options?.refreshForm);
        const response = await fetch(ui.statusPath);
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error?.message || '读取状态失败');
        }
        fillStatus(payload);
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
          const response = await fetch(ui.configPath, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              reasoning_equals: parseReasoningInput(),
              endpoints: parseEndpointsInput(),
              non_stream_status_code: Number.parseInt(refs.statusCodeInput.value, 10),
              log_match: refs.logMatchInput.checked,
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
        await Promise.all([
          loadStatus({ refreshForm: false }),
          loadLogs(true),
        ]);
      }

      refs.form.addEventListener('submit', saveConfig);
      refs.restoreButton.addEventListener('click', restoreConfig);

      Promise.all([
        loadStatus({ refreshForm: true }),
        loadLogs(false),
      ])
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

  if (pathname === UI_PATH) {
    htmlResponse(res, buildManagementHtml());
    return true;
  }

  if (pathname === STATUS_API_PATH && req.method === "GET") {
    const state = await readRuntimeState(runtime);
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

    const nextConfig = buildEditableConfig(runtime.config, payload);
    await writeConfig(runtime.configPath, nextConfig);
    runtime.config = nextConfig;
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
  const decoded = state.decoder.decode(chunk, { stream: true });
  state.buffer += decoded;

  const blocks = state.buffer.split(/\r?\n\r?\n/);
  state.buffer = blocks.pop() ?? "";

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
      const parsed = JSON.parse(payloadText);
      const reasoning = extractReasoningTokens(parsed);
      if (reasoning !== null) {
        return reasoning;
      }
    } catch {
      // ignore malformed SSE payloads
    }
  }
  return null;
}

async function handleNonStreaming({
  config,
  logger,
  monitor,
  pathname,
  upstreamResponse,
  res,
}) {
  const bodyBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  const parsed = isJsonContentType(upstreamResponse.headers.get("content-type"))
    ? parseJsonSafely(bodyBuffer)
    : null;
  const reasoning = parsed ? extractReasoningTokens(parsed) : null;
  const matched = reasoningMatched(config, reasoning);

  recordInspectedResponse(monitor, reasoning, matched);

  if (matched) {
    if (config.log_match) {
      logger(
        `[match] non-stream path=${pathname} reasoning_tokens=${reasoning} action=status_${config.non_stream_status_code}`,
      );
    }
    const blockedBody = buildBlockedBody(pathname, reasoning, config.non_stream_status_code);
    res.writeHead(config.non_stream_status_code, {
      "content-type": "application/json; charset=utf-8",
      "x-codex-retry-gateway-reason": "reasoning-guard-triggered",
    });
    res.end(blockedBody);
    return;
  }

  copyHeadersToClient(upstreamResponse.headers, res);
  res.writeHead(upstreamResponse.status);
  res.end(bodyBuffer);
}

async function handleStreaming({
  config,
  logger,
  monitor,
  pathname,
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
        recordInspectedResponse(monitor, observedReasoning, false);
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
      recordInspectedResponse(monitor, observedReasoning, false);
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
    const reasoning = inspectSseChunk(sseState, value);
    if (Number.isInteger(reasoning)) {
      observedReasoning = reasoning;
    }
    if (reasoningMatched(config, reasoning)) {
      recordInspectedResponse(monitor, reasoning, true);
      if (config.log_match) {
        logger(
          `[match] stream path=${pathname} reasoning_tokens=${reasoning} action=${config.stream_action}`,
        );
      }

      if (strict502Mode || !wroteAnyChunk) {
        abortController.abort();
        reader.cancel().catch(() => {});
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
      }
      return;
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

  runtime.monitor.total_proxy_request_count += 1;

  const requestBody = await readRequestBody(req, config.request_body_limit_bytes);
  const requestJson = isJsonContentType(req.headers["content-type"])
    ? parseJsonSafely(requestBody)
    : null;
  const requestIsStream = Boolean(requestJson?.stream);

  const upstreamUrl = buildUpstreamUrl(config.upstream_base_url, incomingUrl);
  const abortController = new AbortController();

  const upstreamResponse = await fetchUpstreamWithRetry(upstreamUrl, {
    method: req.method,
    headers: cloneHeadersForUpstream(req.headers),
    body: requestBody.length > 0 ? requestBody : undefined,
    signal: abortController.signal,
  }, logger);

  const shouldInspect = matchPath(config, pathname);
  const responseIsStream =
    requestIsStream || isSseContentType(upstreamResponse.headers.get("content-type"));

  if (!shouldInspect) {
    copyHeadersToClient(upstreamResponse.headers, res);
    res.writeHead(upstreamResponse.status);
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    res.end(body);
    return;
  }

  if (responseIsStream) {
    await handleStreaming({
      config,
      logger,
      monitor: runtime.monitor,
      pathname,
      upstreamResponse,
      res,
      abortController,
    });
    return;
  }

  await handleNonStreaming({
    config,
    logger,
    monitor: runtime.monitor,
    pathname,
    upstreamResponse,
    res,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || path.join(__dirname, "config.json");
  const config = await loadConfig(configPath);
  const monitor = createMonitor();

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
    paths: buildRuntimePaths(configPath, args.log || null),
    server: null,
  };

  const server = http.createServer(async (req, res) => {
    try {
      await proxyRequest(runtime, req, res);
    } catch (error) {
      logger(`[error] ${error?.stack || error}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error: {
              message: `${error?.message || error}`,
              type: "codex_retry_gateway_error",
              code: "gateway_error",
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
  });
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
