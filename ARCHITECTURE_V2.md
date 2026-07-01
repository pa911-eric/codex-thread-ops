# AgentQueue V2 Architecture Guide

This document is an implementation guide for agents building AgentQueue V2. It defines the firewalled architecture, module boundaries, data contracts, and validation expectations.

## Architecture Goals

V2 must turn the current POC into a product-grade local monitor without dragging forward accidental UI and coupling.

Primary goals:

- Separate Codex state reading from product classification.
- Separate product classification from UI rendering.
- Make inferred state explainable and testable.
- Keep local data private by default.
- Keep writes conservative and isolated to AgentQueue sidecars unless explicitly documented.
- Preserve V1 until V2 can replace the core monitor experience.

## Firewalled Boundary

Do not mutate the V1 dashboard into V2 in place.

Recommended boundary:

```text
src/
  v2/
    api/
    codex-state/
    classifier/
    store/
    ui/
    fixtures/
    tests/
```

If the project stays intentionally dependency-light, the boundary can be implemented with plain Node.js modules and static browser assets. If a frontend build tool is introduced, document the reason in the change and keep startup simple.

Rules:

- V1 can continue serving the current dashboard.
- V2 should be reachable through a separate route during development, for example `/v2`.
- V2 may reuse domain logic only after it is isolated behind tests.
- V2 should not reuse V1 layout CSS as its baseline.
- V2 should not depend on DOM structure from `public/index.html`.

## Current POC Capabilities To Preserve

Preserve these ideas:

- Local Codex state reading.
- Server-Sent Events or equivalent live refresh.
- Status classification from transcript/index/process evidence.
- Subagent awareness.
- Usage panel when token events exist.
- Local sidecar tags.
- Read/unread support where Codex state allows it.
- Conservative local API.
- Doctor/update checks as diagnostics, not first-screen clutter.

Do not preserve these as defaults:

- Permanent three-region layout.
- Card-first Kanban board.
- Permanent timeline panel.
- Large sidebar control surface.
- Installer-first product story.

## Data Sources

V2 data readers should support these sources through explicit adapters:

- `%CODEX_HOME%\state_5.sqlite`
- `%CODEX_HOME%\goals_1.sqlite`
- `%CODEX_HOME%\session_index.jsonl`
- `%CODEX_HOME%\.codex-global-state.json`
- `%CODEX_HOME%\process_manager\chat_processes.json`
- `%CODEX_HOME%\sessions\**\*.jsonl`
- `%CODEX_HOME%\agentqueue-tags.json`
- `%CODEX_HOME%\agentqueue-webhooks.json`

The UI must never read these files directly. It must consume normalized API responses.

## Module Boundaries

### `codex-state`

Reads raw local Codex files and returns normalized raw records.

Responsibilities:

- Locate Codex home.
- Read SQLite files when available.
- Read session index JSONL.
- Read transcript JSONL files.
- Read process manager metadata.
- Normalize timestamps and paths.
- Tolerate missing files and partial data.
- Report source-level errors without crashing the product.

Must not:

- Decide product attention priority.
- Render UI labels.
- Write AgentQueue sidecars.

### `classifier`

Turns normalized raw records into product concepts.

Responsibilities:

- Produce `ThreadSummary`.
- Produce `ThreadDetail`.
- Determine raw status.
- Determine attention rank.
- Determine confidence.
- Attach evidence.
- Identify stale, unread, risk, subagent, projectless, and token signals.

Must not:

- Read files directly.
- Mutate local Codex state.
- Depend on browser APIs.

### `store`

Owns AgentQueue-local state.

Responsibilities:

- Read and write tags.
- Read and write local view preferences.
- Read and write AgentQueue webhook settings.
- Store V2 settings in AgentQueue-owned files only.
- Use atomic writes for JSON sidecars.

Must not:

- Write transcript JSONL files.
- Write session index files.
- Write SQLite state unless a narrow behavior is explicitly approved and documented.

