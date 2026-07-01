const refreshButton = document.getElementById("refreshButton");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const focusNeedsAttention = document.getElementById("focusNeedsAttention");
const openV1 = document.getElementById("openV1");
const generatedAt = document.getElementById("summaryGeneratedAt");
const summaryRunning = document.getElementById("summaryRunning");
const summaryStale = document.getElementById("summaryStale");
const summaryNeedsAttention = document.getElementById("summaryNeedsAttention");
const summaryUnread = document.getElementById("summaryUnread");
const summaryRisk = document.getElementById("summaryRisk");
const health = document.getElementById("health");
const healthLevel = document.getElementById("healthLevel");
const healthWarnings = document.getElementById("healthWarnings");
const rowsRoot = document.getElementById("threadRows");
const emptyState = document.getElementById("emptyState");
const drawer = document.getElementById("threadDrawer");
const drawerTitle = document.getElementById("drawerTitle");
const drawerMain = document.getElementById("drawerMain");
const drawerTimeline = document.getElementById("drawerTimeline");
const drawerDiagnostics = document.getElementById("drawerDiagnostics");
const drawerActions = document.getElementById("drawerActions");
const drawerClose = document.getElementById("drawerClose");
const rowTemplate = document.getElementById("threadRowTemplate");
const drawerActionTemplate = document.getElementById("drawerActionTemplate");

let rows = [];
let currentThreadId = null;
let preferences = null;

function statusLabelFromStatus(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/_/g, " ")
    .split(" ")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

function sanitizeText(value, fallback = "") {
  if (value == null || value === "") return fallback;
  return String(value);
}

function sanitizeThread(thread = {}, index = 0) {
  const id = sanitizeText(thread.id, `thread-${index}`);
  const rawWorkspace = sanitizeText(thread.workspace, null);
  const workspaceLabel = sanitizeText(thread.workspaceLabel, null) || (rawWorkspace ? rawWorkspace.split(/[\\/]/).filter(Boolean).at(-1) : "unknown");

  return {
    id,
    title: sanitizeText(thread.title, "Untitled thread"),
    workspace: rawWorkspace,
    workspaceLabel: sanitizeText(workspaceLabel, "unknown"),
    status: sanitizeText(thread.status, "unknown"),
    statusLabel: sanitizeText(thread.statusLabel, statusLabelFromStatus(thread.status)),
    attentionRank: Number.isFinite(thread.attentionRank) ? thread.attentionRank : 0,
    attentionReason: sanitizeText(thread.attentionReason, "insufficient local state"),
    confidence: sanitizeText(thread.confidence, "low"),
    activityAt: thread.activityAt || null,
    activityAgeMs: Number.isFinite(thread.activityAgeMs) ? thread.activityAgeMs : null,
    threadSource: sanitizeText(thread.threadSource, "main"),
    parentThreadId: thread.parentThreadId || null,
    badges: Array.isArray(thread.badges) ? thread.badges : [],
    tags: Array.isArray(thread.tags) ? thread.tags : [],
    openUrl: sanitizeText(thread.openUrl, `codex://threads/${id}`),
  };
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAge(value) {
  if (!value) return "unknown";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "now";
  const mins = Math.max(0, Math.floor(diff / 60000));
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours > 0) return `${hours}h ${rem}m`;
  return `${mins}m`;
}

function statusClass(status) {
  return String(status || "unknown").replaceAll("_", "-");
}

function isVisibleRow(thread) {
  const safeThread = thread || {};
  const threadBadges = Array.isArray(safeThread.badges) ? safeThread.badges : [];
  const threadStatus = safeThread.status || "unknown";
  const query = (searchInput.value || "").trim().toLowerCase();
  const filter = statusFilter.value;
  const focus = focusNeedsAttention.checked;

  if (filter && threadStatus !== filter) return false;
  if (focus && !threadBadges.includes("needs-attention") && threadStatus !== "needs_attention" && threadStatus !== "running" && threadStatus !== "stale_running") {
    return false;
  }

  if (!query) return true;
  const haystack = [
    safeThread.id || "",
    safeThread.title || "",
    safeThread.workspace || "",
    safeThread.workspaceLabel || "",
    safeThread.statusLabel || "",
    safeThread.attentionReason || "",
    threadBadges.join(" "),
    (Array.isArray(safeThread.tags) ? safeThread.tags : []).join(" "),
  ].join(" ").toLowerCase();
  return haystack.includes(query);
}

