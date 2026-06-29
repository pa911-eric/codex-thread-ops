#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ACTIONS,
  ACTION_META,
  buildKeyState,
  pickMostRecentThread,
  renderKeySvg,
  svgDataUrl,
} = require("./common");
const { StreamDeckWebSocket } = require("./streamdeck-ws");

const DEFAULT_BASE_URL = "http://localhost:4173";
const DEFAULT_POLL_MS = 3000;
const visibleContexts = new Map();

let streamDeck = null;
let pluginUuid = "";
let latestSnapshot = null;
let latestConnectionState = { connected: false, error: "starting" };
let activeBaseUrl = "";
let timer = null;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("-")) continue;
    values[item.replace(/^-+/, "")] = argv[index + 1];
    index += 1;
  }
  return values;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function loadConfig() {
  const localConfig = readJson(path.join(__dirname, "..", "agentqueue-streamdeck.config.json"));
  const pollMs = Number(process.env.AGENTQUEUE_STREAMDECK_POLL_MS || localConfig.pollMs || DEFAULT_POLL_MS);
  return {
    baseUrl: String(process.env.AGENTQUEUE_STREAMDECK_BASE_URL || localConfig.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    pollMs: Number.isFinite(pollMs) && pollMs >= 1000 ? pollMs : DEFAULT_POLL_MS,
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBaseUrl(configuredBaseUrl) {
  const candidates = [configuredBaseUrl];
  for (let port = 4173; port <= 4185; port += 1) candidates.push(`http://localhost:${port}`);

  const unique = Array.from(new Set(candidates.map((url) => String(url || "").replace(/\/+$/, "")).filter(Boolean)));
  for (const baseUrl of unique) {
    try {
      await fetchJson(`${baseUrl}/api/health`);
      return baseUrl;
    } catch {
      // Continue probing likely AgentQueue ports.
    }
  }
  return configuredBaseUrl;
}

function send(event, context, payload = {}) {
  if (!streamDeck) return;
  streamDeck.send({ event, context, payload });
}

function updateKey(context, action) {
  const state = buildKeyState(action, latestSnapshot, latestConnectionState);
  if (!state) return;
  send("setTitle", context, { title: "", target: 0 });
  send("setImage", context, { image: svgDataUrl(renderKeySvg(state)), target: 0 });
}

function updateAllKeys() {
  for (const [context, action] of visibleContexts.entries()) updateKey(context, action);
}

async function refreshSnapshot() {
  const config = loadConfig();
  if (!activeBaseUrl) activeBaseUrl = await detectBaseUrl(config.baseUrl);

  try {
    latestSnapshot = await fetchJson(`${activeBaseUrl}/api/threads`);
    latestConnectionState = { connected: true, error: "" };
  } catch {
    activeBaseUrl = await detectBaseUrl(config.baseUrl);
    try {
      latestSnapshot = await fetchJson(`${activeBaseUrl}/api/threads`);
      latestConnectionState = { connected: true, error: "" };
    } catch (error) {
      latestConnectionState = { connected: false, error: "offline" };
    }
  }

  updateAllKeys();
}

async function openMostRecent(action) {
  const meta = ACTION_META[action];
  if (!meta || meta.kind !== "open") return;
  await refreshSnapshot();
  const thread = pickMostRecentThread(latestSnapshot, meta.status);
  if (!thread?.id || !activeBaseUrl) return;

  await fetch(`${activeBaseUrl}/api/threads/${thread.id}/open`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

function handleMessage(text) {
  let message = null;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  if (message.event === "willAppear" && message.context && Object.values(ACTIONS).includes(message.action)) {
    visibleContexts.set(message.context, message.action);
    updateKey(message.context, message.action);
    return;
  }

  if (message.event === "willDisappear" && message.context) {
    visibleContexts.delete(message.context);
    return;
  }

  if (message.event === "keyDown" && message.action && message.context) {
    openMostRecent(message.action)
      .then(() => updateKey(message.context, message.action))
      .catch(() => {
        latestConnectionState = { connected: false, error: "open failed" };
        updateKey(message.context, message.action);
      });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  pluginUuid = args.pluginUUID || "";
  const registerEvent = args.registerEvent || "";

  streamDeck = await new StreamDeckWebSocket({
    port: args.port,
    onMessage: handleMessage,
    onClose: () => process.exit(0),
  }).connect();

  streamDeck.send({ event: registerEvent, uuid: pluginUuid });
  await refreshSnapshot();

  const config = loadConfig();
  timer = setInterval(() => {
    refreshSnapshot().catch(() => {
      latestConnectionState = { connected: false, error: "offline" };
      updateAllKeys();
    });
  }, config.pollMs);
}

process.on("SIGTERM", () => {
  if (timer) clearInterval(timer);
  process.exit(0);
});

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
