#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_STATE_ROOT = path.join(os.homedir(), ".codex-retry-gateway");
export const DEFAULT_CODEX_CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_LISTEN_PORT = 4610;
export const DEFAULT_HEALTH_PATH = "/__codex_retry_gateway/health";

function escapeRegExp(value) {
  return `${value}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseOptions(argv, { booleanFlags = [] } = {}) {
  const options = { _: [] };
  const booleanSet = new Set(booleanFlags);

  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      options._.push(current);
      continue;
    }

    const flagName = current.slice(2);
    const optionKey = flagName.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (booleanSet.has(flagName)) {
      options[optionKey] = true;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue === undefined) {
      throw new Error(`Missing value for --${flagName}`);
    }
    options[optionKey] = nextValue;
    index += 1;
  }

  return options;
}

export function getGatewayRoot() {
  return path.resolve(import.meta.dirname, "..");
}

export function getGatewayStatePaths(stateRoot = DEFAULT_STATE_ROOT) {
  return {
    stateRoot,
    configDir: path.join(stateRoot, "config"),
    logDir: path.join(stateRoot, "logs"),
    backupDir: path.join(stateRoot, "backups"),
    configPath: path.join(stateRoot, "config", "config.json"),
    logPath: path.join(stateRoot, "logs", "gateway.log"),
    statePath: path.join(stateRoot, "state.json"),
    pidPath: path.join(stateRoot, "gateway.pid"),
  };
}

export function getGatewayBaseUrl(listenHost, listenPort) {
  return `http://${listenHost}:${listenPort}`;
}

export function getGatewayBaseUrlFromConfig(gatewayConfig) {
  if (!gatewayConfig) {
    return null;
  }
  if (!gatewayConfig.listen_host || gatewayConfig.listen_port === undefined || gatewayConfig.listen_port === null) {
    return null;
  }
  return getGatewayBaseUrl(`${gatewayConfig.listen_host}`, Number.parseInt(`${gatewayConfig.listen_port}`, 10));
}

export async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

export async function writeUtf8File(targetPath, content) {
  const parent = path.dirname(targetPath);
  if (parent && parent !== ".") {
    await ensureDirectory(parent);
  }
  await writeFile(targetPath, content, "utf8");
}

export async function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = await readFile(filePath, "utf8");
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw);
}

export async function writeJsonFile(filePath, value) {
  await writeUtf8File(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function getCodexProviderContext(codexConfigPath) {
  const content = await readFile(codexConfigPath, "utf8");
  const providerMatch = content.match(/^\s*model_provider\s*=\s*"([^"]+)"\s*$/m);
  if (!providerMatch) {
    throw new Error(`model_provider was not found in ${codexConfigPath}`);
  }

  const providerName = providerMatch[1];
  const sectionHeaderRegex = new RegExp(`^\\[model_providers\\.${escapeRegExp(providerName)}\\]\\s*$`, "m");
  const sectionHeaderMatch = sectionHeaderRegex.exec(content);
  if (!sectionHeaderMatch) {
    throw new Error(`[model_providers.${providerName}] was not found in ${codexConfigPath}`);
  }

  const sectionIndex = sectionHeaderMatch.index;
  const headerEndIndex = sectionIndex + sectionHeaderMatch[0].length;
  const remainder = content.slice(headerEndIndex);
  const nextSectionMatch = /^\[.*$/m.exec(remainder);
  const sectionEndIndex = nextSectionMatch ? headerEndIndex + nextSectionMatch.index : content.length;
  const sectionText = content.slice(sectionIndex, sectionEndIndex);
  const baseUrlMatch = sectionText.match(/^\s*base_url\s*=\s*"([^"]+)"\s*$/m);
  if (!baseUrlMatch) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }

  return {
    content,
    providerName,
    sectionText,
    sectionIndex,
    sectionLength: sectionText.length,
    currentBaseUrl: baseUrlMatch[1],
    baseUrlLineText: baseUrlMatch[0],
  };
}

