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
    "unread-thread-ids": [threadId],
    "pinned-thread-ids": [secondThreadId],
    "projectless-thread-ids": [],
    "electron-persisted-atom-state": JSON.stringify({
      "prompt-history": { [threadId]: ["Please test the API."] },
      "thread-workspace-root-hints": { [threadId]: tempRoot },
    }),
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
  };
}

async function startServer(fixture) {
  const child = spawn(process.execPath, ["--no-warnings", "server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: "0",
      CODEX_HOME: fixture.codexHome,
      AGENTQUEUE_INSTALL_METADATA: fixture.installMetadataPath,
      AGENTQUEUE_UPDATE_CHECK: "0",
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
    assert.equal(config.json.version, "0.2.1");

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
    const read = await checkedRequest(server, `/api/threads/${threadId}/read`, { method: "POST" });
    assert.equal(read.status, 200);
    assert.deepEqual(read.json.markedIds, [threadId]);
    assert.equal(read.json.removed, 1);

    const legacyRead = await checkedRequest(server, "/api/threads/read", {
      method: "POST",
      body: { threadIds: [secondThreadId] },
    });
    assert.equal(legacyRead.status, 200);
    assert.deepEqual(legacyRead.json.markedIds, [secondThreadId]);

    const state = await checkedRequest(server, `/api/threads/${threadId}/state`, {
      method: "PATCH",
      body: { pinned: true, projectless: true },
    });
    assert.equal(state.status, 200);
    assert.equal(state.json.pinned, true);
    assert.equal(state.json.projectless, true);

    const invalid = await checkedRequest(server, `/api/threads/${threadId}/state`, {
      method: "PATCH",
      body: { archived: true },
    });
    assert.equal(invalid.status, 400);
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
