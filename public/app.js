const columns = [
  { id: "running", title: "Running", description: "Open turns still producing work" },
  { id: "complete", title: "Complete", description: "Finished in the last 10 minutes" },
  { id: "recent", title: "Recent", description: "Finished in the last 2 hours" },
  { id: "today", title: "Today", description: "Finished today, older than 2 hours" },
  { id: "done", title: "Done", description: "Finished before today" },
];

const state = {
  threads: [],
  summary: null,
  query: "",
  activeStatuses: new Set(columns.map((column) => column.id)),
  quickFilter: "all",
  sortMode: "priority",
  hideDone: true,
  focusMode: false,
  panelCollapsed: false,
  panelWidth: 348,
  usage: null,
  selectedThreadId: null,
  lastSnapshotAt: null,
};

const preferencesKey = "agentqueue-preferences-v1";
const legacyPreferencesKey = "codex-thread-ops-preferences-v1";
const panelWidthDefaults = {
  min: 280,
  max: 620,
  default: 348,
  mobileBreakpoint: 720,
};
const board = document.querySelector("#board");
const columnTemplate = document.querySelector("#columnTemplate");
const cardTemplate = document.querySelector("#cardTemplate");
const search = document.querySelector("#search");
const refresh = document.querySelector("#refresh");
const focusMode = document.querySelector("#focusMode");
const hideDone = document.querySelector("#hideDone");
const statusFilters = document.querySelector("#statusFilters");
const quickFilters = document.querySelector("#quickFilters");
const sortMode = document.querySelector("#sortMode");
const panelToggle = document.querySelector("#panelToggle");
const controlPanel = document.querySelector("#controlPanel");
const panelResizeHandle = document.querySelector("#panelResizeHandle");
const boardSummary = document.querySelector("#boardSummary");
const activeFilters = document.querySelector("#activeFilters");
const detailDrawer = document.querySelector("#detailDrawer");
const closeDetail = document.querySelector("#closeDetail");
const detailKicker = document.querySelector("#detailKicker");
const detailTitle = document.querySelector("#detailTitle");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailContent = document.querySelector("#detailContent");
const cardMenu = document.querySelector("#cardMenu");
const usagePanel = document.querySelector("#usagePanel");
const usageHeadline = document.querySelector("#usageHeadline");
const usagePlan = document.querySelector("#usagePlan");
const usageWindows = document.querySelector("#usageWindows");
let menuThreadId = null;

const quickFilterDefs = [
  { id: "all", label: "All", tip: "Show every matching parent thread" },
  { id: "review", label: "Needs review", tip: "Show threads with unread, goal, or recent child activity" },
  { id: "risk", label: "Risk", tip: "Show threads with elevated permission, stale runs, live processes, warnings, or errors" },
  { id: "logs", label: "Logs", tip: "Show threads with warnings or errors in the last 24 hours" },
  { id: "tokens", label: "Token heavy", tip: "Show threads with high token usage" },
  { id: "unread", label: "Unread", tip: "Show unread parent or child threads" },
  { id: "projectless", label: "Projectless", tip: "Show threads without a project workspace" },
  { id: "subagents", label: "Subagents", tip: "Show subagent threads and parents with subagents" },
];

function readPreferences() {
  try {
    const saved = localStorage.getItem(preferencesKey) || localStorage.getItem(legacyPreferencesKey);
    return JSON.parse(saved || "{}");
  } catch {
    return {};
  }
}

function savePreferences() {
  localStorage.setItem(preferencesKey, JSON.stringify({
    query: state.query,
    activeStatuses: Array.from(state.activeStatuses),
    quickFilter: state.quickFilter,
    sortMode: state.sortMode,
    hideDone: state.hideDone,
    focusMode: state.focusMode,
    panelCollapsed: state.panelCollapsed,
    panelWidth: state.panelWidth,
  }));
}

