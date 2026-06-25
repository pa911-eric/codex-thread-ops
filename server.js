const fs = require("fs/promises");
const path = require("path");
const http = require("http");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

const root = __dirname;
const publicDir = path.join(root, "public");
const home = process.env.USERPROFILE || process.env.HOME || "";
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");

const candidateIndexPaths = [
  path.join(codexHome, "session_index.jsonl"),
  path.join(codexHome, "sessions", "session_index.jsonl"),
];

const globalStatePath = path.join(codexHome, ".codex-global-state.json");
const processManagerPath = path.join(codexHome, "process_manager", "chat_processes.json");
const sessionsRoot = path.join(codexHome, "sessions");
const stateDbPath = path.join(codexHome, "state_5.sqlite");
const goalsDbPath = path.join(codexHome, "goals_1.sqlite");
const logsDbPath = path.join(codexHome, "logs_2.sqlite");
function minutesFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const statusWindows = {
  completeMs: minutesFromEnv("CODEX_THREAD_OPS_COMPLETE_MINUTES", 10) * 60 * 1000,
  recentMs: minutesFromEnv("CODEX_THREAD_OPS_RECENT_MINUTES", 120) * 60 * 1000,
  runningStaleMs: minutesFromEnv("CODEX_THREAD_OPS_STALE_MINUTES", 15) * 60 * 1000,
};

const sessionCache = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
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
  const { state, sessionFilesById, processRowsByThread, spawnEdges, goals, logHealth } = context;
  const atomState = state["electron-persisted-atom-state"] || {};
  const permissionsById = state["heartbeat-thread-permissions-by-id"] || atomState["heartbeat-thread-permissions-by-id"] || {};
  const unreadByHost = state["unread-thread-ids-by-host-v1"] || atomState["unread-thread-ids-by-host-v1"] || {};
  const pinnedIds = new Set(state["pinned-thread-ids"] || atomState["pinned-thread-ids"] || []);
  const projectlessIds = new Set(state["projectless-thread-ids"] || atomState["projectless-thread-ids"] || []);
  const workspaceHints = state["thread-workspace-root-hints"] || atomState["thread-workspace-root-hints"] || {};
  const outputDirs = state["thread-projectless-output-directories"] || atomState["thread-projectless-output-directories"] || {};
  const promptHistory = atomState["prompt-history"] || state["prompt-history"] || {};
  const unreadIds = new Set(Object.values(unreadByHost).flat());
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

  return {
    id: thread.id,
    name: thread.thread_name || "Untitled thread",
    preview: thread.preview || thread.lastPrompt || null,
    status,
    statusLabel: status[0].toUpperCase() + status.slice(1),
    confidence: session ? (runningStale ? "stale" : "high") : "index only",
    updatedAt: thread.updated_at || null,
    activityAt,
    activityDateKey: toLocalDateKey(activityAt),
    completedAt: session?.taskCompleteAt || session?.finalAnswerAt || null,
    runningSince: status === "running" ? (session?.lastUserAt || session?.lastMeaningfulAt || activityAt) : null,
    runningStale,
    aborted: Boolean(session?.turnAbortedAt),
    archived: Boolean(thread.archived),
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
    workspace: thread.cwd || workspaceHints[thread.id] || null,
    outputDirectory: outputDirs[thread.id] || null,
    lastPrompt: prompts.at(-1) || thread.preview || null,
    promptCount: prompts.length,
    sessionFile: thread.rolloutPath || sessionFilesById.get(thread.id) || null,
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
    codexUrl: `codex://threads/${thread.id}`,
    parseError: thread.parse_error || null,
  };
}

function computeSummary(threads, refreshedAt) {
  const counts = Object.fromEntries(["running", "complete", "recent", "today", "done"].map((key) => [key, 0]));
  for (const thread of threads) counts[thread.status] = (counts[thread.status] || 0) + 1;

  return {
    refreshedAt,
    total: threads.length,
    counts,
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

async function loadThreads() {
  const indexPath = await firstExistingPath(candidateIndexPaths);
  const sqliteThreads = readThreadsFromSqlite();
  if (!indexPath && sqliteThreads.length === 0) {
    return {
      indexPath: null,
      stateDbPath,
      codexHome,
      threads: [],
      summary: computeSummary([], new Date().toISOString()),
      error: `No session index found. Checked: ${candidateIndexPaths.join(", ")}`,
    };
  }

  const [indexText, state, sessionFilesById, processRowsByThread] = await Promise.all([
    indexPath ? fs.readFile(indexPath, "utf8") : Promise.resolve(""),
    readJsonFile(globalStatePath, {}),
    getSessionFilesById(),
    readProcessRows(),
  ]);

  const threadsSource = sqliteThreads.length ? sqliteThreads : readThreadsFromIndex(indexText);
  const unique = new Map(threadsSource.map((thread) => [thread.id, thread]));
  const spawnEdges = readSpawnEdges();
  const goals = readGoals();
  const logHealth = readLogHealth();

  const sessionSummaries = new Map();
  await Promise.all(Array.from(unique.entries()).map(async ([id, thread]) => {
    sessionSummaries.set(id, await readSessionSummary(thread.rolloutPath || sessionFilesById.get(id)));
  }));

  const context = { state, sessionFilesById, processRowsByThread, sessionSummaries, spawnEdges, goals, logHealth };
  const threads = Array.from(unique.values())
    .map((thread) => enrichThread(thread, context))
    .sort((a, b) => {
      const pinnedDelta = Number(b.pinned) - Number(a.pinned);
      if (pinnedDelta) return pinnedDelta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    });

  const refreshedAt = new Date().toISOString();
  return {
    indexPath,
    stateDbPath: sqliteThreads.length ? stateDbPath : null,
    goalsDbPath: goals.size ? goalsDbPath : null,
    logsDbPath: logHealth.size ? logsDbPath : null,
    globalStatePath,
    processManagerPath,
    sessionsRoot,
    codexHome,
    statusWindows,
    refreshedAt,
    summary: computeSummary(threads, refreshedAt),
    threads,
  };
}

async function serveStatic(res, requestPath) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
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

async function sendEvent(res) {
  const payload = await loadThreads();
  res.write(`event: snapshot\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname === "/api/threads") {
      sendJson(res, 200, await loadThreads());
      return;
    }

    if (url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, codexHome, now: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/events") {
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
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

function listen(port, attemptsLeft = 12) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    throw error;
  });

  server.listen(port, () => {
    const address = server.address();
    console.log(`Codex thread dashboard running at http://localhost:${address.port}`);
  });
}

listen(Number(process.env.PORT || 4173));
