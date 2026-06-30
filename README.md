# AgentQueue

[![Install Now](https://img.shields.io/badge/Install%20Now-Windows%20EXE-0F172A?style=for-the-badge&logo=windows)](https://github.com/pa911-eric/AgentQueue/releases/latest/download/AgentQueue-Setup-0.4.4.exe)

<img width="1920" height="919" alt="image" src="https://github.com/user-attachments/assets/1c773dd8-aaa9-4eb7-86ad-9534dfd1c7a6" />

A local, dependency-free queue and usage dashboard for Codex and Claude Code power users.

AgentQueue reads your local agent state and gives you a live board of what is running, what just finished, what needs attention, and how quickly current usage limits are burning down.

## Supported agents

AgentQueue auto-detects local agent runtimes and shows every detected source in one board:

- **Codex** (OpenAI) — reads `~/.codex` SQLite inventory and session rollouts. Full feature set, including the usage-limit panel.
- **Claude Code** (Anthropic) — reads `~/.claude/projects/**/*.jsonl` session transcripts. One transcript maps to one thread; status, activity, model, token totals, tools, git branch, and prompt history are derived from the transcript.

Auto mode reads both Codex and Claude Code when both have local state. Force a single-runtime view with `AGENTQUEUE_PROVIDER=claude` or `AGENTQUEUE_PROVIDER=codex` (or `"provider"` in `.agentqueue.json`). See [Provider differences](#provider-differences) for what changes per runtime.

## Features

- Real-time browser dashboard using Server-Sent Events.
- Status lanes for `Running`, `Complete`, `Recent`, `Today`, and `Done`.
- `Recent` is a strict 2-hour window.
- Subagent-aware cards with parent thread titles, compact subagent identity, and child counts.
- Chronological interaction timeline under the board for reopening recently touched threads.
- Usage limit panel with primary/secondary reset windows, burn rate, and burndown charts when local `token_count` events are available.
- Local custom tags with tag chips, tag search, and tag filtering.
- Right-click card menu for details, opening threads, copying IDs/links/titles, and marking local unread state as read.
- Thread status webhooks with per-status message templates, optional signing, and a test action.
- Quick filters for review, risk, unread, projectless, and subagent work.
- <img width="584" height="349" alt="image" src="https://github.com/user-attachments/assets/371353a4-0c4b-4d80-8706-19303f4304a2" />
- Tiered sort modes for priority, activity, longest running, and risk first.
- Local OpenAPI JSON and Swagger UI for API reads, thread/session inspection, tag writes, unread writes, and supported Codex state flags.
- Optional 2x3 Stream Deck plugin for local Running, Complete, Recent, and Unread counts plus one-tap open actions.
- Local-only data access. No telemetry, account service, or npm install required.

## Requirements

- Desktop installer: Windows 10 or newer. Node.js is bundled in the desktop app.
- Source/manual install: Node.js 18 or newer.
- Node.js 24 or newer is recommended for Codex because it can read Codex's local SQLite thread inventory through `node:sqlite`. Claude Code reads JSONL transcripts only and does not require SQLite.
- Local agent state: Codex desktop state in the Codex home directory, and/or Claude Code state in `~/.claude`.

## Install (Windows desktop app)

Download and run the Windows installer:

[AgentQueue-Setup-0.4.4.exe](https://github.com/pa911-eric/AgentQueue/releases/latest/download/AgentQueue-Setup-0.4.4.exe)

The desktop app runs the same local AgentQueue dashboard and API inside an installed Windows app. It starts the local server on `127.0.0.1`, opens the dashboard in an AgentQueue window, and keeps a tray icon available for opening the app, opening diagnostics, copying the local URL, toggling start at login, and quitting.

The desktop installer is separate from `build-agentqueue-installer-exe.ps1`, which is the legacy source installer wrapper that downloads the repo and opens the browser-based launcher.

## Run

```powershell
node --no-warnings server.js
```

Or:

```powershell
npm start
```

Optional configuration:

```powershell
$env:CODEX_HOME = "$env:USERPROFILE\.codex"
$env:PORT = "4173"
$env:AGENTQUEUE_RECENT_MINUTES = "120"
$env:AGENTQUEUE_COMPLETE_MINUTES = "10"
$env:AGENTQUEUE_STALE_MINUTES = "15"
node --no-warnings server.js
```

You can also create a local `.agentqueue.json` file. See `.agentqueue.example.json` for the supported keys. Environment variables override the local config file.

Or on Windows, double-click:

```text
start-dashboard.cmd
```

PowerShell and Unix launchers are also included:

```text
start-dashboard.ps1
start-dashboard.sh
```

Then open the printed localhost URL. By default the app starts at:

```text
http://localhost:4173
```

If the port is already in use, it automatically tries the next available port.

To open the browser automatically:

```powershell
npm start -- --open
```

The double-click launchers open the browser automatically by default.

## Local Diagnostics

Run the doctor before filing an issue or after moving the project folder:

```powershell
npm run doctor
```

The doctor checks Node.js, the active data sources, Codex SQLite support when Codex is active, local session files, Git install state, and the latest GitHub release when the network is available.

Run the endpoint test suite with:

```powershell
npm test
```

## Local API

AgentQueue exposes a local JSON API alongside the dashboard:

- Swagger UI: `http://localhost:4173/api/docs`
- OpenAPI JSON: `http://localhost:4173/api/openapi.json`
- Main snapshot: `GET /api/threads`
- Thread detail: `GET /api/threads/{threadId}`
- Session tail and parsed events: `GET /api/threads/{threadId}/session`, `GET /api/threads/{threadId}/events`
- Writes: `PATCH /api/threads/{threadId}/tags`, `POST /api/threads/{threadId}/read`, `PATCH /api/threads/{threadId}/state`
- Integrations: `GET /api/events`, `POST /api/threads/{threadId}/open`, `GET /api/processes`, `GET /api/usage`, `GET/PUT /api/webhook`, `POST /api/webhook/test`

Writes are intentionally conservative and routed to the thread's owning provider. Tags are stored in AgentQueue's per-provider sidecar files, unread updates remove thread IDs from known Codex unread-state stores, and state writes are limited to supported flags such as `pinned` and `projectless`.

## Stream Deck

The Stream Deck plugin lives in a self-contained top-level folder:

```text
streamdeck/com.pa911.agentqueue.sdPlugin
```

It is built for a 2x3 layout:

```text
Running Count | Complete Count | Recent Count
Open Running  | Open Complete  | Unread Count
```

Install it by copying or symlinking the `.sdPlugin` folder into Stream Deck's plugins folder, restarting Stream Deck, and adding the six AgentQueue actions in that order.

Keep AgentQueue running locally. The plugin probes `http://localhost:4173` through `http://localhost:4185`, matching the dashboard's automatic next-port behavior. Count keys open the AgentQueue dashboard, and open-thread keys fall back to the dashboard when there is no matching thread. For a fixed URL, copy `agentqueue-streamdeck.config.example.json` to `agentqueue-streamdeck.config.json` inside the plugin folder and set `baseUrl`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTQUEUE_PROVIDER` | auto | Force a single data source: `codex` or `claude`. Auto mode reads every detected source. |
| `CODEX_HOME` | `<home>/.codex` | Codex state directory to read. |
| `CLAUDE_HOME` | `<home>/.claude` | Claude Code state directory to read (also accepts `CLAUDE_CONFIG_DIR`). |
| `PORT` | `4173` | Starting localhost port. |
| `AGENTQUEUE_RECENT_MINUTES` | `120` | `Recent` status window. |
| `AGENTQUEUE_COMPLETE_MINUTES` | `10` | `Complete` status window. |
| `AGENTQUEUE_STALE_MINUTES` | `15` | Stale-running warning window. |
| `AGENTQUEUE_OPEN` | unset | Set to `1` to open the dashboard in your browser on start. |
| `AGENTQUEUE_UPDATE_CHECK` | `1` | Set to `0` to disable GitHub release checks. |
| `AGENTQUEUE_UPDATE_CHECK_DISABLED` | unset | Set to `1` to disable GitHub release checks. |

Legacy `CODEX_THREAD_OPS_*` names still work as fallbacks.

### Thread webhooks

Use the Webhook Configure dialog in the dashboard to register an HTTP or HTTPS endpoint. AgentQueue sends a `POST` when a thread changes status lane after the server has established its initial baseline. The runtime settings are stored in:

```text
%CODEX_HOME%\agentqueue-webhooks.json
```

You can seed defaults from `.agentqueue.json` with a `webhook` object. Dashboard changes write to the sidecar file so local endpoints and signing tokens are not committed.

Supported message templates are keyed by status: `running`, `complete`, `recent`, `today`, `done`, plus `default`. Templates can use `{{title}}`, `{{id}}`, `{{status}}`, `{{statusLabel}}`, `{{previousStatus}}`, `{{activityAt}}`, `{{workspace}}`, and `{{url}}`.

Webhook requests include JSON with `event`, `message`, `previousStatus`, `status`, `changedAt`, and a compact `thread` object. If a signing token is configured, AgentQueue adds `x-agentqueue-signature: sha256=<hmac>` over the JSON body.

## Updates

AgentQueue checks GitHub Releases for a newer version and shows a compact notice in the dashboard when one is available. The check is read-only and can be disabled with `AGENTQUEUE_UPDATE_CHECK=0`.

If you installed AgentQueue with `git clone`, update from the project folder:

```powershell
npm run update
```

The updater only fast-forwards a clean checkout from the expected GitHub remote. It refuses to run if local files have changed, so it will not overwrite your work.

To check from the terminal without starting the dashboard:

```powershell
npm run update:check
```

Zip installs cannot be updated with `git pull`; download the latest GitHub Release zip instead.

## Status Model

- `Running`: latest local rollout file has meaningful activity after the latest `task_complete`, and activity is fresh.
- `Complete`: latest completed turn finished in the last 10 minutes.
- `Recent`: latest activity is within the last 2 hours.
- `Today`: latest activity is today but older than 2 hours.
- `Done`: latest activity is before today.

Live terminal processes are shown as badges so a completed thread with a server still running is visible without being misclassified as an active agent turn.

## Data Sources

The dashboard reads local files only.

**Codex (`CODEX_HOME`, default `~/.codex`):**

- `state_5.sqlite`, `goals_1.sqlite`, `logs_2.sqlite`
- `session_index.jsonl`
- `.codex-global-state.json`
- `process_manager/chat_processes.json`
- `sessions/**/*.jsonl`

**Claude Code (`CLAUDE_HOME`, default `~/.claude`):**

- `projects/**/*.jsonl` — one session transcript per thread

Custom tags are stored in AgentQueue's own sidecar files next to each runtime's state (`agentqueue-tags.json`). Webhook settings use the active AgentQueue sidecar (`agentqueue-webhooks.json`); in mixed mode the default Codex-side sidecar drives notifications for the combined board. For Claude Code, pin/projectless flags are stored in a local `agentqueue-localstate.json` sidecar. AgentQueue never writes into the agent's own session files, indexes, or databases.

Webhook delivery is opt-in and user-initiated from the dashboard or local config.

### Provider differences

Claude Code's local state does not include everything Codex exposes, so a few fields behave differently for Claude Code threads, including in the mixed Codex + Claude board:

- **Usage limits:** Codex-derived when Codex is active, hidden for Claude-only mode. Claude Code transcripts record per-message token usage but not rate-limit windows. Per-thread token totals (input + output + cache-creation) are still shown.
- **Unread state:** not tracked by Claude Code, so the unread filter is always empty and "mark read" is a no-op.
- **Subagents, goals, live processes, log health:** Codex-only; these counts are zero for Claude Code.
- **Open thread:** Codex uses its `codex://` deep link; Claude Code opens the local session transcript file instead.

## Privacy

This project does not send your agent state anywhere. It serves a local dashboard from your machine and reads local agent files at request time.

Be thoughtful before screenshots or screen shares: thread titles, prompts, workspace paths, and metadata may contain sensitive project context.

## Contributing

For feature requests, please open a GitHub Issue instead of submitting a pull request. Issues make it easier to discuss the use case, shape the design, and decide whether the request fits AgentQueue before implementation work starts.

## License

MIT


