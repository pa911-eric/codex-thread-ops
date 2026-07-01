const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

function isThreadId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function defaultGlobalStatePath(codexHome) {
  return path.join(codexHome, ".codex-global-state.json");
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
  return typeof atomState === "object" && atomState !== null ? atomState : {};
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

async function writeGlobalState(state, atomState = null, atomStateWasString = false, statePath = null) {
  if (!statePath) throw new Error("Missing global-state path");

  if (atomStateWasString && atomState) {
    state["electron-persisted-atom-state"] = JSON.stringify(atomState);
  }

  await writeJsonFileAtomic(statePath, state && typeof state === "object" ? state : {});
}

function removeUnreadIdsFromStore(store, ids) {
  if (!store) return 0;

  if (Array.isArray(store)) {
    const next = store.filter((value) => !ids.has(value));
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

async function readGlobalState(codexHome) {
  const statePath = defaultGlobalStatePath(codexHome);
  const raw = await readJsonFile(statePath, {});
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const atomState = getPersistedAtomState(state);
  const unreadThreadIds = collectUnreadThreadIds(state, atomState);
  return {
    statePath,
    state,
    atomState,
    atomStateWasString: typeof raw["electron-persisted-atom-state"] === "string",
    unreadThreadIds,
  };
}

async function markThreadsRead(codexHome, threadIds = []) {
  const ids = new Set((Array.isArray(threadIds) ? threadIds : []).filter(isThreadId));
  if (ids.size === 0) return { markedIds: [], removed: 0 };

  const payload = await readGlobalState(codexHome);
  let removed = 0;
  const { state, atomState, atomStateWasString, statePath } = payload;

  for (const storeName of [
    "unread-thread-ids-by-host-v1",
    "unread-thread-ids",
    "thread-unread-state-by-host-v1",
    "thread-unread-state",
  ]) {
    removed += removeUnreadIdsFromStore(state[storeName], ids);
    removed += removeUnreadIdsFromStore(atomState[storeName], ids);
  }

  if (removed > 0) {
    await writeGlobalState(state, atomState, atomStateWasString, statePath);
  }

  return { markedIds: Array.from(ids), removed };
}

function isCodexStateAvailable(codexHome) {
  const statePath = defaultGlobalStatePath(codexHome);
  return fsSync.existsSync(statePath);
}

module.exports = {
  collectUnreadThreadIds,
  defaultGlobalStatePath,
  getPersistedAtomState,
  isCodexStateAvailable,
  markThreadsRead,
  readGlobalState,
  writeGlobalState,
};
