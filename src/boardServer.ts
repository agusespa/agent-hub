import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { cardsStartedWorking, isOnBoard, orderCards, toCard } from './board.js';
import { PROJECT_ROOT } from './app.js';
import { ConflictAlerts, sessionConflicts, type SessionConflict } from './conflicts.js';
import { FILE_ACTIVITY_DIR, FileActivityStore } from './fileActivity.js';
import { repoNameForCwd } from './git.js';
import { HookInstaller, type HookState } from './hookInstall.js';
import { HOOK_STATUS_DIR, HookStatusMerge, HookStatusStore, lastEventBySource } from './hookStatus.js';
import { LAST_PROMPT_DIR, LastPromptStore } from './lastPrompt.js';
import { isTicketId, TicketStore } from './ticket.js';
import { openInApp, projectUrl, sessionUrl } from './openSession.js';
import { PlacementStore } from './placements.js';
import { isNotesText, NotesStore } from './notes.js';
import { isViewPatch, ViewStore, type ViewSettings } from './view.js';
import { CLAUDE_BIN, fetchClaudeSessions, fetchClaudeUsage } from './sources/claude.js';
import { CODEX_BIN, CodexAppServer } from './sources/codex.js';
import { COLUMNS, isColumnId, type Card, type LiveStatus, type PlanUsage, type SessionRecord, type Source } from './types.js';
import { UsageMeter } from './usage.js';
import { UsageAlertLog, usageAlerts, type UsageAlert } from './usageAlerts.js';

interface Board {
  columns: typeof COLUMNS;
  cards: Card[];
  conflicts: SessionConflict[];
  view: ViewSettings;
  usage: PlanUsage[];
  errors: string[];
  /** Sources whose command was not found, which the board leaves out without an error. */
  missingSources: Source[];
  /** Whether the board's hooks are in each tool's config. */
  hooks: Record<Source, HookState>;
  /** When each source's hooks last reported, within the 12 hours status files are kept. */
  lastHookEvents: Partial<Record<Source, number>>;
  pollIntervalMs: number;
  liveReload: boolean;
  generatedAt: number;
}

const SOURCE_NAMES: Record<Source, string> = { claude: 'Claude', codex: 'Codex' };

/** How often open pages ask for a new board. */
const POLL_INTERVAL_MS = 5000;

/** How often usage is checked for alerts, with or without a page open. */
const USAGE_ALERT_INTERVAL_MS = 60_000;

/** A command that is not on PATH or not where the app installs it; Codex wraps the spawn error as the cause. */
export const isNotInstalled = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || (error instanceof Error && error.cause !== undefined && isNotInstalled(error.cause));

/**
 * A source's sessions, or none when it fails. A failure shows as an error, except a source
 * that is not installed, which goes in `missing` instead and is tried again on the next
 * poll, so installing it later needs no restart.
 */
const settle = async (source: Source, load: Promise<SessionRecord[]>, errors: string[], missing: Set<Source>): Promise<SessionRecord[]> => {
  const name = SOURCE_NAMES[source];
  try {
    const records = await load;
    if (missing.delete(source)) console.log(`${name} found`);
    return records;
  } catch (error) {
    if (isNotInstalled(error)) {
      if (!missing.has(source)) console.log(`${name} is not installed; leaving it off the board`);
      missing.add(source);
      return [];
    }
    missing.delete(source);
    const message = `${name}: ${(error as Error).message.split('\n')[0]}`;
    errors.push(message);
    console.warn(message);
    return [];
  }
};

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/base.css': { file: 'base.css', type: 'text/css; charset=utf-8' },
  '/toolbar.css': { file: 'toolbar.css', type: 'text/css; charset=utf-8' },
  '/board.css': { file: 'board.css', type: 'text/css; charset=utf-8' },
  '/cards.css': { file: 'cards.css', type: 'text/css; charset=utf-8' },
  '/details.css': { file: 'details.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
};

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const isCardId = (value: unknown): value is string => typeof value === 'string' && /^(claude|codex):[\w.-]+$/.test(value);