function restorePreferences() {
  const prefs = readPreferences();
  const validStatuses = new Set(columns.map((column) => column.id));
  const nextStatuses = Array.isArray(prefs.activeStatuses)
    ? prefs.activeStatuses.filter((id) => validStatuses.has(id))
    : [];

  if (typeof prefs.query === "string") state.query = prefs.query;
  if (nextStatuses.length) state.activeStatuses = new Set(nextStatuses);
  if (quickFilterDefs.some((filter) => filter.id === prefs.quickFilter)) state.quickFilter = prefs.quickFilter;
  if (["priority", "updated", "running", "risk"].includes(prefs.sortMode)) state.sortMode = prefs.sortMode;
  if (Object.hasOwn(prefs, "hideDone")) state.hideDone = Boolean(prefs.hideDone);
  if (Number.isFinite(Number(prefs.panelWidth))) state.panelWidth = Number(prefs.panelWidth);
  state.focusMode = Boolean(prefs.focusMode);
  state.panelCollapsed = Boolean(prefs.panelCollapsed);

  search.value = state.query;
  sortMode.value = state.sortMode;
  hideDone.checked = state.hideDone;
  focusMode.setAttribute("aria-pressed", String(state.focusMode));
  applyPanelWidth(state.panelWidth, false);
  setPanelCollapsed(state.panelCollapsed, false);
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatRelative(value) {
  if (!value) return "No activity";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid timestamp";

  const diff = Date.now() - date.getTime();
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  return `${Math.round(diff / day)}d ago`;
}

function formatClock(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatDurationMs(value) {
  if (value == null) return "--";
  const ms = Math.max(0, Number(value));
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (ms < minute) return "now";
  if (ms < hour) return `${Math.round(ms / minute)}m`;
  if (ms < day) return `${Math.round(ms / hour)}h`;
  return `${Math.round(ms / day)}d`;
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "--";
  return `${Math.round(Number(value))}%`;
}

function compactPath(value) {
  if (!value) return "";
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return value;
  return `${parts.at(-3)} / ${parts.at(-2)} / ${parts.at(-1)}`;
}

function getThreadById(id) {
  return state.threads.find((thread) => thread.id === id) || null;
}

function getParentThread(thread) {
  if (!thread.parentThreadId) return null;
  return getThreadById(thread.parentThreadId);
}

function getChildThreads(thread) {
  return state.threads.filter((candidate) => candidate.parentThreadId === thread.id);
}

function statusPriority(status) {
  const index = columns.findIndex((column) => column.id === status);
  return index === -1 ? columns.length : index;
}

function getEffectiveStatus(thread) {
  if (thread.threadSource === "subagent") return thread.status;
  return [thread, ...getChildThreads(thread)]
    .map((item) => item.status)
    .sort((a, b) => statusPriority(a) - statusPriority(b))[0] || thread.status;
}

function childStats(thread) {
  const children = getChildThreads(thread);
  return {
    total: children.length,
    running: children.filter((child) => child.status === "running").length,
    recent: children.filter((child) => ["complete", "recent"].includes(child.status)).length,
    unread: children.filter((child) => child.unread).length,
    warnings: children.reduce((sum, child) => sum + (child.logHealth?.warnings24h || 0), 0),
    errors: children.reduce((sum, child) => sum + (child.logHealth?.errors24h || 0), 0),
    liveProcesses: children.reduce((sum, child) => sum + (child.liveProcessCount || 0), 0),
    tokens: children.reduce((sum, child) => sum + (child.tokensUsed || 0), 0),
    activeGoals: children.filter((child) => child.goal?.status === "active").length,
  };
}

function getDisplayTitle(thread) {
  if (thread.threadSource !== "subagent") return thread.name;
  return getParentThread(thread)?.name || "Subagent";
}

function getDisplaySubtitle(thread) {
  if (thread.threadSource !== "subagent") {
    const children = getChildThreads(thread).length;
    if (children) return `${children} subagents`;
    if (thread.projectless) return "Projectless";
    return `ID: ${thread.id.slice(0, 8)}`;
  }
  const agent = thread.agentNickname || "Subagent";
  const role = thread.agentRole ? ` / ${thread.agentRole}` : "";
  return `${agent}${role} subagent`;
}

function getProjectLabel(thread) {
  const parent = getParentThread(thread);
  return compactPath(thread.workspace || thread.outputDirectory || parent?.workspace || parent?.outputDirectory);
}

function getPromptText(thread) {
  if (thread.threadSource !== "subagent") return thread.preview || thread.lastPrompt || thread.id;
  const agent = thread.agentNickname || "subagent";
  return `Delegated to ${agent}. Open details for the full task.`;
}

function getOriginalTask(thread) {
  return thread.preview || thread.lastPrompt || thread.name || "";
}

function threadHasRisk(thread) {
  const stats = childStats(thread);
  return Boolean(
    thread.fullAccess ||
    thread.liveProcessCount ||
    thread.runningStale ||
    thread.aborted ||
    thread.lastError ||
    thread.logHealth?.errors24h ||
    thread.logHealth?.warnings24h ||
    stats.liveProcesses ||
    stats.errors ||
    stats.warnings
  );
}

function threadNeedsReview(thread) {
  const stats = childStats(thread);
  return ["complete", "recent"].includes(getEffectiveStatus(thread)) || thread.unread || thread.goal || stats.recent || stats.unread;
}

function threadHasLogs(thread) {
  const stats = childStats(thread);
  return Boolean(thread.logHealth?.errors24h || thread.logHealth?.warnings24h || stats.errors || stats.warnings);
}

function threadIsTokenHeavy(thread) {
  const stats = childStats(thread);
  return (thread.tokensUsed || 0) + stats.tokens >= 10_000_000;
}

function threadMatches(thread, query) {
  if (!query) return true;
  const parent = getParentThread(thread);
  const haystack = [
    thread.name,
    parent?.name,
    thread.agentNickname,
    thread.agentRole,
    thread.id,
    thread.lastPrompt,
    thread.preview,
    thread.permissionMode,
    thread.approvalPolicy,
    thread.workspace,
    thread.outputDirectory,
    thread.status,
    thread.lastToolName,
  ].map(normalize).join(" ");
  return haystack.includes(query);
}

function makeBadge(label, tone = "") {
  const badge = document.createElement("span");
  badge.className = tone ? `badge ${tone}` : "badge";
  badge.textContent = label;
  return badge;
}

function makeMeta(label, value) {
  const item = document.createElement("div");
  item.className = "meta-item";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("strong");
  val.textContent = value || "-";
  item.append(key, val);
  return item;
}

function renderStatusFilters() {
  statusFilters.replaceChildren();
  const visibleStatusColumns = state.hideDone ? columns.filter((column) => column.id !== "done") : columns;
  for (const column of visibleStatusColumns) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.status = column.id;
    button.textContent = column.title;
    button.title = `Toggle ${column.title} column`;
    button.setAttribute("aria-pressed", String(state.activeStatuses.has(column.id)));
    button.addEventListener("click", () => {
      if (state.activeStatuses.has(column.id)) state.activeStatuses.delete(column.id);
      else state.activeStatuses.add(column.id);
      if (state.activeStatuses.size === 0) state.activeStatuses = new Set(columns.map((item) => item.id));
      savePreferences();
      render();
    });
    statusFilters.append(button);
  }
}

function renderQuickFilters() {
  quickFilters.replaceChildren();
  for (const filter of quickFilterDefs) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = filter.label;
    button.title = filter.tip;
    button.setAttribute("aria-pressed", String(state.quickFilter === filter.id));
    button.addEventListener("click", () => {
      state.quickFilter = filter.id;
      savePreferences();
      render();
    });
    quickFilters.append(button);
  }
}