function renderSummary(snapshot) {
  const summary = snapshot.summary || {};
  summaryRunning.textContent = summary.running || 0;
  summaryStale.textContent = summary.stale || 0;
  summaryNeedsAttention.textContent = summary.needsAttention || 0;
  summaryUnread.textContent = summary.unread || 0;
  summaryRisk.textContent = summary.risk || 0;
  generatedAt.textContent = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : "--";

  if (snapshot.health?.level === "warn" || snapshot.health?.level === "error") {
    health.hidden = false;
    health.classList.remove("v2-health-ok");
    healthLevel.textContent = `Health: ${snapshot.health.level}`;
    healthWarnings.textContent = (snapshot.health.warnings || []).join(" ");
  } else {
    health.hidden = false;
    health.classList.add("v2-health-ok");
    healthLevel.textContent = "Health: ok";
    healthWarnings.textContent = "No warning conditions from local reads.";
  }
}

function renderBadges(badges = []) {
  if (!badges.length) return "";
  return badges
    .map((badge) => `<span class=\"v2-badge ${badge}\">${escapeHtml(badge)}</span>`)
    .join("");
}

function renderEvidence(evidence = []) {
  if (!Array.isArray(evidence) || !evidence.length) {
    return "<p class=\"v2-muted\">No evidence was attached to this classification.</p>";
  }

  return `
    <div class="v2-evidence-list">
      ${evidence.map((item) => `
        <article class="v2-evidence-row">
          <div>
            <span class="v2-badge">${escapeHtml(item.kind || "evidence")}</span>
            <strong>${escapeHtml(item.source || "local state")}</strong>
          </div>
          <p>${escapeHtml(item.message || "No message provided.")}</p>
          ${item.observedAt ? `<time>${escapeHtml(new Date(item.observedAt).toLocaleString())}</time>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function renderTimeline(rows = []) {
  if (!Array.isArray(rows) || !rows.length) {
    return "<p class=\"v2-muted\">No timeline events were available.</p>";
  }

  return `
    <ul class="v2-detail-list">
      ${rows.map((row) => `
        <li>
          <code>${escapeHtml(row.label || row.kind || "event")}</code>
          <span>${escapeHtml(row.message || "")}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderDiagnostics(rows = []) {
  if (!Array.isArray(rows) || !rows.length) {
    return "<p class=\"v2-muted\">No diagnostics were reported.</p>";
  }

  return `
    <ul class="v2-detail-list">
      ${rows.map((row) => `
        <li>
          <code>${escapeHtml(row.code || row.level || "diagnostic")}</code>
          <span>${escapeHtml(row.message || "")}</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderRow(thread) {
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.threadId = thread.id;

  const statusChip = row.querySelector(".v2-status-chip");
  statusChip.textContent = thread.statusLabel;
  statusChip.classList.add(`status-${statusClass(thread.status)}`);

  const confidence = row.querySelector(".v2-confidence");
  confidence.textContent = `Confidence ${thread.confidence}`;

  row.querySelector(".v2-row-title").textContent = thread.title;
  row.querySelector(".v2-row-meta").textContent = `${thread.workspaceLabel || "unknown"} · ${thread.threadSource} · ${formatAge(thread.activityAt)} ago`;
  row.querySelector(".v2-row-reason").textContent = `${thread.attentionReason} (${thread.activityAgeMs == null ? "age unknown" : `${Math.round(thread.activityAgeMs / 1000)}s`})`;
  row.querySelector(".v2-row-badges").innerHTML = renderBadges(thread.badges);

  row.querySelector("[data-action='open']").addEventListener("click", (event) => {
    event.stopPropagation();
    window.open(thread.openUrl, "_blank", "noopener");
  });

  row.querySelector("[data-action='mark-read']").addEventListener("click", async (event) => {
    event.stopPropagation();
    await writeJson(`/api/v2/threads/${thread.id}/read`, { method: "POST" });
    await loadSnapshot();
  });

  row.querySelector("[data-action='edit-tags']").addEventListener("click", async (event) => {
    event.stopPropagation();
    const input = window.prompt("Set tags (comma-separated):", (thread.tags || []).join(", "));
    if (input === null) return;
    const tags = input.split(",").map((value) => value.trim()).filter(Boolean);
    await writeJson(`/api/v2/threads/${thread.id}/tags`, { method: "PATCH", body: { tags } });
    await loadSnapshot();
  });

  row.addEventListener("click", () => {
    showDetail(thread.id);
  });

  rowsRoot.appendChild(row);
}

function renderList(snapshot) {
  rowsRoot.textContent = "";
  const threadRows = Array.isArray(snapshot.threads) ? snapshot.threads : [];
  const visible = threadRows.filter(isVisibleRow);
  if (!visible.length) {
    emptyState.hidden = false;
    const threadCount = threadRows.length;
    if (threadCount === 0) {
      emptyState.innerHTML = `
        <p>No local threads were found for this AgentQueue instance.</p>
        <p>Verify CODEX_HOME and local session data availability.</p>
      `;
    } else {
      emptyState.innerHTML = `
        <p>No threads matched the current filters.</p>
        <p>Try clearing search/status/focus filters and refreshing.</p>
      `;
    }
    return;
  }

  emptyState.hidden = true;
  for (const thread of visible) {
    renderRow(thread);
  }
}

async function writeJson(url, init = {}) {
  const body = init.body ? JSON.stringify(init.body) : null;
  const response = await fetch(url, {
    method: init.method || "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload;
}

async function readJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    const next = text ? JSON.parse(text) : {};
    throw new Error(next.error || `Request failed: ${response.status}`);
  }
  return text ? JSON.parse(text) : null;
}

function renderDrawerDetail(payload) {
  const thread = payload.thread;
  currentThreadId = thread.id;
  drawer.hidden = false;
  drawerTitle.textContent = `${thread.title} (${thread.statusLabel || thread.status})`;
  drawerMain.innerHTML = `
    <div class="v2-detail-grid">
      <span>ID</span><code>${escapeHtml(thread.id)}</code>
      <span>Workspace</span><code>${escapeHtml(thread.workspace || "unknown")}</code>
      <span>Attention</span><strong>${escapeHtml(thread.attentionReason)}</strong>
      <span>Confidence</span><strong>${escapeHtml(thread.confidence)}</strong>
      <span>Generated</span><time>${new Date(payload.generatedAt).toLocaleString()}</time>
    </div>
    <section class="v2-detail-section">
      <p class="v2-eyebrow">Evidence</p>
      ${renderEvidence(payload.evidence)}
    </section>
  `;

  drawerTimeline.innerHTML = `
    <p class="v2-eyebrow">Timeline</p>
    ${renderTimeline(payload.timeline)}
  `;

  drawerDiagnostics.innerHTML = `
    <p class="v2-eyebrow">Diagnostics</p>
    ${renderDiagnostics(payload.diagnostics)}
  `;

  const actions = drawerActionTemplate.content.cloneNode(true);
  actions.querySelector("[data-drawer-action='copy']").addEventListener("click", async () => {
    await navigator.clipboard.writeText(thread.id);
  });
  actions.querySelector("[data-drawer-action='mark-read']").addEventListener("click", async () => {
    await writeJson(`/api/v2/threads/${thread.id}/read`, { method: "POST" });
    await loadSnapshot();
  });
  actions.querySelector("[data-drawer-action='edit-tags']").addEventListener("click", async () => {
    const input = window.prompt("Set tags (comma-separated):", (thread.tags || []).join(", "));
    if (input === null) return;
    const tags = input.split(",").map((value) => value.trim()).filter(Boolean);
    await writeJson(`/api/v2/threads/${thread.id}/tags`, { method: "PATCH", body: { tags } });
    await loadSnapshot();
  });
  const link = actions.querySelector(".v2-link");
  link.href = thread.openUrl;
  link.textContent = "Open in Codex";

  drawerActions.textContent = "";
  drawerActions.appendChild(actions);
}

async function showDetail(threadId) {
  const payload = await readJson(`/api/v2/threads/${threadId}`);
  renderDrawerDetail(payload);
}

async function loadSnapshot() {
  try {
    const snapshot = await readJson("/api/v2/snapshot");
    rows = Array.isArray(snapshot.threads) ? snapshot.threads.map((thread, index) => sanitizeThread(thread, index)) : [];
    renderSummary(snapshot);
    renderList({ ...snapshot, threads: rows });
  } catch (error) {
    rowsRoot.textContent = "";
    rows = [];
    emptyState.hidden = false;
    emptyState.innerHTML = `
      <p>Failed to load snapshot: ${escapeHtml(error.message)}</p>
      <p>Refresh after verifying the backend is running.</p>
    `;
  }
}

async function hydratePreference() {
  try {
    const payload = await readJson("/api/v2/preferences");
    preferences = payload.preferences || {};
    if (preferences && typeof preferences.focusNeedsAttention === "boolean") {
      focusNeedsAttention.checked = preferences.focusNeedsAttention;
    }
  } catch (error) {
    preferences = null;
  }
}

refreshButton.addEventListener("click", loadSnapshot);
searchInput.addEventListener("input", () => renderList({ threads: rows, summary: {}}));
statusFilter.addEventListener("change", () => renderList({ threads: rows, summary: {}}));
focusNeedsAttention.addEventListener("change", async () => {
  await writeJson("/api/v2/preferences", { method: "PATCH", body: { focusNeedsAttention: focusNeedsAttention.checked } }).catch(() => {});
  renderList({ threads: rows, summary: {} });
});
openV1.addEventListener("click", () => {
  window.location.href = "/";
});
drawerClose.addEventListener("click", () => {
  drawer.hidden = true;
  currentThreadId = null;
});

window.addEventListener("load", async () => {
  await hydratePreference();
  await loadSnapshot();
  setInterval(loadSnapshot, 10000);
});
