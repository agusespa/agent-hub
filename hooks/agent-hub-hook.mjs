// The command Claude Code and Codex hooks run once the board's hooks are turned on (see
// src/hookInstall.ts), copied to the board's data folder next to the `agent-hub-hook` wrapper
// that starts it. It is only ever run, never imported, and needs nothing but Node.
//
// Run as `agent-hub-hook.mjs <source> <status>`. The status comes from the hook's own arguments,
// so of the event JSON on stdin only `session_id` and `hook_event_name` are read: prompt, tool and
// transcript fields are dropped unread and never written. It prints nothing and always exits 0,
// so it never changes what the session does.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = ['claude', 'codex'];
/** `ended` clears the session's status. */
const STATUSES = ['working', 'waiting', 'idle', 'ended'];

/** Writes `value` to `file` unless the file already holds a later event's. */
const writeLatest = async (file, value) => {
  // Hooks run in the background, so a later event's hook can finish first; the later event stays.
  const previous = await readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  if (typeof previous?.at === 'number' && previous.at > value.at) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
};

/**
 * Writes `live-status/<source>-<session id>.json` as `{ id, status, at }`, the card id being
 * `<source>:<session id>`. A prompt the user sent also writes `last-prompt/` the same way as
 * `{ id, at }`, in a file of its own so a tool event landing at the same time can't drop it.
 */
const recordHookEvent = async (dataDir, [source, status], input, now) => {
  if (!SOURCES.includes(source) || !STATUSES.includes(status)) return;
  const { session_id: sessionId, hook_event_name: event } = JSON.parse(input);
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId)) return;
  const id = `${source}:${sessionId}`;
  const name = `${source}-${sessionId}.json`;
  // First, so the board, which watches live-status/, finds it when the status lands.
  if (event === 'UserPromptSubmit') await writeLatest(path.join(dataDir, 'last-prompt', name), { id, at: now });
  await writeLatest(path.join(dataDir, 'live-status', name), { id, status: status === 'ended' ? null : status, at: now });
};

const now = Date.now();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  recordHookEvent(path.dirname(fileURLToPath(import.meta.url)), process.argv.slice(2), input, now).catch(() => {});
});
