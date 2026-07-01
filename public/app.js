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
  activeTag: "",
  sortMode: "priority",
  mobileColumn: "running",
  hideDone: true,
  focusMode: false,
  panelCollapsed: false,
  panelWidth: 312,
  timelinePanelCollapsed: true,
  timelinePanelWidth: 360,
  usage: null,
  update: null,
  webhook: null,
  selectedThreadId: null,
  lastSnapshotAt: null,
  projectColors: {},
};

const preferencesKey = "agentqueue-preferences-v1";
const legacyPreferencesKey = "codex-thread-ops-preferences-v1";
const dismissedUpdateKey = "agentqueue-dismissed-update";
const panelWidthDefaults = {
  min: 260,
  max: 460,
  default: 312,
  mobileBreakpoint: 720,
};
const timelinePanelWidthDefaults = {
  min: 280,
  max: 620,
  default: 360,
  mobileBreakpoint: 720,
};
const board = document.querySelector("#board");
const timeline = document.querySelector("#timeline");
const columnTemplate = document.querySelector("#columnTemplate");
const cardTemplate = document.querySelector("#cardTemplate");
const search = document.querySelector("#search");
const refresh = document.querySelector("#refresh");
const focusMode = document.querySelector("#focusMode");
const hideDone = document.querySelector("#hideDone");
const statusFilters = document.querySelector("#statusFilters");
const quickFilters = document.querySelector("#quickFilters");
const tagFilterSection = document.querySelector("#tagFilterSection");
const tagFilters = document.querySelector("#tagFilters");
const sortMode = document.querySelector("#sortMode");
const columnSwitcher = document.querySelector("#columnSwitcher");
const panelToggle = document.querySelector("#panelToggle");
const controlPanel = document.querySelector("#controlPanel");
const panelResizeHandle = document.querySelector("#panelResizeHandle");
const timelinePanel = document.querySelector("#timelinePanel");
const timelinePanelToggle = document.querySelector("#timelinePanelToggle");
const timelinePanelResizeHandle = document.querySelector("#timelinePanelResizeHandle");
const detailDrawer = document.querySelector("#detailDrawer");
const closeDetail = document.querySelector("#closeDetail");
const detailKicker = document.querySelector("#detailKicker");
const detailTitle = document.querySelector("#detailTitle");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailContent = document.querySelector("#detailContent");
const cardMenu = document.querySelector("#cardMenu");
const tagSubmenu = document.querySelector("#tagSubmenu");
const usageDetail = document.querySelector("#usageDetail");
const updateNotice = document.querySelector("#updateNotice");
const updateTitle = document.querySelector("#updateTitle");
const updateDetail = document.querySelector("#updateDetail");
const updateReleaseLink = document.querySelector("#updateReleaseLink");
const copyUpdateCommand = document.querySelector("#copyUpdateCommand");
const dismissUpdate = document.querySelector("#dismissUpdate");
const openWebhookSettings = document.querySelector("#openWebhookSettings");
const closeWebhookSettings = document.querySelector("#closeWebhookSettings");
const webhookModal = document.querySelector("#webhookModal");
const webhookForm = document.querySelector("#webhookForm");
const webhookState = document.querySelector("#webhookState");
const webhookModalState = document.querySelector("#webhookModalState");
const webhookEnabled = document.querySelector("#webhookEnabled");
const webhookEndpoint = document.querySelector("#webhookEndpoint");
const webhookIncludeSubagents = document.querySelector("#webhookIncludeSubagents");
const webhookSigningToken = document.querySelector("#webhookSigningToken");
const webhookFeedback = document.querySelector("#webhookFeedback");
const testWebhook = document.querySelector("#testWebhook");
const newTagModal = document.querySelector("#newTagModal");
const newTagForm = document.querySelector("#newTagForm");
const newTagInput = document.querySelector("#newTagInput");
const newTagFeedback = document.querySelector("#newTagFeedback");
const closeNewTagModalButton = document.querySelector("#closeNewTagModal");
const cancelNewTag = document.querySelector("#cancelNewTag");
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

const webhookStatusIds = ["running", "complete", "recent", "today", "done"];

const sortModeDefs = {
  priority: {
    label: "Tiered priority",
    tiers: ["Status lane", "Running user reply", "Needs review", "Risk", "Activity"],
  },
  updated: {
    label: "Activity first",
    tiers: ["Activity", "Status lane", "Running user reply", "Risk"],
  },
  running: {
    label: "Longest running",
    tiers: ["Running user reply", "Activity", "Risk", "Title"],
  },
  risk: {
    label: "Risk first",
    tiers: ["Risk", "Running user reply", "Activity", "Status lane"],
  },
};

const projectColorPalette = [
  { id: "indigo", label: "Indigo", background: "#e0e7ff", border: "#818cf8", text: "#312e81" },
  { id: "violet", label: "Violet", background: "#f3e8ff", border: "#c4b5fd", text: "#5b21b6" },
  { id: "purple", label: "Purple", background: "#f5f3ff", border: "#a78bfa", text: "#4c1d95" },
  { id: "pink", label: "Pink", background: "#fce7f3", border: "#f9a8d4", text: "#7c2d6f" },
  { id: "teal", label: "Teal", background: "#ccfbf1", border: "#2dd4bf", text: "#0f766e" },
  { id: "slate", label: "Slate", background: "#e2e8f0", border: "#94a3b8", text: "#334155" },
  { id: "stone", label: "Stone", background: "#f5f3ef", border: "#bdad95", text: "#5a4d38" },
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
    activeTag: state.activeTag,
    sortMode: state.sortMode,
    mobileColumn: state.mobileColumn,
    hideDone: state.hideDone,
    focusMode: state.focusMode,
    panelCollapsed: state.panelCollapsed,
    sidebarDesignVersion: 3,
    panelWidth: state.panelWidth,
    timelinePanelCollapsed: state.timelinePanelCollapsed,
    timelinePanelWidth: state.timelinePanelWidth,
    projectColors: state.projectColors,
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
  if (typeof prefs.activeTag === "string") state.activeTag = prefs.activeTag;
  if (Object.hasOwn(sortModeDefs, prefs.sortMode)) state.sortMode = prefs.sortMode;
  if (columns.some((column) => column.id === prefs.mobileColumn)) state.mobileColumn = prefs.mobileColumn;
  if (Object.hasOwn(prefs, "hideDone")) state.hideDone = Boolean(prefs.hideDone);
  if (Number.isFinite(Number(prefs.panelWidth))) {
    const savedPanelWidth = Number(prefs.panelWidth);
    state.panelWidth = prefs.sidebarDesignVersion >= 2
      ? savedPanelWidth
      : Math.min(savedPanelWidth, panelWidthDefaults.default);
  }
  if (Number.isFinite(Number(prefs.timelinePanelWidth))) state.timelinePanelWidth = Number(prefs.timelinePanelWidth);
  state.focusMode = Boolean(prefs.focusMode);
  state.panelCollapsed = Boolean(prefs.panelCollapsed);
  if (Object.hasOwn(prefs, "timelinePanelCollapsed")) state.timelinePanelCollapsed = Boolean(prefs.timelinePanelCollapsed);
  if (typeof prefs.projectColors === "object" && prefs.projectColors !== null) {
    const nextProjectColors = {};
    for (const [projectKey, colorId] of Object.entries(prefs.projectColors)) {
      if (typeof projectKey !== "string" || !projectKey) continue;
      const normalizedColorId = normalizeProjectColorId(colorId);
      if (normalizedColorId) nextProjectColors[projectKey] = normalizedColorId;
    }
    state.projectColors = nextProjectColors;
  }

  search.value = state.query;
  sortMode.value = state.sortMode;
  hideDone.checked = state.hideDone;
  focusMode.setAttribute("aria-pressed", String(state.focusMode));
  applyPanelWidth(state.panelWidth, false);
  setPanelCollapsed(state.panelCollapsed, false);
  applyTimelinePanelWidth(state.timelinePanelWidth, false);
  setTimelinePanelCollapsed(state.timelinePanelCollapsed, false);
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function normalizeTag(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_.:@&/-]/g, "")
    .toLowerCase()
    .slice(0, 40);
}

