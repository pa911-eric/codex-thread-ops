# AgentQueue V2 Product Guide

This document is an implementation guide for agents building AgentQueue V2. Treat the current application as a POC and vision source, not as the product shape to preserve.

## Product Thesis

AgentQueue V2 is a local command center for supervising Codex work across many threads. It answers four operator questions quickly:

- What is active now?
- What needs my attention?
- What changed since I last looked?
- Where do I jump back in?

The product form factor is closer to Task Manager, an inbox, and a CI monitor than a Kanban board. The first screen must be a dense operational monitor, not a marketing page, not a card wall, and not a configuration surface.

## V2 Positioning

AgentQueue is for Codex power users running multiple local threads, subagents, workspaces, and long-running tasks. Its value is not generic project management. Its value is trustworthy local situational awareness.

Core promise:

> AgentQueue gives operators a private, local, explainable queue of Codex work so they can supervise many threads without rereading transcripts or guessing what is still alive.

## Product Principles

- Local first: read local Codex state and AgentQueue sidecars by default. Do not require an account service.
- Explainable status: every status and attention rank must have a reason that can be shown to the user.
- Dense by default: optimize for scanning many threads on a laptop screen.
- Fast path first: search, inspect, and reopen a thread should be one to two interactions.
- POC firewall: keep proven parsing and classification ideas, but do not preserve the V1 layout by default.
- Conservative writes: local sidecar writes are allowed; Codex state writes must remain narrow, explicit, and documented.
- Boring startup: prefer reliable manual/local startup over opaque installer behavior until the product is stable.

## Target Users

Primary user:

- Runs several Codex threads in parallel.
- Uses multiple repositories or customer workspaces.
- Needs to know which agent runs are active, stale, risky, done, or waiting.
- Values direct evidence from local state over speculative summaries.

Secondary user:

- Wants a local read API over Codex thread state.
- Wants optional webhooks or notifications after the core monitor is reliable.

Non-target users for V2 MVP:

- Users who want cloud collaboration.
- Users who want a general task board.
- Users who want a one-click consumer installer before the app is product-stable.

## Jobs To Be Done

1. When I have many Codex threads running, I want one local monitor that tells me which work is active, stale, or complete so I can decide where to look.
2. When I return after time away, I want to see what changed since I last checked so I do not reread every transcript.
3. When a thread needs attention, I want to see the reason and open the exact thread quickly.
4. When a status is inferred, I want to understand why AgentQueue believes it so I can trust or override it.
5. When local Codex data is incomplete or stale, I want the app to say so clearly instead of pretending the state is certain.

## First-Screen Experience

The default V2 screen is a dense monitor list.

Required first-screen regions:

- Command bar: search, refresh, focus mode, status filters, view switcher, settings access.
- Summary strip: running, needs attention, unread, risk, token window, last updated.
- Main queue: grouped list or table of threads sorted by attention rank.
- Detail drawer: opens only when a thread is selected.

Do not make the Kanban board the default V2 experience. Keep board mode as an optional view only after the monitor list is strong.

## Monitor Row Contract

Each visible thread row should answer these questions without opening details:

- What is this thread?
- What workspace or project owns it?
- What state is it in?
- Why is it ranked here?
- When did it last change?
- Is there a process, unread signal, risk signal, or token concern?
- What is the next action?

Recommended row fields:

- Status indicator.
- Thread title.
- Workspace or project path summary.
- Last activity age.
- Attention reason.
- Badges for running process, stale, unread, risk, subagent, token activity, pinned, projectless.
- Primary action: open thread.
- Secondary action menu: copy ID, copy title, mark read, manage tags, inspect source.

## Attention Model

V2 must separate raw status from attention priority.

Raw status describes what the thread appears to be:

- `running`
- `stale_running`
- `needs_attention`
- `recently_completed`
- `recent`
- `quiet`
- `unknown`

Attention priority determines sort order:

1. Running and active now.
2. Running but stale.
3. Needs attention or unread assistant response.
4. Risk signal.
5. Recently completed.
6. Recently touched.
7. Quiet done work.
8. Unknown or low-confidence rows.

Each ranked row must include one primary `attentionReason`, for example:

- `active process`
- `fresh transcript activity`
- `stale running thread`
- `new assistant response`
- `recent task completion`
- `high token burn`
- `manual tag: needs review`
- `insufficient local state`

## Confidence Model

AgentQueue is reading local and inferred state, so V2 must expose confidence.

Use simple confidence levels:

- `high`: direct process state, explicit task completion, direct unread state, or current transcript activity.
- `medium`: inferred from transcript events and recent file writes.
- `low`: derived from stale index entries, missing transcript files, or incomplete metadata.

The detail drawer must show the evidence behind the status:

- Data source.
- Timestamp.
- Event or file that drove the decision.
- Any missing data that lowers confidence.

## MVP Scope

V2 MVP includes:

- Firewalled V2 app shell.
- Dense monitor list as default.
- Thread detail drawer.
- Search.
- Focus mode.
- Status filters.
- Attention-first sorting.
- Open thread action.
- Local tags.
- Mark read behavior where supported.
- Usage summary when token events are available.
- Doctor or diagnostics screen.
- Stable local API for list and detail views.
- Fixture-driven tests for classification.

V2 MVP excludes:

- Installer-first release flow.
- Cloud sync.
- Multi-user collaboration.
- Remote telemetry.
- Kanban as default.
- Permanent timeline panel.
- Overbuilt webhook UI.
- Automatic updates from the dashboard.

## Optional Post-MVP Scope

Add only after the MVP is useful:

- Board view.
- Timeline view.
- Webhook configuration.
- Notification channels.
- Saved views.
- Keyboard command palette.
- Tray or desktop wrapper.
- Import/export of local AgentQueue settings.

## UX Rules

- Follow `DESIGN.md` unless this V2 guide narrows the product shape.
- Use Inter for interface text.
- Use JetBrains Mono for thread IDs, paths, timestamps, process IDs, token counts, and file names.
- Keep controls compact and operator-focused.
- Use 1px outlines, 4px radius, and minimal depth.
- Avoid gradients, decorative hero sections, oversized cards, and marketing-style layout.
- Do not place cards inside cards.
- Do not add a permanent left control panel unless user testing proves it is faster than a command bar.
- Do not add a permanent right timeline panel in the default view.
- Verify text fit across desktop and mobile widths before considering UI work complete.

## Product Metrics

V2 is ready when it meets these practical checks:

- A user can identify active, stale, and needs-attention threads in under 10 seconds.
- A 1440px-wide laptop viewport can show at least 20 useful thread rows without scrolling horizontally.
- Every non-quiet row has an attention reason.
- Every inferred status has inspectable evidence.
- The default screen works without token events, process metadata, or update network access.
- Local startup remains reliable with `npm start`.
- No remote writes or publish steps are required for normal operation.

## Implementation Milestones

1. Product boundary:
   - Keep V1 runnable.
   - Add V2 docs.
   - Decide the V2 folder boundary before moving code.

2. Data contract:
   - Define `ThreadSummary`, `ThreadDetail`, `AttentionReason`, and `StatusEvidence`.
   - Build fixture data from representative local Codex state.
   - Add classification tests before building UI.

3. V2 shell:
   - Build the monitor list against fixtures.
   - Include responsive desktop and mobile layouts.
   - Include empty, loading, partial-data, and error states.

4. Real data integration:
   - Connect local Codex readers through the new contract.
   - Keep the UI independent from raw file formats.
   - Preserve V1 until V2 reaches feature parity on core monitoring.

5. Operator polish:
   - Add detail evidence.
   - Add read/tag actions.
   - Add diagnostics.
   - Add keyboard and interaction polish only after the base monitor is stable.

6. Release decision:
   - Keep manual setup unless there is a reliable, visible, low-confusion packaging path.
   - Do not reintroduce installer complexity merely to look finished.

## Agent Instructions

When implementing V2:

- Start by reading this file, `ARCHITECTURE_V2.md`, `AGENTS.md`, and `DESIGN.md`.
- Treat `README.md` and V1 source as evidence of current capabilities, not as a UX blueprint.
- Prefer small, testable slices.
- Do not perform external writes, pushes, releases, or deployments without explicit approval immediately before the action.
- If state inference is uncertain, model the uncertainty instead of hiding it.
- If a feature does not improve observe, prioritize, resume, or operate-locally, defer it.

