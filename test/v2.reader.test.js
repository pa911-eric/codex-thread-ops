const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { enrichThreadsWithTags, readV2RawThreads } = require("../src/v2/codex-state/reader");

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function createV2ReaderFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-v2-reader-"));
  const codexHome = path.join(tempRoot, ".codex");
  const now = new Date("2026-06-26T12:00:00.000Z");
  const older = new Date(now.getTime() - 3 * 60_000).toISOString();
  const latest = new Date(now.getTime() - 30_000).toISOString();

  await writeJsonl(path.join(codexHome, "session_index.jsonl"), [
    {
      id: "11111111-1111-4111-8111-111111111111",
      thread_name: "Reader thread",
      approvalMode: "on-request",
      cwd: "C:\\reader\\thread",
      updated_at: older,
    },
  ]);

  await writeJsonl(path.join(codexHome, "sessions", "2026", "06", "26", "11111111-1111-4111-8111-111111111111.jsonl"), [
    { timestamp: older, payload: { type: "message", role: "user", content: "check" } },
    { timestamp: latest, payload: { type: "message", role: "assistant", phase: "final_answer" } },
    { type: "event_msg", payload: { type: "task_complete" }, timestamp: now.toISOString() },
  ]);

  await writeJsonl(path.join(codexHome, "process_manager", "chat_processes.json"), [
    {
      conversationId: "11111111-1111-4111-8111-111111111111",
      command: "npm start",
      osPid: process.pid,
      startedAtMs: older,
      updatedAtMs: latest,
    },
  ]);

  await writeJson(path.join(codexHome, ".codex-global-state.json"), {
    "unread-thread-ids": ["11111111-1111-4111-8111-111111111111"],
    "thread-workspace-root-hints": {
      "11111111-1111-4111-8111-111111111111": "C:\\reader\\hint",
    "unknown-id": "ignored",
    "not-an-id": "ignored",
  },
  });

  return { codexHome, tempRoot, now };
}

test("readV2RawThreads normalizes local sources and evidence inputs", async (t) => {
  const fixture = await createV2ReaderFixture();
  t.after(async () => {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  const payload = await readV2RawThreads(fixture.codexHome, { now: fixture.now });
  assert.equal(payload.threads.length, 1);
  assert.equal(payload.threads[0].id, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.threads[0].workspace, "C:\\reader\\hint");
  assert.equal(payload.threads[0].hasUnread, true);
  assert.equal(payload.threads[0].threadSource, "main");
  assert.equal(payload.threads[0].sessionSummary.filePath.endsWith(".jsonl"), true);
  assert.equal(Array.isArray(payload.threads[0].processRows), true);
  if (payload.threads[0].processRows.length) {
    assert.equal(payload.threads[0].processRows[0].command, "npm start");
  }
  assert.equal(payload.threads[0].sourcePaths.sessionManagerPath || payload.threads[0].sourcePaths.processManagerPath, path.join(fixture.codexHome, "process_manager", "chat_processes.json"));
  assert.equal(payload.threads[0].sessionSummary.taskCompleteAt, fixture.now.toISOString());
});

test("readV2RawThreads enriches warning state for missing local inputs", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-v2-reader-empty-"));
  const codexHome = path.join(tempRoot, ".codex");
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const payload = await readV2RawThreads(codexHome);
  assert.equal(payload.threads.length, 0);
  assert.equal(payload.warnings.length > 0, true);
  assert.equal(payload.sources.source, "none");
});

test("enrichThreadsWithTags normalizes and merges tag sidecar records", () => {
  const threads = [
    { id: "11111111-1111-4111-8111-111111111111", tags: ["Need Review", "agent"], threadSource: "main" },
    { id: "22222222-2222-4222-8222-222222222222", threadSource: "main" },
  ];
  const byThread = {
    "11111111-1111-4111-8111-111111111111": ["Needs Review", "needs-review", "AgentQueue"],
    invalid: ["bad"],
    "22222222-2222-4222-8222-222222222222": ["api", " api"],
  };

  const enriched = enrichThreadsWithTags(threads, byThread);
  assert.deepEqual(enriched[0].tags, ["needs-review", "agentqueue"]);
  assert.equal(enriched[0].hasAttentionTag, true);
  assert.deepEqual(enriched[1].tags, ["api"]);
  assert.equal(enriched[1].hasAttentionTag, false);
});
