#!/usr/bin/env node
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { execFileSync, spawn } = require("child_process");
const { buildV2SnapshotFromThreads, buildV2ThreadDetail } = require("./src/v2/api/snapshot");
const { readV2RawThreads, enrichThreadsWithTags } = require("./src/v2/codex-state/reader");
const { readTagsByThread: readV2TagsByThread, setThreadTags: setV2ThreadTags } = require("./src/v2/store/tags");
const { readPreferences, patchPreferences } = require("./src/v2/store/preferences");
const { ATTENTION_REASONS, ATTENTION_REASON_ENUM, CONFIDENCE_LEVELS, EVIDENCE_KINDS, THREAD_STATUSES } = require("./src/v2/contracts/thread-contracts");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const root = __dirname;
const publicDir = path.join(root, "public");
const packageJson = readJsonFileSync(path.join(root, "package.json"), {});
const projectConfig = readJsonFileSync(path.join(root, ".agentqueue.json"), {});
const installMetadataPath = process.env.AGENTQUEUE_INSTALL_METADATA || path.join(root, ".agentqueue-install.json");
const home = process.env.USERPROFILE || process.env.HOME || "";
const codexHome = process.env.CODEX_HOME || projectConfig.codexHome || path.join(home, ".codex");
const claudeHome = process.env.CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || projectConfig.claudeHome || path.join(home, ".claude");
const copilotHome = process.env.COPILOT_HOME || projectConfig.copilotHome || path.join(home, ".copilot");
const defaultRepo = packageJson.repository?.url || "https://github.com/pa911-eric/AgentQueue.git";

const candidateIndexPaths = [
  path.join(codexHome, "session_index.jsonl"),
  path.join(codexHome, "sessions", "session_index.jsonl"),
];

// Codex (OpenAI) local state locations.
const globalStatePath = path.join(codexHome, ".codex-global-state.json");
const processManagerPath = path.join(codexHome, "process_manager", "chat_processes.json");
const sessionsRoot = path.join(codexHome, "sessions");
const stateDbPath = path.join(codexHome, "state_5.sqlite");
const goalsDbPath = path.join(codexHome, "goals_1.sqlite");
const logsDbPath = path.join(codexHome, "logs_2.sqlite");

// Claude Code (Anthropic) local state locations.
const claudeProjectsRoot = path.join(claudeHome, "projects");

// GitHub Copilot Desktop local state locations.
const copilotSessionStateRoot = path.join(copilotHome, "session-state");
const copilotDataDbPath = path.join(copilotHome, "data.db");
const copilotSessionStoreDbPath = path.join(copilotHome, "session-store.db");

function codexStatePresent() {
  return fsSync.existsSync(stateDbPath)
    || candidateIndexPaths.some((filePath) => fsSync.existsSync(filePath))
    || fsSync.existsSync(sessionsRoot);
}

function claudeStatePresent() {
  return fsSync.existsSync(claudeProjectsRoot);
}

function copilotStatePresent() {
  return fsSync.existsSync(copilotSessionStateRoot);
}

// Auto mode reads every local runtime with state. Override with
// AGENTQUEUE_PROVIDER=claude|codex|copilot (or "provider" in .agentqueue.json).
function detectProviders() {
  const explicit = String(process.env.AGENTQUEUE_PROVIDER || projectConfig.provider || "").trim().toLowerCase();
  if (explicit === "claude" || explicit === "codex" || explicit === "copilot") return [explicit];
  const detected = [];
  if (codexStatePresent()) detected.push("codex");
  if (claudeStatePresent()) detected.push("claude");
  if (copilotStatePresent()) detected.push("copilot");
  return detected.length ? detected : ["codex"];
}
const activeProviders = detectProviders();
const provider = activeProviders.length > 1 ? "mixed" : activeProviders[0];
const providerLabels = { codex: "Codex", claude: "Claude Code", copilot: "GitHub Copilot Desktop", mixed: "Mixed" };
const providerLabel = provider === "mixed"
  ? activeProviders.map((name) => providerLabels[name] || name).join(" + ")
  : providerLabels[provider] || provider;

// AgentQueue keeps sidecar files next to each runtime's state.
const dataHome = provider === "claude" ? claudeHome : (provider === "copilot" ? copilotHome : codexHome);
const codexTagsPath = path.join(codexHome, "agentqueue-tags.json");
const claudeTagsPath = path.join(claudeHome, "agentqueue-tags.json");
const copilotTagsPath = path.join(copilotHome, "agentqueue-tags.json");
const tagsPath = path.join(dataHome, "agentqueue-tags.json");
const webhooksPath = path.join(dataHome, "agentqueue-webhooks.json");
const claudeLocalStatePath = path.join(claudeHome, "agentqueue-localstate.json");
const copilotLocalStatePath = path.join(copilotHome, "agentqueue-localstate.json");
const localStatePath = provider === "copilot" ? copilotLocalStatePath : claudeLocalStatePath;
function minutesFromEnv(name, fallback, legacyName = null) {
  const value = Number(process.env[name] ?? (legacyName ? process.env[legacyName] : undefined));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function minutesFromConfig(envName, configName, fallback, legacyName = null) {
  const configuredFallback = Number(projectConfig[configName]);
  return minutesFromEnv(
    envName,
    Number.isFinite(configuredFallback) && configuredFallback > 0 ? configuredFallback : fallback,
    legacyName
  );
}

function parseJsonText(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ""));
}

function readJsonFileSync(filePath, fallback) {
  try {
    return parseJsonText(fsSync.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function boolFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function repoSlugFromUrl(value) {
  const text = String(value || "").trim();
  const match = text.match(/github\.com[/:]([^/\s]+)\/([^/\s.]+)(?:\.git)?/i);
  if (!match) return "";
  return `${match[1]}/${match[2]}`;
}

function versionParts(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function runGit(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }).trim();
}

function getGitInfo() {
  try {
    const inside = runGit(["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return { available: true, isRepo: false };
    const remote = runGit(["remote", "get-url", "origin"]);
    const branch = runGit(["branch", "--show-current"]);
    const status = runGit(["status", "--porcelain"]);
    const commit = runGit(["rev-parse", "--short", "HEAD"]);
    return {
      available: true,
      isRepo: true,
      remote,
      repo: repoSlugFromUrl(remote),
      branch,
      dirty: Boolean(status),
      status,
      commit,
    };
  } catch (error) {
    return { available: false, isRepo: false, error: error.message };
  }
}

function expectedRepoSlug() {
  return repoSlugFromUrl(defaultRepo) || repoSlugFromUrl(getGitInfo().remote) || "pa911-eric/AgentQueue";
}

async function fetchLatestRelease(repo = expectedRepoSlug()) {
  if (!repo || boolFromEnv("AGENTQUEUE_UPDATE_CHECK_DISABLED") || boolFromEnv("AGENTQUEUE_UPDATE_CHECK", true) === false) {
    return { available: false, disabled: true };
  }

  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": `AgentQueue/${packageJson.version || "0.0.0"}`,
    },
  });

  if (response.status === 404) {
    return { available: false, repo, reason: "No GitHub release found" };
  }
  if (!response.ok) {
    return { available: false, repo, reason: `GitHub returned ${response.status}` };
  }

  const release = await response.json();
  const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
  return {
    available: true,
    repo,
    currentVersion: packageJson.version || "0.0.0",
    latestVersion,
    latestTag: release.tag_name || latestVersion,
    updateAvailable: compareVersions(latestVersion, packageJson.version || "0.0.0") > 0,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    name: release.name || release.tag_name || latestVersion,
  };
}

function ensureInstallMetadata() {
  if (fsSync.existsSync(installMetadataPath)) return;
  const git = getGitInfo();
  const metadata = {
    installedFrom: git.isRepo ? "github-git" : "local",
    repo: git.repo || expectedRepoSlug(),
    version: packageJson.version || "0.0.0",
    updateChannel: "stable",
    installedAt: new Date().toISOString(),
    lastUpdateCheck: null,
  };
  fsSync.writeFileSync(installMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function updateInstallMetadata(fields) {
  const current = readJsonFileSync(installMetadataPath, {});
  await fs.writeFile(installMetadataPath, `${JSON.stringify({ ...current, ...fields }, null, 2)}\n`, "utf8");
}

function openBrowser(url) {
  const platform = process.platform;
  const commandName = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(commandName, args, { detached: true, stdio: "ignore" });
  child.unref();
}

const statusWindows = {
  completeMs: minutesFromConfig("AGENTQUEUE_COMPLETE_MINUTES", "completeMinutes", 10, "CODEX_THREAD_OPS_COMPLETE_MINUTES") * 60 * 1000,
  recentMs: minutesFromConfig("AGENTQUEUE_RECENT_MINUTES", "recentMinutes", 120, "CODEX_THREAD_OPS_RECENT_MINUTES") * 60 * 1000,
  runningStaleMs: minutesFromConfig("AGENTQUEUE_STALE_MINUTES", "staleMinutes", 15, "CODEX_THREAD_OPS_STALE_MINUTES") * 60 * 1000,
};

const sessionCache = new Map();
const usageCache = {
  expiresAt: 0,
  payload: null,
};
const webhookStatuses = ["running", "complete", "recent", "today", "done"];
const webhookDefaults = {
  enabled: false,
  endpoint: "",
  signingToken: "",
  includeSubagents: true,
  statuses: {
    running: true,
    complete: true,
    recent: false,
    today: false,
    done: false,
  },
  messages: {
    running: "{{title}} is running",
    complete: "{{title}} completed",
    recent: "{{title}} moved to Recent",
    today: "{{title}} moved to Today",
    done: "{{title}} moved to Done",
    default: "{{title}} changed from {{previousStatus}} to {{status}}",
  },
  headers: {},
  timeoutMs: 8000,
};
let webhookThreadState = null;
let webhookWatcher = null;
let webhookProcessQueue = Promise.resolve();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function sendMethodNotAllowed(res, methods) {
  res.writeHead(405, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    allow: methods.join(", "),
  });
  res.end(JSON.stringify({ error: "Method not allowed", allowedMethods: methods }, null, 2));
  return true;
}

function sendNoContent(res) {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
  return true;
}

async function readJsonFile(filePath, fallback) {
  try {
    return parseJsonText(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonFileAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function cleanHeaderMap(value) {
  const headers = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;

  for (const [key, raw] of Object.entries(value)) {
    const name = String(key || "").trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue;
    if (/^(content-length|host|connection|transfer-encoding)$/i.test(name)) continue;
    const headerValue = String(raw ?? "").trim();
    if (headerValue) headers[name] = headerValue.slice(0, 500);
  }

  return headers;
}

function cleanWebhookMessages(value) {
  const messages = { ...webhookDefaults.messages };
  if (!value || typeof value !== "object" || Array.isArray(value)) return messages;

  for (const key of [...webhookStatuses, "default"]) {
    if (typeof value[key] !== "string") continue;
    const message = value[key].trim();
    messages[key] = message ? message.slice(0, 500) : webhookDefaults.messages[key];
  }

  return messages;
}

function cleanWebhookStatuses(value) {
  const statuses = { ...webhookDefaults.statuses };
  if (!value || typeof value !== "object" || Array.isArray(value)) return statuses;

  for (const status of webhookStatuses) {
    if (Object.prototype.hasOwnProperty.call(value, status)) statuses[status] = Boolean(value[status]);
  }

  return statuses;
}

function cleanWebhookConfig(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const endpoint = typeof source.endpoint === "string" ? source.endpoint.trim() : "";
  let cleanEndpoint = "";

  if (endpoint) {
    const parsed = new URL(endpoint);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Webhook endpoint must use http or https");
    cleanEndpoint = parsed.toString();
  }

  const timeoutMs = Number(source.timeoutMs);
  return {
    enabled: Boolean(source.enabled),
    endpoint: cleanEndpoint,
    signingToken: typeof source.signingToken === "string" ? source.signingToken.trim().slice(0, 200) : "",
    includeSubagents: Object.prototype.hasOwnProperty.call(source, "includeSubagents") ? Boolean(source.includeSubagents) : webhookDefaults.includeSubagents,
    statuses: cleanWebhookStatuses(source.statuses),
    messages: cleanWebhookMessages(source.messages),
    headers: cleanHeaderMap(source.headers),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(30000, timeoutMs)) : webhookDefaults.timeoutMs,
  };
}

async function readWebhookConfig() {
  const base = cleanWebhookConfig(projectConfig.webhook || {});
  const saved = await readJsonFile(webhooksPath, null);
  if (!saved) return { ...webhookDefaults, ...base, statuses: { ...webhookDefaults.statuses, ...base.statuses }, messages: { ...webhookDefaults.messages, ...base.messages } };

  const clean = cleanWebhookConfig(saved);
  return {
    ...webhookDefaults,
    ...base,
    ...clean,
    statuses: { ...webhookDefaults.statuses, ...base.statuses, ...clean.statuses },
    messages: { ...webhookDefaults.messages, ...base.messages, ...clean.messages },
    headers: { ...base.headers, ...clean.headers },
  };
}

async function writeWebhookConfig(value) {
  const clean = cleanWebhookConfig(value);
  await writeJsonFileAtomic(webhooksPath, clean);
  return clean;
}

function publicWebhookConfig(config) {
  const headers = Object.fromEntries(Object.keys(config.headers || {}).map((key) => [key, "********"]));
  return {
    ...config,
    headers,
    configured: Boolean(config.endpoint),
    signingToken: config.signingToken ? "********" : "",
  };
}

function webhookStateForThread(thread) {
  return {
    id: thread.id,
    status: thread.status,
    activityAt: thread.activityAt || null,
  };
}

function renderWebhookMessage(template, values) {
  return String(template || webhookDefaults.messages.default).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}

function buildWebhookPayload(config, event) {
  const template = config.messages[event.status] || config.messages.default || webhookDefaults.messages.default;
  const values = {
    event: "thread.status_changed",
    id: event.thread.id,
    title: event.thread.name || "Untitled thread",
    status: event.status,
    statusLabel: event.thread.statusLabel || event.status,
    previousStatus: event.previousStatus || "unknown",
    previousStatusLabel: event.previousStatus ? event.previousStatus[0].toUpperCase() + event.previousStatus.slice(1) : "Unknown",
    activityAt: event.thread.activityAt || "",
    workspace: event.thread.workspace || "",
    url: event.thread.codexUrl || "",
  };

  return {
    event: values.event,
    message: renderWebhookMessage(template, values),
    changedAt: new Date().toISOString(),
    previousStatus: event.previousStatus,
    status: event.status,
    thread: {
      id: event.thread.id,
      title: event.thread.name,
      status: event.thread.status,
      statusLabel: event.thread.statusLabel,
      activityAt: event.thread.activityAt,
      threadSource: event.thread.threadSource,
      parentThreadId: event.thread.parentThreadId,
      workspace: event.thread.workspace,
      tags: event.thread.tags || [],
      codexUrl: event.thread.codexUrl,
    },
  };
}

async function deliverWebhook(config, payload) {
  const body = JSON.stringify(payload);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "user-agent": `AgentQueue/${packageJson.version || "0.0.0"}`,
    "x-agentqueue-event": payload.event,
    "x-agentqueue-thread-id": payload.thread?.id || "",
    ...config.headers,
  };

  if (config.signingToken) {
    headers["x-agentqueue-signature"] = `sha256=${crypto.createHmac("sha256", config.signingToken).update(body).digest("hex")}`;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText };
  } finally {
    clearTimeout(timeout);
  }
}

function queueWebhookDelivery(config, payload) {
  deliverWebhook(config, payload).catch((error) => {
    console.error(`AgentQueue webhook failed for ${payload.thread?.id || "test"}: ${error.message}`);
  });
}

async function processThreadWebhooks(snapshot) {
  const config = await readWebhookConfig();
  if (!config.enabled || !config.endpoint) return;

  const nextState = new Map();
  const events = [];
  for (const thread of snapshot.threads || []) {
    if (!config.includeSubagents && thread.threadSource === "subagent") continue;
    const current = webhookStateForThread(thread);
    nextState.set(thread.id, current);
    const previous = webhookThreadState?.get(thread.id);
    if (!previous) continue;
    if (previous.status === current.status) continue;
    if (!config.statuses[current.status]) continue;
    events.push({ thread, previousStatus: previous.status, status: current.status });
  }

  webhookThreadState = nextState;
  for (const event of events) queueWebhookDelivery(config, buildWebhookPayload(config, event));
}

async function testWebhook() {
  const config = await readWebhookConfig();
  if (!config.endpoint) throw new Error("Webhook endpoint is required");
  const sampleThread = webhookThreadState?.values().next().value || { id: "00000000-0000-0000-0000-000000000000", status: "complete", activityAt: new Date().toISOString() };
  const payload = buildWebhookPayload(config, {
    previousStatus: "running",
    status: sampleThread.status || "complete",
    thread: {
      id: sampleThread.id,
      name: "AgentQueue webhook test",
      status: sampleThread.status || "complete",
      statusLabel: "Complete",
      activityAt: sampleThread.activityAt || new Date().toISOString(),
      threadSource: "test",
      parentThreadId: null,
      workspace: root,
      tags: ["test"],
      codexUrl: "codex://threads/00000000-0000-0000-0000-000000000000",
    },
  });
  payload.event = "thread.webhook_test";
  const result = await deliverWebhook(config, payload);
  return { ok: result.ok, delivery: result };
}

async function readRequestJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.:@&/-]/g, "")
    .toLowerCase()
    .slice(0, 40);
}

