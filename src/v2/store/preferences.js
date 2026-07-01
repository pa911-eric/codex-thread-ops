const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_PREFERENCES = Object.freeze({
  version: "v2",
  monitorView: "list",
  focusNeedsAttention: true,
  hideDone: false,
});

function preferencesPath(codexHome) {
  return path.join(codexHome, "agentqueue-v2-preferences.json");
}

function normalizePreferencesPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Preferences payload must be an object");
  }

  const next = {};
  const allowedKeys = new Set(Object.keys(DEFAULT_PREFERENCES));
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedKeys.has(key)) throw new Error(`Unsupported preference: ${key}`);

    if (typeof value !== "boolean" && typeof value !== "string") {
      throw new Error(`Preference ${key} must be a string or boolean`);
    }
    next[key] = value;
  }

  if (!Object.keys(next).length) throw new Error("No supported preferences were provided");
  return next;
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    return raw && typeof raw === "object" ? raw : fallback;
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

async function readPreferences(codexHome) {
  const raw = await readJsonFile(preferencesPath(codexHome), {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_PREFERENCES };
  const next = { ...DEFAULT_PREFERENCES };
  for (const [key, value] of Object.entries(raw)) {
    if (Object.prototype.hasOwnProperty.call(DEFAULT_PREFERENCES, key)) {
      next[key] = value;
    }
  }
  return next;
}

async function patchPreferences(codexHome, patch) {
  const updates = normalizePreferencesPayload(patch);
  const current = await readPreferences(codexHome);
  const next = { ...current, ...updates };
  await writeJsonFileAtomic(preferencesPath(codexHome), next);
  return next;
}

module.exports = {
  DEFAULT_PREFERENCES,
  preferencesPath,
  patchPreferences,
  readPreferences,
};
