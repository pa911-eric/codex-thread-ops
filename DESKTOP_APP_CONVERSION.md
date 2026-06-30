# AgentQueue Windows Desktop App Conversion Plan

This document defines the implementation path for converting AgentQueue from a localhost browser app into a regular locally installed Windows exe. The MVP target is a Windows-only tray app that preserves the current dashboard, APIs, local data model, and operator workflow. The only user-visible difference should be that AgentQueue opens in its own desktop window and can live in the Windows notification area instead of requiring a browser tab.

## Current State

AgentQueue is currently a dependency-light Node.js app:

- `server.js` starts an HTTP server, serves static UI assets from `public/`, exposes the local JSON/SSE API, and opens a browser when requested.
- `public/index.html`, `public/app.js`, and `public/styles.css` are the primary UI surface.
- `public/v2/*` is the V2 monitor shell and should continue to work under the same routes.
- `start-dashboard.cmd` and `start-dashboard.ps1` require a system Node.js install and set `AGENTQUEUE_OPEN=1`.
- `install.ps1` installs a release archive to `%LOCALAPPDATA%\AgentQueue`, then optionally launches the command launcher and browser.
- `build-agentqueue-installer-exe.ps1` builds an installer exe wrapper around `install.ps1`; it is not a packaged desktop application.

The core conversion should therefore avoid rewriting the UI. The app already has a clean enough HTTP boundary: the desktop shell can host the same local server and load the same local URL in an embedded window.

## Recommended Technology

Use Electron for the Windows MVP.

Reasons:

- AgentQueue already depends on Node.js filesystem access and benefits from Electron's bundled Node runtime.
- The existing browser UI can run unchanged in a `BrowserWindow`.
- Tray behavior, single-instance locking, auto-start registration, and Windows installer packaging are well-supported.
- It avoids introducing a Rust/Tauri build chain while the product is still changing.

Keep the existing browser mode. The desktop app should be an additional shell around the same server and assets, not a forked product.

## MVP Behavior

The installed exe should:

- Start AgentQueue without requiring the user to install Node.js separately.
- Start the existing local API and dashboard on `127.0.0.1`, using the existing automatic port fallback from `4173`.
- Open the existing dashboard UI in a desktop window.
- Keep all current features working: Codex and Claude providers, local tags, unread state, Stream Deck endpoints, update checks, doctor diagnostics, webhooks, Swagger/OpenAPI, V1, and V2 routes.
- Provide a Windows tray icon with `Open AgentQueue`, `Start at login`, `Diagnostics`, `Open logs`, and `Quit`.
- Hide to tray on window close by default, while `Quit` fully stops the server.
- Enforce a single running desktop instance.
- Support optional start-on-login.
- Continue to allow browser/manual mode via `npm start`.

## Non-Goals For MVP

- No UI redesign.
- No cloud service, telemetry, or account system.
- No silent auto-update.
- No cross-platform packaging.
- No migration away from the local HTTP API.
- No replacement of the Stream Deck plugin. The plugin can continue probing `http://localhost:4173` through `4185`.
- No automatic remote publish or release as part of implementation without explicit human approval.

## Implementation Steps

### 1. Refactor Server Startup Without Changing Routes

Update `server.js` so it can be started by either the CLI or the desktop shell.

Implementation shape:

- Move top-level startup into exported functions:
  - `createAgentQueueServer(options)`
  - `startAgentQueueServer(options)`
  - `runAgentQueueCli(argv)`
- Keep `node --no-warnings server.js`, `npm start`, `doctor`, `update`, and `update-check` behavior unchanged.
- Only call `runAgentQueueCli(process.argv.slice(2))` when `server.js` is the entrypoint.
- Return the selected URL, port, server instance, and shutdown callback from `startAgentQueueServer`.
- Add an option to suppress browser opening from desktop mode, regardless of `AGENTQUEUE_OPEN`.

Validation:

- `npm test`
- `npm start`
- `npm start -- --open`
- `npm run doctor`
- `npm run update:check`
- `GET /api/health`
- `GET /api/events` remains an SSE stream