function renderCard(thread) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  const displayStatus = thread.displayStatus || thread.status;
  const stats = childStats(thread);
  card.dataset.status = displayStatus;
  card.classList.toggle("is-unread", thread.unread || Boolean(stats.unread));
  card.classList.toggle("is-stale", thread.runningStale);
  card.classList.toggle("is-subagent", thread.threadSource === "subagent");
  card.tabIndex = 0;

  const title = card.querySelector("h3");
  const id = card.querySelector(".thread-id");
  const prompt = card.querySelector(".prompt");
  title.textContent = getDisplayTitle(thread);
  title.title = thread.threadSource === "subagent" ? `Parent: ${getDisplayTitle(thread)}\nSubagent task: ${thread.name}` : thread.name;
  id.textContent = getDisplaySubtitle(thread);
  id.title = thread.id;
  prompt.textContent = getPromptText(thread);
  prompt.title = getOriginalTask(thread);

  const meta = card.querySelector(".meta-grid");
  meta.append(makeMeta(displayStatus === "running" ? "Running" : "Activity", formatRelative(thread.activityAt)));
  if (stats.total) meta.append(makeMeta("Subagents", `${stats.total}${stats.running ? ` / ${stats.running} running` : ""}`));
  else if (thread.threadSource === "subagent" && thread.agentNickname) meta.append(makeMeta("Agent", thread.agentNickname));
  if (thread.liveProcessCount || stats.liveProcesses) meta.append(makeMeta("Terminals", thread.liveProcessCount + stats.liveProcesses));
  if (thread.logHealth?.errors24h || stats.errors) meta.append(makeMeta("Errors", thread.logHealth.errors24h + stats.errors));
  else if (thread.logHealth?.warnings24h || stats.warnings) meta.append(makeMeta("Warnings", thread.logHealth.warnings24h + stats.warnings));

  const badges = card.querySelector(".badges");
  if (thread.goal?.status === "active" || stats.activeGoals) badges.append(makeBadge(stats.activeGoals > 1 ? `${stats.activeGoals} active goals` : "goal active", "process"));
  const projectLabel = getProjectLabel(thread);
  if (projectLabel) badges.append(makeBadge(projectLabel, "project"));
  if (!badges.children.length) badges.hidden = true;

  const childSummary = card.querySelector(".child-summary");
  if (stats.total) {
    childSummary.textContent = [
      stats.running ? `${stats.running} running` : null,
      stats.recent ? `${stats.recent} recently finished` : null,
    ].filter(Boolean).join(" - ");
  } else {
    childSummary.hidden = true;
  }

  const time = card.querySelector("time");
  time.dateTime = thread.activityAt || "";
  time.textContent = formatClock(thread.activityAt);

  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    showDetails(thread.id);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") showDetails(thread.id);
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = card.getBoundingClientRect();
      showCardMenu(thread.id, rect.left + 24, rect.top + 24);
    }
  });

  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    showCardMenu(thread.id, event.clientX, event.clientY);
  });

  return card;
}