### `api`

Exposes the normalized V2 contract to the UI and local users.

Responsibilities:

- Serve V2 page assets.
- Serve V2 JSON endpoints.
- Stream or poll snapshot changes.
- Validate write payloads.
- Return explainable errors.

Must not:

- Leak raw private file contents unless the endpoint is explicitly a detail/evidence endpoint.
- Hide partial-data warnings.

### `ui`

Renders the product experience.

Responsibilities:

- Default to monitor list.
- Render command bar, summary strip, queue, and detail drawer.
- Show attention reasons and confidence.
- Support keyboard and pointer interactions.
- Handle loading, empty, partial-data, and error states.
- Keep board/timeline/settings as secondary views.

Must not:

- Parse Codex files.
- Derive core status independently from the classifier.
- Add permanent layout regions that reduce monitor density without product justification.

## Proposed API Contract

### Snapshot

`GET /api/v2/snapshot`

Returns:

```json
{
  "generatedAt": "2026-06-26T00:00:00.000Z",
  "codexHome": "C:\\Users\\EricL\\.codex",
  "health": {
    "level": "ok",
    "warnings": []
  },
  "summary": {
    "total": 0,
    "running": 0,
    "needsAttention": 0,
    "unread": 0,
    "risk": 0,
    "stale": 0
  },
  "threads": []
}
```

### Thread Summary

Each `threads` item should match this shape:

```json
{
  "id": "00000000-0000-0000-0000-000000000000",
  "title": "Thread title",
  "workspace": "C:\\path\\to\\workspace",
  "workspaceLabel": "workspace",
  "status": "running",
  "statusLabel": "Running",
  "attentionRank": 10,
  "attentionReason": "active process",
  "confidence": "high",
  "activityAt": "2026-06-26T00:00:00.000Z",
  "activityAgeMs": 0,
  "threadSource": "main",
  "parentThreadId": null,
  "badges": ["running", "unread"],
  "tags": [],
  "openUrl": "codex://threads/00000000-0000-0000-0000-000000000000",
  "evidence": [
    {
      "kind": "process",
      "source": "chat_processes.json",
      "observedAt": "2026-06-26T00:00:00.000Z",
      "message": "Live process associated with thread"
    }
  ]
}
```

### Thread Detail

`GET /api/v2/threads/:threadId`

Returns:

```json
{
  "thread": {},
  "timeline": [],
  "sources": [],
  "diagnostics": [],
  "actions": {
    "canOpen": true,
    "canMarkRead": true,
    "canTag": true,
    "canPin": false
  }
}
```

### Writes

Allowed V2 writes:

- `PATCH /api/v2/threads/:threadId/tags`
- `POST /api/v2/threads/:threadId/read`
- `PATCH /api/v2/preferences`

Any write that touches Codex-owned state must have:

- A documented rationale.
- Payload validation.
- Tests.
- A detail in `README.md` or the V2 docs.

## Status Derivation

Classifier inputs should be evidence records, not ad hoc booleans.

Recommended evidence kinds:

- `process`
- `transcript_event`
- `session_index`
- `global_state`
- `goal_state`
- `token_count`
- `sidecar_tag`
- `filesystem`
- `diagnostic_warning`

Recommended status derivation:

- `running`: direct process evidence or fresh meaningful transcript activity after last completion.
- `stale_running`: previously running evidence but no fresh activity inside the stale window.
- `needs_attention`: unread state, user-input-needed signal, manual tag, or risk flag.
- `recently_completed`: explicit completion event inside the completion window.
- `recent`: activity inside the recent window.
- `quiet`: older completed or inactive work.
- `unknown`: insufficient evidence to classify confidently.

The classifier should return both the result and the evidence that produced it.

## Confidence Rules

Recommended confidence:

- `high`: direct process evidence, explicit task completion, direct unread state, or fresh transcript event.
- `medium`: session index plus transcript file timestamps agree, but no direct process or completion event exists.
- `low`: source files are missing, stale, contradictory, or derived from index-only records.

