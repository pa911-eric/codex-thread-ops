const assert = require("node:assert/strict");
const test = require("node:test");

const {
  makeThreadDetail,
  makeStatusEvidence,
  makeThreadSummary,
  THREAD_SUMMARY_TEMPLATE,
} = require("../src/v2/contracts/thread-contracts");

test("Thread contract helpers keep required fields and normalize arrays", () => {
  const summary = makeThreadSummary({
    id: "11111111-1111-4111-8111-111111111111",
    title: "Contract test",
    status: "running",
    threadSource: "main",
    statusLabel: "Running",
    attentionRank: 42,
    attentionReason: "active process",
    confidence: "high",
    evidence: [makeStatusEvidence({ kind: "process", source: "fixture", observedAt: "2026-06-26T00:00:00.000Z", message: "Evidence" })],
  });

  assert.equal(summary.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(summary.status, "running");
  assert.equal(summary.threadSource, "main");
  assert.equal(summary.badges.length, 0);
  assert.equal(summary.evidence.length, 1);
  assert.equal(summary.activityAgeMs, THREAD_SUMMARY_TEMPLATE.activityAgeMs);
  assert.equal(typeof summary.id, "string");
});

test("makeThreadDetail merges thread summary and detail sections with defaults", () => {
  const detail = makeThreadDetail({
    thread: {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Contract test",
      status: "running",
      statusLabel: "Running",
      threadSource: "main",
      confidence: "high",
      attentionRank: 100,
      attentionReason: "active process",
    },
    timeline: [{ kind: "process", at: "2026-06-26T00:00:00.000Z", label: "Process", message: "ok" }],
    sources: [{ kind: "session_file", available: true, path: "/tmp/session_index.jsonl" }],
    diagnostics: [{ level: "info", code: "fixture", message: "fixture-only test" }],
    actions: { canOpen: true, canMarkRead: true, canTag: true, canPin: false },
  });

  assert.equal(detail.thread.id, "11111111-1111-4111-8111-111111111111");
  assert.equal(detail.timeline.length, 1);
  assert.equal(detail.sources.length, 1);
  assert.equal(detail.diagnostics.length, 1);
  assert.equal(detail.actions.canOpen, true);
  assert.equal(detail.actions.canTag, true);
});