### 2. Add Desktop Shell Boundary

Add a dedicated desktop folder:

```text
desktop/
  main.cjs
  preload.cjs
  tray.cjs
  windows.cjs
  startup.cjs
  logging.cjs
  assets/
    tray.ico
    app.ico
```

Responsibilities:

- `main.cjs`: Electron lifecycle, single-instance lock, server startup, app shutdown.
- `windows.cjs`: creates the dashboard `BrowserWindow` and loads the local server URL.
- `tray.cjs`: owns the notification-area menu and tray click behavior.
- `startup.cjs`: wraps `app.setLoginItemSettings`.
- `logging.cjs`: writes desktop-shell logs under `%LOCALAPPDATA%\AgentQueue\logs`.
- `preload.cjs`: minimal bridge only if needed. Do not expose broad Node APIs to the renderer.

The renderer should continue loading the existing static UI over HTTP. Avoid loading `public/index.html` directly from `file://`, because the dashboard expects the API and SSE endpoints to share origin with the UI.

### 3. Add Electron Dependencies And Scripts

Add development/package dependencies:

- `electron`
- `electron-builder`

Add scripts:

```json
{
  "desktop": "electron .",
  "desktop:dev": "electron . --dev",
  "desktop:pack": "electron-builder --win --dir",
  "desktop:dist": "electron-builder --win nsis",
  "desktop:smoke": "node test/desktop-smoke.test.js"
}
```

Add package metadata for Electron:

- `main`: `desktop/main.cjs`
- `build.appId`: `com.pa911.agentqueue`
- `build.productName`: `AgentQueue`
- `build.files`: include `server.js`, `package.json`, `public/**`, `src/**`, `desktop/**`, `streamdeck/**`, and docs needed by the app.
- `build.extraMetadata.version`: use the same version as `package.json`.
- `build.win.target`: `nsis`
- `build.win.icon`: `desktop/assets/app.ico`

Keep `package.json` as the version source of truth.

### 4. Host The Existing UI Inside A Desktop Window

Desktop startup flow:

1. Acquire Electron single-instance lock.
2. Start the AgentQueue server in-process with `openBrowser: false`.
3. Wait for `/api/health`.
4. Create the main window.
5. Load the selected local URL, for example `http://127.0.0.1:4173/`.
6. Show the window after the first successful render.
7. Keep the server alive while the tray app is running.

Window rules:

- Use the current UI dimensions as the default window size.
- Remember window bounds in an AgentQueue-owned local settings file.
- Preserve normal links and deep links.
- Open external links in the system browser.
- Keep `codex://` and `file://` open actions working through the OS shell.
- On close, hide to tray unless the user selected `Quit`.

### 5. Add Tray Lifecycle

Tray menu:

- `Open AgentQueue`
- `Open V2 Monitor`
- `Start at login` checkbox
- `Open in browser`
- `Diagnostics`
- `Open logs folder`
- `Copy local URL`
- `Quit`

Tray behavior:

- Left-click opens or focuses the AgentQueue window.
- Double-click also opens or focuses the window.
- `Quit` shuts down the HTTP server and exits the Electron app.
- If the server fails to start, show an error dialog and write a log.

### 6. Add Start-On-Login

Use Electron's `app.setLoginItemSettings` for the MVP.

Behavior:

- Default: disabled unless installer or user setting enables it.
- User can toggle from the tray.
- Store the user's preference in an AgentQueue-owned local file, not in git.
- On startup, sync Windows login settings to the stored preference.

Important: do not silently enable login startup on install unless the installer makes it explicit.

### 7. Optional Start-When-Codex-Runs Trigger

Treat "run when Codex runs" as post-MVP unless the implementation remains simple.

Recommended approach:

- MVP: start at Windows login, which reliably makes AgentQueue available before Codex starts.
- Post-MVP: add an optional lightweight watcher in the tray app that checks for Codex processes and shows AgentQueue when Codex appears.
- Avoid a separate always-on Windows service for MVP.
- Avoid mutating Codex launchers or Codex-owned config.