/** A column's full card order, which has to include the card being moved. Optional. */
const isColumnOrder = (value: unknown, cardId: string): value is string[] | undefined =>
  value === undefined || (Array.isArray(value) && value.length <= 2000 && value.every(isCardId) && value.includes(cardId));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A request's JSON object body; anything else is answered with a 4xx. */
const readJson = async (req: http.IncomingMessage, limit = 4096): Promise<Record<string, unknown>> => {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'expected JSON');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, 'body too large');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (typeof parsed !== 'object' || parsed === null) throw new HttpError(400, 'expected a JSON object');
  return parsed as Record<string, unknown>;
};

export interface BoardServer {
  url: string;
  close: () => void;
}

/**
 * Serves the board page and its API on 127.0.0.1. Port 0 picks a free port, which is
 * what the desktop app uses. `liveReload` reloads open pages when `public/` changes.
 * `onUsageAlert` gets each usage alert once; the desktop app shows them as notifications.
 * `claudeBin`, `codexBin` and `home` (where the tools' hook configs are) are only changed by tests.
 */
export const startBoardServer = async ({
  dataDir,
  port,
  liveReload = false,
  onUsageAlert,
  onConflictAlert,
  claudeBin = CLAUDE_BIN,
  codexBin = CODEX_BIN,
  home,
}: {
  dataDir: string;
  port: number;
  liveReload?: boolean;
  onUsageAlert?: (alert: UsageAlert) => void;
  onConflictAlert?: (conflict: SessionConflict, cards: Card[]) => void;
  claudeBin?: string;
  codexBin?: string;
  home?: string;
}): Promise<BoardServer> => {
  const placements = new PlacementStore(path.join(dataDir, 'placements.json'));
  const tickets = new TicketStore(path.join(dataDir, 'tickets.json'));
  const notes = new NotesStore(path.join(dataDir, 'notes.json'));
  const view = new ViewStore(path.join(dataDir, 'view.json'));
  const lastPrompts = new LastPromptStore(path.join(dataDir, LAST_PROMPT_DIR), path.join(dataDir, 'last-prompts.json'));
  const codex = new CodexAppServer(codexBin);
  const hookStatuses = new HookStatusStore(path.join(dataDir, HOOK_STATUS_DIR));
  const hookMerge = new HookStatusMerge();
  const hookInstaller = new HookInstaller(dataDir, home);
  let hookState = await hookInstaller.state();
  // The hook script follows app updates; the hook commands in the tools' configs stay as they are.
  if (Object.values(hookState).includes('on')) await hookInstaller.writeScript();
  const allowedHosts = new Set<string>();
  const claudeUsageCwd = path.join(dataDir, 'claude-usage');
  const usage = new UsageMeter({
    // Claude's usage endpoint is tightly rate limited and shared with the app's own usage views.
    claude: { read: () => fetchClaudeUsage(claudeBin, claudeUsageCwd), ttlMs: 30 * 60_000, retryMs: 60 * 60_000 },
    codex: { read: () => codex.readUsage(), ttlMs: 60_000 },
  });

  // Each card's live status on the last board, to see which sessions started working. Cards
  // missing from a board, as when a source fails to load, keep their last status.
  const lastStatuses = new Map<string, LiveStatus | null>();
  const missing = new Set<Source>();
  const conflictAlerts = new ConflictAlerts();
  const fileActivity = new FileActivityStore(path.join(dataDir, FILE_ACTIVITY_DIR));

  // Usage is checked for alerts on its own timer, since pages only poll while the board is
  // open. Each check reads the last answers; the reads it starts show in the next one.
  const alertLog = new UsageAlertLog(path.join(dataDir, 'usage-alerts.json'));
  const alertTimer = onUsageAlert
    ? setInterval(() => {
        alertLog
          .take(usageAlerts(usage.get(missing)))
          .then((alerts) => {
            for (const alert of alerts) {
              console.log(`Usage alert: ${alert.title}`);
              onUsageAlert(alert);
            }
          })
          .catch((error: Error) => console.warn(`Usage alerts: ${error.message}`));
      }, USAGE_ALERT_INTERVAL_MS)
    : undefined;

  const buildBoard = async (): Promise<Board> => {
    const errors: string[] = [];
    const [claude, codexThreads, placed, keys, hooked, prompted, savedNotes, savedView] = await Promise.all([
      settle('claude', fetchClaudeSessions(claudeBin, claudeUsageCwd), errors, missing),
      settle('codex', codex.listThreads(), errors, missing),
      placements.read(),
      tickets.read(),
      hookStatuses.read(),
      lastPrompts.read(),
      notes.read(),
      view.read(),
    ]);
    if (missing.size === Object.keys(SOURCE_NAMES).length) {
      errors.push(`Neither Claude Code nor Codex was found: no \`${claudeBin}\` on PATH and no ${codexBin}. Install one.`);
    }
    const records = hookMerge.apply([...claude, ...codexThreads], hooked).filter((record) =>
      isOnBoard(record, { placement: placed.columns.get(record.id), ticket: keys.get(record.id), notes: savedNotes.get(record.id), lastPromptAt: prompted.get(record.id) }),
    );
    const cards = await Promise.all(
      records.map(async (record) =>
        toCard(record, {
          repo: record.repoHint ?? (await repoNameForCwd(record.cwd)),
          placement: placed.columns.get(record.id),
          ticket: keys.get(record.id),
          notes: savedNotes.get(record.id),
          lastPromptAt: prompted.get(record.id),
        }),
      ),
    );
    const started = cardsStartedWorking(cards, lastStatuses, placed.columns);
    for (const card of cards) lastStatuses.set(card.id, card.liveStatus);
    if (started.length > 0) {
      // Started cards go on top of Doing and the others keep their place, all saved in
      // that order so none of them jumps when its status changes later.
      const doing = orderCards(cards, placed.order).filter((card) => card.column === 'doing');
      placed.order.doing = [...started, ...doing].map((card) => card.id);
      for (const card of started) {
        await placements.set(card.id, 'doing', placed.order.doing);
        card.column = 'doing';
        console.log(`Moved ${card.id} to doing: it started working`);
      }
    }
    // File tracking only enriches the early warning; a tracking failure must not suppress it.
    const changedFiles = await fileActivity.read().catch((error: Error) => {
      console.warn(`File activity: ${error.message}`);
      return new Map<string, string[]>();
    });
    const conflicts = await sessionConflicts(cards, undefined, changedFiles);
    const unavailable = [...missing, ...Object.entries(SOURCE_NAMES)
      .filter(([, name]) => errors.some((error) => error.startsWith(`${name}:`)))
      .map(([source]) => source)];
    for (const conflict of conflictAlerts.take(conflicts, unavailable)) onConflictAlert?.(conflict, cards);
    return {
      columns: COLUMNS,
      cards: orderCards(cards, placed.order),
      conflicts,
      view: savedView,
      usage: usage.get(missing),
      errors,
      missingSources: [...missing],
      hooks: hookState,
      lastHookEvents: lastEventBySource(hooked),
      pollIntervalMs: POLL_INTERVAL_MS,
      liveReload,
      generatedAt: Date.now(),
    };
  };

  // Several open tabs polling at once share one build. A save drops it, so the
  // next poll does not get a board read before the save.
  let inFlight: Promise<Board> | undefined;
  // The last board sent, which is enough to check that a card is on it.
  let lastBoard: Board | undefined;
  const getBoard = (): Promise<Board> => {
    inFlight ??= buildBoard()
      .then((board) => (lastBoard = board))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  // Desktop alerts keep working when the board window is closed or in the background.
  const conflictTimer = onConflictAlert ? setInterval(() => {
    void getBoard().catch((error: Error) => console.warn(`Session conflicts: ${error.message}`));
  }, POLL_INTERVAL_MS) : undefined;

  // Pages listening for changes: `board` when a hook reports a session's status, so they
  // load the board at once, and with `liveReload`, `reload` when public/ changes. A server
  // restart drops them too, and with `liveReload` the page reloads when it reconnects.
  const eventClients = new Set<http.ServerResponse>();
  const sendEvent = (event: string) => {
    for (const client of eventClients) client.write(`event: ${event}\ndata: \n\n`);
  };
  const stopWatchingHooks = await hookStatuses.watch(() => {
    inFlight = undefined;
    sendEvent('board');
  });
  let reloadTimer: NodeJS.Timeout | undefined;
  const publicWatcher = liveReload
    ? watch(path.join(PROJECT_ROOT, 'public'), () => {
        // Editors save in several writes; reload once they are done.
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => sendEvent('reload'), 100);
      })
    : undefined;

  const server = http.createServer(async (req, res) => {
    // Rejects pages on other origins that reach this port through DNS rebinding.
    if (!allowedHosts.has(req.headers.host ?? '')) return sendJson(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/api/board') return sendJson(res, 200, await getBoard());

      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(`retry: ${liveReload ? 500 : POLL_INTERVAL_MS}\n\n`);
        eventClients.add(res);
        req.on('close', () => eventClients.delete(res));
        return;
      }

      if (req.method === 'PUT' && url.pathname === '/api/hooks') {
        const { on } = await readJson(req);
        if (typeof on !== 'boolean') return sendJson(res, 400, { error: 'invalid hooks setting' });
        try {
          await hookInstaller.set(on);
        } finally {
          // Also after a failure, which can leave one tool changed and not the other.
          hookState = await hookInstaller.state();
          inFlight = undefined;
        }
        console.log(`Turned hooks ${on ? 'on' : 'off'}: ${JSON.stringify(hookState)}`);
        return sendJson(res, 200, { hooks: hookState });
      }

      if (req.method === 'PUT' && url.pathname === '/api/placement') {
        const { id, column, order } = await readJson(req, 64 * 1024);
        if (!isCardId(id) || !isColumnId(column) || !isColumnOrder(order, id)) {
          return sendJson(res, 400, { error: 'invalid placement' });
        }
        await placements.set(id, column, order);
        inFlight = undefined;
        console.log(`Moved ${id} to ${column}`);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'PUT' && url.pathname === '/api/ticket') {
        const { id, key } = await readJson(req);
        if (!isCardId(id) || !(key === null || isTicketId(key))) return sendJson(res, 400, { error: 'invalid ticket' });
        await tickets.set(id, key);
        inFlight = undefined;
        console.log(key ? `Set ${key} on ${id}` : `Removed the ticket from ${id}`);
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'PUT' && url.pathname === '/api/view') {
        const patch = await readJson(req, 128 * 1024);
        if (!isViewPatch(patch)) return sendJson(res, 400, { error: 'invalid view settings' });
        await view.update(patch);
        inFlight = undefined;
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'PUT' && url.pathname === '/api/notes') {
        const { id, text } = await readJson(req, 128 * 1024);
        if (!isCardId(id) || !isNotesText(text)) return sendJson(res, 400, { error: 'invalid notes' });
        await notes.set(id, text);
        inFlight = undefined;
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/open') {
        const { id, target = 'session' } = await readJson(req);
        if (target !== 'session' && target !== 'vscode') return sendJson(res, 400, { error: 'invalid open target' });
        // Only sessions on the board, so the page cannot make the board open arbitrary links.
        const card = isCardId(id) ? (lastBoard ?? (await getBoard())).cards.find((c) => c.id === id) : undefined;
        const link = card && (target === 'vscode' ? await projectUrl(card) : sessionUrl(card));
        if (!link) return sendJson(res, 400, { error: target === 'vscode' ? 'This session has no existing project folder' : 'This session cannot be opened from the board' });
        await openInApp(link);
        console.log(`Opened ${id}`);
        return sendJson(res, 200, { ok: true });
      }

      const asset = req.method === 'GET' ? STATIC_FILES[url.pathname] : undefined;
      if (asset) {
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
        return res.end(await readFile(path.join(PROJECT_ROOT, 'public', asset.file)));
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      console.error(`${req.method} ${url.pathname} failed:`, error);
      sendJson(res, 500, { error: (error as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const { port: boundPort } = server.address() as AddressInfo;
  allowedHosts.add(`localhost:${boundPort}`).add(`127.0.0.1:${boundPort}`);

  return {
    url: `http://localhost:${boundPort}`,
    close: () => {
      clearInterval(alertTimer);
      clearInterval(conflictTimer);
      codex.stop();
      stopWatchingHooks();
      publicWatcher?.close();
      for (const client of eventClients) client.end();
      server.close();
    },
  };
};