function cleanTags(tags) {
  return Array.from(new Set(
    (Array.isArray(tags) ? tags : [])
      .map(normalizeTag)
      .filter(Boolean)
  )).slice(0, 12);
}

async function readThreadTags(filePath = tagsPath) {
  const raw = await readJsonFile(filePath, {});
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const tagsByThread = {};

  for (const [threadId, tags] of Object.entries(source)) {
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) continue;
    const clean = cleanTags(tags);
    if (clean.length) tagsByThread[threadId] = clean;
  }

  return tagsByThread;
}

async function writeThreadTags(tagsByThread, filePath = tagsPath) {
  await writeJsonFileAtomic(filePath, tagsByThread);
}

function tagsPathForProvider(sourceProvider) {
  if (sourceProvider === "claude") return claudeTagsPath;
  if (sourceProvider === "copilot") return copilotTagsPath;
  return codexTagsPath;
}

function localStatePathForProvider(sourceProvider) {
  if (sourceProvider === "copilot") return copilotLocalStatePath;
  return claudeLocalStatePath;
}

async function setThreadTags(threadId, tags, sourceProvider = null) {
  if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/i.test(threadId)) {
    throw new Error("Invalid thread id");
  }

  const targetProvider = sourceProvider || await getThreadProvider(threadId) || provider;
  const filePath = tagsPathForProvider(targetProvider);
  const tagsByThread = await readThreadTags(filePath);
  const clean = cleanTags(tags);
  if (clean.length) tagsByThread[threadId] = clean;
  else delete tagsByThread[threadId];
  await writeThreadTags(tagsByThread, filePath);
  return { threadId, tags: clean };
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Keep looking through known Codex session index locations.
    }
  }
  return null;
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { id: `invalid-${index}`, thread_name: "Invalid session row", parse_error: error.message };
      }
    });
}

async function walkJsonlFiles(dir) {
  const found = [];
  async function walk(current) {
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push(fullPath);
      }
    }));
  }

  await walk(dir);
  return found;
}

async function getSessionFilesById() {
  const files = await walkJsonlFiles(sessionsRoot);
  const byId = new Map();
  for (const filePath of files) {
    const match = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) byId.set(match[1], filePath);
  }
  return byId;
}

async function readTail(filePath, maxBytes = 160 * 1024) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const handle = await fs.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, stat };
  } finally {
    await handle.close();
  }
}

function summarizeSessionLines(lines) {
  const summary = {
    latestEventAt: null,
    lastMeaningfulAt: null,
    lastMeaningfulType: null,
    taskCompleteAt: null,
    finalAnswerAt: null,
    turnAbortedAt: null,
    lastAssistantPhase: null,
    lastToolName: null,
    lastUserAt: null,
    lastError: null,
    eventCount: 0,
  };

  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    summary.eventCount += 1;
    if (item.timestamp) summary.latestEventAt = item.timestamp;

    const payload = item.payload || {};
    if (payload.type === "message" && payload.role === "user") {
      summary.lastUserAt = item.timestamp;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = "user_message";
    }
    if (payload.type === "function_call") {
      summary.lastToolName = payload.name || summary.lastToolName;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = "function_call";
    }
    if (payload.type === "function_call_output") {
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = "function_call_output";
    }
    if (payload.type === "message" && payload.role === "assistant") {
      summary.lastAssistantPhase = payload.phase || summary.lastAssistantPhase;
      if (payload.phase === "final_answer") summary.finalAnswerAt = item.timestamp;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = payload.phase === "final_answer" ? "final_answer" : "assistant_message";
    }
    if (item.type === "event_msg" && payload.type === "agent_message") {
      summary.lastAssistantPhase = payload.phase || summary.lastAssistantPhase;
      if (payload.phase === "final_answer") summary.finalAnswerAt = item.timestamp;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = payload.phase === "final_answer" ? "final_answer" : "agent_message";
    }
    if (item.type === "event_msg" && payload.type === "task_complete") {
      summary.taskCompleteAt = item.timestamp;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = "task_complete";
    }
    if (item.type === "event_msg" && payload.type === "turn_aborted") {
      summary.turnAbortedAt = item.timestamp;
      summary.lastMeaningfulAt = item.timestamp;
      summary.lastMeaningfulType = "turn_aborted";
    }
    if (item.type === "event_msg" && payload.type === "error") summary.lastError = payload.message || "Error event";
  }

  return summary;
}

async function readSessionSummary(filePath) {
  if (!filePath) return null;

  try {
    const stat = await fs.stat(filePath);
    const cached = sessionCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.summary;
    }

    const tail = await readTail(filePath);
    const lines = tail.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const summary = summarizeSessionLines(lines);
    summary.filePath = filePath;
    summary.fileSize = tail.stat.size;
    summary.fileModifiedAt = tail.stat.mtime.toISOString();

    sessionCache.set(filePath, {
      size: tail.stat.size,
      mtimeMs: tail.stat.mtimeMs,
      summary,
    });

    return summary;
  } catch {
    return null;
  }
}

function parseUsageSnapshots(text) {
  const snapshots = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;

    try {
      const item = JSON.parse(line);
      const payload = item.payload || {};
      const limits = payload.rate_limits;

      if (payload.type !== "token_count" || !limits) continue;
      snapshots.push({
        at: item.timestamp,
        limitId: limits.limit_id || "codex",
        limitName: limits.limit_name || null,
        planType: limits.plan_type || null,
        rateLimitReachedType: limits.rate_limit_reached_type || null,
        primary: limits.primary || null,
        secondary: limits.secondary || null,
        credits: limits.credits || null,
        individualLimit: limits.individual_limit || null,
      });
    } catch {
      // Session logs are append-only; skip incomplete or malformed lines.
    }
  }

  return snapshots;
}

