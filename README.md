# Agent Hub

A local kanban board of Claude Code and Codex sessions.

## Desktop app

- `npm run app` opens the board in its own window.
- `npm run package` builds `out/Agent Hub-darwin-arm64/Agent Hub.app`. Drag it to Applications.

## Live status

Off by default. **Live status → Turn on** enables immediate updates and Codex status, and sorts Parked and Done by your last prompt instead of session start time.

It adds hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`; **Turn off** removes only those hooks. Trust new Codex hooks with `/hooks` in the Codex CLI. Hooks save only session IDs, status and last-prompt times.

## Notifications

The desktop app alerts you when:

- A plan limit is nearly used up, or unused weekly capacity is about to reset.
- Two **Working** sessions share a Git worktree or a named branch within the same local repository. Both cards also show a **Concurrent work** warning. Alerts fire once per overlap, even with the window closed. Codex detection requires Live status.

Concurrent work warnings flag shared workspaces, not confirmed edits to the same files.

macOS notifications require permission and a signed app. `npm run package` signs with an Apple Development certificate if one is available in your keychain. Create one through Xcode → Settings → Accounts → Manage Certificates.

Test the signed build:

```sh
"out/Agent Hub-darwin-arm64/Agent Hub.app/Contents/MacOS/Agent Hub" --test-notification
```

This simulates two Working sessions, checks delivery to Notification Center, and stays open for 30 seconds. If no banner appears, check the notification style and Focus settings.

## Saved data

`~/Library/Application Support/Agent Hub/` stores card placements, tickets, usage-alert history and hook metadata as JSON.

Sessions leave the board 45 days after your last prompt (or session start if no prompt was recorded), unless running, moved out of Parked, or assigned a ticket.

## Data sources

Sessions come from the `claude` CLI and Agent SDK, and `codex app-server`. Git identifies shared worktrees and branches. Prompt and transcript text is never shown or stored.
