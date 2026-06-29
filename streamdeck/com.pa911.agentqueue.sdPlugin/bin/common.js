"use strict";

const ACTIONS = Object.freeze({
  runningCount: "com.pa911.agentqueue.running-count",
  completeCount: "com.pa911.agentqueue.complete-count",
  recentCount: "com.pa911.agentqueue.recent-count",
  openRunning: "com.pa911.agentqueue.open-running",
  openComplete: "com.pa911.agentqueue.open-complete",
  unreadCount: "com.pa911.agentqueue.unread-count",
});

const ACTION_META = Object.freeze({
  [ACTIONS.runningCount]: { kind: "count", label: "Running", countKey: "running", accent: "#10B981" },
  [ACTIONS.completeCount]: { kind: "count", label: "Complete", countKey: "complete", accent: "#F59E0B" },
  [ACTIONS.recentCount]: { kind: "count", label: "Recent", countKey: "recent", accent: "#64748B" },
  [ACTIONS.openRunning]: { kind: "open", label: "Open Running", status: "running", accent: "#10B981" },
  [ACTIONS.openComplete]: { kind: "open", label: "Open Complete", status: "complete", accent: "#F59E0B" },
  [ACTIONS.unreadCount]: { kind: "count", label: "Unread", countKey: "unread", accent: "#38BDF8" },
});

function statusTime(thread) {
  const value = thread?.activityAt || thread?.updatedAt || thread?.completedAt || "";
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function summarizeSnapshot(snapshot) {
  const threads = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
  const counts = {
    running: 0,
    complete: 0,
    recent: 0,
    unread: 0,
  };

  const summaryCounts = snapshot?.summary?.counts || {};
  counts.running = Number(summaryCounts.running || 0);
  counts.complete = Number(summaryCounts.complete || 0);
  counts.recent = Number(summaryCounts.recent || 0);
  counts.unread = Number(snapshot?.summary?.unread || 0);

  if (!snapshot?.summary) {
    for (const thread of threads) {
      if (thread.status === "running") counts.running += 1;
      if (thread.status === "complete") counts.complete += 1;
      if (thread.status === "recent") counts.recent += 1;
      if (thread.unread) counts.unread += 1;
    }
  }

  return { counts, threads };
}

function pickMostRecentThread(snapshot, status) {
  const { threads } = summarizeSnapshot(snapshot);
  return threads
    .filter((thread) => thread.status === status)
    .sort((left, right) => statusTime(right) - statusTime(left))[0] || null;
}

function compactTitle(value, maxLength = 34) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "None";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}

function buildKeyState(action, snapshot, connectionState = {}) {
  const meta = ACTION_META[action];
  if (!meta) return null;

  const connected = connectionState.connected !== false && !connectionState.error;
  if (!connected) {
    return {
      label: "AgentQueue",
      value: "OFF",
      subline: connectionState.error || "localhost",
      accent: "#BA1A1A",
      dim: true,
    };
  }

  if (meta.kind === "count") {
    const { counts } = summarizeSnapshot(snapshot);
    return {
      label: meta.label,
      value: String(counts[meta.countKey] || 0),
      subline: "threads",
      accent: meta.accent,
    };
  }

  const thread = pickMostRecentThread(snapshot, meta.status);
  return {
    label: meta.label,
    value: thread ? "OPEN" : "NONE",
    subline: thread ? compactTitle(thread.name || thread.title || thread.id) : "no thread",
    accent: meta.accent,
    thread,
  };
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderKeySvg(state) {
  const label = escapeXml(state?.label || "AgentQueue");
  const value = escapeXml(state?.value || "0");
  const subline = escapeXml(state?.subline || "");
  const accent = state?.accent || "#10B981";
  const surface = state?.dim ? "#1F2937" : "#0F172A";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="12" fill="${surface}"/>
  <rect x="10" y="10" width="124" height="124" rx="8" fill="none" stroke="#334155" stroke-width="2"/>
  <rect x="16" y="18" width="112" height="6" rx="3" fill="${accent}"/>
  <text x="72" y="45" fill="#CBD5E1" font-family="Inter, Arial, sans-serif" font-size="15" font-weight="700" text-anchor="middle">${label}</text>
  <text x="72" y="92" fill="#FFFFFF" font-family="Inter, Arial, sans-serif" font-size="${value.length > 4 ? 28 : 42}" font-weight="800" text-anchor="middle">${value}</text>
  <text x="72" y="118" fill="#94A3B8" font-family="Inter, Arial, sans-serif" font-size="12" font-weight="600" text-anchor="middle">${subline}</text>
</svg>`;
}

function svgDataUrl(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

module.exports = {
  ACTIONS,
  ACTION_META,
  buildKeyState,
  compactTitle,
  pickMostRecentThread,
  renderKeySvg,
  summarizeSnapshot,
  svgDataUrl,
};
