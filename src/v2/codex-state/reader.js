const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function defaultPaths(codexHome) {
  return {
    codexHome,
    sessionsRoot: path.join(codexHome, "sessions"),
    sessionIndexPaths: [
      path.join(codexHome, "session_index.jsonl"),
      path.join(codexHome, "sessions", "session_index.jsonl"),
    ],
    globalStatePath: path.join(codexHome, ".codex-global-state.json"),
    processManagerPath: path.join(codexHome, "process_manager", "chat_processes.json"),
    stateDbPath: path.join(codexHome, "state_5.sqlite"),
    goalsDbPath: path.join(codexHome, "goals_1.sqlite"),
  };
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
        return { id: `invalid-${index}`, parse_error: error.message };
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
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(fullPath);
    }));
  }

  await walk(dir);
  return found;
}

async function readTail(filePath, maxBytes = 160 * 1024) {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const handle = await fs.open(filePath, "r");
  try {
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, stat };
  } finally {
    await handle.close();
  }
}

function epochToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return new Date(number > 10_000_000_000 ? number : number * 1000).toISOString();
}

function stripWindowsNamespace(value) {
  return String(value || "").replace(/^\\\\\\?\\/, "");
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

async function readSessionSummary(filePath, cache = new Map()) {
  if (!filePath) return null;

  try {
    const stat = await fs.stat(filePath);
    const cached = cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.summary;
    }

    const tail = await readTail(filePath);
    const lines = tail.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const summary = summarizeSessionLines(lines);
    summary.filePath = filePath;
    summary.fileSize = tail.stat.size;
    summary.fileModifiedAt = tail.stat.mtime.toISOString();

    cache.set(filePath, {
      size: tail.stat.size,
      mtimeMs: tail.stat.mtimeMs,
      summary,
    });

    return summary;
  } catch {
    return null;
  }
}

function isThreadId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

