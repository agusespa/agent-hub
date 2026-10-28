// The command Claude Code and Codex hooks run once the board's hooks are turned on (see
// src/hookInstall.ts), copied to the board's data folder next to the `agent-hub-hook` wrapper
// that starts it. It is only ever run, never imported, and needs nothing but Node.
//
// Run as `agent-hub-hook.mjs <source> <status>`. The status comes from the hook's own arguments,
// and edit events also extract changed paths. Prompts, tool contents and transcripts are never
// written. It prints nothing and always exits 0, so it never changes what the session does.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = ['claude', 'codex'];
/** `ended` clears the session's status. */
const STATUSES = ['working', 'waiting', 'idle', 'ended'];

/** Deliberately omit shell commands: their effects cannot be attributed from their arguments. */
const changedPaths = (source, event) => {
  if (event.hook_event_name !== 'PostToolUse' || typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd)) return [];
  const input = event.tool_input;
  let files = [];
  if (source === 'claude' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name)) {
    files = [input?.file_path ?? input?.notebook_path];
  } else if (source === 'codex' && event.tool_name === 'apply_patch') {
    const response = typeof event.tool_response === 'string' ? event.tool_response : event.tool_response?.output;
    // Only successful patches count. Read their path headers, never persist patch contents.
    if (typeof response !== 'string' || !response.startsWith('Success. Updated the following files:')) return [];
    if (typeof input?.command !== 'string') return [];
    files = [...input.command.matchAll(/^\*\*\* (?:Add File: |Update File: |Delete File: |Move to: )(.+)$/gm)].map((match) => match[1]);
  }
  return [...new Set(files.filter((file) => typeof file === 'string' && file.length > 0 && !file.includes('\0'))
    .map((file) => path.resolve(event.cwd, file)))];
};

const recordFileActivity = async (dataDir, source, id, event, at) => {
  const reset = ['UserPromptSubmit', 'SessionStart', 'Stop', 'StopFailure', 'Interrupt', 'SessionEnd'].includes(event.hook_event_name);
  const files = reset ? [] : changedPaths(source, event);
  if (!reset && files.length === 0) return;
  const dir = path.join(dataDir, 'file-activity');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id.replace(':', '-')}-${at}-${randomUUID()}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ id, at, files, ...(reset ? { reset: true } : {}) }));
  await rename(tmp, file);
};

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
  const payload = JSON.parse(input);
  const { session_id: sessionId, hook_event_name: event } = payload;
  if (typeof sessionId !== 'string' || !/^[\w.-]{1,128}$/.test(sessionId)) return;
  const id = `${source}:${sessionId}`;
  const name = `${source}-${sessionId}.json`;
  // First, so the board, which watches live-status/, finds it when the status lands.
  if (event === 'UserPromptSubmit') await writeLatest(path.join(dataDir, 'last-prompt', name), { id, at: now });
  // Before the status, so the refresh it triggers sees the paths; a failure here must not drop the status.
  await recordFileActivity(dataDir, source, id, payload, now).catch(() => {});
  await writeLatest(path.join(dataDir, 'live-status', name), { id, status: status === 'ended' ? null : status, at: now });
};

const now = Date.now();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  recordHookEvent(path.dirname(fileURLToPath(import.meta.url)), process.argv.slice(2), input, now).catch(() => {});
});
