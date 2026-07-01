const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
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

function tagsPath(codexHome) {
  return path.join(codexHome, "agentqueue-v2-tags.json");
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
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

async function readTagsByThread(codexHome) {
  const raw = await readJsonFile(tagsPath(codexHome), {});
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const byThread = {};

  for (const [threadId, threadTags] of Object.entries(source)) {
    if (!/^[0-9a-f-]{36}$/i.test(threadId)) continue;
    const cleaned = cleanTags(threadTags);
    if (cleaned.length) byThread[threadId] = cleaned;
  }

  return byThread;
}

async function setThreadTags(codexHome, threadId, tags) {
  if (typeof threadId !== "string" || !/^[0-9a-f-]{36}$/i.test(threadId)) {
    throw new Error("Invalid thread id");
  }

  const normalized = cleanTags(tags);
  const allTags = await readTagsByThread(codexHome);
  if (normalized.length) allTags[threadId] = normalized;
  else delete allTags[threadId];

  await writeJsonFileAtomic(tagsPath(codexHome), allTags);
  return { threadId, tags: normalized };
}

async function readThreadTagsForThread(codexHome, threadId) {
  const byThread = await readTagsByThread(codexHome);
  return byThread[threadId] || [];
}

module.exports = {
  tagsPath,
  cleanTags,
  normalizeTag,
  readTagsByThread,
  readThreadTagsForThread,
  setThreadTags,
};