function getBoardThreads() {
  const query = normalize(state.query.trim());
  const showSubagents = state.quickFilter === "subagents" || Boolean(query);
  const base = state.threads
    .filter((thread) => showSubagents || thread.threadSource !== "subagent" || !getParentThread(thread))
    .map((thread) => ({ ...thread, displayStatus: getEffectiveStatus(thread) }));

  return sortThreads(base.filter((thread) => {
    if (state.hideDone && thread.displayStatus === "done") return false;
    if (state.focusMode && ["today", "done"].includes(thread.displayStatus) && !threadNeedsReview(thread) && !threadHasRisk(thread)) return false;
    if (!state.activeStatuses.has(thread.displayStatus)) return false;
    if (state.quickFilter === "review" && !threadNeedsReview(thread)) return false;
    if (state.quickFilter === "risk" && !threadHasRisk(thread)) return false;
    if (state.quickFilter === "logs" && !threadHasLogs(thread)) return false;
    if (state.quickFilter === "tokens" && !threadIsTokenHeavy(thread)) return false;
    if (state.quickFilter === "unread" && !thread.unread && !childStats(thread).unread) return false;
    if (state.quickFilter === "projectless" && !thread.projectless) return false;
    if (state.quickFilter === "subagents" && thread.threadSource !== "subagent" && !childStats(thread).total) return false;
    return threadMatches(thread, query);
  }));
}

function statusRank(status) {
  return columns.findIndex((column) => column.id === status);
}

function sortThreads(threads) {
  return [...threads].sort((a, b) => {
    if (state.sortMode === "updated") return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    if (state.sortMode === "running") {
      const aStart = new Date(a.runningSince || a.activityAt || 0).getTime();
      const bStart = new Date(b.runningSince || b.activityAt || 0).getTime();
      return aStart - bStart;
    }
    if (state.sortMode === "risk") {
      const risk = (thread) => Number(threadHasRisk(thread)) * 5 + Number(thread.liveProcessCount && thread.fullAccess) * 8 + (thread.logHealth?.errors24h || 0) * 3 + (thread.logHealth?.warnings24h || 0);
      const delta = risk(b) - risk(a);
      if (delta) return delta;
      return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
    }

    const delta = statusRank(a.displayStatus || a.status) - statusRank(b.displayStatus || b.status);
    if (delta) return delta;
    return new Date(b.activityAt || 0) - new Date(a.activityAt || 0);
  });
}

function renderMetrics() {
  const summary = state.summary || { counts: {}, total: 0, unread: 0 };
  document.querySelector("#runningThreads").textContent = summary.counts?.running || 0;
  document.querySelector("#completeThreads").textContent = summary.counts?.complete || 0;
  document.querySelector("#recentThreads").textContent = summary.counts?.recent || 0;
  document.querySelector("#todayThreads").textContent = summary.counts?.today || 0;
  document.querySelector("#doneThreads").textContent = summary.counts?.done || 0;
  document.querySelector("#unreadThreads").textContent = summary.unread || 0;
  document.querySelector("#riskThreads").textContent = (summary.liveFullAccess || 0) + (summary.staleRunning || 0) + (summary.logErrors24h || 0);
  document.querySelector("#updatedAt").textContent = state.lastSnapshotAt ? `Updated ${formatClock(state.lastSnapshotAt)}` : "--";
  boardSummary.textContent = `${summary.counts?.running || 0} running / ${summary.unread || 0} unread / ${(summary.liveFullAccess || 0) + (summary.staleRunning || 0) + (summary.logErrors24h || 0)} risk`;
  activeFilters.textContent = describeFilters();
}

