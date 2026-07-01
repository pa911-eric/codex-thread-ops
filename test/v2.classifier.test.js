const assert = require("node:assert/strict");
const test = require("node:test");

const { getV2ThreadFixtures } = require("../src/v2/fixtures/thread-fixtures");
const {
  classifyThreads,
  summarizeThreadSummaries,
} = require("../src/v2/classifier/thread-classifier");
const { buildV2SnapshotFromFixtures } = require("../src/v2/api/snapshot");

const now = new Date("2026-06-26T12:00:00.000Z");
const fixtures = getV2ThreadFixtures(now);

test("classifies V2 fixture thread statuses, ranks, and confidence", () => {
  const summaries = classifyThreads(fixtures, { now });
  const byId = Object.fromEntries(summaries.map((row) => [row.id, row]));

  assert.equal(byId["11111111-1111-4111-8111-111111111111"].status, "running");
  assert.equal(byId["11111111-1111-4111-8111-111111111111"].confidence, "high");
  assert.equal(byId["11111111-1111-4111-8111-111111111111"].attentionReason, "active process");
  assert.equal(byId["11111111-1111-4111-8111-111111111111"].evidence.some((item) => item.kind === "process"), true);

  assert.equal(byId["22222222-2222-4222-8222-222222222222"].status, "stale_running");
  assert.equal(byId["22222222-2222-4222-8222-222222222222"].confidence, "high");
  assert.equal(byId["22222222-2222-4222-8222-222222222222"].attentionReason, "stale running thread");

  assert.equal(byId["33333333-3333-4333-8333-333333333333"].status, "recently_completed");
  assert.equal(byId["33333333-3333-4333-8333-333333333333"].attentionReason, "recent task completion");
  assert.equal(byId["33333333-3333-4333-8333-333333333333"].evidence.some((item) => item.kind === "transcript_event"), true);

  assert.equal(byId["44444444-4444-4444-8444-444444444444"].status, "needs_attention");
  assert.equal(byId["44444444-4444-4444-8444-444444444444"].attentionReason, "new assistant response");
  assert.equal(byId["44444444-4444-4444-8444-444444444444"].confidence, "high");

  assert.equal(byId["55555555-5555-4555-8555-555555555555"].status, "quiet");
  assert.equal(byId["55555555-5555-4555-8555-555555555555"].attentionReason, "quiet done work");

  assert.equal(byId["66666666-6666-4666-8666-666666666666"].status, "unknown");
  assert.equal(byId["66666666-6666-4666-8666-666666666666"].confidence, "low");
  assert.equal(byId["66666666-6666-4666-8666-666666666666"].evidence.some((item) => item.kind === "diagnostic_warning"), true);
});

test("summarizes and orders V2 snapshots by attention rank", () => {
  const snapshot = buildV2SnapshotFromFixtures({ now, codexHome: "C:\\Users\\EricL\\.codex" });

  assert.equal(snapshot.summary.total, 6);
  assert.equal(snapshot.summary.running, 1);
  assert.equal(snapshot.summary.stale, 1);
  assert.equal(snapshot.summary.needsAttention, 1);
  assert.equal(snapshot.summary.risk, 1);
  assert.equal(snapshot.health.level, "warn");
  assert.ok(snapshot.threads.length > 0);

  assert.equal(snapshot.threads[0].status, "running");
  assert.equal(snapshot.threads[snapshot.threads.length - 1].status, "unknown");

  const badOrder = snapshot.threads.some((thread, index, list) => index > 0 && thread.attentionRank > list[index - 1].attentionRank);
  assert.equal(badOrder, false);
});