function formatWindowLabel(minutes) {
  if (!minutes) return "Usage";
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function normalizeLimitId(limitId) {
  return String(limitId || "codex").trim() || "codex";
}

function usageLimitDisplayName(limitId, bucketLabel) {
  const normalizedLimitId = normalizeLimitId(limitId);
  if (normalizedLimitId === "codex") return bucketLabel;
  return `${normalizedLimitId} ${bucketLabel}`;
}

function isSameUsageWindow(limit, resetAtMs, windowMinutes) {
  if (!limit) return false;
  const limitResetAtMs = Number(limit.resets_at || 0) * 1000;
  const limitWindowMinutes = Number(limit.window_minutes || 0);
  if (windowMinutes && limitWindowMinutes && limitWindowMinutes !== windowMinutes) return false;
  if (!resetAtMs || !limitResetAtMs) return resetAtMs === limitResetAtMs;
  return Math.abs(limitResetAtMs - resetAtMs) <= 60_000;
}

function buildUsageWindow(limitId, label, latest, snapshots) {
  const resolvedLimitId = normalizeLimitId(limitId);
  const current = latest?.[label];
  if (!current || typeof current.used_percent !== "number") return null;

  const resetAtMs = Number(current.resets_at || 0) * 1000;
  const windowMinutes = Number(current.window_minutes || 0);
  const usedPercent = Number(current.used_percent);
  const bucketLabel = label === "primary" ? `Primary ${formatWindowLabel(windowMinutes)}` : `Secondary ${formatWindowLabel(windowMinutes)}`;
  const shortLabel = usageLimitDisplayName(resolvedLimitId, bucketLabel);

  const points = snapshots
    .map((snapshot) => {
      if (normalizeLimitId(snapshot.limitId) !== resolvedLimitId) return null;
      const limit = snapshot[label];
      if (!isSameUsageWindow(limit, resetAtMs, windowMinutes)) return null;
      return {
        at: snapshot.at,
        usedPercent: Number(limit.used_percent),
        remainingPercent: Math.max(0, 100 - Number(limit.used_percent)),
      };
    })
    .filter((point) => point && Number.isFinite(point.usedPercent))
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  let maxUsedPercent = usedPercent;
  let runningUsedPercent = null;
  for (const point of points) {
    runningUsedPercent = Math.max(runningUsedPercent ?? point.usedPercent, point.usedPercent);
    maxUsedPercent = Math.max(maxUsedPercent, runningUsedPercent);
    point.usedPercent = runningUsedPercent;
    point.remainingPercent = Math.max(0, 100 - runningUsedPercent);
  }

  return {
    key: label,
    groupKey: `${resolvedLimitId}:${label}`,
    limitId: resolvedLimitId,
    limitName: latest?.limitName || null,
    label: bucketLabel,
    shortLabel,
    usedPercent: maxUsedPercent,
    remainingPercent: Math.max(0, 100 - maxUsedPercent),
    windowMinutes,
    resetsAt: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    resetInMs: resetAtMs ? Math.max(0, resetAtMs - Date.now()) : null,
    points: points.slice(-48),
  };
}

function buildUsageWindowsFromSnapshots(snapshots) {
  const latestByLimit = new Map();

  for (let i = snapshots.length - 1; i >= 0; i--) {
    const snapshot = snapshots[i];
    const limitId = normalizeLimitId(snapshot.limitId);
    if (!latestByLimit.has(limitId)) latestByLimit.set(limitId, snapshot);
  }

  const windows = [];
  for (const [limitId, snapshot] of latestByLimit.entries()) {
    for (const label of ["primary", "secondary"]) {
      const window = buildUsageWindow(limitId, label, snapshot, snapshots);
      if (window) windows.push(window);
    }
  }

  windows.sort((a, b) => {
    if (a.limitId !== b.limitId) {
      if (a.limitId === "codex") return -1;
      if (b.limitId === "codex") return 1;
      return a.limitId.localeCompare(b.limitId);
    }

    if (a.key !== b.key) return a.key === "primary" ? -1 : 1;
    return 0;
  });

  return windows;
}

async function readUsageMetrics() {
  if (!activeProviders.includes("codex")) {
    return {
      available: false,
      refreshedAt: new Date().toISOString(),
      message: "Usage limits are only exposed by Codex local state.",
    };
  }

  if (usageCache.payload && Date.now() < usageCache.expiresAt) return usageCache.payload;

  const files = await walkJsonlFiles(sessionsRoot);
  const snapshots = [];

  await Promise.all(files.map(async (filePath) => {
    try {
      const tail = await readTail(filePath, 768 * 1024);
      snapshots.push(...parseUsageSnapshots(tail.text));
    } catch {
      // Ignore inaccessible or transient session files.
    }
  }));

  snapshots.sort((a, b) => new Date(a.at) - new Date(b.at));
  const latest = snapshots.at(-1) || null;
  const windows = latest ? buildUsageWindowsFromSnapshots(snapshots) : [];
  const activeLimitId = latest ? normalizeLimitId(latest.limitId) : "codex";
  const legacyPrimary = windows.find((window) => window.groupKey === `${activeLimitId}:primary`) || buildUsageWindow(activeLimitId, "primary", latest, snapshots);
  const legacySecondary = windows.find((window) => window.groupKey === `${activeLimitId}:secondary`) || buildUsageWindow(activeLimitId, "secondary", latest, snapshots);

  const payload = latest ? {
    available: true,
    refreshedAt: new Date().toISOString(),
    latestAt: latest.at,
    limitId: latest.limitId,
    planType: latest.planType,
    rateLimitReachedType: latest.rateLimitReachedType,
    windows,
    primary: legacyPrimary || null,
    secondary: legacySecondary || null,
  } : {
    available: false,
    refreshedAt: new Date().toISOString(),
    message: "No local token_count rate limit events found.",
  };

  usageCache.payload = payload;
  usageCache.expiresAt = Date.now() + 15_000;
  return payload;
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessRows() {
  const rows = await readJsonFile(processManagerPath, []);
  const byThread = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const conversationId = row.conversationId;
    if (!conversationId) continue;
    const list = byThread.get(conversationId) || [];
    list.push({
      command: row.command || "Command",
      osPid: row.osPid || null,
      alive: processIsAlive(row.osPid),
      startedAt: row.startedAtMs ? new Date(row.startedAtMs).toISOString() : null,
      updatedAt: row.updatedAtMs ? new Date(row.updatedAtMs).toISOString() : null,
    });
    byThread.set(conversationId, list);
  }

  return byThread;
}

function cleanPermission(value) {
  return String(value || "unknown").replace(/^:/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function epochToIso(value) {
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number > 10_000_000_000 ? number : number * 1000).toISOString();
}

function stripWindowsNamespace(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseParentThreadId(source) {
  const parsed = parseJson(source, null);
  return parsed?.subagent?.thread_spawn?.parent_thread_id || null;
}

function readSqliteRows(dbPath, sql) {
  if (!DatabaseSync) return [];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function readThreadsFromSqlite() {
  return readSqliteRows(stateDbPath, `
    select id, title, preview, rollout_path, cwd, source, thread_source, agent_nickname,
           agent_role, created_at, updated_at, created_at_ms, updated_at_ms, recency_at_ms,
           archived, archived_at, sandbox_policy, approval_mode, tokens_used, git_branch,
           git_origin_url, model, reasoning_effort
    from threads
    order by coalesce(updated_at_ms, updated_at * 1000) desc
  `).map((row) => ({
    id: row.id,
    title: row.title,
    thread_name: row.title,
    preview: row.preview,
    rolloutPath: row.rollout_path,
    cwd: stripWindowsNamespace(row.cwd),
    source: row.source,
    threadSource: row.thread_source || "user",
    parentThreadId: parseParentThreadId(row.source),
    agentNickname: row.agent_nickname,
    agentRole: row.agent_role,
    createdAt: epochToIso(row.created_at_ms || row.created_at),
    updated_at: epochToIso(row.updated_at_ms || row.updated_at),
    recencyAt: epochToIso(row.recency_at_ms),
    archived: Boolean(row.archived),
    archivedAt: epochToIso(row.archived_at),
    sandboxPolicy: parseJson(row.sandbox_policy, row.sandbox_policy),
    approvalMode: row.approval_mode,
    tokensUsed: row.tokens_used || 0,
    gitBranch: row.git_branch,
    gitOriginUrl: row.git_origin_url,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
  }));
}

function readThreadsFromIndex(indexText) {
  const unique = new Map();
  for (const thread of parseJsonLines(indexText)) {
    if (thread.id) unique.set(thread.id, thread);
  }
  return Array.from(unique.values());
}

function readSpawnEdges() {
  const childrenByParent = new Map();
  const parentByChild = new Map();
  for (const row of readSqliteRows(stateDbPath, "select parent_thread_id, child_thread_id, status from thread_spawn_edges")) {
    const list = childrenByParent.get(row.parent_thread_id) || [];
    list.push({ childThreadId: row.child_thread_id, status: row.status });
    childrenByParent.set(row.parent_thread_id, list);
    parentByChild.set(row.child_thread_id, { parentThreadId: row.parent_thread_id, status: row.status });
  }
  return { childrenByParent, parentByChild };
}

function readGoals() {
  const goals = new Map();
  for (const row of readSqliteRows(goalsDbPath, "select * from thread_goals")) {
    goals.set(row.thread_id, {
      status: row.status,
      tokensUsed: row.tokens_used || 0,
      tokenBudget: row.token_budget || null,
      updatedAt: epochToIso(row.updated_at_ms),
      objective: row.objective || "",
    });
  }
  return goals;
}

function readLogHealth() {
  const health = new Map();
  const rows = readSqliteRows(logsDbPath, `
    select thread_id,
           sum(case when level = 'ERROR' then 1 else 0 end) as errors_24h,
           sum(case when level = 'WARN' then 1 else 0 end) as warnings_24h,
           max(ts) as last_log_ts
    from logs
    where thread_id is not null
      and thread_id != ''
      and ts > strftime('%s','now','-24 hours')
    group by thread_id
  `);

  for (const row of rows) {
    health.set(row.thread_id, {
      errors24h: Number(row.errors_24h || 0),
      warnings24h: Number(row.warnings_24h || 0),
      lastLogAt: epochToIso(row.last_log_ts),
    });
  }

  return health;
}

function isThreadId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function getPersistedAtomState(state) {
  const atomState = state?.["electron-persisted-atom-state"];
  if (!atomState) return {};
  if (typeof atomState === "string") {
    try {
      const parsed = JSON.parse(atomState);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      return {};
    }
  }
  return typeof atomState === "object" ? atomState : {};
}

function collectUnreadIdsFromStore(store, target = new Set()) {
  if (!store) return target;

  if (Array.isArray(store)) {
    for (const id of store) {
      if (isThreadId(id)) target.add(id);
    }
    return target;
  }

  if (typeof store !== "object") {
    if (isThreadId(store)) target.add(store);
    return target;
  }

  for (const [key, value] of Object.entries(store)) {
    if (value === true && isThreadId(key)) target.add(key);
    else collectUnreadIdsFromStore(value, target);
  }

  return target;
}

function collectUnreadThreadIds(state, atomState = getPersistedAtomState(state)) {
  const unreadIds = new Set();
  const storeNames = [
    "unread-thread-ids-by-host-v1",
    "unread-thread-ids",
    "thread-unread-state-by-host-v1",
    "thread-unread-state",
  ];

  for (const name of storeNames) {
    collectUnreadIdsFromStore(state?.[name], unreadIds);
    collectUnreadIdsFromStore(atomState?.[name], unreadIds);
  }

  return unreadIds;
}

function removeUnreadIdsFromStore(store, ids) {
  if (!store) return 0;

  if (Array.isArray(store)) {
    const next = store.filter((id) => !ids.has(id));
    const removed = store.length - next.length;
    store.splice(0, store.length, ...next);
    return removed;
  }

  if (typeof store !== "object") return 0;
  let removed = 0;

  for (const [key, value] of Object.entries(store)) {
    if (value === true && ids.has(key)) {
      delete store[key];
      removed += 1;
      continue;
    }
    removed += removeUnreadIdsFromStore(value, ids);
  }

  return removed;
}

async function writeGlobalState(state, atomState = null, atomStateWasString = false) {
  if (!state || typeof state !== "object") state = {};
  if (atomStateWasString && atomState) {
    state["electron-persisted-atom-state"] = JSON.stringify(atomState);
  } else if (atomState && typeof atomState === "object") {
    state["electron-persisted-atom-state"] = atomState;
  }
  await writeJsonFileAtomic(globalStatePath, state);
}

function normalizeIdArray(value) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === "string" && item)
  ));
}

function setIdInArrayStore(store, threadId, enabled) {
  const items = normalizeIdArray(store);
  const had = items.includes(threadId);
  if (enabled && !had) items.push(threadId);
  if (!enabled && had) return items.filter((id) => id !== threadId);
  return items;
}

function writeThreadFlag(state, atomState, storeName, threadId, enabled) {
  const currentStore = state[storeName] || atomState[storeName] || [];
  const nextStore = setIdInArrayStore(currentStore, threadId, enabled);
  state[storeName] = nextStore;
  if (atomState && Object.prototype.hasOwnProperty.call(atomState, storeName)) {
    atomState[storeName] = nextStore;
  }
  return nextStore.includes(threadId);
}

async function setThreadState(threadId, updates, sourceProvider = null) {
  if (!isThreadId(threadId)) throw new Error("Invalid thread id");
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new Error("Request body must be an object");

  const allowedKeys = new Set(["pinned", "projectless", "archived"]);
  const next = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported thread state field: ${key}`);
    if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
    next[key] = value;
  }
  if (Object.keys(next).length === 0) throw new Error("No supported state fields provided");

  const targetProvider = sourceProvider || await getThreadProvider(threadId) || provider;
  if (targetProvider === "claude" || targetProvider === "copilot") {
    // Some runtimes have no global UI-state store, so pins/projectless/archive live in
    // AgentQueue's own non-destructive sidecar.
    const targetLocalStatePath = localStatePathForProvider(targetProvider);
    const localState = await readLocalState(targetLocalStatePath);
    const result = { threadId };
    if (Object.prototype.hasOwnProperty.call(next, "pinned")) {
      localState.pinned = setIdInArrayStore(localState.pinned, threadId, next.pinned);
      result.pinned = localState.pinned.includes(threadId);
    }
    if (Object.prototype.hasOwnProperty.call(next, "projectless")) {
      localState.projectless = setIdInArrayStore(localState.projectless, threadId, next.projectless);
      result.projectless = localState.projectless.includes(threadId);
    }
    if (Object.prototype.hasOwnProperty.call(next, "archived")) {
      localState.archived = setIdInArrayStore(localState.archived, threadId, next.archived);
      result.archived = localState.archived.includes(threadId);
    }
    await writeLocalState(localState, targetLocalStatePath);
    return result;
  }

  const state = await readJsonFile(globalStatePath, {});
  const atomStateWasString = typeof state["electron-persisted-atom-state"] === "string";
  const atomState = getPersistedAtomState(state);
  const result = { threadId };

  if (Object.prototype.hasOwnProperty.call(next, "pinned")) {
    result.pinned = writeThreadFlag(state, atomState, "pinned-thread-ids", threadId, next.pinned);
  }
  if (Object.prototype.hasOwnProperty.call(next, "projectless")) {
    result.projectless = writeThreadFlag(state, atomState, "projectless-thread-ids", threadId, next.projectless);
  }
  if (Object.prototype.hasOwnProperty.call(next, "archived")) {
    result.archived = writeThreadFlag(state, atomState, "archived-thread-ids", threadId, next.archived);
  }

  await writeGlobalState(state, atomState, atomStateWasString);
  return result;
}

async function markThreadsRead(threadIds, sourceProvider = null) {
  const ids = new Set(
    (Array.isArray(threadIds) ? threadIds : [])
      .filter(isThreadId)
  );

  if (ids.size === 0) return { markedIds: [], removed: 0 };

  const codexIds = sourceProvider
    ? (sourceProvider === "codex" ? ids : new Set())
    : (provider === "codex" ? ids : await filterThreadIdsByProvider(ids, "codex"));

  // Other providers do not expose compatible unread state, so there is nothing to clear.
  if (codexIds.size === 0) return { markedIds: Array.from(ids), removed: 0 };

  const state = await readJsonFile(globalStatePath, {});
  const atomStateWasString = typeof state["electron-persisted-atom-state"] === "string";
  const atomState = getPersistedAtomState(state);
  let removed = 0;

  for (const storeName of [
    "unread-thread-ids-by-host-v1",
    "unread-thread-ids",
    "thread-unread-state-by-host-v1",
    "thread-unread-state",
  ]) {
    removed += removeUnreadIdsFromStore(state[storeName], codexIds);
    removed += removeUnreadIdsFromStore(atomState[storeName], codexIds);
  }

  if (removed > 0) {
    await writeGlobalState(state, atomState, atomStateWasString);
  }

  return { markedIds: Array.from(ids), removed };
}

function getStatus({ activityAt, session }, now = Date.now()) {
  const activityMs = new Date(activityAt || 0).getTime();
  const taskCompleteMs = new Date(session?.taskCompleteAt || 0).getTime();
  const lastMeaningfulMs = new Date(session?.lastMeaningfulAt || session?.latestEventAt || 0).getTime();
  const hasOpenTurn = session && session.lastMeaningfulType !== "task_complete";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  if (hasOpenTurn && lastMeaningfulMs >= startOfToday.getTime() && now - lastMeaningfulMs <= statusWindows.runningStaleMs) return "running";
  if (taskCompleteMs && now - taskCompleteMs <= statusWindows.completeMs) return "complete";
  if (activityMs && now - activityMs <= statusWindows.recentMs) return "recent";
  if (activityMs && activityMs >= startOfToday.getTime()) return "today";
  return "done";
}

function maxIso(...values) {
  const times = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function toLocalDateKey(value) {
  const date = value ? new Date(value) : new Date(0);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
}

function enrichThread(thread, context) {
  const { state, sessionFilesById, processRowsByThread, spawnEdges, goals, logHealth, tagsByThread } = context;
  const threadProvider = context.provider || "codex";
  const atomState = getPersistedAtomState(state);
  const permissionsById = state["heartbeat-thread-permissions-by-id"] || atomState["heartbeat-thread-permissions-by-id"] || {};
  const pinnedIds = new Set(state["pinned-thread-ids"] || atomState["pinned-thread-ids"] || []);
  const projectlessIds = new Set(state["projectless-thread-ids"] || atomState["projectless-thread-ids"] || []);
  const archivedIds = new Set(state["archived-thread-ids"] || atomState["archived-thread-ids"] || []);
  const workspaceHints = state["thread-workspace-root-hints"] || atomState["thread-workspace-root-hints"] || {};
  const outputDirs = state["thread-projectless-output-directories"] || atomState["thread-projectless-output-directories"] || {};
  const promptHistory = atomState["prompt-history"] || state["prompt-history"] || {};
  const unreadIds = collectUnreadThreadIds(state, atomState);
  const permissions = permissionsById[thread.id] || {};
  const processes = processRowsByThread.get(thread.id) || [];
  const liveProcesses = processes.filter((row) => row.alive);
  const session = context.sessionSummaries.get(thread.id) || null;
  const prompts = promptHistory[thread.id] || [];
  const goal = goals.get(thread.id) || null;
  const logs = logHealth.get(thread.id) || { errors24h: 0, warnings24h: 0, lastLogAt: null };
  const childThreads = spawnEdges.childrenByParent.get(thread.id) || [];
  const parent = spawnEdges.parentByChild.get(thread.id) || {};
  const parentThreadId = thread.parentThreadId || parent.parentThreadId || null;
  const activityAt = maxIso(thread.recencyAt, thread.updated_at, session?.lastMeaningfulAt, session?.latestEventAt, goal?.updatedAt, ...processes.map((row) => row.updatedAt));
  const status = getStatus({ activityAt, session });
  const latestEventMs = new Date(session?.lastMeaningfulAt || session?.latestEventAt || activityAt || 0).getTime();
  const unfinished = session && session.lastMeaningfulType !== "task_complete";
  const runningStale = unfinished && Date.now() - latestEventMs > statusWindows.runningStaleMs;
  const localSandbox = typeof thread.sandboxPolicy === "object" ? thread.sandboxPolicy?.type : thread.sandboxPolicy;
  const permissionMode = cleanPermission(permissions.activePermissionProfile?.id || permissions.sandboxPolicy?.type || localSandbox || "unknown");
  const workspace = thread.cwd || workspaceHints[thread.id] || null;
  const outputDirectory = outputDirs[thread.id] || null;
  const sessionFilePath = thread.rolloutPath || sessionFilesById.get(thread.id) || null;
  const deepLink = threadProvider === "codex"
    ? `codex://threads/${thread.id}`
    : (sessionFilePath ? pathToFileURL(sessionFilePath).href : "");

  return {
    id: thread.id,
    title: thread.title || thread.thread_name || "Untitled thread",
    name: thread.thread_name || "Untitled thread",
    preview: thread.preview || thread.lastPrompt || null,
    status,
    statusLabel: status[0].toUpperCase() + status.slice(1),
    confidence: session ? (runningStale ? "stale" : "high") : "index only",
    updatedAt: thread.updated_at || null,
    activityAt,
    activityDateKey: toLocalDateKey(activityAt),
    completedAt: session?.taskCompleteAt || session?.finalAnswerAt || null,
    lastUserAt: session?.lastUserAt || null,
    runningSince: status === "running" ? (session?.lastUserAt || session?.lastMeaningfulAt || activityAt) : null,
    runningStale,
    aborted: Boolean(session?.turnAbortedAt),
    archived: Boolean(thread.archived || archivedIds.has(thread.id)),
    unread: unreadIds.has(thread.id),
    pinned: pinnedIds.has(thread.id),
    projectless: projectlessIds.has(thread.id),
    threadSource: thread.threadSource || "user",
    parentThreadId,
    childThreadCount: childThreads.length,
    openChildThreadCount: childThreads.filter((edge) => edge.status === "open").length,
    agentNickname: thread.agentNickname || null,
    agentRole: thread.agentRole || null,
    permissionMode,
    fullAccess: /danger|full/i.test(permissionMode),
    approvalPolicy: permissions.approvalPolicy || thread.approvalMode || "unknown",
    workspace,
    outputDirectory,
    lastPrompt: prompts.at(-1) || thread.preview || null,
    promptCount: prompts.length,
    sessionFile: sessionFilePath,
    sessionFileSize: session?.fileSize || null,
    lastToolName: session?.lastToolName || null,
    lastMeaningfulType: session?.lastMeaningfulType || null,
    lastAssistantPhase: session?.lastAssistantPhase || null,
    lastError: session?.lastError || thread.parse_error || null,
    liveProcessCount: liveProcesses.length,
    liveProcesses,
    processCount: processes.length,
    logHealth: logs,
    goal,
    tokensUsed: thread.tokensUsed || 0,
    gitBranch: thread.gitBranch || null,
    gitOriginUrl: thread.gitOriginUrl || null,
    model: thread.model || null,
    reasoningEffort: thread.reasoningEffort || null,
    tags: tagsByThread[thread.id] || [],
    codexUrl: deepLink,
    openUrl: deepLink,
    openLabel: threadProvider === "codex" ? "Open in Codex" : "Open transcript",
    provider: threadProvider,
    providerLabel: providerLabels[threadProvider] || threadProvider,
    parseError: thread.parse_error || null,
  };
}

