const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readThreadTagsForThread,
  readTagsByThread,
  setThreadTags,
} = require("../src/v2/store/tags");

const { patchPreferences, readPreferences } = require("../src/v2/store/preferences");

async function createCodexHome() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-v2-store-"));
  const codexHome = path.join(tempRoot, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  return { tempRoot, codexHome };
}

test("thread tag sidecar stores clean values and supports replacement", async (t) => {
  const fixture = await createCodexHome();
  t.after(async () => {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  const threadId = "11111111-1111-4111-8111-111111111111";
  const result = await setThreadTags(fixture.codexHome, threadId, ["Needs Review", "bad tag!!", "Needs Review"]);
  assert.equal(Array.isArray(result.tags), true);
  assert.deepEqual(result.tags, ["needs-review", "bad-tag"]);

  const all = await readTagsByThread(fixture.codexHome);
  assert.deepEqual(all[threadId], ["needs-review", "bad-tag"]);

  const single = await readThreadTagsForThread(fixture.codexHome, threadId);
  assert.deepEqual(single, ["needs-review", "bad-tag"]);
});

test("preferences store writes and validates updates", async (t) => {
  const fixture = await createCodexHome();
  t.after(async () => {
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  const defaults = await readPreferences(fixture.codexHome);
  assert.equal(defaults.version, "v2");
  assert.equal(defaults.monitorView, "list");

  const updated = await patchPreferences(fixture.codexHome, { focusNeedsAttention: false });
  assert.equal(updated.focusNeedsAttention, false);
  assert.equal(updated.hideDone, false);
  assert.equal(updated.monitorView, "list");

  const refreshed = await readPreferences(fixture.codexHome);
  assert.equal(refreshed.focusNeedsAttention, false);

  await assert.rejects(() => patchPreferences(fixture.codexHome, { bad: true }), /Unsupported preference/);
  await assert.rejects(() => patchPreferences(fixture.codexHome, {}), /No supported preferences were provided/);
});