function normalizeProjectColorId(value) {
  return projectColorPalette.some((color) => color.id === value) ? value : "";
}

function projectColorById(colorId) {
  return projectColorPalette.find((color) => color.id === colorId) || null;
}

function projectColorIds() {
  return projectColorPalette.map((color) => color.id);
}

function getProjectGroupKey(thread) {
  const path = getProjectPath(thread);
  return path || "Projectless";
}

function syncProjectColors(threadList = []) {
  const activeKeys = new Set(threadList.map((thread) => getProjectGroupKey(thread)));
  const nextColors = {};
  for (const [projectKey, colorId] of Object.entries(state.projectColors)) {
    if (!activeKeys.has(projectKey)) continue;
    const normalizedColorId = normalizeProjectColorId(colorId);
    if (normalizedColorId) nextColors[projectKey] = normalizedColorId;
  }
  if (Object.keys(nextColors).length === Object.keys(state.projectColors).length && Object.keys(nextColors).every((projectKey) => nextColors[projectKey] === state.projectColors[projectKey])) {
    return false;
  }
  state.projectColors = nextColors;
  return true;
}

function ensureProjectColorAssignments(groups) {
  let dirty = false;
  const availableColors = projectColorIds();
  const usedColors = new Set();

  for (const [projectKey, colorId] of Object.entries(state.projectColors)) {
    usedColors.add(normalizeProjectColorId(colorId));
  }

  for (const group of groups) {
    if (!group.projectKey) continue;
    const assigned = normalizeProjectColorId(state.projectColors[group.projectKey]);
    if (assigned) {
      state.projectColors[group.projectKey] = assigned;
      usedColors.add(assigned);
    } else {
      const candidates = availableColors.filter((colorId) => !usedColors.has(colorId));
      const chosen = candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : availableColors[Math.floor(Math.random() * availableColors.length)];
      state.projectColors[group.projectKey] = chosen;
      usedColors.add(chosen);
      dirty = true;
    }
    group.colorId = state.projectColors[group.projectKey];
  }

  return dirty;
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

function formatTimelineDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatIsoTimestamp(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
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

function getThreadTags(thread, includeChildren = false) {
  const tags = new Set(Array.isArray(thread.tags) ? thread.tags : []);
  if (includeChildren) {
    for (const child of getChildThreads(thread)) {
      for (const tag of child.tags || []) tags.add(tag);
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b));
}

function getDisplayTitle(thread) {
  if (thread.threadSource !== "subagent") return thread.title || thread.name;
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
  return getProjectName(thread);
}

function getProjectPath(thread) {
  const parent = getParentThread(thread);
  return thread.workspace || parent?.workspace || "";
}

function getProjectName(thread) {
  const pathValue = getProjectPath(thread);
  const parts = String(pathValue).split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "";
}

function setProjectColor(projectKey, colorId) {
  const normalizedColorId = normalizeProjectColorId(colorId);
  const nextColors = { ...state.projectColors };

  if (!projectKey) return;
  if (!normalizedColorId) delete nextColors[projectKey];
  else nextColors[projectKey] = normalizedColorId;

  state.projectColors = nextColors;
  savePreferences();
}

function getPromptText(thread) {
  if (thread.threadSource !== "subagent") return thread.lastPrompt || thread.preview || thread.id;
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
  const tags = getThreadTags(thread, true);
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
    thread.provider,
    thread.providerLabel,
    thread.lastToolName,
    tags.join(" "),
  ].map(normalize).join(" ");
  return haystack.includes(query);
}

function threadMatchesActiveTag(thread) {
  if (!state.activeTag) return true;
  return getThreadTags(thread, true).includes(state.activeTag);
}

function makeBadge(label, tone = "") {
  const badge = document.createElement("span");
  badge.className = tone ? `badge ${tone}` : "badge";
  badge.textContent = label;
  return badge;
}

function makeProviderBadge(thread) {
  const label = thread.providerLabel || thread.provider || "Provider";
  const badge = document.createElement("span");
  badge.className = `badge provider-icon provider-${thread.provider || "codex"}`;
  badge.title = label;
  badge.setAttribute("aria-label", label);

  const icon = document.createElement("img");
  icon.src = thread.provider === "claude"
    ? "/provider-claude.png"
    : thread.provider === "copilot"
      ? "/provider-copilot.png"
      : "/provider-codex.png";
  icon.alt = "";
  icon.loading = "lazy";
  badge.append(icon);
  return badge;
}

function makeIcon(name) {
  const paths = {
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M9 13v2"/><path d="M15 13v2"/>',
    branch: '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  };
  const icon = document.createElement("span");
  icon.className = `card-icon icon-${name}`;
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 24 24" focusable="false">${paths[name] || ""}</svg>`;
  return icon;
}

function formatCompactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1).replace(/\.0$/, "")}K`;
  return Intl.NumberFormat().format(number);
}

function makeCardMeta(iconName, value, options = {}) {
  const item = document.createElement("div");
  item.className = options.tone ? `card-meta ${options.tone}` : "card-meta";
  if (options.providerBadge) item.append(makeProviderBadge(options.providerBadge));
  else item.append(makeIcon(iconName));
  const text = document.createElement("span");
  text.textContent = value || "-";
  if (options.tooltip !== null && options.tooltip !== undefined && text.textContent !== "-") {
    text.title = options.tooltip;
    text.setAttribute("aria-label", options.tooltip);
  }
  item.append(text);
  return item;
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
    const option = document.createElement("option");
    option.value = filter.id;
    option.textContent = filter.label;
    option.title = filter.tip;
    option.selected = state.quickFilter === filter.id;
    quickFilters.append(option);
  }
  quickFilters.value = state.quickFilter;
}

function getTagCounts() {
  const counts = state.summary?.tagCounts || {};
  return Object.entries(counts)
    .filter(([tag, count]) => tag && count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderTagFilters() {
  const tagCounts = getTagCounts();
  tagFilterSection.hidden = tagCounts.length === 0;
  tagFilters.replaceChildren();
  if (!tagCounts.length) {
    state.activeTag = "";
    return;
  }

  if (state.activeTag && !tagCounts.some(([tag]) => tag === state.activeTag)) {
    state.activeTag = "";
    savePreferences();
  }

  const all = document.createElement("button");
  all.type = "button";
  all.textContent = "All";
  all.title = "Clear tag filter";
  all.setAttribute("aria-pressed", String(!state.activeTag));
  all.addEventListener("click", () => {
    state.activeTag = "";
    savePreferences();
    render();
  });
  tagFilters.append(all);

  for (const [tag, count] of tagCounts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${tag} ${count}`;
    button.title = `Show threads tagged ${tag}`;
    button.setAttribute("aria-pressed", String(state.activeTag === tag));
    button.addEventListener("click", () => {
      state.activeTag = state.activeTag === tag ? "" : tag;
      savePreferences();
      render();
    });
    tagFilters.append(button);
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
  const statusText = card.querySelector(".card-status-text");
  const prompt = card.querySelector(".prompt");
  const unreadIndicator = card.querySelector(".unread-indicator");
  const runningSpinner = card.querySelector(".running-spinner");
  const metadata = card.querySelector(".card-metadata");
  const lastTool = card.querySelector(".last-tool");
  const tokensUsed = card.querySelector(".tokens-used");
  const cardTitle = getDisplayTitle(thread);
  title.textContent = cardTitle;
  title.title = thread.threadSource === "subagent" ? `Parent: ${cardTitle}\nSubagent task: ${thread.name}` : cardTitle;
  statusText.textContent = displayStatus;
  prompt.textContent = getPromptText(thread);
  prompt.title = getOriginalTask(thread);
  runningSpinner.hidden = displayStatus !== "running";
  if (thread.unread || stats.unread) {
    unreadIndicator.hidden = false;
    unreadIndicator.textContent = thread.unread ? "Unread" : `${stats.unread} unread`;
    unreadIndicator.title = thread.unread ? "Unread thread" : `${stats.unread} unread subagent${stats.unread === 1 ? "" : "s"}`;
  }

  const modelLabel = thread.model || thread.providerLabel || thread.provider || "unknown";
  metadata.append(
    makeCardMeta("bot", modelLabel, { providerBadge: thread, tooltip: modelLabel }),
    makeCardMeta("branch", thread.gitBranch || getDisplaySubtitle(thread), { tooltip: thread.gitBranch || getDisplaySubtitle(thread) })
  );
  if ((thread.permissionMode || "").toLowerCase() === "danger-full-access") {
    metadata.append(makeCardMeta("shield", "full access", { tone: "danger" }));
  }
  lastTool.textContent = thread.lastToolName || "-";
  const tokenCount = (thread.tokensUsed || 0) + (stats.tokens || 0);
  tokensUsed.textContent = formatCompactNumber(tokenCount);
  const tokenCountLabel = Intl.NumberFormat().format(tokenCount);
  tokensUsed.title = `${tokenCountLabel} tokens`;
  tokensUsed.setAttribute("aria-label", `${tokenCountLabel} tokens`);
  const badges = card.querySelector(".badges");
  if (thread.goal?.status === "active" || stats.activeGoals) badges.append(makeBadge(stats.activeGoals > 1 ? `${stats.activeGoals} active goals` : "goal active", "process"));
  for (const tag of getThreadTags(thread, false)) badges.append(makeBadge(tag, "tag"));
  if (!badges.children.length) badges.hidden = true;
  else badges.hidden = false;

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
    openThreadInCodex(thread);
  });

  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openThreadInCodex(thread);
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

