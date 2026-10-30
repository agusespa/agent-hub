# Agent Hub

A local macOS app for keeping track of conversations from Claude Desktop and the Codex desktop app in one kanban board. Terminal-only sessions, IDE sessions and background agents are excluded.

## Features

- Kanban columns **Parked**, **Stand-by**, **Doing** and **Done**; sessions move to Doing when they start working. Switch **View** to **Project** for one lane per project instead.
- Working, waiting and idle status, with filters by project, source and ticket.
- One card per desktop conversation. Claude cards use the permanent Desktop conversation ID, so resuming or rewinding keeps their identity, placement, tickets and notes.
- Tickets and notes per session, and Codex titles editable from the board.
- Open sessions in Codex and project folders in VS Code.
- Hand a Claude session over to Codex to review or continue it: Claude summarizes it and a new Codex chat opens in the same folder with the prompt ready to send. The card shows the handover until the session is used again or you clear it, and the same handover cannot be repeated meanwhile.
- Plan usage and reset times, with alerts for low capacity and unused weekly capacity, an alert level and quiet hours.
- Concurrent-work warnings for sessions sharing a worktree or branch, including through edits outside their own project, with alerts when they edit the same files and, if chosen in Settings, when they start sharing.
- **Settings → Config files** lists Claude's and Codex's settings, MCP and instruction files, globally or for a project on the board, and opens the folder that holds them in VS Code.

## Install

Requires macOS, Node.js 22 or later, and Git. Install and sign in to the sources you use:

- **Claude Desktop:** install the desktop app. The `claude` command must also be available on your shell's `PATH` for internal status and plan-usage reads. Terminal sessions are never added to the board.
- **Codex:** install the desktop app at `/Applications/Codex.app`; Agent Hub uses its bundled CLI.
- **VS Code** is optional, for opening project folders.

From this repository's directory:

```sh
npm ci
npm run package
```

Move the generated `Agent Hub.app` from `out/Agent Hub-darwin-arm64/` to `/Applications` and open it.

Agent Hub only works as the desktop app: opening its address in a browser shows a notice instead of the board. To test changes in a browser during development, run `npm run dev` and open http://localhost:4317.

### Sign the app for notifications

Notifications need a signed build and macOS permission:

1. In **Xcode → Settings → Accounts**, add your Apple account, then open **Manage Certificates** and create an **Apple Development** certificate.
2. Run `npm run package` again. Packaging automatically signs the app when that certificate is in your keychain; without it, packaging prints a warning and notifications will not work.
3. Quit any running copy, replace `/Applications/Agent Hub.app` with the new build, and open it.
4. Allow notifications when prompted. **Settings → Notifications → macOS settings** opens the pane to enable them and choose a banner or alert style; **Send a test** checks they arrive.

## Configuration

**Live status** is off by default. Turn on the **Live status** switch in **Settings** for immediate updates and Codex status. It also lets Parked and Done sort by your last prompt instead of session start time. Codex concurrent-work detection requires this setting.

This adds Agent Hub hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`. Trust new Codex hooks with `/hooks` in the Codex CLI; existing sessions may need a restart. Turning it off removes only Agent Hub's hooks. Hooks save session IDs, status, last-prompt times and edited file paths.

Filters, sorting, the view and theme, card positions, tickets, notes, and handovers save automatically in `~/Library/Application Support/Agent Hub/`. Existing Claude card state migrates automatically from CLI session IDs to permanent Desktop conversation IDs. Agent Hub does not display or store prompt or transcript text; a handover summary goes only into the Codex prompt.

Sessions leave the board after 45 days without a prompt (or since session start if none was recorded), unless running, moved out of Parked, or given a ticket or notes. **Settings → Keep idle sessions** changes this to 2 weeks or 90 days. Sessions started in your home folder are not shown, as they belong to no project.
