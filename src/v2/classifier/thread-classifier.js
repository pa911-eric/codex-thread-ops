const path = require("node:path");
const {
  ATTENTION_RANK,
  ATTENTION_REASONS,
  CLASSIFIER_WINDOWS,
  CONFIDENCE_LEVELS,
  EVIDENCE_KINDS,
  THREAD_STATUSES,
  makeStatusEvidence,
  makeThreadSummary,
  toStatusLabel,
} = require("../contracts/thread-contracts");

function toMillis(value) {
  if (value == null || value === "") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function latestAt(...values) {
  return values.reduce((chosen, candidate) => {
    if (!Number.isFinite(candidate)) return chosen;
    return chosen == null || candidate > chosen ? candidate : chosen;
  }, null);
}

function deriveWorkspaceLabel(workspace, workspaceLabel) {
  if (typeof workspaceLabel === "string" && workspaceLabel.trim()) return workspaceLabel.trim();
  if (typeof workspace !== "string" || !workspace.trim()) return "unknown";
  return path.basename(workspace);
}

function pushEvidence(evidence, item) {
  if (!item) return;
  evidence.push(makeStatusEvidence(item));
}

function classifyThread(raw, now = new Date(), windows = CLASSIFIER_WINDOWS) {
  const referenceAt = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const processUpdatedAt = toMillis(raw.processUpdatedAt);
  const activityAt = toMillis(raw.activityAt);
  const completionAt = toMillis(raw.completionAt);
  const indexUpdatedAt = toMillis(raw.indexUpdatedAt);
  const latestActivityAt = latestAt(processUpdatedAt, activityAt, completionAt, indexUpdatedAt);
  const evidence = [];
  const badges = [];
  const hasUnread = Boolean(raw.hasUnread);
  const hasAttentionTag = Boolean(raw.hasAttentionTag) || (Array.isArray(raw.tags) && raw.tags.includes("needs-review"));
  const hasRiskSignal = Boolean(raw.riskSignal);
  const hasMissingData = Boolean(raw.missingLocalState);
  let status = THREAD_STATUSES.UNKNOWN;
  let confidence = CONFIDENCE_LEVELS.LOW;
  let attentionReason = ATTENTION_REASONS.INSUFFICIENT_STATE;
  let rank = ATTENTION_RANK[THREAD_STATUSES.UNKNOWN];

  if (processUpdatedAt != null) {
    const isFresh = referenceAt - processUpdatedAt <= windows.runningStaleMs;
    const observedAt = new Date(processUpdatedAt).toISOString();
    pushEvidence(evidence, {
      kind: EVIDENCE_KINDS.PROCESS,
      source: "process_manager/chat_processes.json",
      observedAt,
      message: "Live thread process is currently tracked in process manager metadata.",
    });

    status = isFresh ? THREAD_STATUSES.RUNNING : THREAD_STATUSES.STALE_RUNNING;
    attentionReason = isFresh ? ATTENTION_REASONS.ACTIVE_PROCESS : ATTENTION_REASONS.STALE_PROCESS;
    confidence = CONFIDENCE_LEVELS.HIGH;
    rank = ATTENTION_RANK[status];
  } else if (completionAt != null && referenceAt - completionAt <= windows.recentlyCompletedMs) {
    const observedAt = new Date(completionAt).toISOString();
    pushEvidence(evidence, {
      kind: EVIDENCE_KINDS.TRANSCRIPT_EVENT,
      source: "session events",
      observedAt,
      message: "Recent task completion event was observed in transcript history.",
    });

    status = THREAD_STATUSES.RECENTLY_COMPLETED;
    attentionReason = ATTENTION_REASONS.RECENT_COMPLETION;
    confidence = CONFIDENCE_LEVELS.HIGH;
    rank = ATTENTION_RANK[status];
  } else if (hasUnread || hasAttentionTag || hasRiskSignal) {
    if (hasUnread) {
      pushEvidence(evidence, {
        kind: EVIDENCE_KINDS.GLOBAL_STATE,
        source: ".codex-global-state.json",
        observedAt: new Date(referenceAt).toISOString(),
        message: "Unread marker or explicit user attention signal is present in local state.",
      });
    }
    if (hasAttentionTag) {
      pushEvidence(evidence, {
        kind: EVIDENCE_KINDS.SIDECAR_TAG,
        source: "agentqueue-tags.json",
        observedAt: new Date(referenceAt).toISOString(),
        message: "Attention tag indicates review is needed.",
      });
    }
    if (hasRiskSignal) {
      pushEvidence(evidence, {
        kind: EVIDENCE_KINDS.DIAGNOSTIC_WARNING,
        source: "risk_signal",
        observedAt: new Date(referenceAt).toISOString(),
        message: "Risk signal reported from local classification inputs.",
      });
    }

    status = THREAD_STATUSES.NEEDS_ATTENTION;
    attentionReason = hasUnread ? ATTENTION_REASONS.UNREAD_RESPONSE : ATTENTION_REASONS.MANUAL_TAG;
    confidence = hasUnread ? CONFIDENCE_LEVELS.HIGH : CONFIDENCE_LEVELS.MEDIUM;
    rank = ATTENTION_RANK[status];
  } else if (activityAt != null && referenceAt - activityAt <= windows.recentMs) {
    const observedAt = new Date(activityAt).toISOString();
    pushEvidence(evidence, {
      kind: EVIDENCE_KINDS.TRANSCRIPT_EVENT,
      source: "session_index.jsonl",
      observedAt,
      message: "Recent transcript activity indicates thread is active.",
    });

    status = THREAD_STATUSES.RECENT;
    attentionReason = ATTENTION_REASONS.FRESH_ACTIVITY;
    confidence = CONFIDENCE_LEVELS.MEDIUM;
    rank = ATTENTION_RANK[status];
  } else if (completionAt != null || activityAt != null || indexUpdatedAt != null) {
    const source = completionAt != null ? "task_complete" : indexUpdatedAt != null ? "session_index.jsonl" : "session event";
    const observedAt = new Date(latestActivityAt).toISOString();
    pushEvidence(evidence, {
      kind: EVIDENCE_KINDS.SESSION_INDEX,
      source,
      observedAt,
      message: "Thread shows older terminal activity but no recent action.",
    });

    status = THREAD_STATUSES.QUIET;
    attentionReason = ATTENTION_REASONS.QUIET_DONE;
    confidence = completionAt != null ? CONFIDENCE_LEVELS.MEDIUM : CONFIDENCE_LEVELS.LOW;
    rank = ATTENTION_RANK[status];
  } else {
    status = THREAD_STATUSES.UNKNOWN;
    attentionReason = ATTENTION_REASONS.INSUFFICIENT_STATE;
    rank = ATTENTION_RANK[status];
    confidence = CONFIDENCE_LEVELS.LOW;
  }

  if (hasMissingData) {
    pushEvidence(evidence, {
      kind: EVIDENCE_KINDS.DIAGNOSTIC_WARNING,
      source: "thread fixture",
      observedAt: new Date(referenceAt).toISOString(),
      message: "Local state is incomplete; some signals are unavailable.",
    });

    if (status === THREAD_STATUSES.QUIET) {
      confidence = CONFIDENCE_LEVELS.LOW;
    } else if (status === THREAD_STATUSES.RECENTLY_COMPLETED) {
      confidence = CONFIDENCE_LEVELS.MEDIUM;
    }
  }

  if (status === THREAD_STATUSES.RUNNING) {
    badges.push("running");
  } else if (status === THREAD_STATUSES.STALE_RUNNING) {
    badges.push("stale");
  } else if (status === THREAD_STATUSES.NEEDS_ATTENTION) {
    badges.push("needs-attention");
  } else if (status === THREAD_STATUSES.RECENTLY_COMPLETED) {
    badges.push("completion");
  } else if (status === THREAD_STATUSES.RECENT) {
    badges.push("recent");
  } else if (status === THREAD_STATUSES.QUIET) {
    badges.push("done");
  } else {
    badges.push("unknown");
  }

  if (hasUnread) badges.push("unread");
  if (hasRiskSignal) badges.push("risk");
  if (raw.threadSource === "subagent") badges.push("subagent");
  if (hasMissingData) badges.push("missing");
  if (raw.parentThreadId) badges.push("child");

  return makeThreadSummary({
    id: raw.id,
    title: raw.title || "Untitled thread",
    workspace: raw.workspace || null,
    workspaceLabel: deriveWorkspaceLabel(raw.workspace, raw.workspaceLabel),
    status,
    statusLabel: toStatusLabel(status),
    attentionRank: rank,
    attentionReason,
    confidence,
    activityAt: latestActivityAt ? new Date(latestActivityAt).toISOString() : null,
    activityAgeMs: latestActivityAt == null ? null : referenceAt - latestActivityAt,
    threadSource: raw.threadSource || "main",
    parentThreadId: raw.parentThreadId || null,
    badges,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    openUrl: `codex://threads/${raw.id}`,
    evidence,
  });
}

function summarizeThreadSummaries(summaries) {
  const summary = {
    total: summaries.length,
    running: 0,
    stale: 0,
    needsAttention: 0,
    unread: 0,
    risk: 0,
  };

  for (const thread of summaries) {
    if (thread.status === THREAD_STATUSES.RUNNING) summary.running += 1;
    if (thread.status === THREAD_STATUSES.STALE_RUNNING) summary.stale += 1;
    if (thread.status === THREAD_STATUSES.NEEDS_ATTENTION) summary.needsAttention += 1;
    if (thread.badges.includes("unread")) summary.unread += 1;
    if (thread.badges.includes("risk")) summary.risk += 1;
  }

  return summary;
}

function classifyThreads(rawThreads, options = {}) {
  const now = options.now || new Date();
  const windows = options.windows || CLASSIFIER_WINDOWS;
  return rawThreads.map((raw) => classifyThread(raw, now, windows));
}

module.exports = {
  classifyThread,
  classifyThreads,
  summarizeThreadSummaries,
};