function computeSummary(threads, refreshedAt) {
  const counts = Object.fromEntries(["running", "complete", "recent", "today", "done"].map((key) => [key, 0]));
  for (const thread of threads) counts[thread.status] = (counts[thread.status] || 0) + 1;
  const tagCounts = {};
  for (const thread of threads) {
    for (const tag of thread.tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  return {
    refreshedAt,
    total: threads.length,
    counts,
    tagCounts,
    unread: threads.filter((thread) => thread.unread).length,
    liveProcesses: threads.reduce((sum, thread) => sum + thread.liveProcessCount, 0),
    liveFullAccess: threads.filter((thread) => thread.liveProcessCount && thread.fullAccess).length,
    logWarnings24h: threads.reduce((sum, thread) => sum + (thread.logHealth?.warnings24h || 0), 0),
    logErrors24h: threads.reduce((sum, thread) => sum + (thread.logHealth?.errors24h || 0), 0),
    fullAccess: threads.filter((thread) => thread.fullAccess).length,
    projectless: threads.filter((thread) => thread.projectless).length,
    subagents: threads.filter((thread) => thread.threadSource === "subagent").length,
    activeGoals: threads.filter((thread) => thread.goal?.status === "active").length,
    staleRunning: threads.filter((thread) => thread.runningStale).length,
  };
}

// AgentQueue-local pin/projectless state for runtimes (like Claude Code) that do
// not expose their own global UI state. Stored in a sidecar so it is non-destructive.
async function readLocalState(filePath = localStatePath) {
  const value = await readJsonFile(filePath, {});
  return {
    pinned: normalizeIdArray(value && value.pinned),
    projectless: normalizeIdArray(value && value.projectless),
    archived: normalizeIdArray(value && value.archived),
  };
}

async function writeLocalState(next, filePath = localStatePath) {
  await writeJsonFileAtomic(filePath, {
    pinned: normalizeIdArray(next.pinned),
    projectless: normalizeIdArray(next.projectless),
    archived: normalizeIdArray(next.archived),
  });
}

// ---- Claude Code (Anthropic) data source ----
// Claude Code stores one append-only JSONL transcript per session under
// <claudeHome>/projects/<encoded-cwd>/<sessionId>.jsonl. One transcript == one
// thread, and the filename's UUID is the thread id.

const claudeSessionCache = new Map();
const COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens"]);

function claudeContentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

function isHumanUserLine(item) {
  if (item.type !== "user") return false;
  const content = item.message && item.message.content;
  // Tool results are also recorded as role "user"; they are not human prompts.
  if (Array.isArray(content) && content.some((block) => block && block.type === "tool_result")) return false;
  return true;
}

function addClaudeUsage(totals, usage) {
  if (!usage || typeof usage !== "object") return;
  totals.input += Number(usage.input_tokens || 0);
  totals.output += Number(usage.output_tokens || 0);
  totals.cacheRead += Number(usage.cache_read_input_tokens || 0);
  totals.cacheCreate += Number(usage.cache_creation_input_tokens || 0);
}

function summarizeClaudeLines(lines) {
  const summary = {
    latestEventAt: null,
    lastMeaningfulAt: null,
    lastMeaningfulType: null,
    taskCompleteAt: null,
    finalAnswerAt: null,
    turnAbortedAt: null,
    lastAssistantPhase: null,
    lastToolName: null,
    lastUserAt: null,
    lastError: null,
    eventCount: 0,
  };
  const meta = {
    title: null,
    firstPrompt: null,
    cwd: null,
    gitBranch: null,
    model: null,
    version: null,
    permissionMode: null,
    createdAt: null,
    prompts: [],
  };
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let endedWithCompletedTurn = false;

  for (const raw of lines) {
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const ts = item.timestamp || null;
    if (item.cwd) meta.cwd = stripWindowsNamespace(item.cwd);
    if (item.gitBranch) meta.gitBranch = item.gitBranch;
    if (item.version) meta.version = item.version;
    if (item.permissionMode) meta.permissionMode = item.permissionMode;

    // Some sessions carry a Claude-written summary line; prefer it as the title.
    if (item.type === "summary" && typeof item.summary === "string" && !meta.title) {
      meta.title = item.summary.trim() || null;
    }

    if (item.type !== "user" && item.type !== "assistant") {
      // queue-operation / attachment / last-prompt / system: advance the clock only.
      if (ts) summary.latestEventAt = ts;
      continue;
    }

    summary.eventCount += 1;
    if (ts) {
      summary.latestEventAt = ts;
      if (!meta.createdAt) meta.createdAt = ts;
    }

    if (isHumanUserLine(item)) {
      const text = claudeContentToText(item.message && item.message.content);
      if (text) {
        if (!meta.firstPrompt) meta.firstPrompt = text;
        meta.prompts.push(text);
      }
      summary.lastUserAt = ts;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "user_message";
      endedWithCompletedTurn = false;
      continue;
    }

    if (item.type === "user") {
      // A tool result returning to the model: the turn is still in progress.
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "function_call_output";
      endedWithCompletedTurn = false;
      continue;
    }

    // Assistant message.
    const message = item.message || {};
    if (message.model) meta.model = message.model;
    addClaudeUsage(tokens, message.usage);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolUse = content.filter((block) => block && block.type === "tool_use");
    if (toolUse.length) summary.lastToolName = toolUse[toolUse.length - 1].name || summary.lastToolName;

    if (COMPLETE_STOP_REASONS.has(message.stop_reason)) {
      summary.finalAnswerAt = ts;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "final_answer";
      endedWithCompletedTurn = true;
    } else {
      // stop_reason "tool_use" (or streaming/null): the model has not finished.
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = toolUse.length ? "function_call" : "assistant_message";
      endedWithCompletedTurn = false;
    }
  }

  // If the transcript ends with the model finishing its reply, treat that as a
  // completed turn so status mapping mirrors Codex's task_complete behavior.
  if (endedWithCompletedTurn) {
    summary.taskCompleteAt = summary.finalAnswerAt;
    summary.lastMeaningfulType = "task_complete";
  }

  // Count tokens actually processed for this session. cache_read is excluded
  // because it represents reused (cached) context rather than new work, and it
  // otherwise dwarfs the figure by an order of magnitude.
  const tokensUsed = tokens.input + tokens.output + tokens.cacheCreate;
  return { summary, meta, tokens, tokensUsed };
}

async function readClaudeSession(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const cached = claudeSessionCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.result;
    }

    let text;
    if (stat.size > 12 * 1024 * 1024) {
      // Very large transcript: read the tail (loses the title but keeps recency).
      const tail = await readTail(filePath, 4 * 1024 * 1024);
      text = tail.text;
    } else {
      text = await fs.readFile(filePath, "utf8");
    }

    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const parsed = summarizeClaudeLines(lines);
    parsed.summary.filePath = filePath;
    parsed.summary.fileSize = stat.size;
    parsed.summary.fileModifiedAt = stat.mtime.toISOString();

    const result = { ...parsed, filePath, stat };
    claudeSessionCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, result });
    return result;
  } catch {
    return null;
  }
}

function claudeIdFromFile(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base;
}

async function getClaudeSessionFilesById() {
  const files = fsSync.existsSync(claudeProjectsRoot) ? await walkJsonlFiles(claudeProjectsRoot) : [];
  const byId = new Map();
  for (const filePath of files) {
    const id = claudeIdFromFile(filePath);
    if (!isThreadId(id)) continue;
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, filePath);
      continue;
    }
    // If the same session id appears under multiple project dirs, keep the newest.
    try {
      if (fsSync.statSync(filePath).mtimeMs > fsSync.statSync(existing).mtimeMs) byId.set(id, filePath);
    } catch {
      // Ignore transient stat failures and keep the first match.
    }
  }
  return byId;
}

function truncate(value, max) {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function loadClaudeThreads() {
  const exists = fsSync.existsSync(claudeProjectsRoot);
  const sessionFilesById = await getClaudeSessionFilesById();
  const [tagsByThread, localState] = await Promise.all([readThreadTags(claudeTagsPath), readLocalState(claudeLocalStatePath)]);

  const sessionSummaries = new Map();
  const promptHistory = {};
  const rawThreads = [];

  await Promise.all(Array.from(sessionFilesById.entries()).map(async ([id, filePath]) => {
    const parsed = await readClaudeSession(filePath);
    if (!parsed) return;
    sessionSummaries.set(id, parsed.summary);
    promptHistory[id] = parsed.meta.prompts.slice(-50);

    const meta = parsed.meta;
    const title = truncate(meta.title || meta.firstPrompt, 120) || "Claude session";
    rawThreads.push({
      id,
      title,
      thread_name: title,
      preview: truncate(meta.firstPrompt, 200),
      rolloutPath: filePath,
      cwd: meta.cwd || null,
      source: null,
      threadSource: "user",
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      createdAt: meta.createdAt,
      updated_at: parsed.summary.latestEventAt,
      recencyAt: parsed.summary.latestEventAt,
      archived: false,
      sandboxPolicy: meta.permissionMode || null,
      approvalMode: meta.permissionMode || null,
      tokensUsed: parsed.tokensUsed,
      gitBranch: meta.gitBranch || null,
      gitOriginUrl: null,
      model: meta.model || null,
      reasoningEffort: null,
    });
  }));

  // Synthetic global state so the shared enrichment path keeps working: prompt
  // history feeds prompt counts, and pins come from AgentQueue's local sidecar.
  const state = {
    "prompt-history": promptHistory,
    "pinned-thread-ids": localState.pinned,
    "projectless-thread-ids": localState.projectless,
    "archived-thread-ids": localState.archived,
  };

  const context = {
    state,
    sessionFilesById,
    processRowsByThread: new Map(),
    sessionSummaries,
    spawnEdges: { childrenByParent: new Map(), parentByChild: new Map() },
    goals: new Map(),
    logHealth: new Map(),
    tagsByThread,
    provider: "claude",
  };

  const threads = rawThreads
    .map((thread) => enrichThread(thread, context))
    .sort((a, b) => {
      const pinnedDelta = Number(b.pinned) - Number(a.pinned);
      if (pinnedDelta) return pinnedDelta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    });

  const refreshedAt = new Date().toISOString();
  const snapshot = {
    provider: "claude",
    providerLabel: providerLabels.claude,
    indexPath: null,
    stateDbPath: null,
    goalsDbPath: null,
    logsDbPath: null,
    globalStatePath: null,
    processManagerPath: null,
    localStatePath,
    sessionsRoot: claudeProjectsRoot,
    codexHome,
    claudeHome,
    dataHome: claudeHome,
    tagsPath: claudeTagsPath,
    statusWindows,
    refreshedAt,
    summary: computeSummary(threads, refreshedAt),
    usage: {
      available: false,
      refreshedAt,
      message: "Usage limits are not exposed in Claude Code local state.",
    },
    threads,
    error: exists ? undefined : `No Claude Code projects directory found at ${claudeProjectsRoot}`,
  };

  webhookProcessQueue = webhookProcessQueue.then(() => processThreadWebhooks(snapshot)).catch((error) => {
    console.error(`AgentQueue webhook processing failed: ${error.message}`);
  });
  return snapshot;
}

// ---- GitHub Copilot Desktop data source ----
// Copilot Desktop stores one session directory per chat under
// <copilotHome>/session-state/<sessionId>. workspace.yaml carries user-facing
// metadata and events.jsonl carries the append-only interaction stream.

const copilotSessionCache = new Map();

async function getCopilotSessionFilesById() {
  const byId = new Map();
  let entries = [];
  try {
    entries = await fs.readdir(copilotSessionStateRoot, { withFileTypes: true });
  } catch {
    return byId;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !isThreadId(entry.name)) continue;
    const eventsPath = path.join(copilotSessionStateRoot, entry.name, "events.jsonl");
    if (fsSync.existsSync(eventsPath)) byId.set(entry.name, eventsPath);
  }
  return byId;
}

