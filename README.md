# Agent Hub

A local kanban board of Claude Code and Codex sessions.

## Desktop app

- `npm run app` opens the board in its own window.
- `npm run package` builds `out/Agent Hub-darwin-arm64/Agent Hub.app`. Drag it to Applications.

## Saved data

`~/Library/Application Support/Agent Hub/` holds `placements.json` (card columns and order) and `tickets.json` (the ticket you set on each card with + Ticket), both plain JSON. There are no settings. Sessions you haven't sent a prompt in for 45 days (or started in that time, if Live status saw no prompt) drop off the board unless they are running or you moved the card out of Parked or set a ticket on it.

## Data sources

The board only reads, and only through documented interfaces: the `claude` CLI and Agent SDK, and `codex app-server`. Prompt and transcript text is never shown or stored.

## Live status

Off by default. **Live status → Turn on** adds the board's hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`, the only files the board writes outside its own folder; **Turn off** removes just those. With them on, status changes show at once, Codex cards get a status too, and Parked and Done sort by when you last sent each session a prompt (otherwise by when it started). The hooks keep only the session id, the event's status and the time of your last prompt, in `live-status/` and `last-prompt/` under the saved data folder; the board copies those times to `last-prompts.json`. Codex runs a new hook only after you trust it with `/hooks` in the Codex CLI.