function threadOpenUrl(thread) {
  return thread?.openUrl || thread?.codexUrl || "";
}

function openThreadInCodex(thread) {
  const url = threadOpenUrl(thread);
  if (!url) return;
  window.location.href = url;
}

function getBoardThreads() {
  const query = normalize(state.query.trim());
  const showSubagents = state.quickFilter === "subagents" || Boolean(query);
  const base = state.threads
    .filter((thread) => !thread.archived)
    .filter((thread) => {
      if (thread.threadSource === "subagent" && !getParentThread(thread)) return false;
      return showSubagents || thread.threadSource !== "subagent" || !getParentThread(thread);
    })
    .map((thread) => ({ ...thread, displayStatus: getEffectiveStatus(thread) }));

  return sortThreads(base.filter((thread) => {
    if (state.hideDone && thread.displayStatus === "done") return false;
    if (state.focusMode && ["today", "done"].includes(thread.displayStatus) && !threadNeedsReview(thread) && !threadHasRisk(thread)) return false;
    if (!state.activeStatuses.has(thread.displayStatus)) return false;
    if (!threadMatchesActiveTag(thread)) return false;
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

function timeValue(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function runningAnchor(thread) {
  return timeValue(thread.lastUserAt || thread.runningSince || thread.activityAt);
}

function riskScore(thread) {
  const stats = childStats(thread);
  return Number(threadHasRisk(thread)) * 5
    + Number((thread.liveProcessCount || stats.liveProcesses) && thread.fullAccess) * 8
    + Number(thread.runningStale) * 4
    + ((thread.logHealth?.errors24h || 0) + stats.errors) * 3
    + ((thread.logHealth?.warnings24h || 0) + stats.warnings)
    + Number(thread.fullAccess) * 2
    + Number(thread.unread || stats.unread) * 2;
}

function compareNumber(a, b, direction = "desc") {
  const delta = a - b;
  return direction === "asc" ? delta : -delta;
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function compareRunningUserReply(a, b, direction = "desc") {
  const aRunning = (a.displayStatus || a.status) === "running";
  const bRunning = (b.displayStatus || b.status) === "running";
  if (aRunning !== bRunning) return Number(bRunning) - Number(aRunning);
  if (!aRunning && !bRunning) return 0;
  return compareNumber(runningAnchor(a), runningAnchor(b), direction);
}

function compareByActivity(a, b) {
  return compareNumber(timeValue(a.activityAt), timeValue(b.activityAt), "desc");
}

function getInteractionAt(thread) {
  if (thread.lastUserAt) return thread.lastUserAt;
  if (thread.promptCount || thread.lastPrompt) return thread.activityAt;
  return null;
}

function compareByRisk(a, b) {
  return compareNumber(riskScore(a), riskScore(b), "desc");
}

function compareByStatus(a, b) {
  return statusRank(a.displayStatus || a.status) - statusRank(b.displayStatus || b.status);
}

function compareStable(a, b) {
  return compareText(getDisplayTitle(a), getDisplayTitle(b)) || compareText(a.id, b.id);
}

function sortThreads(threads) {
  return [...threads].sort((a, b) => {
    if (state.sortMode === "updated") {
      return compareByActivity(a, b)
        || compareByStatus(a, b)
        || compareRunningUserReply(a, b, "desc")
        || compareByRisk(a, b)
        || compareStable(a, b);
    }

    if (state.sortMode === "running") {
      return compareRunningUserReply(a, b, "asc")
        || compareByActivity(a, b)
        || compareByRisk(a, b)
        || compareStable(a, b);
    }

    if (state.sortMode === "risk") {
      return compareByRisk(a, b)
        || compareRunningUserReply(a, b, "desc")
        || compareByActivity(a, b)
        || compareByStatus(a, b)
        || compareStable(a, b);
    }

    return compareByStatus(a, b)
      || compareRunningUserReply(a, b, "desc")
      || Number(threadNeedsReview(b)) - Number(threadNeedsReview(a))
      || compareByRisk(a, b)
      || compareByActivity(a, b)
      || compareStable(a, b);
  });
}

function renderUpdatedAt() {
  const updatedAt = document.querySelector("#updatedAt");
  if (!updatedAt) return;
  updatedAt.textContent = state.lastSnapshotAt ? `Updated ${formatClock(state.lastSnapshotAt)}` : "--";
}

function usageLimitLabel(window) {
  if (!window) return "Usage limit";
  if (window.windowMinutes <= 360) return `${Math.round(window.windowMinutes / 60)} hour usage limit`;
  if (window.windowMinutes >= 7 * 24 * 60) return "Weekly usage limit";
  return `${window.label || "Usage"} usage limit`;
}

function normalizeUsageLimitName(raw) {
  const value = String(raw || "").trim();
  if (!value) return "Usage";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function usageGroupLabel(window) {
  if (!window?.limitId) return "Usage limits";
  if (window.limitId === "codex") return "General usage limits";
  const explicit = window.limitName || "";
  const base = explicit.trim() || normalizeUsageLimitName(window.limitId);
  return `${base} usage limits`;
}

function usageShortResetText(window) {
  if (!window?.resetsAt) return "Resets --";
  const resetAt = new Date(window.resetsAt);
  if (Number.isNaN(resetAt.getTime())) return "Resets --";
  if (window.windowMinutes <= 360) {
    return `Resets ${resetAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return `Resets ${resetAt.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

function renderUsageDetailWindow(window) {
  if (!window) return "";
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  const remaining = formatPercent(window.remainingPercent);
  const label = usageLimitLabel(window);
  const resetText = usageShortResetText(window);
  const title = `${usageGroupLabel(window)}. ${usageLimitLabel(window)}. ${remaining} left. ${resetText}.`;

  return `
    <article class="usage-detail-row" title="${escapeHtml(title)}">
      <div class="usage-detail-top">
        <strong>${escapeHtml(label)}</strong>
        <span>${escapeHtml(remaining)} left</span>
      </div>
      <div class="usage-bar" aria-hidden="true"><span style="width: ${usedPercent}%"></span></div>
      <p>${escapeHtml(resetText)}</p>
    </article>
  `;
}

function renderUsage() {
  if (!usageDetail) return;
  const usage = state.usage;
  if (!usage?.available) {
    usageDetail.hidden = true;
    return;
  }

  const groupOrder = [];
  const grouped = new Map();
  const seen = new Set();
  const addWindow = (window) => {
    if (!window) return;
    const key = window.groupKey || window.key || `${window.limitId || "codex"}:${window.label || ""}`;
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    if (!key) return;
    const groupName = usageGroupLabel(window);
    if (!grouped.has(groupName)) {
      grouped.set(groupName, []);
      groupOrder.push(groupName);
    }
    grouped.get(groupName).push(window);
  };

  for (const window of usage.windows || []) addWindow(window);
  addWindow(usage.primary);
  addWindow(usage.secondary);

  const detailRows = [];
  for (const groupName of groupOrder) {
    const windowRows = (grouped.get(groupName) || [])
      .map((window) => renderUsageDetailWindow(window))
      .filter(Boolean);
    if (!windowRows.length) continue;
    detailRows.push(`<p class="usage-group-title">${escapeHtml(groupName)}</p>`);
    detailRows.push(windowRows.join(""));
  }

  const detailHtml = detailRows.join("");
  usageDetail.hidden = !detailHtml;
  usageDetail.innerHTML = detailHtml;
}

function renderUpdateNotice() {
  const update = state.update;
  if (!update?.updateAvailable || !update.latestTag) {
    updateNotice.hidden = true;
    return;
  }

  const dismissed = localStorage.getItem(dismissedUpdateKey);
  if (dismissed === update.latestTag) {
    updateNotice.hidden = true;
    return;
  }

  updateTitle.textContent = `${update.latestTag} available`;
  updateDetail.textContent = `Current ${update.currentVersion || "--"}. Run npm run update from this folder.`;
  updateReleaseLink.href = update.releaseUrl || `https://github.com/${update.repo || ""}/releases`;
  updateNotice.hidden = false;
}

function setWebhookFeedback(value) {
  webhookFeedback.textContent = value || "";
}

function renderWebhookSettings() {
  const config = state.webhook || {};
  webhookEnabled.checked = Boolean(config.enabled);
  webhookEndpoint.value = config.endpoint || "";
  webhookIncludeSubagents.checked = config.includeSubagents !== false;
  webhookSigningToken.value = "";
  webhookSigningToken.placeholder = config.signingToken ? "Configured" : "";

  for (const status of webhookStatusIds) {
    const input = webhookForm.querySelector(`[data-webhook-status="${status}"]`);
    if (input) input.checked = Boolean(config.statuses?.[status]);
  }

  webhookForm.querySelectorAll("[data-webhook-message]").forEach((input) => {
    input.value = config.messages?.[input.dataset.webhookMessage] || "";
  });

  let label = "Disabled";
  if (config.enabled && config.endpoint) label = "Active";
  else if (config.enabled) label = "Incomplete";
  else if (config.endpoint) label = "Configured";
  webhookState.textContent = label;
  webhookModalState.textContent = label;
}

function openWebhookModal() {
  webhookModal.hidden = false;
  document.body.classList.add("modal-open");
  renderWebhookSettings();
  webhookEndpoint.focus();
}

function closeWebhookModal() {
  webhookModal.hidden = true;
  document.body.classList.remove("modal-open");
  openWebhookSettings.focus();
}

function openNewTagModal(threadId) {
  const thread = getThreadById(threadId || menuThreadId);
  if (!thread) return;

  newTagForm.dataset.threadId = thread.id;
  newTagInput.value = "";
  newTagFeedback.textContent = "";
  newTagModal.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    newTagInput.focus();
    newTagInput.select();
  });
}

function closeNewTagModal() {
  newTagForm.removeAttribute("data-thread-id");
  newTagInput.value = "";
  newTagFeedback.textContent = "";
  newTagModal.hidden = true;
  document.body.classList.remove("modal-open");
}

function collectWebhookSettings() {
  const statuses = {};
  for (const status of webhookStatusIds) {
    statuses[status] = Boolean(webhookForm.querySelector(`[data-webhook-status="${status}"]`)?.checked);
  }

  const messages = {};
  webhookForm.querySelectorAll("[data-webhook-message]").forEach((input) => {
    messages[input.dataset.webhookMessage] = input.value.trim();
  });

  return {
    enabled: webhookEnabled.checked,
    endpoint: webhookEndpoint.value.trim(),
    includeSubagents: webhookIncludeSubagents.checked,
    signingToken: webhookSigningToken.value.trim(),
    statuses,
    messages,
  };
}

async function loadWebhookSettings() {
  try {
    const response = await fetch("/api/webhook", { cache: "no-store" });
    if (!response.ok) throw new Error(`Webhook config failed: ${response.status}`);
    state.webhook = await response.json();
    renderWebhookSettings();
  } catch (error) {
    setWebhookFeedback(error.message);
  }
}

async function saveWebhookSettings() {
  setWebhookFeedback("Saving");
  const response = await fetch("/api/webhook", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(collectWebhookSettings()),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Webhook save failed: ${response.status}`);
  state.webhook = data;
  renderWebhookSettings();
  setWebhookFeedback("Saved");
}

async function sendWebhookTest() {
  setWebhookFeedback("Testing");
  const response = await fetch("/api/webhook/test", { method: "POST" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Webhook test failed: ${response.status}`);
  if (!data.ok) throw new Error(`HTTP ${data.delivery?.status || "--"}`);
  setWebhookFeedback("Sent");
}

function groupThreadsByRepeatedProject(threads) {
  const byProject = new Map();
  for (const thread of threads) {
    const project = getProjectName(thread) || "Projectless";
    const projectKey = getProjectGroupKey(thread);
    if (!byProject.has(projectKey)) {
      byProject.set(projectKey, {
        type: "project",
        project,
        projectKey,
        path: getProjectPath(thread),
        threads: [],
      });
    }
    const group = byProject.get(projectKey);
    group.project = project;
    group.path = getProjectPath(thread);
    group.threads.push(thread);
  }
  const groups = Array.from(byProject.values());
  if (ensureProjectColorAssignments(groups)) savePreferences();
  return groups;
}

function renderProjectGroup(group) {
  const section = document.createElement("section");
  section.className = "project-group";
  const color = projectColorById(group.colorId);
  section.style.setProperty("--project-group-bg", color?.background || "var(--surface-mid)");
  section.style.setProperty("--project-group-border", color?.border || "var(--outline-strong)");
  section.style.setProperty("--project-group-text", color?.text || "var(--muted)");
  section.style.setProperty("--project-group-control", color?.background || "var(--surface-mid)");

  const header = document.createElement("header");
  const title = document.createElement("span");
  title.className = "project-label";
  const projectName = group.project || "Projectless";
  title.textContent = `PROJECT: ${projectName}`;
  title.title = group.path || projectName;

  const count = document.createElement("span");
  count.className = "project-count";
  count.textContent = String(group.threads.length);

  const colorPicker = document.createElement("select");
  const autoOption = document.createElement("option");
  autoOption.value = "";
  autoOption.textContent = "Auto";
  colorPicker.append(autoOption);

  for (const color of projectColorPalette) {
    const option = document.createElement("option");
    option.value = color.id;
    option.textContent = color.label;
    colorPicker.append(option);
  }
  colorPicker.value = group.colorId || "";
  colorPicker.className = "project-color-select";
  colorPicker.title = `Assign color for ${projectName}`;
  colorPicker.setAttribute("aria-label", `Assign color for ${projectName}`);
  colorPicker.addEventListener("change", (event) => {
    event.preventDefault();
    setProjectColor(group.projectKey, colorPicker.value);
    render();
  });

  header.append(title, colorPicker, count);

  const cards = document.createElement("div");
  cards.className = "project-cards";
  cards.append(...group.threads.map(renderCard));

  section.append(header, cards);
  return section;
}

function renderBoard(filtered) {
  board.replaceChildren();

  const visibleColumns = state.hideDone ? columns.filter((column) => column.id !== "done") : columns;
  if (!visibleColumns.some((column) => column.id === state.mobileColumn)) {
    state.mobileColumn = visibleColumns[0]?.id || "running";
  }

  renderColumnSwitcher(filtered, visibleColumns);
  board.className = "board";
  board.setAttribute("aria-label", "Agent thread board");
  board.dataset.columnCount = String(visibleColumns.length);
  board.dataset.view = "board";

  for (const column of visibleColumns) {
    const el = columnTemplate.content.firstElementChild.cloneNode(true);
    const threads = filtered.filter((thread) => thread.displayStatus === column.id);
    el.dataset.status = column.id;
    el.classList.toggle("is-mobile-hidden", column.id !== state.mobileColumn);
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
      const grouped = groupThreadsByRepeatedProject(threads);
      cards.append(...grouped.map((group) => (
        group.type === "project" ? renderProjectGroup(group) : renderCard(group.thread)
      )));
    }

    board.append(el);
  }
}

function renderColumnSwitcher(filtered, visibleColumns) {
  columnSwitcher.replaceChildren();
  columnSwitcher.hidden = false;

  for (const column of visibleColumns) {
    const count = filtered.filter((thread) => thread.displayStatus === column.id).length;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${column.title} (${count})`;
    button.setAttribute("aria-pressed", String(state.mobileColumn === column.id));
    button.addEventListener("click", () => {
      state.mobileColumn = column.id;
      savePreferences();
      render();
    });
    columnSwitcher.append(button);
  }
}

function timelineReason(thread, stats) {
  const items = [
    thread.unread || stats.unread ? "unread" : null,
    thread.goal?.status === "active" || stats.activeGoals ? "goal" : null,
    thread.liveProcessCount || stats.liveProcesses ? "terminal" : null,
    thread.runningStale ? "stale" : null,
  ].filter(Boolean);
  return items.join(", ") || compactPath(thread.workspace || thread.outputDirectory) || "-";
}

function renderTimeline(filtered) {
  timeline.replaceChildren();
  const entries = filtered
    .map((thread) => ({ ...thread, interactionAt: getInteractionAt(thread) }))
    .filter((thread) => thread.interactionAt)
    .sort((a, b) => compareNumber(timeValue(a.interactionAt), timeValue(b.interactionAt), "desc") || compareStable(a, b));
  const visibleEntries = entries.slice(0, 28);

  const header = document.createElement("header");
  header.className = "timeline-header";
  header.innerHTML = `
    <div>
      <p class="eyebrow">Timeline</p>
      <h2>Interaction Timeline</h2>
    </div>
    <span class="timeline-count">${visibleEntries.length}${entries.length > visibleEntries.length ? ` / ${entries.length}` : ""}</span>
  `;
  timeline.append(header);

  if (!visibleEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No matching interactions";
    timeline.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "timeline-list";

  for (const thread of visibleEntries) {
    const stats = childStats(thread);
    const displayStatus = thread.displayStatus || thread.status;
    const displayStatusLabel = columns.find((column) => column.id === displayStatus)?.title || thread.statusLabel || displayStatus;
    const row = document.createElement("article");
    row.className = "timeline-row";
    row.dataset.status = displayStatus;
    row.tabIndex = 0;
    row.title = getOriginalTask(thread);

    const time = document.createElement("time");
    time.className = "timeline-time";
    time.dateTime = thread.interactionAt;
    time.title = formatIsoTimestamp(thread.interactionAt);
    time.innerHTML = `
      <strong>${escapeHtml(formatTimelineDate(thread.interactionAt))}</strong>
      <span>${escapeHtml(formatClock(thread.interactionAt))}</span>
    `;

    const main = document.createElement("div");
    main.className = "timeline-main";
    main.innerHTML = `
      <div class="timeline-title-row">
        <h3>${escapeHtml(getDisplayTitle(thread))}</h3>
        <span class="badge ${escapeHtml(displayStatus)}">${escapeHtml(displayStatusLabel)}</span>
      </div>
      <p>${escapeHtml(getPromptText(thread))}</p>
      <div class="timeline-meta">
        <span>${escapeHtml(thread.id)}</span>
        <span>${escapeHtml(formatRelative(thread.interactionAt))}</span>
        <span>${escapeHtml(timelineReason(thread, stats))}</span>
      </div>
    `;

    const actions = document.createElement("div");
    actions.className = "timeline-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.title = thread.openLabel || "Open";
    open.addEventListener("click", () => openThreadInCodex(thread));
    const details = document.createElement("button");
    details.type = "button";
    details.textContent = "Details";
    details.title = "Open details";
    details.addEventListener("click", () => showDetails(thread.id));
    actions.append(open, details);

    row.addEventListener("click", (event) => {
      if (event.target.closest("button, a")) return;
      openThreadInCodex(thread);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") openThreadInCodex(thread);
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        showCardMenu(thread.id, rect.left + 24, rect.top + 24);
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showCardMenu(thread.id, event.clientX, event.clientY);
    });

    row.append(time, main, actions);
    list.append(row);
  }

  timeline.append(list);
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

function renderParentLink(thread, parent) {
  if (thread.threadSource !== "subagent" || !parent) return "";
  return `
    <section class="detail-parent-nav" aria-label="Parent thread">
      <button class="parent-row" type="button" data-thread-id="${escapeHtml(parent.id)}" title="Back to parent thread details">
        <span>Back to parent</span>
        <strong>${escapeHtml(parent.name)}</strong>
      </button>
    </section>
  `;
}

function renderDetailBadges(thread) {
  const stats = childStats(thread);
  const badges = [];
  badges.push(makeBadge(thread.statusLabel, thread.status).outerHTML);
  if (thread.providerLabel) badges.push(makeProviderBadge(thread).outerHTML);
  if (thread.threadSource === "subagent") badges.push(makeBadge(thread.agentRole ? `subagent ${thread.agentRole}` : "subagent", "strong").outerHTML);
  if (stats.total) badges.push(makeBadge(`${stats.total} subagents`, "strong").outerHTML);
  if (thread.fullAccess) badges.push(makeBadge("full access", "danger").outerHTML);
  if (thread.liveProcessCount || stats.liveProcesses) badges.push(makeBadge(`${thread.liveProcessCount + stats.liveProcesses} live terminal`, "process").outerHTML);
  if (thread.logHealth?.errors24h || stats.errors) badges.push(makeBadge(`${thread.logHealth.errors24h + stats.errors} errors`, "danger").outerHTML);
  if (thread.logHealth?.warnings24h || stats.warnings) badges.push(makeBadge(`${thread.logHealth.warnings24h + stats.warnings} warnings`, "warning").outerHTML);
  if (thread.goal?.status) badges.push(makeBadge(`goal ${thread.goal.status}`, "process").outerHTML);
  for (const tag of getThreadTags(thread, false)) badges.push(makeBadge(tag, "tag").outerHTML);
  return `<div class="badges detail-badges">${badges.join("")}</div>`;
}

function renderTagEditor(thread) {
  const tags = getThreadTags(thread, false);
  const chips = tags.length
    ? tags.map((tag) => `
      <button class="tag-chip" type="button" data-remove-tag="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}">
        <span>${escapeHtml(tag)}</span>
        <strong aria-hidden="true">x</strong>
      </button>
    `).join("")
    : `<p class="tag-empty">No tags yet</p>`;

  return `
    <section class="detail-section tag-editor-section">
      <h3>Tags</h3>
      <div class="tag-chip-list">${chips}</div>
      <form id="tagEditor" class="tag-editor">
        <input name="tag" type="text" maxlength="40" placeholder="Add tag" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
    </section>
  `;
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
    ${renderParentLink(thread, parent)}
    ${renderDetailBadges(thread)}
    <section class="detail-section">
      <h3>Overview</h3>
      <p>${escapeHtml(getOriginalTask(thread))}</p>
    </section>
    ${renderTagEditor(thread)}
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
      <a class="open-link" href="${escapeHtml(threadOpenUrl(thread))}">${escapeHtml(thread.openLabel || "Open")}</a>
      <button id="copyDetailId" type="button">Copy Thread ID</button>
    </section>
  `;

  detailContent.querySelectorAll(".child-row").forEach((row) => {
    row.addEventListener("click", () => showDetails(row.dataset.threadId));
  });
  detailContent.querySelector(".parent-row")?.addEventListener("click", (event) => {
    showDetails(event.currentTarget.dataset.threadId);
  });
  detailContent.querySelector("#copyDetailId")?.addEventListener("click", async () => {
    await navigator.clipboard.writeText(thread.id);
  });
  detailContent.querySelector("#tagEditor")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = event.currentTarget.elements.tag;
    const tag = normalizeTag(input.value);
    if (!tag) return;
    const tags = Array.from(new Set([...getThreadTags(thread, false), tag]));
    input.value = "";
    updateThreadTags(thread.id, tags).catch((error) => {
      document.querySelector("#updatedAt").textContent = `Issue: ${error.message}`;
    });
  });
  detailContent.querySelectorAll("[data-remove-tag]").forEach((button) => {
    button.addEventListener("click", () => {
      const removeTag = button.dataset.removeTag;
      updateThreadTags(thread.id, getThreadTags(thread, false).filter((tag) => tag !== removeTag)).catch((error) => {
        document.querySelector("#updatedAt").textContent = `Issue: ${error.message}`;
      });
    });
  });

  detailDrawer.hidden = false;
  document.body.classList.add("detail-open");
}

function closeDetails() {
  detailDrawer.hidden = true;
  state.selectedThreadId = null;
  document.body.classList.remove("detail-open");
}

function getReadActionIds(thread) {
  const ids = [thread.id, ...getChildThreads(thread).map((child) => child.id)];
  return Array.from(new Set(ids));
}

async function markRead(thread) {
  const threadIds = getReadActionIds(thread);
  const response = await fetch("/api/threads/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadIds }),
  });

  if (!response.ok) throw new Error(`Mark read failed: ${response.status}`);
  const result = await response.json();

  const ids = new Set(threadIds);
  state.threads = state.threads.map((item) => ids.has(item.id) ? { ...item, unread: false } : item);
  render();
  await loadThreads({ force: true });
  const remaining = state.threads.filter((item) => ids.has(item.id) && item.unread);
  if (remaining.length) {
    throw new Error(result.removed
      ? "The thread was marked unread again after refresh"
      : "No matching unread state was removed");
  }
}

async function archiveThread(thread) {
  const response = await fetch(`/api/threads/${thread.id}/state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });

  if (!response.ok) throw new Error(`Archive failed: ${response.status}`);
  const result = await response.json();
  state.threads = state.threads.map((item) => (item.id === thread.id ? { ...item, archived: Boolean(result.archived) } : item));
  render();
  await loadThreads({ force: true });
}

async function updateThreadTags(threadId, tags) {
  const response = await fetch("/api/threads/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId, tags }),
  });

  if (!response.ok) throw new Error(`Tag update failed: ${response.status}`);

  const result = await response.json();
  state.threads = state.threads.map((item) => (
    item.id === threadId ? { ...item, tags: result.tags || [] } : item
  ));
  render();
  await loadThreads();
}

function setMenuItemHidden(action, hidden) {
  const item = cardMenu.querySelector(`[data-action="${action}"]`);
  if (item) item.hidden = hidden;
}

function renderTagSubmenu(thread) {
  const threadTags = new Set(getThreadTags(thread, false));
  const tagCounts = getTagCounts();
  tagSubmenu.replaceChildren();

  if (tagCounts.length) {
    for (const [tag, count] of tagCounts) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = "toggle-tag";
      button.dataset.tag = tag;
      button.setAttribute("role", "menuitemcheckbox");
      button.setAttribute("aria-checked", String(threadTags.has(tag)));
      button.title = threadTags.has(tag) ? `Remove ${tag}` : `Add ${tag}`;

      const label = document.createElement("span");
      label.textContent = `${threadTags.has(tag) ? "✓ " : ""}${tag}`;
      const meta = document.createElement("small");
      meta.textContent = String(count);
      button.append(label, meta);
      tagSubmenu.append(button);
    }

    tagSubmenu.append(document.createElement("hr"));
  } else {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.disabled = true;
    empty.textContent = "No tags";
    tagSubmenu.append(empty, document.createElement("hr"));
  }

  const newTag = document.createElement("button");
  newTag.type = "button";
  newTag.dataset.action = "new-tag";
  newTag.setAttribute("role", "menuitem");
  newTag.textContent = "New Tag";
  tagSubmenu.append(newTag);
}

function showCardMenu(threadId, x, y) {
  const thread = getThreadById(threadId);
  if (!thread) return;

  const stats = childStats(thread);
  menuThreadId = threadId;

  setMenuItemHidden("mark-read", !thread.unread && !stats.unread);
  setMenuItemHidden("archive", thread.archived);
  renderTagSubmenu(thread);
  const tagsMenu = cardMenu.querySelector('[data-menu="tags"]');
  tagsMenu?.classList.remove("is-open", "align-left");
  cardMenu.querySelector('[data-action="tags-menu"]')?.setAttribute("aria-expanded", "false");

  cardMenu.hidden = false;
  cardMenu.style.left = "0px";
  cardMenu.style.top = "0px";

  const rect = cardMenu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  cardMenu.style.left = `${Math.max(8, left)}px`;
  cardMenu.style.top = `${Math.max(8, top)}px`;
  if (left + rect.width + 210 > window.innerWidth) tagsMenu?.classList.add("align-left");
  cardMenu.querySelector("button:not([hidden])")?.focus();
}

function closeCardMenu() {
  cardMenu.hidden = true;
  cardMenu.querySelector('[data-menu="tags"]')?.classList.remove("is-open");
  cardMenu.querySelector('[data-action="tags-menu"]')?.setAttribute("aria-expanded", "false");
  menuThreadId = null;
}

async function handleMenuAction(action, actionTarget = null) {
  const thread = getThreadById(menuThreadId);
  if (!thread) return;

  if (action === "tags-menu") {
    const submenu = cardMenu.querySelector('[data-menu="tags"]');
    const trigger = cardMenu.querySelector('[data-action="tags-menu"]');
    const open = !submenu?.classList.contains("is-open");
    submenu?.classList.toggle("is-open", open);
    trigger?.setAttribute("aria-expanded", String(open));
    return;
  }

  const tag = normalizeTag(actionTarget?.dataset.tag);
  closeCardMenu();

  if (action === "details") showDetails(thread.id);
  if (action === "new-tag") {
    openNewTagModal(thread.id);
  }
  if (action === "toggle-tag") {
    if (!tag) return;
    const tags = new Set(getThreadTags(thread, false));
    if (tags.has(tag)) tags.delete(tag);
    else tags.add(tag);
    await updateThreadTags(thread.id, Array.from(tags));
  }
  if (action === "open") openThreadInCodex(thread);
  if (action === "copy-id") await navigator.clipboard.writeText(thread.id);
  if (action === "copy-link") await navigator.clipboard.writeText(threadOpenUrl(thread));
  if (action === "copy-title") await navigator.clipboard.writeText(getDisplayTitle(thread));
  if (action === "mark-read") await markRead(thread);
  if (action === "archive") await archiveThread(thread);
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

function getTimelinePanelMaxWidth() {
  const viewportMax = Math.floor(window.innerWidth * 0.44);
  return Math.max(timelinePanelWidthDefaults.min, Math.min(timelinePanelWidthDefaults.max, viewportMax));
}

function clampTimelinePanelWidth(value) {
  const width = Number(value);
  const fallback = Number.isFinite(width) ? width : timelinePanelWidthDefaults.default;
  return Math.round(Math.max(timelinePanelWidthDefaults.min, Math.min(getTimelinePanelMaxWidth(), fallback)));
}

function updateTimelinePanelResizeHandle(width) {
  const max = getTimelinePanelMaxWidth();
  timelinePanelResizeHandle.setAttribute("aria-valuemin", String(timelinePanelWidthDefaults.min));
  timelinePanelResizeHandle.setAttribute("aria-valuemax", String(max));
  timelinePanelResizeHandle.setAttribute("aria-valuenow", String(width));
  timelinePanelResizeHandle.setAttribute("aria-valuetext", `${width}px`);
}

function applyTimelinePanelWidth(width, persist = true) {
  const nextWidth = clampTimelinePanelWidth(width);
  state.timelinePanelWidth = nextWidth;
  document.documentElement.style.setProperty("--timeline-panel-width", `${nextWidth}px`);
  updateTimelinePanelResizeHandle(nextWidth);
  if (persist) savePreferences();
}

function initTimelinePanelResize() {
  let pointerId = null;
  let startX = 0;
  let startWidth = timelinePanelWidthDefaults.default;

  timelinePanelResizeHandle.addEventListener("pointerdown", (event) => {
    if (state.timelinePanelCollapsed || window.innerWidth <= timelinePanelWidthDefaults.mobileBreakpoint) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startWidth = state.timelinePanelWidth;
    timelinePanelResizeHandle.setPointerCapture(pointerId);
    document.body.classList.add("is-resizing");
    event.preventDefault();
  });

  timelinePanelResizeHandle.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    applyTimelinePanelWidth(startWidth + startX - event.clientX, false);
  });

  function finishResize(event) {
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    document.body.classList.remove("is-resizing");
    savePreferences();
  }

  timelinePanelResizeHandle.addEventListener("pointerup", finishResize);
  timelinePanelResizeHandle.addEventListener("pointercancel", finishResize);

  timelinePanelResizeHandle.addEventListener("dblclick", () => {
    applyTimelinePanelWidth(timelinePanelWidthDefaults.default);
  });

  timelinePanelResizeHandle.addEventListener("keydown", (event) => {
    const steps = {
      ArrowLeft: 16,
      ArrowRight: -16,
      PageUp: 48,
      PageDown: -48,
    };

    if (event.key === "Home") {
      event.preventDefault();
      applyTimelinePanelWidth(timelinePanelWidthDefaults.min);
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      applyTimelinePanelWidth(getTimelinePanelMaxWidth());
      return;
    }

    if (!Object.hasOwn(steps, event.key)) return;
    event.preventDefault();
    applyTimelinePanelWidth(state.timelinePanelWidth + steps[event.key]);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > timelinePanelWidthDefaults.mobileBreakpoint) applyTimelinePanelWidth(state.timelinePanelWidth, false);
    else updateTimelinePanelResizeHandle(state.timelinePanelWidth);
  });
}

function setTimelinePanelCollapsed(collapsed, persist = true) {
  state.timelinePanelCollapsed = collapsed;
  document.body.classList.toggle("timeline-panel-collapsed", collapsed);
  timelinePanel.setAttribute("aria-label", collapsed ? "Thread interaction timeline collapsed" : "Thread interaction timeline");
  timelinePanelToggle.setAttribute("aria-expanded", String(!collapsed));
  timelinePanelToggle.setAttribute("aria-label", collapsed ? "Expand timeline" : "Collapse timeline");
  timelinePanelToggle.title = collapsed ? "Expand timeline" : "Collapse timeline";
  if (persist) savePreferences();
}

function render() {
  renderStatusFilters();
  renderQuickFilters();
  renderUpdatedAt();
  renderTagFilters();
  const filtered = getBoardThreads();
  if (syncProjectColors(state.threads)) savePreferences();
  renderUsage();
  renderUpdateNotice();
  renderBoard(filtered);
  renderTimeline(filtered);
  if (state.selectedThreadId) showDetails(state.selectedThreadId);
}

async function applySnapshot(data) {
  state.threads = data.threads || [];
  state.summary = data.summary || null;
  state.usage = data.usage || null;
  state.lastSnapshotAt = data.refreshedAt || new Date().toISOString();
  render();
}

async function loadThreads({ force = false } = {}) {
  refresh.disabled = true;
  try {
    const url = force ? `/api/threads?refresh=${Date.now()}` : "/api/threads";
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    await applySnapshot(data);
    return data;
  } catch (error) {
    document.querySelector("#updatedAt").textContent = `Issue: ${error.message}`;
    return null;
  } finally {
    refresh.disabled = false;
  }
}

async function checkForUpdates() {
  try {
    const response = await fetch("/api/update-check");
    if (!response.ok) return;
    state.update = await response.json();
    renderUpdateNotice();
  } catch {
    // Update checks are optional and should never interrupt local monitoring.
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
}

search.addEventListener("input", () => {
  state.query = search.value;
  savePreferences();
  render();
});

refresh.addEventListener("click", loadThreads);
copyUpdateCommand.addEventListener("click", async () => {
  await navigator.clipboard.writeText("npm run update");
  copyUpdateCommand.textContent = "Copied";
  setTimeout(() => {
    copyUpdateCommand.textContent = "Copy Command";
  }, 1400);
});
dismissUpdate.addEventListener("click", () => {
  if (state.update?.latestTag) localStorage.setItem(dismissedUpdateKey, state.update.latestTag);
  renderUpdateNotice();
});
openWebhookSettings.addEventListener("click", openWebhookModal);
closeWebhookSettings.addEventListener("click", closeWebhookModal);
webhookModal.addEventListener("click", (event) => {
  if (event.target === webhookModal) closeWebhookModal();
});
webhookForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveWebhookSettings().catch((error) => {
    setWebhookFeedback(error.message);
  });
});
newTagForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const tag = normalizeTag(newTagInput.value);
  if (!tag) {
    newTagFeedback.textContent = "Tag cannot be empty after normalization.";
    return;
  }
  const threadId = newTagForm.dataset.threadId;
  const thread = getThreadById(threadId);
  if (!thread) {
    newTagFeedback.textContent = "No thread is selected.";
    return;
  }
  const tags = Array.from(new Set([...getThreadTags(thread, false), tag]));
  newTagFeedback.textContent = "Saving...";
  updateThreadTags(thread.id, tags)
    .then(() => {
      closeNewTagModal();
    })
    .catch((error) => {
      newTagFeedback.textContent = `Issue: ${error.message}`;
    });
});
testWebhook.addEventListener("click", () => {
  sendWebhookTest().catch((error) => {
    setWebhookFeedback(error.message);
  });
});
closeNewTagModalButton?.addEventListener("click", closeNewTagModal);
cancelNewTag?.addEventListener("click", closeNewTagModal);
newTagModal.addEventListener("click", (event) => {
  if (event.target === newTagModal) closeNewTagModal();
});
panelToggle.addEventListener("click", () => setPanelCollapsed(!state.panelCollapsed));
timelinePanelToggle.addEventListener("click", () => setTimelinePanelCollapsed(!state.timelinePanelCollapsed));
closeDetail.addEventListener("click", closeDetails);
cardMenu.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  handleMenuAction(button.dataset.action, button).catch((error) => {
    document.querySelector("#updatedAt").textContent = `Issue: ${error.message}`;
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
  if (!webhookModal.hidden) closeWebhookModal();
  if (!newTagModal.hidden) closeNewTagModal();
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
quickFilters.addEventListener("change", () => {
  state.quickFilter = quickFilters.value;
  savePreferences();
  render();
});

initPanelResize();
initTimelinePanelResize();
restorePreferences();
renderStatusFilters();
renderQuickFilters();
renderUpdatedAt();
connectEvents();
checkForUpdates();
loadWebhookSettings();