function parseCopilotYaml(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    result[match[1]] = match[2].trim();
  }
  return result;
}

async function readCopilotWorkspace(sessionDir) {
  const workspacePath = path.join(sessionDir, "workspace.yaml");
  try {
    return parseCopilotYaml(await fs.readFile(workspacePath, "utf8"));
  } catch {
    return {};
  }
}

function copilotContentToText(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item.text === "string") return item.text;
        if (item && typeof item.content === "string") return item.content;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text.trim();
    if (typeof content.content === "string") return content.content.trim();
  }
  return "";
}

function summarizeCopilotLines(lines, workspace = {}) {
  const summary = {
    latestEventAt: null,
    lastMeaningfulAt: null,
    lastMeaningfulType: null,
    taskCompleteAt: null,
    finalAnswerAt: null,
    turnAbortedAt: null,
    lastAssistantPhase: null,
    lastToolName: null,
    lastUserAt: null,
    lastError: null,
    eventCount: 0,
  };
  const meta = {
    title: workspace.name || null,
    firstPrompt: null,
    cwd: workspace.cwd ? stripWindowsNamespace(workspace.cwd) : null,
    gitBranch: null,
    model: null,
    version: null,
    permissionMode: null,
    createdAt: workspace.created_at || null,
    updatedAt: workspace.updated_at || null,
    prompts: [],
    remoteUrl: null,
  };
  let inputTokens = 0;
  let outputTokens = 0;
  let endedWithAssistantTurn = false;

  for (const raw of lines) {
    let item;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const ts = item.timestamp || null;
    const data = item.data && typeof item.data === "object" ? item.data : {};
    summary.eventCount += 1;
    if (ts) summary.latestEventAt = ts;

    if (item.type === "session.start" || item.type === "session.resume") {
      meta.model = data.selectedModel || meta.model;
      meta.version = data.copilotVersion || meta.version;
      meta.cwd = stripWindowsNamespace(data.context?.cwd || meta.cwd || "");
      if (data.startTime && !meta.createdAt) meta.createdAt = data.startTime;
      continue;
    }
    if (item.type === "session.model_change") {
      meta.model = data.newModel || meta.model;
      continue;
    }
    if (item.type === "session.info") {
      meta.remoteUrl = data.url || meta.remoteUrl;
      continue;
    }
    if (item.type === "user.message") {
      const text = copilotContentToText(data.content || data.message || data.prompt);
      if (text) {
        if (!meta.firstPrompt) meta.firstPrompt = text;
        meta.prompts.push(text);
      }
      summary.lastUserAt = ts;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "user_message";
      endedWithAssistantTurn = false;
      continue;
    }
    if (item.type === "hook.start" && data.hookType === "userPromptSubmitted") {
      const text = copilotContentToText(data.input?.prompt);
      if (text) {
        if (!meta.firstPrompt) meta.firstPrompt = text;
        meta.prompts.push(text);
        summary.lastUserAt = ts;
        summary.lastMeaningfulAt = ts;
        summary.lastMeaningfulType = "user_message";
        endedWithAssistantTurn = false;
      }
      continue;
    }
    if (item.type === "assistant.message") {
      meta.model = data.model || meta.model;
      outputTokens += Number(data.outputTokens || 0);
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      const lastTool = toolRequests.at(-1);
      if (lastTool) summary.lastToolName = lastTool.name || lastTool.toolName || summary.lastToolName;
      summary.lastAssistantPhase = data.phase || summary.lastAssistantPhase;
      summary.finalAnswerAt = ts;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = toolRequests.length ? "function_call" : "final_answer";
      endedWithAssistantTurn = !toolRequests.length;
      continue;
    }
    if (item.type === "tool.execution_start" || item.type === "external_tool.requested") {
      summary.lastToolName = data.name || data.toolName || data.toolCallId || summary.lastToolName;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "function_call";
      endedWithAssistantTurn = false;
      continue;
    }
    if (item.type === "tool.execution_complete" || item.type === "external_tool.completed") {
      summary.lastToolName = data.name || data.toolName || data.toolCallId || summary.lastToolName;
      if (data.success === false) summary.lastError = "Tool execution failed";
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "function_call_output";
      endedWithAssistantTurn = false;
      continue;
    }
    if (item.type === "abort") {
      summary.turnAbortedAt = ts;
      summary.lastMeaningfulAt = ts;
      summary.lastMeaningfulType = "turn_aborted";
      summary.lastError = data.reason || summary.lastError;
      endedWithAssistantTurn = false;
      continue;
    }
    if (item.type === "session.shutdown") {
      meta.model = data.currentModel || meta.model;
      inputTokens += Number(data.currentTokens || 0);
      if (endedWithAssistantTurn) {
        summary.taskCompleteAt = summary.finalAnswerAt || ts;
        summary.lastMeaningfulType = "task_complete";
      }
      continue;
    }
  }

  if (endedWithAssistantTurn && !summary.taskCompleteAt) {
    summary.taskCompleteAt = summary.finalAnswerAt;
    summary.lastMeaningfulType = "task_complete";
  }

  return { summary, meta, tokensUsed: inputTokens + outputTokens };
}

async function readCopilotSession(eventsPath) {
  try {
    const stat = await fs.stat(eventsPath);
    const workspacePath = path.join(path.dirname(eventsPath), "workspace.yaml");
    let workspaceMtimeMs = 0;
    try {
      workspaceMtimeMs = (await fs.stat(workspacePath)).mtimeMs;
    } catch {
      workspaceMtimeMs = 0;
    }
    const cached = copilotSessionCache.get(eventsPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.workspaceMtimeMs === workspaceMtimeMs) {
      return cached.result;
    }

    const workspace = await readCopilotWorkspace(path.dirname(eventsPath));
    let text;
    if (stat.size > 12 * 1024 * 1024) {
      const tail = await readTail(eventsPath, 4 * 1024 * 1024);
      text = tail.text;
    } else {
      text = await fs.readFile(eventsPath, "utf8");
    }
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const parsed = summarizeCopilotLines(lines, workspace);
    parsed.summary.filePath = eventsPath;
    parsed.summary.fileSize = stat.size;
    parsed.summary.fileModifiedAt = stat.mtime.toISOString();

    const result = { ...parsed, filePath: eventsPath, stat };
    copilotSessionCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, workspaceMtimeMs, result });
    return result;
  } catch {
    return null;
  }
}

async function loadCopilotThreads() {
  const exists = fsSync.existsSync(copilotSessionStateRoot);
  const sessionFilesById = await getCopilotSessionFilesById();
  const [tagsByThread, localState] = await Promise.all([readThreadTags(copilotTagsPath), readLocalState(copilotLocalStatePath)]);

  const sessionSummaries = new Map();
  const promptHistory = {};
  const rawThreads = [];

  await Promise.all(Array.from(sessionFilesById.entries()).map(async ([id, filePath]) => {
    const parsed = await readCopilotSession(filePath);
    if (!parsed) return;
    sessionSummaries.set(id, parsed.summary);
    promptHistory[id] = parsed.meta.prompts.slice(-50);

    const meta = parsed.meta;
    const title = truncate(meta.title || meta.firstPrompt, 120) || "Copilot session";
    rawThreads.push({
      id,
      title,
      thread_name: title,
      preview: truncate(meta.firstPrompt, 200),
      rolloutPath: filePath,
      cwd: meta.cwd || null,
      source: meta.remoteUrl || null,
      threadSource: "user",
      parentThreadId: null,
      agentNickname: null,
      agentRole: null,
      createdAt: meta.createdAt,
      updated_at: meta.updatedAt || parsed.summary.latestEventAt,
      recencyAt: parsed.summary.latestEventAt || meta.updatedAt,
      archived: false,
      sandboxPolicy: meta.permissionMode || null,
      approvalMode: meta.permissionMode || null,
      tokensUsed: parsed.tokensUsed,
      gitBranch: meta.gitBranch || null,
      gitOriginUrl: null,
      model: meta.model || null,
      reasoningEffort: null,
    });
  }));

  const state = {
    "prompt-history": promptHistory,
    "pinned-thread-ids": localState.pinned,
    "projectless-thread-ids": localState.projectless,
    "archived-thread-ids": localState.archived,
  };

  const context = {
    state,
    sessionFilesById,
    processRowsByThread: new Map(),
    sessionSummaries,
    spawnEdges: { childrenByParent: new Map(), parentByChild: new Map() },
    goals: new Map(),
    logHealth: new Map(),
    tagsByThread,
    provider: "copilot",
  };

  const threads = rawThreads
    .map((thread) => enrichThread(thread, context))
    .sort((a, b) => {
      const pinnedDelta = Number(b.pinned) - Number(a.pinned);
      if (pinnedDelta) return pinnedDelta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    });

  const refreshedAt = new Date().toISOString();
  const snapshot = {
    provider: "copilot",
    providerLabel: providerLabels.copilot,
    indexPath: null,
    stateDbPath: null,
    goalsDbPath: null,
    logsDbPath: null,
    globalStatePath: null,
    processManagerPath: null,
    localStatePath: copilotLocalStatePath,
    sessionsRoot: copilotSessionStateRoot,
    copilotHome,
    dataHome: copilotHome,
    tagsPath: copilotTagsPath,
    statusWindows,
    refreshedAt,
    summary: computeSummary(threads, refreshedAt),
    usage: {
      available: false,
      refreshedAt,
      message: "Usage limits are not exposed in GitHub Copilot Desktop local state.",
    },
    threads,
    error: exists ? undefined : `No GitHub Copilot Desktop session-state directory found at ${copilotSessionStateRoot}`,
  };

  webhookProcessQueue = webhookProcessQueue.then(() => processThreadWebhooks(snapshot)).catch((error) => {
    console.error(`AgentQueue webhook processing failed: ${error.message}`);
  });
  return snapshot;
}

async function loadCodexThreads() {
  const indexPath = await firstExistingPath(candidateIndexPaths);
  const sqliteThreads = readThreadsFromSqlite();
  if (!indexPath && sqliteThreads.length === 0) {
    const refreshedAt = new Date().toISOString();
    return {
      provider: "codex",
      providerLabel: providerLabels.codex,
      indexPath: null,
      stateDbPath,
      codexHome,
      threads: [],
      summary: computeSummary([], refreshedAt),
      usage: await readUsageMetrics(),
      refreshedAt,
      error: `No session index found. Checked: ${candidateIndexPaths.join(", ")}`,
    };
  }

  const [indexText, state, sessionFilesById, processRowsByThread, tagsByThread] = await Promise.all([
    indexPath ? fs.readFile(indexPath, "utf8") : Promise.resolve(""),
    readJsonFile(globalStatePath, {}),
    getSessionFilesById(),
    readProcessRows(),
    readThreadTags(codexTagsPath),
  ]);

  const threadsSource = sqliteThreads.length ? sqliteThreads : readThreadsFromIndex(indexText);
  const unique = new Map(threadsSource.map((thread) => [thread.id, thread]));
  const spawnEdges = readSpawnEdges();
  const goals = readGoals();
  const logHealth = readLogHealth();
  const usage = await readUsageMetrics();

  const sessionSummaries = new Map();
  await Promise.all(Array.from(unique.entries()).map(async ([id, thread]) => {
    sessionSummaries.set(id, await readSessionSummary(thread.rolloutPath || sessionFilesById.get(id)));
  }));

  const context = { state, sessionFilesById, processRowsByThread, sessionSummaries, spawnEdges, goals, logHealth, tagsByThread, provider: "codex" };
  const threads = Array.from(unique.values())
    .map((thread) => enrichThread(thread, context))
    .sort((a, b) => {
      const pinnedDelta = Number(b.pinned) - Number(a.pinned);
      if (pinnedDelta) return pinnedDelta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    });

  const refreshedAt = new Date().toISOString();
  const snapshot = {
    provider: "codex",
    providerLabel: providerLabels.codex,
    indexPath,
    stateDbPath: sqliteThreads.length ? stateDbPath : null,
    goalsDbPath: goals.size ? goalsDbPath : null,
    logsDbPath: logHealth.size ? logsDbPath : null,
    globalStatePath,
    processManagerPath,
    sessionsRoot,
    codexHome,
    dataHome: codexHome,
    tagsPath: codexTagsPath,
    statusWindows,
    refreshedAt,
    summary: computeSummary(threads, refreshedAt),
    usage,
    threads,
  };
  webhookProcessQueue = webhookProcessQueue.then(() => processThreadWebhooks(snapshot)).catch((error) => {
    console.error(`AgentQueue webhook processing failed: ${error.message}`);
  });
  return snapshot;
}

async function loadThreads() {
  const loaderByProvider = {
    codex: loadCodexThreads,
    claude: loadClaudeThreads,
    copilot: loadCopilotThreads,
  };
  const snapshots = await Promise.all(activeProviders.map((name) => loaderByProvider[name]()));
  if (snapshots.length === 1) {
    return {
      ...snapshots[0],
      provider,
      providerLabel,
      activeProviders,
    };
  }

  const refreshedAt = new Date().toISOString();
  const threads = snapshots
    .flatMap((snapshot) => snapshot.threads || [])
    .sort((a, b) => {
      const pinnedDelta = Number(b.pinned) - Number(a.pinned);
      if (pinnedDelta) return pinnedDelta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    });
  const codexSnapshot = snapshots.find((snapshot) => snapshot.provider === "codex") || null;
  return {
    provider,
    providerLabel,
    activeProviders,
    providers: Object.fromEntries(snapshots.map((snapshot) => [snapshot.provider, {
      provider: snapshot.provider,
      providerLabel: snapshot.providerLabel,
      total: snapshot.threads?.length || 0,
      error: snapshot.error,
      dataHome: snapshot.dataHome,
    }])),
    indexPath: codexSnapshot?.indexPath || null,
    stateDbPath: codexSnapshot?.stateDbPath || null,
    goalsDbPath: codexSnapshot?.goalsDbPath || null,
    logsDbPath: codexSnapshot?.logsDbPath || null,
    globalStatePath: codexSnapshot?.globalStatePath || null,
    processManagerPath: codexSnapshot?.processManagerPath || null,
    sessionsRoot: codexSnapshot?.sessionsRoot || null,
    codexHome,
    claudeHome,
    copilotHome,
    dataHome,
    statusWindows,
    refreshedAt,
    summary: computeSummary(threads, refreshedAt),
    usage: codexSnapshot?.usage || await readUsageMetrics(),
    threads,
    errors: snapshots.filter((snapshot) => snapshot.error).map((snapshot) => snapshot.error),
  };
}