function usageEstimateText(window) {
  if (!window) return "No estimate";
  if (window.exhaustionConfidence === "after reset") return "Not before reset";
  if (window.exhaustionConfidence === "flat") return "Flat use";
  if (window.exhaustionConfidence === "insufficient") return "Need more samples";
  if (window.exhaustionInMs == null) return "No estimate";
  return `${formatDurationMs(window.exhaustionInMs)} to empty`;
}

function renderUsageChart(points) {
  const width = 210;
  const height = 48;
  const usableWidth = width - 8;
  const usableHeight = height - 8;
  const chartPoints = (points || []).slice(-36);

  if (chartPoints.length < 2) {
    return `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><line x1="4" y1="${height - 6}" x2="${width - 4}" y2="${height - 6}" /></svg>`;
  }

  const times = chartPoints.map((point) => new Date(point.at).getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(1, maxTime - minTime);
  const path = chartPoints.map((point) => {
    const x = 4 + ((new Date(point.at).getTime() - minTime) / span) * usableWidth;
    const y = 4 + ((100 - point.remainingPercent) / 100) * usableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  return `
    <svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <line x1="4" y1="4" x2="${width - 4}" y2="4" />
      <line x1="4" y1="${height - 6}" x2="${width - 4}" y2="${height - 6}" />
      <polyline points="${path}" />
    </svg>
  `;
}

function renderUsageWindow(window) {
  if (!window) return "";
  const resetText = window.resetInMs == null ? "--" : formatDurationMs(window.resetInMs);
  const slope = window.slopePercentPerHour ? `${window.slopePercentPerHour.toFixed(1)}%/h` : "--";

  return `
    <article class="usage-window">
      <header>
        <span>${escapeHtml(window.label)}</span>
        <strong>${escapeHtml(formatPercent(window.remainingPercent))} left</strong>
      </header>
      <div class="usage-bar" aria-hidden="true"><span style="width: ${Math.max(0, Math.min(100, window.usedPercent))}%"></span></div>
      ${renderUsageChart(window.points)}
      <dl>
        <div><dt>Used</dt><dd>${escapeHtml(formatPercent(window.usedPercent))}</dd></div>
        <div><dt>Reset</dt><dd>${escapeHtml(resetText)}</dd></div>
        <div><dt>Burn</dt><dd>${escapeHtml(slope)}</dd></div>
        <div><dt>Estimate</dt><dd>${escapeHtml(usageEstimateText(window))}</dd></div>
      </dl>
    </article>
  `;
}

function renderUsage() {
  const usage = state.usage;
  if (!usage?.available) {
    usagePanel.hidden = true;
    return;
  }

  const primary = usage.primary;
  usagePanel.hidden = false;
  usageHeadline.textContent = primary ? `${formatPercent(primary.remainingPercent)} primary remaining` : "Usage data available";
  usagePlan.textContent = usage.planType || usage.limitId || "";
  usageWindows.innerHTML = [renderUsageWindow(usage.primary), renderUsageWindow(usage.secondary)].filter(Boolean).join("");
}

function describeFilters() {
  const filters = [];
  if (state.quickFilter !== "all") filters.push(quickFilterDefs.find((filter) => filter.id === state.quickFilter)?.label || state.quickFilter);
  if (state.query.trim()) filters.push(`Search: ${state.query.trim()}`);
  if (state.focusMode) filters.push("Focus");
  if (state.hideDone) filters.push("Hide done");
  if (state.activeStatuses.size !== columns.length) {
    filters.push(Array.from(state.activeStatuses)
      .map((id) => columns.find((column) => column.id === id)?.title || id)
      .join(", "));
  }
  return filters.length ? filters.join(" / ") : "All threads";
}

function renderBoard(filtered) {
  board.replaceChildren();

  const visibleColumns = state.hideDone ? columns.filter((column) => column.id !== "done") : columns;
  board.dataset.columnCount = String(visibleColumns.length);

  for (const column of visibleColumns) {
    const el = columnTemplate.content.firstElementChild.cloneNode(true);
    const threads = filtered.filter((thread) => thread.displayStatus === column.id);
    el.dataset.status = column.id;
    el.querySelector("h2").textContent = column.title;
    el.querySelector("p").textContent = column.description;
    el.querySelector(".count").textContent = `(${threads.length})`;

    const cards = el.querySelector(".cards");
    if (threads.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "No threads";
      cards.append(empty);
    } else {
      cards.append(...threads.map(renderCard));
    }

    board.append(el);
  }
}

function detailRow(label, value) {
  if (!value && value !== 0) return "";
  return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderChildList(thread) {
  const children = getChildThreads(thread);
  if (!children.length) return "";
  const rows = children
    .sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || new Date(b.activityAt || 0) - new Date(a.activityAt || 0))
    .map((child) => `
      <button class="child-row" type="button" data-thread-id="${escapeHtml(child.id)}">
        <span>${escapeHtml(child.agentNickname || child.agentRole || "Subagent")}</span>
        <strong>${escapeHtml(child.statusLabel)} - ${escapeHtml(formatRelative(child.activityAt))}</strong>
        <small>${escapeHtml(getOriginalTask(child).slice(0, 130))}</small>
      </button>
    `).join("");
  return `<section class="detail-section"><h3>Subagents</h3><div class="child-list">${rows}</div></section>`;
}

function renderDetailBadges(thread) {
  const stats = childStats(thread);
  const badges = [];
  badges.push(makeBadge(thread.statusLabel, thread.status).outerHTML);
  if (thread.threadSource === "subagent") badges.push(makeBadge(thread.agentRole ? `subagent ${thread.agentRole}` : "subagent", "strong").outerHTML);
  if (stats.total) badges.push(makeBadge(`${stats.total} subagents`, "strong").outerHTML);
  if (thread.fullAccess) badges.push(makeBadge("full access", "danger").outerHTML);
  if (thread.liveProcessCount || stats.liveProcesses) badges.push(makeBadge(`${thread.liveProcessCount + stats.liveProcesses} live terminal`, "process").outerHTML);
  if (thread.logHealth?.errors24h || stats.errors) badges.push(makeBadge(`${thread.logHealth.errors24h + stats.errors} errors`, "danger").outerHTML);
  if (thread.logHealth?.warnings24h || stats.warnings) badges.push(makeBadge(`${thread.logHealth.warnings24h + stats.warnings} warnings`, "warning").outerHTML);
  if (thread.goal?.status) badges.push(makeBadge(`goal ${thread.goal.status}`, "process").outerHTML);
  return `<div class="badges detail-badges">${badges.join("")}</div>`;
}

function showDetails(threadId) {
  const thread = getThreadById(threadId);
  if (!thread) return;
  const parent = getParentThread(thread);
  const stats = childStats(thread);
  state.selectedThreadId = threadId;

  detailKicker.textContent = thread.threadSource === "subagent" ? "Subagent" : "Thread";
  detailTitle.textContent = getDisplayTitle(thread);
  detailSubtitle.textContent = thread.threadSource === "subagent"
    ? `${thread.agentNickname || "Subagent"}${thread.agentRole ? ` / ${thread.agentRole}` : ""}`
    : thread.id;

  detailContent.innerHTML = `
    ${renderDetailBadges(thread)}
    <section class="detail-section">
      <h3>Overview</h3>
      <p>${escapeHtml(getOriginalTask(thread))}</p>
    </section>
    <section class="detail-grid">
      ${detailRow("Activity", formatRelative(thread.activityAt))}
      ${detailRow("Updated", formatClock(thread.activityAt))}
      ${detailRow("Permission", thread.permissionMode)}
      ${detailRow("Approval", thread.approvalPolicy)}
      ${detailRow("Tokens", Intl.NumberFormat().format((thread.tokensUsed || 0) + stats.tokens))}
      ${detailRow("Prompts", thread.promptCount)}
      ${detailRow("Workspace", compactPath(thread.workspace))}
      ${detailRow("Git branch", thread.gitBranch)}
      ${detailRow("Last tool", thread.lastToolName)}
      ${detailRow("Logs 24h", `${thread.logHealth?.errors24h || 0} errors / ${thread.logHealth?.warnings24h || 0} warnings`)}
      ${parent ? detailRow("Parent", parent.name) : ""}
    </section>
    ${thread.liveProcesses?.length ? `<section class="detail-section"><h3>Live Commands</h3>${thread.liveProcesses.map((item) => `<pre>${escapeHtml(item.command)}</pre>`).join("")}</section>` : ""}
    ${renderChildList(thread)}
    <section class="detail-actions">
      <a class="open-link" href="${escapeHtml(thread.codexUrl)}">Open in Codex</a>
      <button id="copyDetailId" type="button">Copy Thread ID</button>
    </section>
  `;

  detailContent.querySelectorAll(".child-row").forEach((row) => {
    row.addEventListener("click", () => showDetails(row.dataset.threadId));
  });
  detailContent.querySelector("#copyDetailId")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(thread.id);
  });

  detailDrawer.hidden = false;
  document.body.classList.add("detail-open");
}

function closeDetails() {
  detailDrawer.hidden = true;
  state.selectedThreadId = null;
  document.body.classList.remove("detail-open");
}

function getReadActionIds(thread, includeChildren = false) {
  const ids = [thread.id];
  if (includeChildren) ids.push(...getChildThreads(thread).map((child) => child.id));
  return Array.from(new Set(ids));
}

async function markRead(thread, includeChildren = false) {
  const threadIds = getReadActionIds(thread, includeChildren);
  const response = await fetch("/api/threads/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadIds }),
  });

  if (!response.ok) throw new Error(`Mark read failed: ${response.status}`);

  const ids = new Set(threadIds);
  state.threads = state.threads.map((item) => ids.has(item.id) ? { ...item, unread: false } : item);
  render();
  await loadThreads();
}

