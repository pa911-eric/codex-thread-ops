# AgentQueue

<img width="1920" height="919" alt="image" src="https://github.com/user-attachments/assets/1c773dd8-aaa9-4eb7-86ad-9534dfd1c7a6" />

A local, dependency-free queue and usage dashboard for Codex desktop power users.

AgentQueue reads your local Codex state and gives you a live board of what is running, what just finished, what needs attention, and how quickly current usage limits are burning down.

## Features

- Real-time browser dashboard using Server-Sent Events.
- Status lanes for `Running`, `Complete`, `Recent`, `Today`, and `Done`.
- `Recent` is a strict 2-hour window.
- Subagent-aware cards with parent thread titles, compact subagent identity, and child counts.
- Usage limit panel with primary/secondary reset windows, burn rate, and burndown charts when local `token_count` events are available.
- Right-click card menu for details, opening threads, copying IDs/links/titles, and marking local unread state as read.
- Quick filters for review, risk, unread, projectless, and subagent work.
- Sort modes for status priority, newest activity, longest running, and risk first.
- Local-only data access. No telemetry, account service, or npm install required.

## Requirements

- Node.js 18 or newer.
- Node.js 24 or newer is recommended because it can read Codex's local SQLite thread inventory through `node:sqlite`.
- Codex desktop local state in the default Codex home directory.

## Run

```powershell
node --no-warnings server.js
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

Or on Windows, double-click:

```text
start-dashboard.cmd
```

Then open the printed localhost URL. By default the app starts at:

```text
http://localhost:4173
```

If the port is already in use, it automatically tries the next available port.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `<home>/.codex` | Codex state directory to read. |
| `PORT` | `4173` | Starting localhost port. |
| `AGENTQUEUE_RECENT_MINUTES` | `120` | `Recent` status window. |
| `AGENTQUEUE_COMPLETE_MINUTES` | `10` | `Complete` status window. |
| `AGENTQUEUE_STALE_MINUTES` | `15` | Stale-running warning window. |

Legacy `CODEX_THREAD_OPS_*` names still work as fallbacks.

## Status Model

- `Running`: latest local rollout file has meaningful activity after the latest `task_complete`, and activity is fresh.
- `Complete`: latest completed turn finished in the last 10 minutes.
- `Recent`: latest activity is within the last 2 hours.
- `Today`: latest activity is today but older than 2 hours.
- `Done`: latest activity is before today.

Live terminal processes are shown as badges so a completed thread with a server still running is visible without being misclassified as an active agent turn.

## Data Sources

The dashboard reads local files only:

- `%CODEX_HOME%\state_5.sqlite`
- `%CODEX_HOME%\goals_1.sqlite`
- `%CODEX_HOME%\session_index.jsonl`
- `%CODEX_HOME%\.codex-global-state.json`
- `%CODEX_HOME%\process_manager\chat_processes.json`
- `%CODEX_HOME%\sessions\**\*.jsonl`

Usage metrics come from local `token_count` events in session JSONL files. If those events are not available, the usage panel stays hidden.

If `CODEX_HOME` is not set, the app uses your platform home directory's `.codex` folder.

## Privacy

This project does not send your Codex state anywhere. It serves a local dashboard from your machine and reads local Codex files at request time.

Be thoughtful before screenshots or screen shares: thread titles, prompts, workspace paths, and metadata may contain sensitive project context.

## License

MIT
