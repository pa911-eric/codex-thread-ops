# Agent Instructions

## Design System

- Follow [DESIGN.md](./DESIGN.md) for all UI and UX changes.
- Keep AgentQueue clinical, precise, dense, and operator-focused. Prefer functional controls and direct thread data over decorative presentation.
- Use Inter for interface text and JetBrains Mono for machine data such as thread IDs, paths, timestamps, token counts, and process metadata.
- Use Deep Slate, Emerald, Amber, and neutral Slate as the primary semantic colors. Avoid gradients, purple accents, heavy shadows, and oversized marketing-style layouts.
- Define depth with 1px outlines and subtle focus states. Cards, buttons, inputs, and structural containers should use a 4px radius; badges and tags can use an 8px radius.
- Preserve the dashboard-first experience: the first screen should remain the usable thread monitor, not a landing page.
- On desktop, keep the board dense with at least 280px columns and 16px gutters. On mobile, keep a single visible column with a column switcher.
- When adding controls, use compact, familiar dashboard patterns such as segmented controls, checkboxes, selects, and icon-capable buttons.
- Before finishing UI work, verify that text does not overflow controls or overlap adjacent content across desktop and mobile widths.

## Data Providers

- AgentQueue reads either Codex (`~/.codex`) or Claude Code (`~/.claude/projects`) local state, auto-detected at startup and overridable with `AGENTQUEUE_PROVIDER`. Keep both providers working; do not regress the Codex path when changing the Claude path or vice versa.
- The Codex and Claude readers must converge on the same enriched thread shape consumed by `enrichThread`/`computeSummary`. When you add a thread field, populate it (or a sensible null) in both providers.
- Reads stay local and non-destructive. AgentQueue writes only its own sidecars (`agentqueue-tags.json`, `agentqueue-webhooks.json`, `agentqueue-localstate.json`) and never mutates an agent's session files, indexes, or databases.

## Version Management

- Keep `package.json` as the source of truth for the local AgentQueue version. Bump it intentionally when user-facing behavior, install/update flows, or data contracts change.
- GitHub update checks compare `package.json` version to the latest GitHub Release tag. Release tags should use `vX.Y.Z` and match the package version without the leading `v`.
- Do not silently auto-update from the dashboard. The UI may show that an update is available, link to release notes, and copy `npm run update`, but applying updates must stay user-initiated.
- Keep `npm run update` conservative: it should only fast-forward a clean git checkout from the expected GitHub remote and must refuse to run when local changes are present.
- Do not commit local install metadata or machine-specific config. `.agentqueue-install.json` and `.agentqueue.json` are intentionally ignored; update `.agentqueue.example.json` when supported config keys change.
- When changing updater, doctor, or launcher behavior, update `README.md` in the same change and verify `npm run doctor` plus `npm run update:check` when network access is available.