export async function setCodexProviderBaseUrl({ codexConfigPath, providerName, newBaseUrl }) {
  const context = await getCodexProviderContext(codexConfigPath);
  if (context.providerName !== providerName) {
    throw new Error(`model_provider changed unexpectedly: expected ${providerName}, actual ${context.providerName}`);
  }

  let replaced = false;
  const updatedSection = context.sectionText.replace(
    /^(\s*base_url\s*=\s*")([^"]*)("\s*)$/m,
    (_, prefix, __existing, suffix) => {
      replaced = true;
      return `${prefix}${newBaseUrl}${suffix}`;
    },
  );
  if (!replaced) {
    throw new Error(`base_url was not found in [model_providers.${providerName}]`);
  }

  const updatedContent =
    context.content.slice(0, context.sectionIndex) +
    updatedSection +
    context.content.slice(context.sectionIndex + context.sectionLength);

  await writeUtf8File(codexConfigPath, updatedContent);
}

export function normalizeIntArray(values, fallback = [516]) {
  const source = values === undefined || values === null ? fallback : values;
  const queue = Array.isArray(source) ? source.flat(Infinity) : [source];
  const normalized = queue
    .map((value) => (typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [value]))
    .flat()
    .map((value) => Number.parseInt(`${value}`, 10))
    .filter((value) => Number.isInteger(value));

  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

export function normalizeStringArray(values, fallback = []) {
  const source = values === undefined || values === null ? fallback : values;
  const queue = Array.isArray(source) ? source.flat(Infinity) : [source];
  const normalized = queue
    .flatMap((value) => `${value ?? ""}`.split(/[\s,]+/))
    .map((value) => value.trim())
    .filter(Boolean);

  return normalized.length > 0 ? [...new Set(normalized)] : [...fallback];
}

export function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitGatewayHealth({
  listenHost,
  listenPort,
  healthPath,
  timeoutSeconds = 10,
}) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const healthUrl = `${getGatewayBaseUrl(listenHost, listenPort)}${healthPath}`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) {
        return response;
      }
    } catch {
      // ignore and retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Gateway health check timed out: ${healthUrl}`);
}

async function readTail(filePath, lineCount = 20) {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const raw = await readFile(filePath, "utf8");
  return raw.split(/\r?\n/).slice(-lineCount).join("\n").trim();
}

