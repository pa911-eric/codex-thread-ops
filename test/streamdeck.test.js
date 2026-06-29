const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ACTIONS,
  buildKeyState,
  pickMostRecentThread,
  renderKeySvg,
  summarizeSnapshot,
} = require("../streamdeck/com.pa911.agentqueue.sdPlugin/bin/common");

const snapshot = {
  summary: {
    counts: {
      running: 2,
      complete: 1,
      recent: 3,
    },
    unread: 4,
  },
  threads: [
    { id: "older-running", name: "Older Running", status: "running", activityAt: "2026-06-29T10:00:00.000Z" },
    { id: "newer-running", name: "Newer Running", status: "running", activityAt: "2026-06-29T11:00:00.000Z" },
    { id: "complete", name: "Complete Thread", status: "complete", activityAt: "2026-06-29T12:00:00.000Z" },
  ],
};

test("Stream Deck summary maps AgentQueue snapshot counts", () => {
  const summary = summarizeSnapshot(snapshot);
  assert.deepEqual(summary.counts, {
    running: 2,
    complete: 1,
    recent: 3,
    unread: 4,
  });
});

test("Stream Deck open action chooses newest matching thread", () => {
  const thread = pickMostRecentThread(snapshot, "running");
  assert.equal(thread.id, "newer-running");
});

test("Stream Deck key renderer creates offline and count states", () => {
  const count = buildKeyState(ACTIONS.runningCount, snapshot, { connected: true });
  assert.equal(count.label, "Running");
  assert.equal(count.value, "2");
  assert.match(renderKeySvg(count), /Running/);

  const offline = buildKeyState(ACTIONS.unreadCount, snapshot, { connected: false, error: "offline" });
  assert.equal(offline.value, "OFF");
  assert.match(renderKeySvg(offline), /offline/);
});