async function getThreadSnapshot(threadId) {
  if (!isThreadId(threadId)) return null;
  const snapshot = await loadThreads();
  const thread = snapshot.threads.find((item) => item.id === threadId) || null;
  return { snapshot, thread };
}

async function getThreadProvider(threadId) {
  const found = await getThreadSnapshot(threadId);
  return found?.thread?.provider || null;
}

async function filterThreadIdsByProvider(ids, targetProvider) {
  const snapshot = await loadThreads();
  const allowed = new Set(
    snapshot.threads
      .filter((thread) => ids.has(thread.id) && thread.provider === targetProvider)
      .map((thread) => thread.id)
  );
  return allowed;
}

async function loadV2SnapshotPayload(now = new Date()) {
  const rawPayload = await readV2RawThreads(codexHome, { now });
  const tagsByThread = await readV2TagsByThread(codexHome);
  const rawThreads = enrichThreadsWithTags(rawPayload.threads, tagsByThread);
  const snapshot = buildV2SnapshotFromThreads({
    now,
    codexHome,
    threads: rawThreads,
    warnings: rawPayload.warnings || [],
  });
  return {
    snapshot,
    rawThreads,
    sources: rawPayload.sources || {},
  };
}

async function getV2ThreadPayload(threadId, now = new Date()) {
  if (!isThreadId(threadId)) return null;
  const { snapshot, rawThreads } = await loadV2SnapshotPayload(now);
  const thread = snapshot.threads.find((item) => item.id === threadId) || null;
  if (!thread) return null;
  const raw = rawThreads.find((item) => item.id === threadId) || null;
  return buildV2ThreadDetail({ now, codexHome, thread, raw });
}

function parsePositiveInt(value, fallback, max) {
  const number = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(number, max);
}

async function readThreadSessionPayload(threadId, query = new URLSearchParams()) {
  const found = await getThreadSnapshot(threadId);
  if (!found?.thread) return null;
  const filePath = found.thread.sessionFile;
  if (!filePath) return { threadId, filePath: null, text: "", bytes: 0, modifiedAt: null };

  const maxBytes = parsePositiveInt(query.get("tailBytes"), 256 * 1024, 2 * 1024 * 1024);
  try {
    const tail = await readTail(filePath, maxBytes);
    return {
      threadId,
      filePath,
      bytes: tail.text.length,
      fileSize: tail.stat.size,
      modifiedAt: tail.stat.mtime.toISOString(),
      truncated: tail.stat.size > maxBytes,
      text: tail.text,
    };
  } catch (error) {
    return { threadId, filePath, text: "", bytes: 0, modifiedAt: null, error: error.message };
  }
}

async function readThreadEventsPayload(threadId, query = new URLSearchParams()) {
  const session = await readThreadSessionPayload(threadId, query);
  if (!session) return null;
  const limit = parsePositiveInt(query.get("limit"), 100, 500);
  const events = parseJsonLines(session.text)
    .filter((event) => !String(event.id || "").startsWith("invalid-"))
    .slice(-limit);
  return {
    threadId,
    filePath: session.filePath,
    truncated: session.truncated,
    count: events.length,
    events,
  };
}

async function readTagsPayload() {
  const tagMaps = await Promise.all(activeProviders.map((name) => readThreadTags(tagsPathForProvider(name))));
  const tagsByThread = {};
  for (const map of tagMaps) {
    for (const [threadId, tags] of Object.entries(map)) {
      tagsByThread[threadId] = cleanTags([...(tagsByThread[threadId] || []), ...tags]);
    }
  }
  const counts = {};
  for (const tags of Object.values(tagsByThread)) {
    for (const tag of tags) counts[tag] = (counts[tag] || 0) + 1;
  }
  return {
    tags: Object.keys(counts).sort((a, b) => a.localeCompare(b)),
    counts,
    threads: tagsByThread,
  };
}

async function readProcessesPayload() {
  if (!activeProviders.includes("codex")) {
    return {
      processManagerPath: null,
      total: 0,
      live: 0,
      threads: {},
    };
  }
  const processRowsByThread = await readProcessRows();
  const threads = {};
  for (const [threadId, rows] of processRowsByThread.entries()) {
    threads[threadId] = rows;
  }
  return {
    processManagerPath,
    total: Object.values(threads).reduce((sum, rows) => sum + rows.length, 0),
    live: Object.values(threads).flat().filter((row) => row.alive).length,
    threads,
  };
}

function readConfigPayload() {
  return {
    version: packageJson.version || "0.0.0",
    provider,
    providerLabel,
    activeProviders,
    codexHome,
    claudeHome,
    copilotHome,
    dataHome,
    publicDir,
    statusWindows,
    updateCheckEnabled: !boolFromEnv("AGENTQUEUE_UPDATE_CHECK_DISABLED") && boolFromEnv("AGENTQUEUE_UPDATE_CHECK", true),
    projectConfig: {
      port: projectConfig.port || null,
      provider: projectConfig.provider || null,
      codexHome: projectConfig.codexHome || null,
      claudeHome: projectConfig.claudeHome || null,
      copilotHome: projectConfig.copilotHome || null,
      openBrowser: Boolean(projectConfig.openBrowser),
      recentMinutes: projectConfig.recentMinutes || null,
      completeMinutes: projectConfig.completeMinutes || null,
      staleMinutes: projectConfig.staleMinutes || null,
      webhook: projectConfig.webhook ? { ...projectConfig.webhook, signingToken: projectConfig.webhook.signingToken ? "********" : "" } : null,
    },
  };
}

function readProviderSourcePayload(sourceProvider) {
  if (sourceProvider === "claude") {
    return {
      provider: "claude",
      providerLabel: providerLabels.claude,
      claudeHome,
      dataHome: claudeHome,
      claudeProjectsRoot,
      tagsPath: claudeTagsPath,
      webhooksPath: path.join(claudeHome, "agentqueue-webhooks.json"),
      localStatePath: claudeLocalStatePath,
      sessionsRoot: claudeProjectsRoot,
      exists: {
        claudeHome: fsSync.existsSync(claudeHome),
        claudeProjectsRoot: fsSync.existsSync(claudeProjectsRoot),
        tags: fsSync.existsSync(claudeTagsPath),
        webhooks: fsSync.existsSync(path.join(claudeHome, "agentqueue-webhooks.json")),
        localState: fsSync.existsSync(claudeLocalStatePath),
      },
    };
  }
  if (sourceProvider === "copilot") {
    return {
      provider: "copilot",
      providerLabel: providerLabels.copilot,
      copilotHome,
      dataHome: copilotHome,
      copilotSessionStateRoot,
      dataDbPath: copilotDataDbPath,
      sessionStoreDbPath: copilotSessionStoreDbPath,
      tagsPath: copilotTagsPath,
      webhooksPath: path.join(copilotHome, "agentqueue-webhooks.json"),
      localStatePath: copilotLocalStatePath,
      sessionsRoot: copilotSessionStateRoot,
      exists: {
        copilotHome: fsSync.existsSync(copilotHome),
        copilotSessionStateRoot: fsSync.existsSync(copilotSessionStateRoot),
        dataDb: fsSync.existsSync(copilotDataDbPath),
        sessionStoreDb: fsSync.existsSync(copilotSessionStoreDbPath),
        tags: fsSync.existsSync(copilotTagsPath),
        webhooks: fsSync.existsSync(path.join(copilotHome, "agentqueue-webhooks.json")),
        localState: fsSync.existsSync(copilotLocalStatePath),
      },
    };
  }
  return {
    provider: "codex",
    providerLabel: providerLabels.codex,
    codexHome,
    dataHome: codexHome,
    candidateIndexPaths,
    globalStatePath,
    tagsPath: codexTagsPath,
    webhooksPath: path.join(codexHome, "agentqueue-webhooks.json"),
    processManagerPath,
    sessionsRoot,
    stateDbPath,
    goalsDbPath,
    logsDbPath,
    exists: {
      codexHome: fsSync.existsSync(codexHome),
      index: candidateIndexPaths.some((filePath) => fsSync.existsSync(filePath)),
      sessionIndex: candidateIndexPaths.filter((filePath) => fsSync.existsSync(filePath)),
      globalState: fsSync.existsSync(globalStatePath),
      tags: fsSync.existsSync(codexTagsPath),
      webhooks: fsSync.existsSync(path.join(codexHome, "agentqueue-webhooks.json")),
      processManager: fsSync.existsSync(processManagerPath),
      sessionsRoot: fsSync.existsSync(sessionsRoot),
      stateDb: fsSync.existsSync(stateDbPath),
      goalsDb: fsSync.existsSync(goalsDbPath),
      logsDb: fsSync.existsSync(logsDbPath),
    },
  };
}

function readSourcesPayload() {
  if (provider !== "mixed") return readProviderSourcePayload(provider);

  return {
    provider,
    providerLabel,
    activeProviders,
    codexHome,
    claudeHome,
    copilotHome,
    dataHome,
    sources: Object.fromEntries(activeProviders.map((name) => [name, readProviderSourcePayload(name)])),
  };
}

async function serveStatic(res, requestPath) {
  let safePath = requestPath === "/" ? "/index.html" : requestPath;
  if (safePath === "/v2" || safePath === "/v2/") safePath = "/v2/index.html";
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
    }[ext] || "application/octet-stream";
    sendText(res, 200, body, type);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function runDoctor() {
  const rows = [];
  const add = (status, label, detail) => rows.push({ status, label, detail });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const git = getGitInfo();

  add(nodeMajor >= 18 ? "pass" : "fail", "Node.js", `${process.version}${nodeMajor >= 24 ? " with node:sqlite support" : " without stable node:sqlite support"}`);
  add("pass", "Data source", `${providerLabel} (${provider})`);
  if (activeProviders.includes("codex")) {
    add(DatabaseSync ? "pass" : "warn", "SQLite inventory", DatabaseSync ? "node:sqlite is available" : "Node 24+ recommended for Codex SQLite inventory reads");
    add(fsSync.existsSync(codexHome) ? "pass" : "fail", "CODEX_HOME", codexHome);
    add(candidateIndexPaths.some((filePath) => fsSync.existsSync(filePath)) || fsSync.existsSync(stateDbPath) ? "pass" : "warn", "Thread inventory", "session_index.jsonl or state_5.sqlite");
    add(fsSync.existsSync(sessionsRoot) ? "pass" : "warn", "Sessions directory", sessionsRoot);
  }
  if (activeProviders.includes("claude")) {
    add(fsSync.existsSync(claudeHome) ? "pass" : "fail", "CLAUDE_HOME", claudeHome);
    add(fsSync.existsSync(claudeProjectsRoot) ? "pass" : "warn", "Claude projects", claudeProjectsRoot);
  }
  if (activeProviders.includes("copilot")) {
    add(fsSync.existsSync(copilotHome) ? "pass" : "fail", "COPILOT_HOME", copilotHome);
    add(fsSync.existsSync(copilotSessionStateRoot) ? "pass" : "warn", "Copilot sessions", copilotSessionStateRoot);
  }
  add(git.available ? "pass" : "warn", "Git", git.available ? "git command is available" : git.error || "git unavailable");
  add(git.isRepo ? "pass" : "warn", "Install type", git.isRepo ? `git clone on ${git.branch || "detached"} @ ${git.commit}` : "not a git checkout");
  if (git.isRepo) {
    add(git.dirty ? "warn" : "pass", "Local changes", git.dirty ? "working tree has local changes; update will stop" : "working tree clean");
    add(git.repo === expectedRepoSlug() ? "pass" : "warn", "GitHub remote", git.remote || "missing origin remote");
  }

  try {
    const release = await fetchLatestRelease(git.repo || expectedRepoSlug());
    await updateInstallMetadata({ lastUpdateCheck: new Date().toISOString(), repo: release.repo || git.repo || expectedRepoSlug() });
    if (release.available) {
      add(release.updateAvailable ? "warn" : "pass", "Latest release", release.updateAvailable ? `${release.latestTag} available; current ${release.currentVersion}` : `current ${release.currentVersion}`);
    } else {
      add("warn", "Latest release", release.reason || "update check disabled");
    }
  } catch (error) {
    add("warn", "Latest release", error.message);
  }

  console.log("AgentQueue doctor\n");
  for (const row of rows) {
    const mark = row.status === "pass" ? "PASS" : row.status === "fail" ? "FAIL" : "WARN";
    console.log(`[${mark}] ${row.label}: ${row.detail}`);
  }
  const failed = rows.some((row) => row.status === "fail");
  process.exitCode = failed ? 1 : 0;
}

