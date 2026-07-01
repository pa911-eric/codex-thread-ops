const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const threadId = "11111111-1111-4111-8111-111111111111";
const secondThreadId = "22222222-2222-4222-8222-222222222222";
const hiddenCodexThreadId = "44444444-4444-4444-8444-444444444444";

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonl(filePath, rows) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

async function createCodexFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-api-"));
  const codexHome = path.join(tempRoot, ".codex");
  const now = new Date();
  const earlier = new Date(now.getTime() - 60_000).toISOString();
  const later = now.toISOString();

  await fs.mkdir(path.join(codexHome, "sessions", "2026", "06", "25"), { recursive: true });
  await writeJsonl(path.join(codexHome, "session_index.jsonl"), [
    {
      id: threadId,
      thread_name: "API Test Thread",
      preview: "Build endpoint tests",
      cwd: tempRoot,
      updated_at: later,
      approvalMode: "on-request",
      tokensUsed: 1200,
    },
    {
      id: secondThreadId,
      thread_name: "Second API Thread",
      preview: "Check state writes",
      cwd: tempRoot,
      updated_at: earlier,
    },
  ]);

  await writeJsonl(path.join(codexHome, "sessions", "2026", "06", "25", `${threadId}.jsonl`), [
    { timestamp: earlier, payload: { type: "message", role: "user", content: "Please test the API." } },
    { timestamp: later, payload: { type: "function_call", name: "shell" } },
    {
      timestamp: later,
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 12, resets_at: Math.floor((Date.now() + 3600_000) / 1000), window_minutes: 300 },
        },
      },
    },
  ]);

  await writeJson(path.join(codexHome, ".codex-global-state.json"), {
    "unread-thread-ids": [threadId, secondThreadId],
    "pinned-thread-ids": [secondThreadId],
    "projectless-thread-ids": [],
    "electron-persisted-atom-state": {
      "prompt-history": { [threadId]: ["Please test the API."] },
      "thread-workspace-root-hints": { [threadId]: tempRoot },
      "unread-thread-ids-by-host-v1": { local: [hiddenCodexThreadId] },
    },
  });
  await writeJson(path.join(codexHome, "agentqueue-tags.json"), { [threadId]: ["api"] });
  await writeJson(path.join(codexHome, "process_manager", "chat_processes.json"), [
    {
      conversationId: threadId,
      command: "npm start",
      osPid: process.pid,
      startedAtMs: Date.now() - 5_000,
      updatedAtMs: Date.now(),
    },
  ]);

  return {
    tempRoot,
    codexHome,
    installMetadataPath: path.join(tempRoot, ".agentqueue-install.json"),
    env: { CODEX_HOME: codexHome, AGENTQUEUE_PROVIDER: "codex" },
  };
}

const claudeThreadId = "33333333-3333-4333-8333-333333333333";
const copilotThreadId = "55555555-5555-4555-8555-555555555555";

async function createClaudeFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-claude-"));
  const claudeHome = path.join(tempRoot, ".claude");
  const now = Date.now();
  const earlier = new Date(now - 120_000).toISOString();
  const mid = new Date(now - 60_000).toISOString();
  const later = new Date(now).toISOString();
  const projectDir = path.join(claudeHome, "projects", "-tmp-project");

  await writeJsonl(path.join(projectDir, `${claudeThreadId}.jsonl`), [
    { type: "queue-operation", operation: "enqueue", timestamp: earlier, sessionId: claudeThreadId, content: "Build the thing" },
    {
      type: "user",
      isSidechain: false,
      message: { role: "user", content: "Build the thing" },
      uuid: "u1",
      timestamp: earlier,
      cwd: tempRoot,
      gitBranch: "main",
      version: "2.1.0",
      permissionMode: "auto",
      sessionId: claudeThreadId,
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000 },
        content: [{ type: "text", text: "Working on it" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
      uuid: "a1",
      timestamp: mid,
      sessionId: claudeThreadId,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      uuid: "u2",
      timestamp: mid,
      sessionId: claudeThreadId,
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        model: "claude-opus-4-8",
        stop_reason: "end_turn",
        usage: { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 1200 },
        content: [{ type: "text", text: "Done" }],
      },
      uuid: "a2",
      timestamp: later,
      sessionId: claudeThreadId,
    },
  ]);

  return {
    tempRoot,
    claudeHome,
    installMetadataPath: path.join(tempRoot, ".agentqueue-install.json"),
    env: { CLAUDE_HOME: claudeHome, AGENTQUEUE_PROVIDER: "claude" },
  };
}

