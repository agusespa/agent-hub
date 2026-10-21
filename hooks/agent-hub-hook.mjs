// The command Claude Code and Codex hooks run once the board's hooks are turned on (see
// src/hookInstall.ts), copied to the board's data folder next to the `agent-hub-hook` wrapper
// that starts it. It is only ever run, never imported, and needs nothing but Node.
//
// Run as `agent-hub-hook.mjs <source> <status>`. The status comes from the hook's own arguments,
// so of the event JSON on stdin only `session_id` is read: prompt, tool and transcript fields are
// dropped unread and never written. It prints nothing and always exits 0, so it never changes
// what the session does.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = ['claude', 'codex'];
/** `ended` clears the session's status. */
const STATUSES = ['working', 'waiting', 'idle', 'ended'];

/** Writes `<dir>/<source>-<session id>.json` as `{ id, status, at }`, the card id being `<source>:<session id>`. */
const recordHookEvent = async (dir, [source, status], input, now) => {
  if (!SOURCES.includes(source) || !STATUSES.includes(status)) return;
  const sessionId = JSON.parse(input).session_id;
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId)) return;
  const file = path.join(dir, `${source}-${sessionId}.json`);
  // Hooks run in the background, so a later event's hook can finish first; the later event stays.
  const previous = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  if (typeof previous?.at === 'number' && previous.at > now) return;
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ id: `${source}:${sessionId}`, status: status === 'ended' ? null : status, at: now }));
  await rename(tmp, file);
};

const now = Date.now();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live-status');
  recordHookEvent(dir, process.argv.slice(2), input, now).catch(() => {});
});
