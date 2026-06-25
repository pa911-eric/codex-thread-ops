# AgentQueue

[![Install Now](https://img.shields.io/badge/Install%20Now-Recommended%20Script%20Install-0F172A?style=for-the-badge&logo=powershell)](https://github.com/pa911-eric/AgentQueue/releases/latest/download/install.ps1)

<img width="1920" height="919" alt="image" src="https://github.com/user-attachments/assets/1c773dd8-aaa9-4eb7-86ad-9534dfd1c7a6" />

A local, dependency-free queue and usage dashboard for Codex desktop power users.

AgentQueue reads your local Codex state and gives you a live board of what is running, what just finished, what needs attention, and how quickly current usage limits are burning down.

## Features

- Real-time browser dashboard using Server-Sent Events.
- Status lanes for `Running`, `Complete`, `Recent`, `Today`, and `Done`.
- `Recent` is a strict 2-hour window.
- Subagent-aware cards with parent thread titles, compact subagent identity, and child counts.
- Chronological interaction timeline under the board for reopening recently touched threads.
- Usage limit panel with primary/secondary reset windows, burn rate, and burndown charts when local `token_count` events are available.
- Local custom tags with tag chips, tag search, and tag filtering.
- Right-click card menu for details, opening threads, copying IDs/links/titles, and marking local unread state as read.
- Quick filters for review, risk, unread, projectless, and subagent work.
- <img width="584" height="349" alt="image" src="https://github.com/user-attachments/assets/371353a4-0c4b-4d80-8706-19303f4304a2" />
- Tiered sort modes for priority, activity, longest running, and risk first.
- Local-only data access. No telemetry, account service, or npm install required.

## Requirements

- Node.js 18 or newer.
- Node.js 24 or newer is recommended because it can read Codex's local SQLite thread inventory through `node:sqlite`.
- Codex desktop local state in the default Codex home directory.

## Install Now

### One-click installer (recommended)

Use this direct link to download and run the installer script:
https://github.com/pa911-eric/AgentQueue/releases/latest/download/install.ps1

The script prints progress, writes a timestamped install log to `%TEMP%\AgentQueue-install-*.log`, and now launches the dashboard automatically after install.

If you prefer markdown:

[Download and run the installer](https://github.com/pa911-eric/AgentQueue/releases/latest/download/install.ps1) to install AgentQueue in one step.

### One-click PowerShell command (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/pa911-eric/AgentQueue/releases/latest/download/install.ps1 -UseBasicParsing -OutFile $env:TEMP\agentqueue-install.ps1; & $env:TEMP\agentqueue-install.ps1 -Launch"
```

If you need a legacy EXE install:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://github.com/pa911-eric/AgentQueue/releases/latest/download/AgentQueueInstaller.exe -UseBasicParsing -OutFile $env:TEMP\AgentQueueInstaller.exe; & $env:TEMP\AgentQueueInstaller.exe"
```

The EXE installer now opens a visible console window and keeps the progress visible while it installs and starts the dashboard.

To install a specific version, use `-Version` (for example, `-Version 0.1.0`) if you clone and run locally.

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

The doctor checks Node.js, SQLite support, `CODEX_HOME`, Codex inventory files, session files, Git install state, and the latest GitHub release when the network is available.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `<home>/.codex` | Codex state directory to read. |
| `PORT` | `4173` | Starting localhost port. |
| `AGENTQUEUE_RECENT_MINUTES` | `120` | `Recent` status window. |
| `AGENTQUEUE_COMPLETE_MINUTES` | `10` | `Complete` status window. |
| `AGENTQUEUE_STALE_MINUTES` | `15` | Stale-running warning window. |
| `AGENTQUEUE_OPEN` | unset | Set to `1` to open the dashboard in your browser on start. |
| `AGENTQUEUE_UPDATE_CHECK` | `1` | Set to `0` to disable GitHub release checks. |
| `AGENTQUEUE_UPDATE_CHECK_DISABLED` | unset | Set to `1` to disable GitHub release checks. |

Legacy `CODEX_THREAD_OPS_*` names still work as fallbacks.

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

The dashboard reads local files only:

- `%CODEX_HOME%\state_5.sqlite`
- `%CODEX_HOME%\goals_1.sqlite`
- `%CODEX_HOME%\session_index.jsonl`
- `%CODEX_HOME%\.codex-global-state.json`
- `%CODEX_HOME%\agentqueue-tags.json`
- `%CODEX_HOME%\process_manager\chat_processes.json`
- `%CODEX_HOME%\sessions\**\*.jsonl`

Usage metrics come from local `token_count` events in session JSONL files. If those events are not available, the usage panel stays hidden.

Custom tags are stored in AgentQueue's own `%CODEX_HOME%\agentqueue-tags.json` sidecar file. AgentQueue does not write tags into Codex session JSONL files, the session index, or Codex SQLite databases.

If `CODEX_HOME` is not set, the app uses your platform home directory's `.codex` folder.

## Privacy

This project does not send your Codex state anywhere. It serves a local dashboard from your machine and reads local Codex files at request time.

Be thoughtful before screenshots or screen shares: thread titles, prompts, workspace paths, and metadata may contain sensitive project context.

## Contributing

For feature requests, please open a GitHub Issue instead of submitting a pull request. Issues make it easier to discuss the use case, shape the design, and decide whether the request fits AgentQueue before implementation work starts.

## License

MIT