async function createCopilotFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-copilot-"));
  const copilotHome = path.join(tempRoot, ".copilot");
  const now = Date.now();
  const earlier = new Date(now - 90_000).toISOString();
  const later = new Date(now).toISOString();
  const sessionDir = path.join(copilotHome, "session-state", copilotThreadId);

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "workspace.yaml"), [
    `id: ${copilotThreadId}`,
    `cwd: ${tempRoot}`,
    "client_name: github/autopilot",
    "name: Copilot API Thread",
    "user_named: true",
    `created_at: ${earlier}`,
    `updated_at: ${later}`,
    "",
  ].join("\n"), "utf8");
  await writeJsonl(path.join(sessionDir, "events.jsonl"), [
    {
      type: "session.start",
      data: {
        sessionId: copilotThreadId,
        copilotVersion: "1.0.65",
        startTime: earlier,
        selectedModel: "gpt-5.3-codex",
        context: { cwd: tempRoot },
      },
      id: "s1",
      timestamp: earlier,
    },
    {
      type: "user.message",
      data: { content: "Build the Copilot thing" },
      id: "u1",
      timestamp: earlier,
    },
    {
      type: "tool.execution_start",
      data: { toolCallId: "t1", name: "powershell" },
      id: "t1",
      timestamp: later,
    },
    {
      type: "tool.execution_complete",
      data: { toolCallId: "t1", name: "powershell", success: true },
      id: "t2",
      timestamp: later,
    },
    {
      type: "assistant.message",
      data: { model: "gpt-5.3-codex", content: "Done", outputTokens: 42 },
      id: "a1",
      timestamp: later,
    },
  ]);

  return {
    tempRoot,
    copilotHome,
    installMetadataPath: path.join(tempRoot, ".agentqueue-install.json"),
    env: { COPILOT_HOME: copilotHome, AGENTQUEUE_PROVIDER: "copilot" },
  };
}

async function createMixedFixture() {
  const codex = await createCodexFixture();
  const claude = await createClaudeFixture();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentqueue-mixed-"));
  return {
    codex,
    claude,
    installMetadataPath: codex.installMetadataPath,
    env: {
      CODEX_HOME: codex.codexHome,
      CLAUDE_HOME: claude.claudeHome,
      COPILOT_HOME: path.join(tempRoot, ".copilot"),
      AGENTQUEUE_PROVIDER: "",
    },
  };
}

async function startServer(fixture) {
  const child = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      AGENTQUEUE_INSTALL_METADATA: fixture.installMetadataPath,
      AGENTQUEUE_UPDATE_CHECK: "0",
      ...(fixture.env || { CODEX_HOME: fixture.codexHome }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Server did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 10_000);
    child.stdout.on("data", () => {
      const match = stdout.match(/AgentQueue running at (http:\/\/localhost:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });

  return {
    child,
    baseUrl,
    getOutput() {
      return { stdout, stderr };
    },
    async stop() {
      if (child.exitCode != null) return;
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function request(baseUrl, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers, body });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: contentType.includes("application/json") && text ? JSON.parse(text) : null,
  };
}

async function checkedRequest(server, pathname, options = {}) {
  try {
    return await request(server.baseUrl, pathname, options);
  } catch (error) {
    const output = server.getOutput();
    error.message = `${error.message}\nserver stdout:\n${output.stdout}\nserver stderr:\n${output.stderr}`;
    throw error;
  }
}

async function startWebhookReceiver() {
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      json: JSON.parse(body),
    });
    res.writeHead(204);
    res.end();
  });

  await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  return {
    received,
    url: `http://127.0.0.1:${address.port}/hook`,
    close: () => new Promise((resolve) => receiver.close(resolve)),
  };
}