function openUrl(url) {
  let command;
  let args;
  if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function stopGateway({ stateRoot = DEFAULT_STATE_ROOT, quiet = false }) {
  const paths = getGatewayStatePaths(stateRoot);
  if (!fs.existsSync(paths.pidPath)) {
    return quiet ? null : "No running gateway PID file was found.";
  }

  const pidRaw = (await readFile(paths.pidPath, "utf8")).trim();
  if (!pidRaw) {
    await rm(paths.pidPath, { force: true });
    return quiet ? null : "Gateway PID file was empty and has been removed.";
  }

  const gatewayPid = Number.parseInt(pidRaw, 10);
  if (Number.isInteger(gatewayPid) && isProcessAlive(gatewayPid)) {
    try {
      process.kill(gatewayPid);
    } catch {
      // ignore first failure
    }

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && isProcessAlive(gatewayPid)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (isProcessAlive(gatewayPid)) {
      try {
        process.kill(gatewayPid, "SIGKILL");
      } catch {
        // ignore hard kill failure
      }
    }
  }

  await rm(paths.pidPath, { force: true });
  return quiet ? null : `Gateway stopped. PID=${gatewayPid}`;
}

export async function startGateway({
  stateRoot = DEFAULT_STATE_ROOT,
  configPath,
  logPath,
  restartIfRunning = false,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  const effectiveConfigPath = configPath || paths.configPath;
  const effectiveLogPath = logPath || paths.logPath;

  if (!fs.existsSync(effectiveConfigPath)) {
    throw new Error(`Gateway config file was not found: ${effectiveConfigPath}`);
  }

  await ensureDirectory(path.dirname(effectiveLogPath));

  if (fs.existsSync(paths.pidPath)) {
    const existingPidRaw = (await readFile(paths.pidPath, "utf8")).trim();
    if (existingPidRaw) {
      const existingPid = Number.parseInt(existingPidRaw, 10);
      if (Number.isInteger(existingPid) && isProcessAlive(existingPid)) {
        if (restartIfRunning) {
          await stopGateway({ stateRoot, quiet: true });
        } else {
          return `Gateway is already running. PID=${existingPid}`;
        }
      } else {
        await rm(paths.pidPath, { force: true });
      }
    }
  }

  const gatewayConfig = await readJsonFile(effectiveConfigPath);
  if (!gatewayConfig) {
    throw new Error(`Gateway config file could not be read: ${effectiveConfigPath}`);
  }

  const gatewayRoot = getGatewayRoot();
  const gatewayEntry = path.join(gatewayRoot, "gateway.mjs");
  if (!fs.existsSync(gatewayEntry)) {
    throw new Error(`Gateway entry file was not found: ${gatewayEntry}`);
  }

  const child = spawn(process.execPath, [gatewayEntry, "--config", effectiveConfigPath, "--log", effectiveLogPath], {
    cwd: gatewayRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  await writeUtf8File(paths.pidPath, `${child.pid}`);

  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!isProcessAlive(child.pid)) {
    const logTail = await readTail(effectiveLogPath, 20);
    throw new Error(`Gateway exited right after startup. PID=${child.pid}\n${logTail}`);
  }

  await waitGatewayHealth({
    listenHost: `${gatewayConfig.listen_host}`,
    listenPort: Number.parseInt(`${gatewayConfig.listen_port}`, 10),
    healthPath: `${gatewayConfig.health_path || DEFAULT_HEALTH_PATH}`,
  });

  return `Gateway started. PID=${child.pid}. Listen=${getGatewayBaseUrl(gatewayConfig.listen_host, gatewayConfig.listen_port)}`;
}

export async function installForCurrentProvider({
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  await ensureDirectory(paths.stateRoot);
  await ensureDirectory(paths.configDir);
  await ensureDirectory(paths.logDir);
  await ensureDirectory(paths.backupDir);

  if (!fs.existsSync(codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${codexConfigPath}`);
  }

  const providerContext = await getCodexProviderContext(codexConfigPath);
  const localGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);

  let originalBaseUrl = providerContext.currentBaseUrl;
  if (providerContext.currentBaseUrl === localGatewayBaseUrl) {
    if (!existingState?.original_base_url) {
      throw new Error("Provider already points to the local gateway, but original_base_url is missing from state.");
    }
    originalBaseUrl = `${existingState.original_base_url}`;
  }

  if (originalBaseUrl === localGatewayBaseUrl) {
    throw new Error("A real upstream_base_url could not be determined.");
  }

  const backupPath = path.join(paths.backupDir, `config-${new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15)}.toml`);
  await copyFile(codexConfigPath, backupPath);

  const existingGatewayConfig = await readJsonFile(paths.configPath);
  const defaultEndpoints = ["/responses", "/chat/completions", "/v1/responses", "/v1/chat/completions"];
  const mergedEndpoints = [];
  for (const endpoint of [
    ...normalizeStringArray(existingGatewayConfig?.endpoints, []),
    ...defaultEndpoints,
  ]) {
    if (!mergedEndpoints.includes(endpoint)) {
      mergedEndpoints.push(endpoint);
    }
  }

  const gatewayConfig = {
    listen_host: listenHost,
    listen_port: listenPort,
    upstream_base_url: originalBaseUrl,
    request_body_limit_bytes:
      existingGatewayConfig?.request_body_limit_bytes === undefined || existingGatewayConfig?.request_body_limit_bytes === null
        ? 10485760
        : Number.parseInt(`${existingGatewayConfig.request_body_limit_bytes}`, 10),
    endpoints: mergedEndpoints,
    reasoning_equals: normalizeIntArray(existingGatewayConfig?.reasoning_equals, [516]),
    non_stream_status_code:
      existingGatewayConfig?.non_stream_status_code === undefined || existingGatewayConfig?.non_stream_status_code === null
        ? 502
        : Number.parseInt(`${existingGatewayConfig.non_stream_status_code}`, 10),
    stream_action: existingGatewayConfig?.stream_action || "strict_502",
    log_match: existingGatewayConfig?.log_match === undefined ? true : Boolean(existingGatewayConfig.log_match),
    health_path: existingGatewayConfig?.health_path || DEFAULT_HEALTH_PATH,
  };

  const previousConfigContent = await readFile(codexConfigPath, "utf8");

  try {
    await writeJsonFile(paths.configPath, gatewayConfig);
    await setCodexProviderBaseUrl({
      codexConfigPath,
      providerName: providerContext.providerName,
      newBaseUrl: localGatewayBaseUrl,
    });

    await startGateway({
      stateRoot,
      configPath: paths.configPath,
      logPath: paths.logPath,
      restartIfRunning: true,
    });

    const state = {
      installed_at: new Date().toISOString(),
      codex_config_path: codexConfigPath,
      provider_name: providerContext.providerName,
      original_base_url: originalBaseUrl,
      gateway_base_url: localGatewayBaseUrl,
      gateway_config_path: paths.configPath,
      gateway_log_path: paths.logPath,
      gateway_pid_path: paths.pidPath,
      latest_backup_path: backupPath,
      state_root: paths.stateRoot,
    };
    await writeJsonFile(paths.statePath, state);

    return {
      provider: providerContext.providerName,
      upstream: originalBaseUrl,
      gateway: localGatewayBaseUrl,
      configPath: paths.configPath,
      backupPath,
    };
  } catch (error) {
    await writeUtf8File(codexConfigPath, previousConfigContent);
    await stopGateway({ stateRoot, quiet: true });
    throw error;
  }
}

export async function restoreCodexConfig({
  stateRoot = DEFAULT_STATE_ROOT,
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  const state = await readJsonFile(paths.statePath);
  if (!state) {
    throw new Error(`Install state file was not found: ${paths.statePath}`);
  }

  const backupPath = `${state.latest_backup_path || ""}`;
  if (!backupPath || !fs.existsSync(backupPath)) {
    throw new Error(`A restorable backup file was not found: ${backupPath}`);
  }

  await stopGateway({ stateRoot, quiet: true });
  await copyFile(backupPath, codexConfigPath);
  await rm(paths.statePath, { force: true });

  return {
    configPath: codexConfigPath,
    restoredFrom: backupPath,
  };
}

export async function launchUi({
  codexConfigPath = DEFAULT_CODEX_CONFIG_PATH,
  stateRoot = DEFAULT_STATE_ROOT,
  listenHost = DEFAULT_LISTEN_HOST,
  listenPort = DEFAULT_LISTEN_PORT,
  noOpen = false,
}) {
  const paths = getGatewayStatePaths(stateRoot);
  await ensureDirectory(paths.stateRoot);
  await ensureDirectory(paths.configDir);
  await ensureDirectory(paths.logDir);
  await ensureDirectory(paths.backupDir);

  if (!fs.existsSync(codexConfigPath)) {
    throw new Error(`Codex config file was not found: ${codexConfigPath}`);
  }

  const providerContext = await getCodexProviderContext(codexConfigPath);
  const currentBaseUrl = `${providerContext.currentBaseUrl}`;
  const requestedGatewayBaseUrl = getGatewayBaseUrl(listenHost, listenPort);
  const existingState = await readJsonFile(paths.statePath);
  const existingGatewayConfig = await readJsonFile(paths.configPath);
  const stateGatewayBaseUrl = existingState?.gateway_base_url ? `${existingState.gateway_base_url}` : null;
  const configGatewayBaseUrl = getGatewayBaseUrlFromConfig(existingGatewayConfig);
  const managedGatewayBaseUrls = [requestedGatewayBaseUrl];
  for (const candidate of [stateGatewayBaseUrl, configGatewayBaseUrl]) {
    if (candidate && !managedGatewayBaseUrls.includes(candidate)) {
      managedGatewayBaseUrls.push(candidate);
    }
  }

  const originalBaseUrl =
    existingState?.original_base_url
      ? `${existingState.original_base_url}`
      : existingGatewayConfig?.upstream_base_url
        ? `${existingGatewayConfig.upstream_base_url}`
        : null;

  const canReuseExistingInstall =
    existingGatewayConfig &&
    originalBaseUrl &&
    managedGatewayBaseUrls.includes(currentBaseUrl);

  let mode = "install";
  if (!canReuseExistingInstall) {
    await installForCurrentProvider({
      codexConfigPath,
      stateRoot,
      listenHost,
      listenPort,
    });
  } else {
    mode = "reuse";
    const previousCodexConfigContent = await readFile(codexConfigPath, "utf8");
    const previousGatewayConfigContent = fs.existsSync(paths.configPath)
      ? await readFile(paths.configPath, "utf8")
      : null;
    const previousStateContent = fs.existsSync(paths.statePath)
      ? await readFile(paths.statePath, "utf8")
      : null;

    try {
      existingGatewayConfig.listen_host = listenHost;
      existingGatewayConfig.listen_port = listenPort;
      if (!existingGatewayConfig.health_path) {
        existingGatewayConfig.health_path = DEFAULT_HEALTH_PATH;
      }
      await writeJsonFile(paths.configPath, existingGatewayConfig);

      if (currentBaseUrl !== requestedGatewayBaseUrl) {
        await setCodexProviderBaseUrl({
          codexConfigPath,
          providerName: providerContext.providerName,
          newBaseUrl: requestedGatewayBaseUrl,
        });
      }

      await startGateway({
        stateRoot,
        configPath: paths.configPath,
        logPath: paths.logPath,
        restartIfRunning: true,
      });

      const statePayload = {
        installed_at: existingState?.installed_at ? `${existingState.installed_at}` : new Date().toISOString(),
        last_started_at: new Date().toISOString(),
        codex_config_path: codexConfigPath,
        provider_name: providerContext.providerName,
        original_base_url: originalBaseUrl,
        gateway_base_url: requestedGatewayBaseUrl,
        gateway_config_path: paths.configPath,
        gateway_log_path: paths.logPath,
        gateway_pid_path: paths.pidPath,
        latest_backup_path: existingState?.latest_backup_path ? `${existingState.latest_backup_path}` : "",
        state_root: paths.stateRoot,
      };
      await writeJsonFile(paths.statePath, statePayload);
    } catch (error) {
      await writeUtf8File(codexConfigPath, previousCodexConfigContent);
      if (previousGatewayConfigContent !== null) {
        await writeUtf8File(paths.configPath, previousGatewayConfigContent);
      }
      if (previousStateContent !== null) {
        await writeUtf8File(paths.statePath, previousStateContent);
      }
      await stopGateway({ stateRoot, quiet: true });
      throw error;
    }
  }

  const effectiveGatewayConfig = await readJsonFile(paths.configPath);
  const effectiveGatewayBaseUrl = getGatewayBaseUrlFromConfig(effectiveGatewayConfig) || requestedGatewayBaseUrl;
  const uiUrl = `${effectiveGatewayBaseUrl}/__codex_retry_gateway/ui`;

  if (!noOpen) {
    openUrl(uiUrl);
  }

  return {
    mode,
    uiUrl,
    gatewayBaseUrl: effectiveGatewayBaseUrl,
  };
}
