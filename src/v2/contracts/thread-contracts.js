const THREAD_STATUSES = Object.freeze({
  RUNNING: "running",
  STALE_RUNNING: "stale_running",
  NEEDS_ATTENTION: "needs_attention",
  RECENTLY_COMPLETED: "recently_completed",
  RECENT: "recent",
  QUIET: "quiet",
  UNKNOWN: "unknown",
});

const CONFIDENCE_LEVELS = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

const ATTENTION_REASONS = Object.freeze({
  ACTIVE_PROCESS: "active process",
  STALE_PROCESS: "stale running thread",
  UNREAD_RESPONSE: "new assistant response",
  RECENT_COMPLETION: "recent task completion",
  FRESH_ACTIVITY: "fresh transcript activity",
  MANUAL_TAG: "manual tag: needs review",
  QUIET_DONE: "quiet done work",
  INSUFFICIENT_STATE: "insufficient local state",
});

const ATTENTION_RANK = Object.freeze({
  [THREAD_STATUSES.RUNNING]: 120,
  [THREAD_STATUSES.STALE_RUNNING]: 100,
  [THREAD_STATUSES.NEEDS_ATTENTION]: 90,
  [THREAD_STATUSES.RECENTLY_COMPLETED]: 70,
  [THREAD_STATUSES.RECENT]: 60,
  [THREAD_STATUSES.QUIET]: 30,
  [THREAD_STATUSES.UNKNOWN]: 10,
});

const CLASSIFIER_WINDOWS = Object.freeze({
  runningStaleMs: 15 * 60 * 1000,
  recentlyCompletedMs: 10 * 60 * 1000,
  recentMs: 120 * 60 * 1000,
});

const EVIDENCE_KINDS = Object.freeze({
  PROCESS: "process",
  TRANSCRIPT_EVENT: "transcript_event",
  SESSION_INDEX: "session_index",
  GLOBAL_STATE: "global_state",
  SIDECAR_TAG: "sidecar_tag",
  DIAGNOSTIC_WARNING: "diagnostic_warning",
});

const ATTENTION_REASON_ENUM = Object.freeze({
  ACTIVE_PROCESS: ATTENTION_REASONS.ACTIVE_PROCESS,
  STALE_PROCESS: ATTENTION_REASONS.STALE_PROCESS,
  UNREAD_RESPONSE: ATTENTION_REASONS.UNREAD_RESPONSE,
  RECENT_COMPLETION: ATTENTION_REASONS.RECENT_COMPLETION,
  FRESH_ACTIVITY: ATTENTION_REASONS.FRESH_ACTIVITY,
  MANUAL_TAG: ATTENTION_REASONS.MANUAL_TAG,
  QUIET_DONE: ATTENTION_REASONS.QUIET_DONE,
  INSUFFICIENT_STATE: ATTENTION_REASONS.INSUFFICIENT_STATE,
});

const STATUS_EVIDENCE = Object.freeze({
  KINDS: EVIDENCE_KINDS,
  TEMPLATE: {
    kind: "",
    source: "",
    observedAt: null,
    message: "",
  },
});

const THREAD_SUMMARY_TEMPLATE = Object.freeze({
  id: "",
  title: "",
  workspace: null,
  workspaceLabel: "unknown",
  status: THREAD_STATUSES.UNKNOWN,
  statusLabel: "Unknown",
  attentionRank: ATTENTION_RANK[THREAD_STATUSES.UNKNOWN],
  attentionReason: ATTENTION_REASONS.INSUFFICIENT_STATE,
  confidence: CONFIDENCE_LEVELS.LOW,
  activityAt: null,
  activityAgeMs: null,
  threadSource: "main",
  parentThreadId: null,
  badges: [],
  tags: [],
  openUrl: "",
  evidence: [],
});

const THREAD_DETAIL_TEMPLATE = Object.freeze({
  thread: { ...THREAD_SUMMARY_TEMPLATE },
  timeline: [],
  sources: [],
  diagnostics: [],
  actions: {
    canOpen: true,
    canMarkRead: true,
    canTag: true,
    canPin: false,
  },
});

function normalizeArray(value, maxLength = null) {
  const max = maxLength == null ? -1 : maxLength;
  const items = Array.isArray(value) ? value : [];
  return max >= 0 ? items.slice(0, max) : [...items];
}

function toStatusLabel(status) {
  const normalized = String(status || "").toLowerCase().replace(/_/g, " ");
  return normalized
    .split(" ")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function makeStatusEvidence({ kind, source, observedAt, message }) {
  return {
    kind,
    source: source || "",
    observedAt: observedAt || null,
    message: message || "",
  };
}

function makeThreadSummary(values = {}) {
  const summary = { ...THREAD_SUMMARY_TEMPLATE };
  return {
    ...summary,
    ...values,
    badges: normalizeArray(values.badges, 12),
    tags: normalizeArray(values.tags, 12),
    evidence: normalizeArray(values.evidence, 32),
  };
}

function makeThreadDetail(values = {}) {
  const base = { ...THREAD_DETAIL_TEMPLATE };
  const thread = makeThreadSummary(values.thread || {});
  return {
    ...base,
    ...values,
    thread,
    timeline: normalizeArray(values.timeline),
    sources: normalizeArray(values.sources),
    diagnostics: normalizeArray(values.diagnostics),
    actions: values.actions || base.actions,
  };
}

module.exports = {
  THREAD_STATUSES,
  CONFIDENCE_LEVELS,
  ATTENTION_REASON_ENUM,
  ATTENTION_REASONS,
  ATTENTION_RANK,
  CLASSIFIER_WINDOWS,
  EVIDENCE_KINDS,
  STATUS_EVIDENCE,
  THREAD_SUMMARY_TEMPLATE,
  THREAD_DETAIL_TEMPLATE,
  toStatusLabel,
  makeStatusEvidence,
  makeThreadSummary,
  makeThreadDetail,
};
