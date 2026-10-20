# Agent Hub

A local kanban board of Claude Code and Codex sessions.

## Desktop app

- `npm run app` opens the board in its own window.
- `npm run package` builds `out/Agent Hub-darwin-arm64/Agent Hub.app`. Drag it to Applications.

## Saved data

`~/Library/Application Support/Agent Hub/` holds `placements.json` (card columns and order) and `jira.json` (the Jira key you set on each card with + Jira), both plain JSON. There are no settings. Sessions unused for 45 days drop off the board unless they are running or you moved the card out of Parked or set a Jira key on it.

## Data sources

The board only reads, and only through documented interfaces: the `claude` CLI and Agent SDK, and `codex app-server`. Prompt and transcript text is never shown or stored.