async function firstExistingPath(paths) {
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // keep checking
    }
  }
  return null;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function getSessionFilesById(sessionsRoot) {
  const files = await walkJsonlFiles(sessionsRoot);
  const byId = new Map();
  for (const filePath of files) {
    const match = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    if (match) byId.set(match[1], filePath);
  }
  return byId;
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

async function readProcessRows(processManagerPath) {
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

function readThreadsFromSqlite(stateDbPath) {
  return readSqliteRows(stateDbPath, `
    select id, title, preview, rollout_path, cwd, source, thread_source, agent_nickname,
           agent_role, created_at, updated_at, created_at_ms, updated_at_ms, recency_at_ms,
           archived, archived_at, sandbox_policy, approval_mode, tokens_used, git_branch,
           git_origin_url, model, reasoning_effort
    from threads
    order by coalesce(updated_at_ms, updated_at * 1000) desc
  `).map((row) => ({
    id: row.id,
    thread_name: row.title,
    preview: row.preview,
    rolloutPath: row.rollout_path,
    cwd: stripWindowsNamespace(row.cwd),
    source: row.source,
    threadSource: row.thread_source || "main",
    parentThreadId: parseParentThreadId(row.source),
    agentNickname: row.agent_nickname,
    agentRole: row.agent_role,
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

function maxIso(...values) {
  const times = values
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((time) => !Number.isNaN(time));

  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function toWorkspaceLabel(codexPath) {
  if (!codexPath) return "unknown";
  const parts = String(codexPath).split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "unknown";
}

function normalizeThreadIdSet(value) {
  const values = Array.isArray(value) ? value : [];
  return new Set(values.filter((item) => isThreadId(item)));
}

function readGoals(goalsDbPath) {
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

function readSpawnEdges(stateDbPath) {
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

function computeMissingSignals({ thread, hasSessionFile, hasSessionSummary, hasSqliteRecord, hasIndexRecord, hasProcess, hasGlobalState }) {
  return !hasSessionFile && !hasSessionSummary && !hasSqliteRecord && !hasIndexRecord && !hasProcess && !hasGlobalState;
}

async function readV2RawThreads(codexHome, options = {}) {
  const now = options.now || new Date();
  const paths = defaultPaths(codexHome);
  const nowIso = now.toISOString();
  const warnings = [];
  const indexPath = await firstExistingPath(paths.sessionIndexPaths);

  const threadsFromSqlite = readThreadsFromSqlite(paths.stateDbPath);
  const usingSqlite = threadsFromSqlite.length > 0;

  if (!indexPath && !usingSqlite) {
    return {
      generatedAt: nowIso,
      codexHome,
      warnings: [`No thread index found. Checked: ${paths.sessionIndexPaths.join(", ")}`],
      sources: {
        source: "none",
        indexPath: null,
        stateDbPath: paths.stateDbPath,
        goalsDbPath: paths.goalsDbPath,
        processManagerPath: paths.processManagerPath,
        sessionsRoot: paths.sessionsRoot,
      },
      threads: [],
    };
  }

  const indexText = indexPath ? await fs.readFile(indexPath, "utf8") : "";
  const threadsSource = usingSqlite ? threadsFromSqlite : readThreadsFromIndex(indexText);
  const uniqueThreads = new Map(threadsSource.map((thread) => [thread.id, thread]));
  const threads = Array.from(uniqueThreads.values());

  const [globalStatePayload, sessionFilesById, processRowsByThread, goals] = await Promise.all([
    readJsonFile(paths.globalStatePath, {}),
    getSessionFilesById(paths.sessionsRoot),
    readProcessRows(paths.processManagerPath),
    Promise.resolve(readGoals(paths.goalsDbPath)),
  ]);

  const atomState = (() => {
    const stored = globalStatePayload?.["electron-persisted-atom-state"];
    if (typeof stored !== "string") return globalStatePayload || {};
    try {
      const parsed = JSON.parse(stored);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  })();
  const workspaceHints = globalStatePayload["thread-workspace-root-hints"] || atomState["thread-workspace-root-hints"] || {};
  const unreadIds = (() => {
    const ids = new Set();
    const names = [
      "unread-thread-ids-by-host-v1",
      "unread-thread-ids",
      "thread-unread-state-by-host-v1",
      "thread-unread-state",
    ];

    for (const name of names) {
      if (globalStatePayload[name]) {
        for (const id of normalizeThreadIdSet(globalStatePayload[name])) ids.add(id);
      }
      if (atomState[name]) {
        for (const id of normalizeThreadIdSet(atomState[name])) ids.add(id);
      }
    }

    return ids;
  })();

  const sessionSummaryCache = new Map();
  const spawnEdges = readSpawnEdges(paths.stateDbPath);

  const normalized = [];
  for (const thread of threads) {
    if (!thread || !thread.id || !isThreadId(thread.id)) continue;

    const processRows = processRowsByThread.get(thread.id) || [];
    const sessionFile = thread.rolloutPath || sessionFilesById.get(thread.id) || null;
    const sessionSummary = await readSessionSummary(sessionFile, sessionSummaryCache);
    const processUpdatedAt = processRows.map((row) => row.updatedAt).filter(Boolean).sort().at(-1) || null;
    const sessionActivityAt = maxIso(sessionSummary?.lastMeaningfulAt, sessionSummary?.latestEventAt, sessionSummary?.taskCompleteAt, sessionSummary?.finalAnswerAt);
    const indexActivityAt = thread.recencyAt || thread.updated_at || null;
    const activityAt = maxIso(processUpdatedAt, sessionActivityAt, indexActivityAt);
    const goal = goals.get(thread.id) || null;
    const parentFromSpawn = spawnEdges.parentByChild?.get(thread.id)?.parentThreadId || thread.parentThreadId || null;
    const localWorkspace = workspaceHints[thread.id] || thread.cwd || null;
    const riskSignal = Boolean(
      (thread.approvalMode || "").toLowerCase() === "unrestricted"
      || (thread.sandboxPolicy && String(thread.sandboxPolicy).toLowerCase().includes("danger"))
      || sessionSummary?.lastError
      || processRows.some((row) => row.alive)
    );

    const hasSessionFile = Boolean(sessionFile);
    const hasSessionSummary = Boolean(sessionSummary);
    const hasIndexRecord = Boolean(indexPath);
    const hasSqliteRecord = usingSqlite;
    const hasProcess = processRows.length > 0;
    const hasGlobalState = Boolean(globalStatePayload && Object.keys(globalStatePayload).length);

    const missingLocalState = computeMissingSignals({
      thread,
      hasSessionFile,
      hasSessionSummary,
      hasSqliteRecord,
      hasIndexRecord,
      hasProcess,
      hasGlobalState,
    });

    const raw = {
      id: thread.id,
      title: thread.thread_name || thread.title || "Untitled thread",
      workspace: localWorkspace || thread.cwd || null,
      workspaceLabel: toWorkspaceLabel(localWorkspace || thread.cwd || ""),
      threadSource: thread.threadSource || "main",
      parentThreadId: parentFromSpawn || null,
      activityAt,
      processUpdatedAt,
      completionAt: sessionSummary?.taskCompleteAt || null,
      indexUpdatedAt: thread.updated_at || null,
      hasUnread: unreadIds.has(thread.id),
      hasAttentionTag: false,
      riskSignal,
      missingLocalState,
      sessionFile,
      processRows,
      sessionSummary,
      goal,
      sessionSummaryPath: sessionFile,
      sessionUpdatedAt: sessionSummary?.fileModifiedAt || null,
      processCount: processRows.length,
      liveProcessCount: processRows.filter((row) => row.alive).length,
      sourceFlags: {
        hasSessionFile,
        hasSessionSummary,
        hasIndexRecord,
        hasSqliteRecord,
        hasProcess,
        hasGlobalState,
      },
      sourcePaths: {
        sessionIndexPath: indexPath,
        sessionsRoot: paths.sessionsRoot,
        globalStatePath: paths.globalStatePath,
        processManagerPath: paths.processManagerPath,
        stateDbPath: paths.stateDbPath,
        goalsDbPath: paths.goalsDbPath,
      },
      rawRecord: thread,
      staleSeconds: thread.updated_at ? Math.max(0, (Date.now() - new Date(thread.updated_at).getTime()) / 1000) : null,
    };

    normalized.push(raw);
  }

  return {
    generatedAt: nowIso,
    codexHome,
    warnings,
    sources: {
      source: usingSqlite ? "sqlite" : "index",
      indexPath,
      sessionsRoot: paths.sessionsRoot,
      globalStatePath: paths.globalStatePath,
      processManagerPath: paths.processManagerPath,
      stateDbPath: paths.stateDbPath,
      goalsDbPath: paths.goalsDbPath,
      codexHome,
    },
    threads: normalized,
  };
}

function enrichThreadsWithTags(rawThreads, tagsByThread = {}) {
  for (const thread of rawThreads) {
    thread.tags = cleanTags(tagsByThread[thread.id] || []);
    thread.hasAttentionTag = thread.tags.includes("needs-review");
  }
  return rawThreads;
}

function cleanTags(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .toLowerCase()
    .slice(0, 40)
  ))).slice(0, 12);
}

module.exports = {
  computeMissingSignals,
  defaultPaths,
  enrichThreadsWithTags,
  parseParentThreadId,
  readV2RawThreads,
  readThreadsFromIndex,
  readThreadsFromSqlite,
  stripWindowsNamespace,
  maxIso,
};
