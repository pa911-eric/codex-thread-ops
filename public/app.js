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
  hideDone: false,
  focusMode: false,
  selectedThreadId: null,
  lastSnapshotAt: null,
};

const board = document.querySelector("#board");
const spotlight = document.querySelector("#spotlight");
const columnTemplate = document.querySelector("#columnTemplate");
const cardTemplate = document.querySelector("#cardTemplate");
const search = document.querySelector("#search");
const refresh = document.querySelector("#refresh");
const focusMode = document.querySelector("#focusMode");
const hideDone = document.querySelector("#hideDone");
const statusFilters = document.querySelector("#statusFilters");
const quickFilters = document.querySelector("#quickFilters");
const sortMode = document.querySelector("#sortMode");
const detailDrawer = document.querySelector("#detailDrawer");
const closeDetail = document.querySelector("#closeDetail");
const detailKicker = document.querySelector("#detailKicker");
const detailTitle = document.querySelector("#detailTitle");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailContent = document.querySelector("#detailContent");

const quickFilterDefs = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "risk", label: "Risk" },
  { id: "logs", label: "Logs" },
  { id: "tokens", label: "Token heavy" },
  { id: "unread", label: "Unread" },
  { id: "projectless", label: "Projectless" },
  { id: "subagents", label: "Subagents" },
];

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
    if (thread.workspace) return compactPath(thread.workspace);
    return `ID: ${thread.id.slice(0, 8)}`;
  }
  const agent = thread.agentNickname || "Subagent";
  const role = thread.agentRole ? ` / ${thread.agentRole}` : "";
  return `${agent}${role} subagent`;
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
  for (const column of columns) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.status = column.id;
    button.textContent = column.title;
    button.setAttribute("aria-pressed", String(state.activeStatuses.has(column.id)));
    button.addEventListener("click", () => {
      if (state.activeStatuses.has(column.id)) state.activeStatuses.delete(column.id);
      else state.activeStatuses.add(column.id);
      if (state.activeStatuses.size === 0) state.activeStatuses = new Set(columns.map((item) => item.id));
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
    button.setAttribute("aria-pressed", String(state.quickFilter === filter.id));
    button.addEventListener("click", () => {
      state.quickFilter = filter.id;
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
  badges.append(makeBadge(columns.find((column) => column.id === displayStatus)?.title || thread.statusLabel, displayStatus));
  if (thread.unread || stats.unread) badges.append(makeBadge(stats.unread ? `${stats.unread} unread` : "unread", "danger"));
  if (thread.liveProcessCount && thread.fullAccess) badges.append(makeBadge("live full access", "danger"));
  else if (thread.liveProcessCount || stats.liveProcesses) badges.append(makeBadge("live terminal", "process"));
  if (thread.runningStale) badges.append(makeBadge("stale", "warning"));
  if (thread.threadSource === "subagent") badges.append(makeBadge(thread.agentRole ? `subagent ${thread.agentRole}` : "subagent", "strong"));
  if (stats.total) badges.append(makeBadge(`${stats.total} subagents`, "strong"));

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

  const open = card.querySelector(".open-link");
  open.href = thread.codexUrl;

  card.querySelector(".copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(thread.id);
  });

  card.querySelector(".details").addEventListener("click", (event) => {
    event.preventDefault();
    showDetails(thread.id);
  });

  card.addEventListener("click", (event) => {
    if (event.target.closest("a, button")) return;
    showDetails(thread.id);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") showDetails(thread.id);
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
}

function renderSpotlight(filtered) {
  spotlight.replaceChildren();
  const parentThreads = state.threads.filter((thread) => thread.threadSource !== "subagent");
  const running = state.threads.filter((thread) => thread.status === "running");
  const justFinished = state.threads.filter((thread) => ["complete", "recent"].includes(thread.status));
  const needsEyes = parentThreads.filter((thread) => threadNeedsReview(thread) || threadHasRisk(thread));
  const tokenHeavy = parentThreads.filter(threadIsTokenHeavy);

  const items = [
    { label: "Running now", value: running.length, detail: running[0] ? getDisplayTitle(running[0]) : "No active turns" },
    { label: "Finished in 2h", value: justFinished.length, detail: justFinished[0] ? getDisplayTitle(justFinished[0]) : "Nothing fresh yet" },
    { label: "Needs eyes", value: needsEyes.length, detail: needsEyes[0] ? getDisplayTitle(needsEyes[0]) : "Clear" },
    { label: "Token heavy", value: tokenHeavy.length, detail: tokenHeavy[0] ? getDisplayTitle(tokenHeavy[0]) : "No heavy threads" },
  ];

  for (const item of items) {
    const tile = document.createElement("article");
    tile.className = "spotlight-tile";
    tile.innerHTML = `<span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong><p>${escapeHtml(item.detail)}</p>`;
    spotlight.append(tile);
  }
}

function renderBoard(filtered) {
  board.replaceChildren();

  for (const column of columns) {
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

function render() {
  renderStatusFilters();
  renderQuickFilters();
  const filtered = getBoardThreads();
  renderMetrics();
  renderSpotlight(filtered);
  renderBoard(filtered);
  if (state.selectedThreadId) showDetails(state.selectedThreadId);
}

async function applySnapshot(data) {
  state.threads = data.threads || [];
  state.summary = data.summary || null;
  state.lastSnapshotAt = data.refreshedAt || new Date().toISOString();
  document.querySelector("#source").textContent = data.error || `${data.indexPath || "No index"} | ${data.sessionsRoot || ""}`;
  document.querySelector("#connectionState").textContent = "Live";
  render();
}

async function loadThreads() {
  refresh.disabled = true;
  try {
    const response = await fetch("/api/threads");
    applySnapshot(await response.json());
  } catch (error) {
    document.querySelector("#connectionState").textContent = "Offline";
    document.querySelector("#source").textContent = error.message;
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
  render();
});

refresh.addEventListener("click", loadThreads);
closeDetail.addEventListener("click", closeDetails);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !detailDrawer.hidden) closeDetails();
});

focusMode.addEventListener("click", () => {
  state.focusMode = !state.focusMode;
  focusMode.setAttribute("aria-pressed", String(state.focusMode));
  render();
});

hideDone.addEventListener("change", () => {
  state.hideDone = hideDone.checked;
  render();
});

sortMode.addEventListener("change", () => {
  state.sortMode = sortMode.value;
  render();
});

setInterval(() => {
  if (state.threads.length) renderMetrics();
}, 1000);

renderStatusFilters();
renderQuickFilters();
connectEvents();
