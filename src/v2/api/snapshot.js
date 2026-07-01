const { getV2ThreadFixtures } = require("../fixtures/thread-fixtures");
const { classifyThread, classifyThreads, summarizeThreadSummaries } = require("../classifier/thread-classifier");

function buildSnapshotHealth(summaries, warnings = []) {
  const lowConfidence = summaries.some((thread) => thread.confidence === "low");
  const hasMissingData = summaries.some((thread) => thread.badges.includes("missing") || thread.status === "unknown");
  const normalizedWarnings = Array.isArray(warnings) ? [...warnings] : [];

  if (lowConfidence) {
    normalizedWarnings.push("Some classifications are low confidence and should be treated as advisory.");
  }
  if (hasMissingData) {
    normalizedWarnings.push("Some threads show missing local state for stronger confidence.");
  }

  const hasUnknown = summaries.some((thread) => thread.status === "unknown");

  if (hasUnknown) {
    normalizedWarnings.push("Some threads could not be fully classified due to incomplete local state.");
  }
  return {
    level: (normalizedWarnings.length ? "warn" : "ok"),
    warnings: normalizedWarnings,
  };
}

function sortByAttention(threads) {
  return [...threads].sort((left, right) => {
    if (right.attentionRank !== left.attentionRank) return right.attentionRank - left.attentionRank;
    const leftAge = left.activityAt || "";
    const rightAge = right.activityAt || "";
    return leftAge > rightAge ? -1 : leftAge < rightAge ? 1 : 0;
  });
}

function buildV2SnapshotFromThreads({ now = new Date(), codexHome = "", threads = [], warnings = [] }) {
  const rawThreads = Array.isArray(threads) ? threads : getV2ThreadFixtures(now);
  const snapshots = classifyThreads(rawThreads, { now });
  const ordered = sortByAttention(snapshots);
  return {
    generatedAt: now.toISOString(),
    codexHome,
    health: buildSnapshotHealth(snapshots, warnings),
    summary: summarizeThreadSummaries(ordered),
    threads: ordered,
  };
}

function buildV2SnapshotFromFixtures({ now = new Date(), codexHome = "", threads } = {}) {
  return buildV2SnapshotFromThreads({ now, codexHome, threads: Array.isArray(threads) ? threads : getV2ThreadFixtures(now) });
}

function buildV2ThreadDetail({ now = new Date(), codexHome = "", thread, raw }) {
  if (!thread) return null;

  const summary = thread.id ? thread : classifyThread(raw || thread, now);
  const timeline = [];
  const sources = [];
  const diagnostics = [];

  const rawThread = raw || thread;
  const pathInfo = rawThread.sourcePaths || {};
  const processRows = Array.isArray(rawThread.processRows) ? rawThread.processRows : [];

  if (rawThread.sessionSummary?.taskCompleteAt) {
    timeline.push({
      kind: "transcript_event",
      at: rawThread.sessionSummary.taskCompleteAt,
      label: "Task complete",
      message: "Task completion was observed in transcript events.",
    });
  }

  if (rawThread.sessionSummary?.finalAnswerAt) {
    timeline.push({
      kind: "transcript_event",
      at: rawThread.sessionSummary.finalAnswerAt,
      label: "Final answer",
      message: "Transcript indicates final answer phase activity.",
    });
  }

  for (const row of processRows) {
    timeline.push({
      kind: "process",
      at: row.updatedAt || row.startedAt,
      label: "Process activity",
      message: `${row.alive ? "Active process" : "Process observed"} for thread (${row.command || "command"})`,
    });
  }

  if (rawThread.goal) {
    timeline.push({
      kind: "goal_state",
      at: rawThread.goal.updatedAt,
      label: "Goal state",
      message: rawThread.goal.status || "goal update",
    });
  }

  sources.push(
    {
      kind: "session_index",
      available: Boolean(rawThread.sourcePaths?.sessionIndexPath),
      path: rawThread.sourcePaths?.sessionIndexPath || null,
    },
    {
      kind: "session_file",
      available: Boolean(rawThread.sessionFile || rawThread.sessionSummary?.filePath),
      path: rawThread.sessionFile || rawThread.sessionSummary?.filePath || null,
    },
    {
      kind: "process_manager",
      available: Boolean(pathInfo.processManagerPath),
      path: pathInfo.processManagerPath || null,
    },
    {
      kind: "state_sqlite",
      available: Boolean(pathInfo.stateDbPath),
      path: pathInfo.stateDbPath || null,
    },
    {
      kind: "goal_sqlite",
      available: Boolean(pathInfo.goalsDbPath),
      path: pathInfo.goalsDbPath || null,
    },
    {
      kind: "global_state",
      available: Boolean(pathInfo.globalStatePath),
      path: pathInfo.globalStatePath || null,
    }
  );

  if (!thread.activityAt) diagnostics.push({ level: "warning", code: "missing_activity", message: "No recent activity timestamp was available." });
  if (thread.confidence === "low") diagnostics.push({ level: "warning", code: "low_confidence", message: "Status inference is low confidence." });
  if (rawThread.missingLocalState) diagnostics.push({ level: "warning", code: "missing_local_state", message: "Some local sources were unavailable when classifying this thread." });
  if (rawThread.riskSignal) diagnostics.push({ level: "info", code: "risk_signal", message: "One or more risk signals are present." });

  const evidence = Array.isArray(thread.evidence) ? thread.evidence : [];
  return {
    thread: {
      ...thread,
      source: rawThread.sourcePaths ? pathInfo : {},
    },
    timeline,
    sources,
    diagnostics,
    actions: {
      canOpen: true,
      canMarkRead: true,
      canTag: true,
      canPin: false,
    },
    evidence,
    generatedAt: now.toISOString(),
    codexHome,
  };
}

module.exports = {
  buildV2SnapshotFromFixtures,
  buildV2SnapshotFromThreads,
  sortByAttention,
  buildV2ThreadDetail,
};