If evidence conflicts, prefer lower confidence and expose the conflict in detail diagnostics.

## UI Architecture

V2 UI should be organized around product surfaces:

```text
ui/
  components/
    CommandBar
    SummaryStrip
    MonitorQueue
    MonitorRow
    DetailDrawer
    StatusBadge
    EvidenceList
    EmptyState
    DiagnosticsPanel
  views/
    MonitorView
    BoardView
    TimelineView
    SettingsView
```

If implemented without a bundler, use equivalent file/module boundaries and keep rendering functions small.

Default view layout:

```text
+------------------------------------------------------------+
| Command bar                                                |
+------------------------------------------------------------+
| Summary strip                                              |
+------------------------------------------------------------+
| Grouped monitor queue                         Detail drawer |
| Group: Running                                             |
| Group: Needs attention                                     |
| Group: Recent                                              |
+------------------------------------------------------------+
```

Mobile layout:

- Command bar remains first.
- Summary strip can scroll horizontally.
- Queue remains single-column.
- Detail drawer becomes a full-screen sheet.
- Board mode is optional and secondary.

## Testing Strategy

Minimum tests before V2 is considered implementation-ready:

- Fixture parser tests for session index records.
- Fixture parser tests for transcript JSONL records.
- Classifier tests for all statuses.
- Classifier tests for confidence levels.
- Store tests for tag/preference writes.
- API tests for snapshot, detail, tags, read, and preferences.
- UI smoke checks for desktop and mobile widths.

Use fixture data for edge cases:

- Missing session index.
- Missing transcript file.
- Transcript newer than index.
- Index newer than transcript.
- Running process with old transcript.
- Completion event after activity.
- Subagent with parent thread.
- Thread with no title.
- Token events unavailable.
- Corrupt JSONL row.

## Migration Plan

Recommended migration:

1. Add V2 docs.
2. Add V2 module skeleton and fixtures.
3. Extract or duplicate the smallest raw readers needed for tests.
4. Build classifier contract and tests.
5. Build `/api/v2/snapshot` and `/api/v2/threads/:threadId`.
6. Build V2 monitor shell against fixtures.
7. Wire V2 monitor to live API.
8. Add read/tag writes.
9. Add diagnostics and settings.
10. Decide whether to retire, keep, or hide V1.

Do not delete V1 until V2 can monitor live local threads, open thread details, and handle partial local state.

## Operational Constraints

- Do not push, release, deploy, or publish without explicit human approval immediately before the action.
- Do not auto-update from the dashboard.
- Do not add telemetry.
- Do not store machine-specific config in git.
- Keep `.agentqueue-install.json` and `.agentqueue.json` ignored.
- Update `.agentqueue.example.json` when supported config keys change.
- Update `README.md` when user-facing setup, update, doctor, or launcher behavior changes.

## Validation Checklist

Before finishing a V2 implementation slice:

- The old V1 dashboard still starts unless the task explicitly removes it.
- `npm test` passes or the failure is documented.
- New classifier behavior has fixture coverage.
- New API behavior has tests.
- UI text fits at desktop and mobile widths.
- The default view remains the monitor list.
- Every new status or attention rank has evidence.
- Writes stay within approved local sidecars unless documented otherwise.
- No external write or publish action was performed without approval.

## Agent Instructions

Before coding:

- Read `PRODUCT_V2.md`.
- Read this file.
- Read `AGENTS.md` and `DESIGN.md`.
- Inspect current V1 behavior only for capability and data-source evidence.

During coding:

- Keep edits scoped to the V2 slice.
- Prefer tests around classification and contracts before UI polish.
- Preserve local-first behavior.
- Model uncertainty explicitly.
- Keep the app useful when optional data sources are unavailable.

When reporting work:

- State which V2 milestone the change advances.
- State whether V1 was touched.
- State what validation ran.
- State any remaining data-source uncertainty.

