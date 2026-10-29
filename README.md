# Agent Hub

A local macOS app for keeping track of Claude Code and Codex sessions in one kanban board.

## Features

- Kanban columns **Parked**, **Stand-by**, **Doing** and **Done**; sessions move to Doing when they start working.
- Working, waiting and idle status, with filters by repository, source and ticket.
- Tickets and notes per session, and Codex titles editable from the board.
- Open sessions in Codex and project folders in VS Code.
- Plan usage and reset times, with alerts for low capacity and unused weekly capacity.
- Concurrent-work warnings for sessions sharing a worktree or branch, including through edits outside their own project, with an alert when they edit the same files.

## Install

Requires macOS, Node.js 22 or later, and Git. Install and sign in to the sources you use:

- **Claude Code:** the `claude` command must be available on your shell's `PATH`.
- **Codex:** install the desktop app at `/Applications/Codex.app`; Agent Hub uses its bundled CLI.
- **VS Code** is optional, for opening project folders.

From this repository's directory:

```sh
npm ci
npm run package
```

Move the generated `Agent Hub.app` from `out/Agent Hub-darwin-arm64/` to `/Applications` and open it.

### Sign the app for notifications

Notifications need a signed build and macOS permission:

1. In **Xcode → Settings → Accounts**, add your Apple account, then open **Manage Certificates** and create an **Apple Development** certificate.
2. Run `npm run package` again. Packaging automatically signs the app when that certificate is in your keychain; without it, packaging prints a warning and notifications will not work.
3. Quit any running copy, replace `/Applications/Agent Hub.app` with the new build, and open it.
4. Allow notifications when prompted. Check **System Settings → Notifications → Agent Hub** to enable notifications and choose a banner or alert style.

## Configuration

**Live status** is off by default. Choose **Live status → Turn on** for immediate updates and Codex status. It also lets Parked and Done sort by your last prompt instead of session start time. Codex concurrent-work detection requires this setting.

This adds Agent Hub hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`. Trust new Codex hooks with `/hooks` in the Codex CLI; existing sessions may need a restart. **Turn off** removes only Agent Hub's hooks. Hooks save session IDs, status, last-prompt times and edited file paths.

Filters, sorting, card positions, tickets, and notes save automatically in `~/Library/Application Support/Agent Hub/`. Agent Hub does not display or store prompt or transcript text.

Sessions leave the board after 45 days without a prompt (or since session start if none was recorded), unless running, moved out of Parked, or given a ticket or notes.