function runUpdate() {
  const git = getGitInfo();
  console.log("AgentQueue update\n");
  if (!git.available) {
    console.error(`Git is unavailable: ${git.error || "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  if (!git.isRepo) {
    console.error("This install is not a git checkout. Download the latest GitHub release zip instead.");
    process.exitCode = 1;
    return;
  }
  if (git.repo !== expectedRepoSlug()) {
    console.error(`Refusing to update from unexpected remote: ${git.remote}`);
    console.error(`Expected GitHub repo: ${expectedRepoSlug()}`);
    process.exitCode = 1;
    return;
  }
  if (git.dirty) {
    console.error("Refusing to update because the working tree has local changes.");
    console.error("Commit, stash, or move those changes first, then run npm run update again.");
    process.exitCode = 1;
    return;
  }

  console.log(`Remote: ${git.remote}`);
  console.log(`Current: ${packageJson.version || "0.0.0"} @ ${git.commit}`);
  execFileSync("git", ["pull", "--ff-only"], { cwd: root, stdio: "inherit" });
  const nextVersion = readJsonFileSync(path.join(root, "package.json"), {}).version || "0.0.0";
  fsSync.writeFileSync(installMetadataPath, `${JSON.stringify({
    ...readJsonFileSync(installMetadataPath, {}),
    installedFrom: "github-git",
    repo: git.repo,
    version: nextVersion,
    lastUpdatedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  console.log(`\nAgentQueue is updated to ${nextVersion}. Run npm start to launch.`);
}

async function runUpdateCheck() {
  const git = getGitInfo();
  const release = await fetchLatestRelease(git.repo || expectedRepoSlug());
  await updateInstallMetadata({ lastUpdateCheck: new Date().toISOString(), repo: release.repo || git.repo || expectedRepoSlug() });
  if (!release.available) {
    console.log(release.reason || "No release information available.");
    return;
  }
  console.log(`Current: ${release.currentVersion}`);
  console.log(`Latest:  ${release.latestTag}`);
  console.log(release.updateAvailable ? `Update available: ${release.releaseUrl}` : "AgentQueue is current.");
}

async function renderHealthPage() {
  const git = getGitInfo();
  const release = await fetchLatestRelease(git.repo || expectedRepoSlug()).catch((error) => ({ available: false, reason: error.message }));
  const rows = [
    ["Version", packageJson.version || "0.0.0"],
    ["Source", `${providerLabel} (${provider})`],
    ["Node", process.version],
    ["CODEX_HOME", codexHome],
    ["CLAUDE_HOME", claudeHome],
    ["COPILOT_HOME", copilotHome],
    ["SQLite", DatabaseSync ? "available" : "unavailable; Node 24+ recommended"],
    ["Git install", git.isRepo ? `${git.repo} ${git.dirty ? "(local changes)" : "(clean)"}` : "not a git checkout"],
    ["Latest release", release.available ? `${release.latestTag}${release.updateAvailable ? " available" : " current"}` : release.reason || "unknown"],
  ];
  return `<!doctype html><html><head><meta charset="utf-8"><title>AgentQueue Health</title><style>body{font-family:Inter,system-ui,sans-serif;margin:24px;background:#f8fafc;color:#0f172a}main{max-width:820px}table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e2e8f0}td{padding:10px 12px;border-bottom:1px solid #e2e8f0}td:first-child{font-weight:700;color:#475569;width:180px}code{font-family:Consolas,monospace}</style></head><body><main><h1>AgentQueue Health</h1><table>${rows.map(([label, detail]) => `<tr><td>${label}</td><td><code>${escapeHtml(detail)}</code></td></tr>`).join("")}</table></main></body></html>`;
}

function jsonContent(schema) {
  return { "application/json": { schema } };
}

function okResponse(description, schema = { type: "object" }) {
  return { description, content: jsonContent(schema) };
}

function getOpenApiDocument() {
  const threadIdParameter = {
    name: "threadId",
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
    description: "Codex thread UUID.",
  };
  const errorResponse = okResponse("Error response", { $ref: "#/components/schemas/Error" });
  return {
    openapi: "3.1.0",
    info: {
      title: "AgentQueue API",
      version: packageJson.version || "0.0.0",
      description: `Local API for reading ${providerLabel} thread state and writing conservative AgentQueue thread metadata.`,
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "System" },
      { name: "Threads" },
      { name: "V2 Threads" },
      { name: "Tags" },
      { name: "Codex State" },
      { name: "Integrations" },
    ],
    paths: {
      "/api/health": {
        get: {
          tags: ["System"],
          summary: "Return server health and install metadata.",
          responses: { 200: okResponse("Health payload") },
        },
      },
      "/api/config": {
        get: {
          tags: ["System"],
          summary: "Return effective AgentQueue configuration.",
          responses: { 200: okResponse("Configuration payload") },
        },
      },
      "/api/sources": {
        get: {
          tags: ["System"],
          summary: "Return local Codex data source paths and presence checks.",
          responses: { 200: okResponse("Source inventory") },
        },
      },
      "/api/openapi.json": {
        get: {
          tags: ["System"],
          summary: "Return this OpenAPI document.",
          responses: { 200: okResponse("OpenAPI document") },
        },
      },
      "/api/update-check": {
        get: {
          tags: ["Integrations"],
          summary: "Check the configured GitHub Release for updates.",
          responses: { 200: okResponse("Update check result") },
        },
      },
      "/api/webhook": {
        get: {
          tags: ["Integrations"],
          summary: "Return thread status webhook configuration.",
          responses: { 200: okResponse("Webhook configuration", { $ref: "#/components/schemas/WebhookConfig" }) },
        },
        put: {
          tags: ["Integrations"],
          summary: "Replace thread status webhook configuration.",
          requestBody: { required: true, content: jsonContent({ $ref: "#/components/schemas/WebhookConfigInput" }) },
          responses: { 200: okResponse("Webhook configuration", { $ref: "#/components/schemas/WebhookConfig" }), 400: errorResponse },
        },
      },
      "/api/webhook/test": {
        post: {
          tags: ["Integrations"],
          summary: "Send a test webhook delivery to the configured endpoint.",
          responses: { 200: okResponse("Webhook test result"), 400: errorResponse },
        },
      },
      "/api/usage": {
        get: {
          tags: ["Threads"],
          summary: "Return local Codex token usage windows parsed from session logs.",
          responses: { 200: okResponse("Usage payload") },
        },
      },
      "/api/processes": {
        get: {
          tags: ["Threads"],
          summary: "Return live/local terminal process metadata grouped by thread.",
          responses: { 200: okResponse("Process payload") },
        },
      },
      "/api/tags": {
        get: {
          tags: ["Tags"],
          summary: "Return all AgentQueue tags and thread mappings.",
          responses: { 200: okResponse("Tag inventory") },
        },
      },
      "/api/threads": {
        get: {
          tags: ["Threads"],
          summary: "Return the full dashboard thread snapshot.",
          responses: { 200: okResponse("Thread snapshot", { $ref: "#/components/schemas/ThreadSnapshot" }) },
        },
      },
      "/api/v2/snapshot": {
        get: {
          tags: ["V2 Threads"],
          summary: "Return the V2 monitor snapshot contract.",
          responses: { 200: okResponse("V2 thread snapshot", { $ref: "#/components/schemas/V2Snapshot" }) },
        },
      },
      "/api/v2/threads/{threadId}": {
        get: {
          tags: ["V2 Threads"],
          summary: "Return one enriched thread from the current snapshot.",
          parameters: [threadIdParameter],
          responses: { 200: okResponse("V2 thread detail", { $ref: "#/components/schemas/V2ThreadDetail" }), 404: errorResponse },
        },
      },
      "/api/v2/threads/{threadId}/tags": {
        patch: {
          tags: ["V2 Threads"],
          summary: "Replace V2 thread tags in AgentQueue local sidecar.",
          parameters: [threadIdParameter],
          requestBody: { required: true, content: jsonContent({ $ref: "#/components/schemas/TagsInput" }) },
          responses: { 200: okResponse("Updated V2 tags"), 400: errorResponse },
        },
      },
      "/api/v2/threads/{threadId}/read": {
        post: {
          tags: ["V2 Threads"],
          summary: "Mark a V2 thread as read in Codex unread-state stores.",
          parameters: [threadIdParameter],
          responses: { 200: okResponse("Read-state update"), 400: errorResponse },
        },
      },
      "/api/v2/preferences": {
        get: {
          tags: ["V2 Threads"],
          summary: "Return V2 local preferences.",
          responses: { 200: okResponse("V2 preferences") },
        },
        patch: {
          tags: ["V2 Threads"],
          summary: "Update V2 local preferences in AgentQueue sidecar storage.",
          requestBody: { required: true, content: jsonContent({ $ref: "#/components/schemas/V2Preferences" }) },
          responses: { 200: okResponse("Updated V2 preferences"), 400: errorResponse },
        },
      },
      "/api/threads/{threadId}/session": {
        get: {
          tags: ["Threads"],
          summary: "Return the tail text of a thread session JSONL file.",
          parameters: [
            threadIdParameter,
            { name: "tailBytes", in: "query", schema: { type: "integer", minimum: 1, maximum: 2097152 } },
          ],
          responses: { 200: okResponse("Session tail"), 404: errorResponse },
        },
      },
      "/api/threads/{threadId}/events": {
        get: {
          tags: ["Threads"],
          summary: "Return parsed JSONL events from the tail of a thread session file.",
          parameters: [
            threadIdParameter,
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
            { name: "tailBytes", in: "query", schema: { type: "integer", minimum: 1, maximum: 2097152 } },
          ],
          responses: { 200: okResponse("Thread events"), 404: errorResponse },
        },
      },
      "/api/threads/{threadId}/tags": {
        patch: {
          tags: ["Tags"],
          summary: "Replace AgentQueue tags for a thread.",
          parameters: [threadIdParameter],
          requestBody: { required: true, content: jsonContent({ $ref: "#/components/schemas/TagsInput" }) },
          responses: { 200: okResponse("Updated tags"), 400: errorResponse },
        },
      },
      "/api/threads/{threadId}/read": {
        post: {
          tags: ["Codex State"],
          summary: "Remove a thread id from known Codex unread-state stores.",
          parameters: [threadIdParameter],
          responses: { 200: okResponse("Read-state update"), 400: errorResponse },
        },
      },
      "/api/threads/{threadId}/state": {
        patch: {
          tags: ["Codex State"],
          summary: "Update supported Codex global-state flags for a thread.",
          parameters: [threadIdParameter],
          requestBody: { required: true, content: jsonContent({ $ref: "#/components/schemas/ThreadStateInput" }) },
          responses: { 200: okResponse("Updated thread state"), 400: errorResponse },
        },
      },
      "/api/threads/{threadId}/open": {
        post: {
          tags: ["Integrations"],
          summary: "Open a thread via its provider link (codex:// for Codex, file:// transcript/event files for local transcript providers).",
          parameters: [threadIdParameter],
          requestBody: { content: jsonContent({ type: "object", properties: { dryRun: { type: "boolean" } } }) },
          responses: { 200: okResponse("Open result"), 400: errorResponse },
        },
      },
      "/api/events": {
        get: {
          tags: ["Integrations"],
          summary: "Stream thread snapshots as Server-Sent Events.",
          responses: {
            200: {
              description: "SSE stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      },
      "/api/threads/read": {
        post: {
          tags: ["Codex State"],
          deprecated: true,
          summary: "Legacy bulk mark-read endpoint.",
          requestBody: { required: true, content: jsonContent({ type: "object", properties: { threadIds: { type: "array", items: { type: "string", format: "uuid" } } } }) },
          responses: { 200: okResponse("Read-state update"), 400: errorResponse },
        },
      },
      "/api/threads/tags": {
        post: {
          tags: ["Tags"],
          deprecated: true,
          summary: "Legacy thread tag replacement endpoint.",
          requestBody: { required: true, content: jsonContent({ type: "object", properties: { threadId: { type: "string", format: "uuid" }, tags: { type: "array", items: { type: "string" } } } }) },
          responses: { 200: okResponse("Updated tags"), 400: errorResponse },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" } },
          required: ["error"],
        },
        ThreadSnapshot: {
          type: "object",
          properties: {
            refreshedAt: { type: "string", format: "date-time" },
            summary: { type: "object" },
            threads: { type: "array", items: { type: "object" } },
          },
        },
        V2Snapshot: {
          type: "object",
          required: ["generatedAt", "codexHome", "health", "summary", "threads"],
          properties: {
            generatedAt: { type: "string", format: "date-time" },
            codexHome: { type: "string" },
            health: { $ref: "#/components/schemas/V2Health" },
            summary: { $ref: "#/components/schemas/V2Summary" },
            threads: {
              type: "array",
              items: { $ref: "#/components/schemas/ThreadSummary" },
            },
          },
        },
        V2Health: {
          type: "object",
          required: ["level", "warnings"],
          properties: {
            level: { type: "string", enum: ["ok", "warn", "error"] },
            warnings: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        V2Summary: {
          type: "object",
          required: ["total", "running", "stale", "needsAttention", "unread", "risk"],
          properties: {
            total: { type: "integer", minimum: 0 },
            running: { type: "integer", minimum: 0 },
            stale: { type: "integer", minimum: 0 },
            needsAttention: { type: "integer", minimum: 0 },
            unread: { type: "integer", minimum: 0 },
            risk: { type: "integer", minimum: 0 },
          },
        },
        ThreadSummary: {
          type: "object",
          required: [
            "id",
            "title",
            "status",
            "statusLabel",
            "attentionRank",
            "attentionReason",
            "confidence",
            "threadSource",
          ],
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            workspace: { type: ["string", "null"] },
            workspaceLabel: { type: "string" },
            status: { type: "string", enum: Object.values(THREAD_STATUSES) },
            statusLabel: { type: "string" },
            attentionRank: { type: "integer", minimum: 0 },
            attentionReason: { type: "string", enum: Object.values(ATTENTION_REASON_ENUM) },
            confidence: { type: "string", enum: Object.values(CONFIDENCE_LEVELS) },
            activityAt: { type: ["string", "null"], format: "date-time" },
            activityAgeMs: { type: ["number", "null"], minimum: 0 },
            threadSource: { type: "string" },
            parentThreadId: { type: ["string", "null"], format: "uuid" },
            badges: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            openUrl: { type: "string", format: "uri" },
            evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/StatusEvidence" },
            },
          },
        },
        StatusEvidence: {
          type: "object",
          required: ["kind", "source", "observedAt", "message"],
          properties: {
            kind: { type: "string", enum: Object.values(EVIDENCE_KINDS) },
            source: { type: "string" },
            observedAt: { type: ["string", "null"], format: "date-time" },
            message: { type: "string" },
          },
          additionalProperties: false,
        },
        ThreadDetail: {
          type: "object",
          required: ["thread", "timeline", "sources", "diagnostics", "actions", "evidence", "generatedAt", "codexHome"],
          properties: {
            thread: { $ref: "#/components/schemas/ThreadSummary" },
            timeline: { type: "array", items: { $ref: "#/components/schemas/ThreadDetailTimelineItem" } },
            sources: { type: "array", items: { $ref: "#/components/schemas/ThreadDetailSource" } },
            diagnostics: { type: "array", items: { $ref: "#/components/schemas/ThreadDetailDiagnostic" } },
            actions: { $ref: "#/components/schemas/ThreadDetailActions" },
            evidence: {
              type: "array",
              items: { $ref: "#/components/schemas/StatusEvidence" },
            },
            generatedAt: { type: "string", format: "date-time" },
            codexHome: { type: "string" },
          },
        },
        ThreadDetailTimelineItem: {
          type: "object",
          properties: {
            kind: { type: "string" },
            at: { type: ["string", "null"], format: "date-time" },
            label: { type: "string" },
            message: { type: "string" },
          },
        },
        ThreadDetailSource: {
          type: "object",
          properties: {
            kind: { type: "string" },
            available: { type: "boolean" },
            path: { type: ["string", "null"] },
          },
        },
        ThreadDetailDiagnostic: {
          type: "object",
          properties: {
            level: { type: "string", enum: ["warning", "info", "error"] },
            code: { type: "string" },
            message: { type: "string" },
          },
        },
        ThreadDetailActions: {
          type: "object",
          required: ["canOpen", "canMarkRead", "canTag", "canPin"],
          properties: {
            canOpen: { type: "boolean" },
            canMarkRead: { type: "boolean" },
            canTag: { type: "boolean" },
            canPin: { type: "boolean" },
          },
        },
        V2ThreadDetail: { $ref: "#/components/schemas/ThreadDetail" },
        V2Preferences: {
          type: "object",
          properties: {
            version: { type: "string" },
            monitorView: { type: "string", enum: ["list", "board"] },
            focusNeedsAttention: { type: "boolean" },
            hideDone: { type: "boolean" },
          },
          required: ["version", "monitorView", "focusNeedsAttention", "hideDone"],
          additionalProperties: false,
        },
        TagsInput: {
          type: "object",
          properties: { tags: { type: "array", items: { type: "string" }, maxItems: 12 } },
          required: ["tags"],
        },
        ThreadStateInput: {
          type: "object",
          properties: {
            pinned: { type: "boolean" },
            projectless: { type: "boolean" },
            archived: { type: "boolean" },
          },
          additionalProperties: false,
        },
        WebhookConfig: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            endpoint: { type: "string" },
            configured: { type: "boolean" },
            includeSubagents: { type: "boolean" },
            statuses: { type: "object", additionalProperties: { type: "boolean" } },
            messages: { type: "object", additionalProperties: { type: "string" } },
            signingToken: { type: "string", description: "Masked when configured." },
          },
        },
        WebhookConfigInput: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            endpoint: { type: "string", format: "uri" },
            includeSubagents: { type: "boolean" },
            statuses: { type: "object", additionalProperties: { type: "boolean" } },
            messages: { type: "object", additionalProperties: { type: "string", maxLength: 500 } },
            signingToken: { type: "string" },
            headers: { type: "object", additionalProperties: { type: "string" } },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 },
          },
          additionalProperties: false,
        },
      },
    },
  };
}

function renderSwaggerPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AgentQueue API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #f8fafc; color: #0f172a; font-family: Inter, system-ui, sans-serif; }
    .topbar { display: none; }
    #swagger-ui { max-width: 1280px; margin: 0 auto; }
    .swagger-ui .scheme-container, .swagger-ui .opblock, .swagger-ui .info { border-radius: 4px; box-shadow: none; }
    .swagger-ui .info { margin: 18px 0; }
    .swagger-ui code, .swagger-ui textarea { font-family: "JetBrains Mono", Consolas, monospace; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "/api/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      displayRequestDuration: true,
      persistAuthorization: false,
    });
  </script>
</body>
</html>`;
}

async function sendEvent(res) {
  const payload = await loadThreads();
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function matchThreadRoute(pathname) {
  const match = pathname.match(/^\/api\/threads\/([0-9a-f-]{36})(?:\/([^/]+))?$/i);
  if (!match) return null;
  return { threadId: match[1], action: match[2] || "" };
}

async function handleApiRequest(req, res, url) {
  if (url.pathname === "/api/docs") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendText(res, 200, renderSwaggerPage(), "text/html; charset=utf-8");
    return true;
  }

  if (url.pathname === "/api/openapi.json") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, getOpenApiDocument());
    return true;
  }

  if (url.pathname === "/api/v2/snapshot") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const payload = await loadV2SnapshotPayload(new Date());
    sendJson(res, 200, payload.snapshot);
    return true;
  }

  if (url.pathname === "/api/v2/preferences") {
    if (req.method === "GET") {
      sendJson(res, 200, { ok: true, preferences: await readPreferences(codexHome) });
      return true;
    }

    if (req.method === "PATCH") {
      const body = await readRequestJson(req);
      sendJson(res, 200, { ok: true, preferences: await patchPreferences(codexHome, body) });
      return true;
    }

    return sendMethodNotAllowed(res, ["GET", "PATCH"]);
  }

  const v2ThreadRoute = url.pathname.match(/^\/api\/v2\/threads\/([0-9a-f-]{36})(?:\/([^/]+))?$/i);
  if (v2ThreadRoute) {
    const threadId = v2ThreadRoute[1];
    const action = v2ThreadRoute[2] || "";

    if (!action) {
      if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
      const found = await getV2ThreadPayload(threadId);
      if (!found) return sendJson(res, 404, { error: "Thread not found" });
      sendJson(res, 200, found);
      return true;
    }

    if (action === "tags") {
      if (req.method !== "PATCH") return sendMethodNotAllowed(res, ["PATCH"]);
      const body = await readRequestJson(req);
      sendJson(res, 200, { ok: true, ...(await setV2ThreadTags(codexHome, threadId, body.tags)) });
      return true;
    }

    if (action === "read") {
      if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
      sendJson(res, 200, { ok: true, ...(await markThreadsRead([threadId])) });
      return true;
    }

    return sendJson(res, 404, { error: "Unsupported V2 thread action" });
  }

  if (url.pathname === "/api/threads/read") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const body = await readRequestJson(req);
    sendJson(res, 200, { ok: true, ...(await markThreadsRead(body.threadIds)) });
    return true;
  }

  if (url.pathname === "/api/webhook") {
    if (req.method === "GET") {
      sendJson(res, 200, publicWebhookConfig(await readWebhookConfig()));
      return true;
    }

    if (req.method === "PUT") {
      const current = await readWebhookConfig();
      const rawBody = await readRequestJson(req);
      const body = rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? rawBody : {};
      const next = {
        ...current,
        ...body,
        signingToken: body.signingToken ? body.signingToken : current.signingToken,
        statuses: { ...current.statuses, ...(body.statuses || {}) },
        messages: { ...current.messages, ...(body.messages || {}) },
        headers: Object.prototype.hasOwnProperty.call(body, "headers") ? { ...(body.headers || {}) } : current.headers,
      };
      sendJson(res, 200, publicWebhookConfig(await writeWebhookConfig(next)));
      return true;
    }

    return sendMethodNotAllowed(res, ["GET", "PUT"]);
  }

  if (url.pathname === "/api/webhook/test") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    sendJson(res, 200, await testWebhook());
    return true;
  }

  if (url.pathname === "/api/threads") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, await loadThreads());
    return true;
  }

  if (url.pathname === "/api/threads/read") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const body = await readRequestJson(req);
    sendJson(res, 200, { ok: true, ...(await markThreadsRead(body.threadIds)) });
    return true;
  }

  if (url.pathname === "/api/threads/tags") {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
    const body = await readRequestJson(req);
    sendJson(res, 200, { ok: true, ...(await setThreadTags(body.threadId, body.tags)) });
    return true;
  }

  const threadRoute = matchThreadRoute(url.pathname);
  if (threadRoute) {
    const { threadId, action } = threadRoute;

    if (!action) {
      if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
      const found = await getThreadSnapshot(threadId);
      if (!found?.thread) return sendJson(res, 404, { error: "Thread not found" });
      sendJson(res, 200, { thread: found.thread, refreshedAt: found.snapshot.refreshedAt });
      return true;
    }

    if (action === "session") {
      if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
      const payload = await readThreadSessionPayload(threadId, url.searchParams);
      if (!payload) return sendJson(res, 404, { error: "Thread not found" });
      sendJson(res, 200, payload);
      return true;
    }

    if (action === "events") {
      if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
      const payload = await readThreadEventsPayload(threadId, url.searchParams);
      if (!payload) return sendJson(res, 404, { error: "Thread not found" });
      sendJson(res, 200, payload);
      return true;
    }

    if (action === "tags") {
      if (req.method !== "PATCH") return sendMethodNotAllowed(res, ["PATCH"]);
      const body = await readRequestJson(req);
      sendJson(res, 200, { ok: true, ...(await setThreadTags(threadId, body.tags)) });
      return true;
    }

    if (action === "read") {
      if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
      sendJson(res, 200, { ok: true, ...(await markThreadsRead([threadId])) });
      return true;
    }

    if (action === "state") {
      if (req.method !== "PATCH") return sendMethodNotAllowed(res, ["PATCH"]);
      const body = await readRequestJson(req);
      sendJson(res, 200, { ok: true, ...(await setThreadState(threadId, body)) });
      return true;
    }

    if (action === "open") {
      if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
      const body = await readRequestJson(req);
      let target = `codex://threads/${threadId}`;
      const targetProvider = await getThreadProvider(threadId);
      if (targetProvider === "claude") {
        const filePath = (await getClaudeSessionFilesById()).get(threadId);
        target = filePath ? pathToFileURL(filePath).href : "";
      } else if (targetProvider === "copilot") {
        const filePath = (await getCopilotSessionFilesById()).get(threadId);
        target = filePath ? pathToFileURL(filePath).href : "";
      }
      const opened = Boolean(target) && !body.dryRun;
      if (opened) openBrowser(target);
      sendJson(res, 200, { ok: true, threadId, url: target, codexUrl: target, opened });
      return true;
    }
  }

  if (url.pathname === "/api/tags") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, await readTagsPayload());
    return true;
  }

  if (url.pathname === "/api/processes") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, await readProcessesPayload());
    return true;
  }

  if (url.pathname === "/api/config") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, readConfigPayload());
    return true;
  }

  if (url.pathname === "/api/sources") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, readSourcesPayload());
    return true;
  }

  if (url.pathname === "/api/health") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, {
      ok: true,
      version: packageJson.version || "0.0.0",
      provider,
      providerLabel,
      activeProviders,
      codexHome,
      claudeHome,
      copilotHome,
      dataHome,
      node: process.version,
      sqlite: Boolean(DatabaseSync),
      git: getGitInfo(),
      now: new Date().toISOString(),
    });
    return true;
  }

  if (url.pathname === "/api/update-check") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    const git = getGitInfo();
    const release = await fetchLatestRelease(git.repo || expectedRepoSlug());
    await updateInstallMetadata({ lastUpdateCheck: new Date().toISOString(), repo: release.repo || git.repo || expectedRepoSlug() });
    sendJson(res, 200, { ...release, gitInstall: Boolean(git.isRepo), dirty: Boolean(git.dirty) });
    return true;
  }

  if (url.pathname === "/api/usage") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    sendJson(res, 200, await readUsageMetrics());
    return true;
  }

  if (url.pathname === "/api/events") {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    await sendEvent(res);
    const timer = setInterval(() => {
      sendEvent(res).catch((error) => {
        res.write(`event: error\n`);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      });
    }, 3000);
    req.on("close", () => clearInterval(timer));
    return true;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "API endpoint not found" });
    return true;
  }

  return false;
}

function createAgentQueueServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");

    try {
      if (url.pathname === "/health") {
        if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
        sendText(res, 200, await renderHealthPage(), "text/html; charset=utf-8");
        return;
      }

      if (await handleApiRequest(req, res, url)) return;

      await serveStatic(res, url.pathname);
    } catch (error) {
      if (res.headersSent) {
        console.error(error.stack || error.message);
        res.end();
        return;
      }
      const status = /invalid|unsupported|required|must be|too large|JSON/i.test(error.message) ? 400 : 500;
      sendJson(res, status, { error: error.message });
    }
  });
}

async function runWebhookWatcherTick() {
  const config = await readWebhookConfig();
  if (!config.enabled || !config.endpoint) return;
  await loadThreads();
}

function startWebhookWatcher() {
  if (webhookWatcher) return;
  runWebhookWatcherTick().catch((error) => {
    console.error(`AgentQueue webhook watcher failed: ${error.message}`);
  });
  webhookWatcher = setInterval(() => {
    runWebhookWatcherTick().catch((error) => {
      console.error(`AgentQueue webhook watcher failed: ${error.message}`);
    });
  }, 3000);
}

function stopWebhookWatcher() {
  if (!webhookWatcher) return;
  clearInterval(webhookWatcher);
  webhookWatcher = null;
}

function closeServer(server) {
  stopWebhookWatcher();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function startAgentQueueServer(options = {}) {
  const server = options.server || createAgentQueueServer();
  const startPort = Number(options.port || process.env.PORT || projectConfig.port || 4173);
  const host = options.host || "127.0.0.1";
  const attempts = Number.isFinite(Number(options.attempts)) ? Number(options.attempts) : 12;
  const openOnStart = Boolean(options.openOnStart);
  const log = options.log === false ? () => {} : (options.log || console.log);

  return new Promise((resolve, reject) => {
    function listenOn(port, attemptsLeft) {
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
          listenOn(port + 1, attemptsLeft - 1);
          return;
        }
        reject(error);
      });

      server.listen(port, host, () => {
        const address = server.address();
        const selectedPort = typeof address === "object" && address ? address.port : port;
        const url = `http://${host}:${selectedPort}`;
        log(`AgentQueue running at ${url}`);
        startWebhookWatcher();
        if (openOnStart) openBrowser(url);
        resolve({
          server,
          url,
          port: selectedPort,
          host,
          close: () => closeServer(server),
        });
      });
    }

    listenOn(startPort, attempts);
  });
}

async function runAgentQueueCli(argv = process.argv.slice(2)) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "start";
  ensureInstallMetadata();
  if (command === "doctor") {
    await runDoctor();
    return;
  }
  if (command === "update") {
    runUpdate();
    return;
  }
  if (command === "update-check" || command === "check-updates") {
    await runUpdateCheck();
    return;
  }
  if (command !== "start") {
    console.error(`Unknown command: ${command}`);
    console.error("Use: start, doctor, update, or update-check");
    process.exitCode = 1;
    return;
  }

  const shouldOpen = argv.includes("--open") || boolFromEnv("AGENTQUEUE_OPEN", Boolean(projectConfig.openBrowser));
  await startAgentQueueServer({
    port: Number(process.env.PORT || projectConfig.port || 4173),
    host: "localhost",
    openOnStart: shouldOpen,
  });
}

module.exports = {
  createAgentQueueServer,
  startAgentQueueServer,
  runAgentQueueCli,
};

if (require.main === module) {
  runAgentQueueCli().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