function setMenuItemHidden(action, hidden) {
  const item = cardMenu.querySelector(`[data-action="${action}"]`);
  if (item) item.hidden = hidden;
}

function showCardMenu(threadId, x, y) {
  const thread = getThreadById(threadId);
  if (!thread) return;

  const stats = childStats(thread);
  menuThreadId = threadId;

  setMenuItemHidden("mark-read", !thread.unread);
  setMenuItemHidden("mark-family-read", !(stats.total && (thread.unread || stats.unread)));

  cardMenu.hidden = false;
  cardMenu.style.left = "0px";
  cardMenu.style.top = "0px";

  const rect = cardMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  cardMenu.style.left = `${Math.max(8, left)}px`;
  cardMenu.style.top = `${Math.max(8, top)}px`;
  cardMenu.querySelector("button:not([hidden])")?.focus();
}

function closeCardMenu() {
  cardMenu.hidden = true;
  menuThreadId = null;
}

async function handleMenuAction(action) {
  const thread = getThreadById(menuThreadId);
  if (!thread) return;

  closeCardMenu();

  if (action === "details") showDetails(thread.id);
  if (action === "open") window.location.href = thread.codexUrl;
  if (action === "copy-id") await navigator.clipboard.writeText(thread.id);
  if (action === "copy-link") await navigator.clipboard.writeText(thread.codexUrl);
  if (action === "copy-title") await navigator.clipboard.writeText(getDisplayTitle(thread));
  if (action === "mark-read") await markRead(thread, false);
  if (action === "mark-family-read") await markRead(thread, true);
}

