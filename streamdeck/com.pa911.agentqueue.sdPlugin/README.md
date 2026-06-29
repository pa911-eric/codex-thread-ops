# AgentQueue Stream Deck Plugin

This plugin is designed for a 2x3 Stream Deck layout:

| Row | Key 1 | Key 2 | Key 3 |
| --- | --- | --- | --- |
| 1 | Running Count | Complete Count | Recent Count |
| 2 | Open Most Recent Running | Open Most Recent Complete | Unread Count |

## Install

1. Keep AgentQueue running locally with `npm start`.
2. Copy or symlink `streamdeck/com.pa911.agentqueue.sdPlugin` into the Stream Deck plugins folder.
3. Restart Stream Deck.
4. Add the six AgentQueue actions to the deck in the order shown above.

Default localhost probing starts at `http://localhost:4173` and checks ports through `4185`, matching AgentQueue's automatic next-port behavior.

If you need a fixed URL, copy `agentqueue-streamdeck.config.example.json` to `agentqueue-streamdeck.config.json` in this plugin folder and set `baseUrl`.

The open actions call AgentQueue's local `POST /api/threads/{threadId}/open` endpoint, which opens the `codex://threads/{threadId}` deep link on this machine.