If implemented later, the watcher should only observe process names and local state. It should not modify Codex files.

### 8. Package A Real Windows Installer

Use `electron-builder` NSIS for the desktop installer.

Installer requirements:

- Installs to the normal per-user application location.
- Creates Start Menu shortcut.
- Optionally creates Desktop shortcut.
- Does not require system Node.js.
- Does not overwrite `.agentqueue.json`, `.agentqueue-install.json`, or sidecar runtime state.
- Does not auto-update silently.
- Can uninstall cleanly without deleting Codex or Claude state.

Keep `build-agentqueue-installer-exe.ps1` during transition, but rename or document it as the legacy source installer wrapper to avoid confusion.

### 9. Preserve Current Update Rules

Current update behavior is intentionally conservative. The desktop app should preserve that product rule.

MVP update model:

- Dashboard can still check GitHub Releases.
- Desktop app can display the existing update notice.
- Applying updates remains user-initiated.
- Do not silently download and replace the app.

If desktop auto-update is added later, it must require explicit user action and should be documented separately from the MVP.

### 10. Desktop Diagnostics

Extend diagnostics so a user can tell whether the installed exe is healthy.

Add checks for:

- Packaged app version.
- Electron version.
- Server URL and selected port.
- Tray startup setting.
- Log directory.
- Whether the app is running from packaged exe or dev mode.
- Whether Node.js is external or bundled.

Expose diagnostics in:

- Tray `Diagnostics`.
- Existing `/health` page.
- Existing `npm run doctor` where applicable.

### 11. Tests And Smoke Validation

Add desktop smoke coverage without making the whole test suite depend on the GUI.

Recommended tests:

- Unit test server startup exports without opening a browser.
- Unit test startup settings wrapper with mocked Electron APIs.
- Unit test single-instance and quit-path state transitions where practical.
- Smoke test packaged/dev Electron boot:
  - starts the server
  - loads `/`
  - receives `/api/health`
  - receives `/api/threads`
  - verifies window title
  - quits cleanly

Manual validation matrix:

- Fresh Windows install with no system Node.js.
- Existing git clone still works with `npm start`.
- Existing `start-dashboard.cmd` still works.
- Existing Stream Deck plugin still connects.
- Codex-only provider.
- Claude-only provider.
- Mixed provider.
- Port `4173` occupied; app moves to the next port and the tray URL matches.
- Window close hides to tray.
- Tray quit stops the server.
- Start-at-login toggle survives restart.
- Uninstall leaves agent state untouched.

### 12. Documentation Updates

Update these docs in the implementation PR:

- `README.md`
  - Add Desktop App install/run section.
  - Keep manual `npm start` path.
  - Clarify legacy installer wrapper versus desktop installer.
  - Document tray behavior and start-at-login.
- `.agentqueue.example.json`
  - Add any supported desktop settings if they are config-file driven.
- `PRODUCT_V2.md`
  - Move tray/desktop wrapper from optional post-MVP to MVP only when the implementation is accepted.
- `ARCHITECTURE_V2.md`
  - Document the desktop shell as a host around the same local API.

## Suggested Milestones

1. Server lifecycle refactor, no Electron yet.
2. Electron dev shell loads existing dashboard.
3. Tray behavior and single-instance lock.
4. Start-at-login and local desktop settings.
5. Packaged Windows installer.
6. Desktop diagnostics and smoke tests.
7. README and release packaging cleanup.

Each milestone should keep `npm start` working. The desktop shell should never become the only way to run AgentQueue during the MVP.

## Release Gate

Before shipping the Windows desktop MVP:

- `npm test` passes.
- Desktop dev shell starts and quits cleanly.
- Packaged installer installs on Windows.
- Installed exe runs without system Node.js.
- Existing browser mode still works.
- Existing Stream Deck plugin connects to the desktop-hosted server.
- No external push, release, or publish has occurred without explicit approval immediately before the action.