test("AgentQueue API endpoints", async (t) => {
  const fixture = await createCodexFixture();
  const server = await startServer(fixture);
  t.after(async () => {
    await server.stop();
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  await t.test("serves system endpoints and Swagger UI", async () => {
    const health = await checkedRequest(server, "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.codexHome, fixture.codexHome);

    const config = await checkedRequest(server, "/api/config");
    assert.equal(config.status, 200);
    assert.equal(config.json.version, require(path.join(root, "package.json")).version);
    assert.equal(config.json.provider, "codex");

    const sources = await checkedRequest(server, "/api/sources");
    assert.equal(sources.status, 200);
    assert.equal(sources.json.exists.codexHome, true);

    const spec = await checkedRequest(server, "/api/openapi.json");
    assert.equal(spec.status, 200);
    assert.equal(spec.json.openapi, "3.1.0");
    assert.ok(spec.json.paths["/api/threads/{threadId}/state"]);

    const docs = await checkedRequest(server, "/api/docs");
    assert.equal(docs.status, 200);
    assert.match(docs.text, /SwaggerUIBundle/);

    const healthPage = await checkedRequest(server, "/health");
    assert.equal(healthPage.status, 200);
    assert.match(healthPage.text, /AgentQueue Health/);
  });

  await t.test("serves thread, session, event, usage, process, and tag reads", async () => {
    const threads = await checkedRequest(server, "/api/threads");
    assert.equal(threads.status, 200);
    assert.equal(threads.json.summary.total, 2);
    assert.ok(threads.json.threads.some((thread) => thread.id === threadId));

    const thread = await checkedRequest(server, `/api/threads/${threadId}`);
    assert.equal(thread.status, 200);
    assert.equal(thread.json.thread.name, "API Test Thread");
    assert.equal(thread.json.thread.unread, true);

    const missing = await checkedRequest(server, "/api/threads/33333333-3333-4333-8333-333333333333");
    assert.equal(missing.status, 404);

    const session = await checkedRequest(server, `/api/threads/${threadId}/session?tailBytes=4096`);
    assert.equal(session.status, 200);
    assert.match(session.json.text, /Please test the API/);

    const events = await checkedRequest(server, `/api/threads/${threadId}/events?limit=2`);
    assert.equal(events.status, 200);
    assert.equal(events.json.count, 2);

    const usage = await checkedRequest(server, "/api/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.limitId, "codex");

    const processes = await checkedRequest(server, "/api/processes");
    assert.equal(processes.status, 200);
    assert.equal(processes.json.total, 1);
    assert.equal(processes.json.threads[threadId][0].command, "npm start");

    const tags = await checkedRequest(server, "/api/tags");
    assert.equal(tags.status, 200);
    assert.deepEqual(tags.json.threads[threadId], ["api"]);
  });

  await t.test("serves V2 snapshot endpoint", async () => {
    const snapshot = await checkedRequest(server, "/api/v2/snapshot");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.summary.total, 2);
    assert.equal(snapshot.json.health.level, "ok");
    assert.equal(snapshot.json.threads[0].id, "11111111-1111-4111-8111-111111111111");
    assert.equal(snapshot.json.threads[1].status, "needs_attention");
    assert.equal(snapshot.json.summary.stale, 0);
    assert.equal(snapshot.json.summary.needsAttention, 1);
    assert.equal(snapshot.json.summary.unread, 2);
    assert.equal(snapshot.json.summary.risk, 1);
    assert.equal(snapshot.json.threads[0].status, "running");
    assert.equal(snapshot.json.threads[0].evidence.some((item) => item.kind === "process"), true);
    assert.ok(snapshot.json.threads[0].evidence.length > 0);
  });

  await t.test("serves V2 thread detail, tag, read, and preference endpoints", async () => {
    const detail = await checkedRequest(server, `/api/v2/threads/${threadId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.thread.id, threadId);
    assert.equal(detail.json.thread.title, "API Test Thread");
    assert.equal(detail.json.actions.canOpen, true);
    assert.equal(detail.json.actions.canTag, true);
    assert.equal(detail.json.actions.canMarkRead, true);
    assert.equal(detail.json.codexHome, fixture.codexHome);
    assert.equal(detail.json.timeline.some((item) => item.kind === "process"), true);
    assert.equal(detail.json.sources.some((item) => item.path && item.path.includes("session_index.jsonl")), true);

    const setTags = await checkedRequest(server, `/api/v2/threads/${threadId}/tags`, {
      method: "PATCH",
      body: { tags: ["Needs Review", "Needs Review", "api"] },
    });
    assert.equal(setTags.status, 200);
    assert.deepEqual(setTags.json.tags.sort(), ["api", "needs-review"]);

    const markedRead = await checkedRequest(server, `/api/v2/threads/${threadId}/read`, { method: "POST" });
    assert.equal(markedRead.status, 200);
    assert.deepEqual(markedRead.json.markedIds, [threadId]);

    const prefGet = await checkedRequest(server, "/api/v2/preferences");
    assert.equal(prefGet.status, 200);
    assert.equal(prefGet.json.preferences.version, "v2");
    assert.equal(prefGet.json.preferences.monitorView, "list");

    const prefPatch = await checkedRequest(server, "/api/v2/preferences", {
      method: "PATCH",
      body: { focusNeedsAttention: false },
    });
    assert.equal(prefPatch.status, 200);
    assert.equal(prefPatch.json.preferences.focusNeedsAttention, false);
  });

  await t.test("writes thread tags through current and legacy endpoints", async () => {
    const updated = await checkedRequest(server, `/api/threads/${threadId}/tags`, {
      method: "PATCH",
      body: { tags: ["Needs Review", "api", "bad tag!!"] },
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json.tags, ["needs-review", "api", "bad-tag"]);

    const legacy = await checkedRequest(server, "/api/threads/tags", {
      method: "POST",
      body: { threadId, tags: ["legacy"] },
    });
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.json.tags, ["legacy"]);
  });

  await t.test("writes Codex read and supported state flags", async () => {
    const read = await checkedRequest(server, `/api/threads/${secondThreadId}/read`, { method: "POST" });
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.markedIds, [secondThreadId]);
    assert.equal(read.json.removed, 1);

    const legacyRead = await checkedRequest(server, "/api/threads/read", {
      method: "POST",
      body: { threadIds: [secondThreadId] },
    });
    assert.equal(legacyRead.status, 200);
    assert.deepEqual(legacyRead.json.markedIds, [secondThreadId]);
    assert.equal(legacyRead.json.removed, 0);

    const hiddenRead = await checkedRequest(server, "/api/threads/read", {
      method: "POST",
      body: { threadIds: [hiddenCodexThreadId] },
    });
    assert.equal(hiddenRead.status, 200);
    assert.equal(hiddenRead.json.removed, 1);
    const persistedState = JSON.parse(await fs.readFile(path.join(fixture.codexHome, ".codex-global-state.json"), "utf8"));
    assert.deepEqual(persistedState["electron-persisted-atom-state"]["unread-thread-ids-by-host-v1"], { local: [] });

    const state = await checkedRequest(server, `/api/threads/${threadId}/state`, {
      method: "PATCH",
      body: { pinned: true, projectless: true },
    });
    assert.equal(state.status, 200);
    assert.equal(state.json.pinned, true);
    assert.equal(state.json.projectless, true);

    const archived = await checkedRequest(server, `/api/threads/${threadId}/state`, {
      method: "PATCH",
      body: { archived: true },
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.archived, true);

    const archivedSnapshot = await checkedRequest(server, "/api/threads");
    const archivedThread = archivedSnapshot.json.threads.find((item) => item.id === threadId);
    assert.equal(archivedThread.archived, true);
  });

  await t.test("serves integration endpoints", async () => {
    const update = await checkedRequest(server, "/api/update-check");
    assert.equal(update.status, 200);
    assert.equal(update.json.disabled, true);

    const receiver = await startWebhookReceiver();
    try {
      const webhookConfig = await checkedRequest(server, "/api/webhook", {
        method: "PUT",
        body: {
          enabled: true,
          endpoint: receiver.url,
          signingToken: "test-secret",
          includeSubagents: false,
          statuses: { running: true, complete: true, recent: false, today: false, done: false },
          messages: { complete: "Done: {{title}}", default: "{{id}} {{status}}" },
        },
      });
      assert.equal(webhookConfig.status, 200);
      assert.equal(webhookConfig.json.endpoint, receiver.url);
      assert.equal(webhookConfig.json.signingToken, "********");
      assert.equal(webhookConfig.json.statuses.complete, true);

      const savedWebhook = await checkedRequest(server, "/api/webhook");
      assert.equal(savedWebhook.status, 200);
      assert.equal(savedWebhook.json.includeSubagents, false);

      const webhookTest = await checkedRequest(server, "/api/webhook/test", { method: "POST" });
      assert.equal(webhookTest.status, 200);
      assert.equal(webhookTest.json.ok, true);
      assert.equal(receiver.received.length, 1);
      assert.equal(receiver.received[0].method, "POST");
      assert.equal(receiver.received[0].json.event, "thread.webhook_test");
      assert.equal(receiver.received[0].headers["x-agentqueue-event"], "thread.webhook_test");
      const signature = crypto.createHmac("sha256", "test-secret").update(receiver.received[0].body).digest("hex");
      assert.equal(receiver.received[0].headers["x-agentqueue-signature"], `sha256=${signature}`);
    } finally {
      await receiver.close();
    }

    const open = await checkedRequest(server, `/api/threads/${threadId}/open`, {
      method: "POST",
      body: { dryRun: true },
    });
    assert.equal(open.status, 200);
    assert.equal(open.json.opened, false);
    assert.equal(open.json.codexUrl, `codex://threads/${threadId}`);

    const controller = new AbortController();
    const response = await fetch(`${server.baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    controller.abort();
    const chunk = Buffer.from(first.value).toString("utf8");
    assert.match(chunk, /event: snapshot/);
  });

  await t.test("returns method and API not-found errors", async () => {
    const wrongMethod = await checkedRequest(server, "/api/threads", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "GET");

    const missing = await checkedRequest(server, "/api/not-real");
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "API endpoint not found");
  });
});

test("AgentQueue Claude Code provider", async (t) => {
  const fixture = await createClaudeFixture();
  const server = await startServer(fixture);
  t.after(async () => {
    await server.stop();
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  await t.test("reads Claude Code transcripts as threads", async () => {
    const config = await checkedRequest(server, "/api/config");
    assert.equal(config.json.provider, "claude");
    assert.equal(config.json.providerLabel, "Claude Code");

    const snapshot = await checkedRequest(server, "/api/threads");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.provider, "claude");
    assert.equal(snapshot.json.summary.total, 1);

    const thread = snapshot.json.threads.find((item) => item.id === claudeThreadId);
    assert.ok(thread, "expected the Claude session to appear as a thread");
    // Transcript ends with an end_turn assistant message, so the turn is complete.
    assert.equal(thread.status, "complete");
    assert.equal(thread.model, "claude-opus-4-8");
    assert.equal(thread.gitBranch, "main");
    assert.equal(thread.name, "Build the thing");
    assert.equal(thread.lastToolName, "Bash");
    // input+output+cache_creation across both assistant turns: (100+50+200)+(20+30+0).
    assert.equal(thread.tokensUsed, 400);
    assert.equal(thread.promptCount, 1);
    assert.ok(thread.openUrl.startsWith("file://"), "expected a file:// transcript link");
    assert.equal(thread.openLabel, "Open transcript");
  });

  await t.test("hides the usage panel for Claude Code", async () => {
    const usage = await checkedRequest(server, "/api/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.available, false);
  });

  await t.test("stores pin state in the local sidecar", async () => {
    const pin = await checkedRequest(server, `/api/threads/${claudeThreadId}/state`, {
      method: "PATCH",
      body: { pinned: true },
    });
    assert.equal(pin.status, 200);
    assert.equal(pin.json.pinned, true);

    const snapshot = await checkedRequest(server, "/api/threads");
    const thread = snapshot.json.threads.find((item) => item.id === claudeThreadId);
    assert.equal(thread.pinned, true);

    const localState = JSON.parse(await fs.readFile(path.join(fixture.claudeHome, "agentqueue-localstate.json"), "utf8"));
    assert.deepEqual(localState.pinned, [claudeThreadId]);
    const archive = await checkedRequest(server, `/api/threads/${claudeThreadId}/state`, {
      method: "PATCH",
      body: { archived: true },
    });
    assert.equal(archive.status, 200);
    assert.equal(archive.json.archived, true);

    const archivedState = JSON.parse(await fs.readFile(path.join(fixture.claudeHome, "agentqueue-localstate.json"), "utf8"));
    assert.deepEqual(archivedState.archived, [claudeThreadId]);
  });

  await t.test("reports Claude data sources", async () => {
    const sources = await checkedRequest(server, "/api/sources");
    assert.equal(sources.status, 200);
    assert.equal(sources.json.provider, "claude");
    assert.equal(sources.json.exists.claudeProjectsRoot, true);
  });
});

test("AgentQueue GitHub Copilot Desktop provider", async (t) => {
  const fixture = await createCopilotFixture();
  const server = await startServer(fixture);
  t.after(async () => {
    await server.stop();
    await fs.rm(fixture.tempRoot, { recursive: true, force: true });
  });

  await t.test("reads Copilot session-state as threads", async () => {
    const config = await checkedRequest(server, "/api/config");
    assert.equal(config.json.provider, "copilot");
    assert.equal(config.json.providerLabel, "GitHub Copilot Desktop");

    const snapshot = await checkedRequest(server, "/api/threads");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.provider, "copilot");
    assert.equal(snapshot.json.summary.total, 1);

    const thread = snapshot.json.threads.find((item) => item.id === copilotThreadId);
    assert.ok(thread, "expected the Copilot session to appear as a thread");
    assert.equal(thread.status, "complete");
    assert.equal(thread.provider, "copilot");
    assert.equal(thread.model, "gpt-5.3-codex");
    assert.equal(thread.name, "Copilot API Thread");
    assert.equal(thread.lastToolName, "powershell");
    assert.equal(thread.tokensUsed, 42);
    assert.equal(thread.promptCount, 1);
    assert.ok(thread.openUrl.startsWith("file://"), "expected a file:// transcript link");
    assert.equal(thread.openLabel, "Open transcript");
  });

  await t.test("stores Copilot tags and state in Copilot sidecars", async () => {
    const tags = await checkedRequest(server, `/api/threads/${copilotThreadId}/tags`, {
      method: "PATCH",
      body: { tags: ["copilot"] },
    });
    assert.equal(tags.status, 200);
    assert.deepEqual(tags.json.tags, ["copilot"]);

    const pin = await checkedRequest(server, `/api/threads/${copilotThreadId}/state`, {
      method: "PATCH",
      body: { pinned: true },
    });
    assert.equal(pin.status, 200);
    assert.equal(pin.json.pinned, true);

    const savedTags = JSON.parse(await fs.readFile(path.join(fixture.copilotHome, "agentqueue-tags.json"), "utf8"));
    assert.deepEqual(savedTags[copilotThreadId], ["copilot"]);
    const localState = JSON.parse(await fs.readFile(path.join(fixture.copilotHome, "agentqueue-localstate.json"), "utf8"));
    assert.deepEqual(localState.pinned, [copilotThreadId]);
  });

  await t.test("reports Copilot data sources", async () => {
    const sources = await checkedRequest(server, "/api/sources");
    assert.equal(sources.status, 200);
    assert.equal(sources.json.provider, "copilot");
    assert.equal(sources.json.exists.copilotSessionStateRoot, true);
  });
});

test("AgentQueue mixed provider mode", async (t) => {
  const fixture = await createMixedFixture();
  const server = await startServer(fixture);
  t.after(async () => {
    await server.stop();
    await fs.rm(fixture.codex.tempRoot, { recursive: true, force: true });
    await fs.rm(fixture.claude.tempRoot, { recursive: true, force: true });
  });

  await t.test("merges Codex and Claude Code threads", async () => {
    const config = await checkedRequest(server, "/api/config");
    assert.equal(config.json.provider, "mixed");
    assert.deepEqual(config.json.activeProviders, ["codex", "claude"]);

    const snapshot = await checkedRequest(server, "/api/threads");
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.json.provider, "mixed");
    assert.equal(snapshot.json.summary.total, 3);
    assert.equal(snapshot.json.threads.find((item) => item.id === threadId).provider, "codex");
    assert.equal(snapshot.json.threads.find((item) => item.id === claudeThreadId).provider, "claude");
  });

  await t.test("keeps Codex-only usage available", async () => {
    const usage = await checkedRequest(server, "/api/usage");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.available, true);
    assert.equal(usage.json.limitId, "codex");
  });

  await t.test("routes writes to each provider sidecar or state store", async () => {
    const codexTags = await checkedRequest(server, `/api/threads/${threadId}/tags`, {
      method: "PATCH",
      body: { tags: ["codex-tag"] },
    });
    assert.equal(codexTags.status, 200);

    const claudeTags = await checkedRequest(server, `/api/threads/${claudeThreadId}/tags`, {
      method: "PATCH",
      body: { tags: ["claude-tag"] },
    });
    assert.equal(claudeTags.status, 200);

    const tags = await checkedRequest(server, "/api/tags");
    assert.deepEqual(tags.json.threads[threadId], ["codex-tag"]);
    assert.deepEqual(tags.json.threads[claudeThreadId], ["claude-tag"]);

    const pin = await checkedRequest(server, `/api/threads/${claudeThreadId}/state`, {
      method: "PATCH",
      body: { pinned: true },
    });
    assert.equal(pin.status, 200);

    const localState = JSON.parse(await fs.readFile(path.join(fixture.claude.claudeHome, "agentqueue-localstate.json"), "utf8"));
    assert.deepEqual(localState.pinned, [claudeThreadId]);
  });
});