function getPanelMaxWidth() {
  const viewportMax = Math.floor(window.innerWidth * 0.52);
  return Math.max(panelWidthDefaults.min, Math.min(panelWidthDefaults.max, viewportMax));
}

function clampPanelWidth(value) {
  const width = Number(value);
  const fallback = Number.isFinite(width) ? width : panelWidthDefaults.default;
  return Math.round(Math.max(panelWidthDefaults.min, Math.min(getPanelMaxWidth(), fallback)));
}

function updatePanelResizeHandle(width) {
  const max = getPanelMaxWidth();
  panelResizeHandle.setAttribute("aria-valuemin", String(panelWidthDefaults.min));
  panelResizeHandle.setAttribute("aria-valuemax", String(max));
  panelResizeHandle.setAttribute("aria-valuenow", String(width));
  panelResizeHandle.setAttribute("aria-valuetext", `${width}px`);
}

function applyPanelWidth(width, persist = true) {
  const nextWidth = clampPanelWidth(width);
  state.panelWidth = nextWidth;
  document.documentElement.style.setProperty("--panel-width", `${nextWidth}px`);
  updatePanelResizeHandle(nextWidth);
  if (persist) savePreferences();
}

function initPanelResize() {
  let pointerId = null;
  let startX = 0;
  let startWidth = panelWidthDefaults.default;

  panelResizeHandle.addEventListener("pointerdown", (event) => {
    if (state.panelCollapsed || window.innerWidth <= panelWidthDefaults.mobileBreakpoint) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startWidth = state.panelWidth;
    panelResizeHandle.setPointerCapture(pointerId);
    document.body.classList.add("is-resizing");
    event.preventDefault();
  });

  panelResizeHandle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    applyPanelWidth(startWidth + event.clientX - startX, false);
  });

  function finishResize(event) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    document.body.classList.remove("is-resizing");
    savePreferences();
  }

  panelResizeHandle.addEventListener("pointerup", finishResize);
  panelResizeHandle.addEventListener("pointercancel", finishResize);

  panelResizeHandle.addEventListener("dblclick", () => {
    applyPanelWidth(panelWidthDefaults.default);
  });

  panelResizeHandle.addEventListener("keydown", (event) => {
    const steps = {
      ArrowLeft: -16,
      ArrowRight: 16,
      PageUp: 48,
      PageDown: -48,
    };

    if (event.key === "Home") {
      event.preventDefault();
      applyPanelWidth(panelWidthDefaults.min);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      applyPanelWidth(getPanelMaxWidth());
      return;
    }

    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    applyPanelWidth(state.panelWidth + steps[event.key]);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > panelWidthDefaults.mobileBreakpoint) applyPanelWidth(state.panelWidth, false);
    else updatePanelResizeHandle(state.panelWidth);
  });
}

function setPanelCollapsed(collapsed, persist = true) {
  state.panelCollapsed = collapsed;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  controlPanel.setAttribute("aria-label", collapsed ? "Dashboard controls collapsed" : "Dashboard controls");
  panelToggle.setAttribute("aria-expanded", String(!collapsed));
  panelToggle.setAttribute("aria-label", collapsed ? "Expand controls" : "Collapse controls");
  panelToggle.title = collapsed ? "Expand controls" : "Collapse controls";
  if (persist) savePreferences();
}

function render() {
  renderStatusFilters();
  renderQuickFilters();
  const filtered = getBoardThreads();
  renderMetrics();
  renderUsage();
  renderBoard(filtered);
  if (state.selectedThreadId) showDetails(state.selectedThreadId);
}

async function applySnapshot(data) {
  state.threads = data.threads || [];
  state.summary = data.summary || null;
  state.usage = data.usage || null;
  state.lastSnapshotAt = data.refreshedAt || new Date().toISOString();
  document.querySelector("#connectionState").textContent = data.error ? "Issue" : "Live";
  render();
}

async function loadThreads() {
  refresh.disabled = true;
  try {
    const response = await fetch("/api/threads");
    applySnapshot(await response.json());
  } catch (error) {
    document.querySelector("#connectionState").textContent = "Offline";
    boardSummary.textContent = error.message;
  } finally {
    refresh.disabled = false;
  }
}

function connectEvents() {
  if (!("EventSource" in window)) {
    setInterval(loadThreads, 5000);
    loadThreads();
    return;
  }

  const source = new EventSource("/api/events");
  source.addEventListener("snapshot", (event) => {
    applySnapshot(JSON.parse(event.data));
  });
  source.addEventListener("error", () => {
    document.querySelector("#connectionState").textContent = "Reconnecting";
  });
}

search.addEventListener("input", () => {
  state.query = search.value;
  savePreferences();
  render();
});

refresh.addEventListener("click", loadThreads);
panelToggle.addEventListener("click", () => setPanelCollapsed(!state.panelCollapsed));
closeDetail.addEventListener("click", closeDetails);
cardMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  handleMenuAction(button.dataset.action).catch((error) => {
    boardSummary.textContent = error.message;
  });
});
document.addEventListener("click", (event) => {
  if (!cardMenu.hidden && !event.target.closest("#cardMenu")) closeCardMenu();
});
document.addEventListener("scroll", closeCardMenu, true);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!cardMenu.hidden) closeCardMenu();
  if (!detailDrawer.hidden) closeDetails();
});

focusMode.addEventListener("click", () => {
  state.focusMode = !state.focusMode;
  focusMode.setAttribute("aria-pressed", String(state.focusMode));
  savePreferences();
  render();
});

hideDone.addEventListener("change", () => {
  state.hideDone = hideDone.checked;
  savePreferences();
  render();
});

sortMode.addEventListener("change", () => {
  state.sortMode = sortMode.value;
  savePreferences();
  render();
});

setInterval(() => {
  if (state.threads.length) renderMetrics();
}, 1000);

initPanelResize();
restorePreferences();
renderStatusFilters();
renderQuickFilters();
connectEvents();
