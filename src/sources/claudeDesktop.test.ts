import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readClaudeDesktopSessions } from './claudeDesktop.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'agent-hub-desktop-sessions-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reads only the current and prior CLI IDs from account metadata', async () => {
  const dir = path.join(root, 'organization', 'account');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'local_conversation.json'), JSON.stringify({
    sessionId: 'local_conversation', cliSessionId: 'current', priorCliSessionIds: ['first', 'second'],
    title: 'Desktop title', cwd: '/code/app', createdAt: 1, lastActivityAt: 2, postTurnSummary: 'Private summary',
  }));
  await writeFile(path.join(dir, 'local_incomplete.json'), '{');
  await writeFile(path.join(dir, 'local_unfamiliar.json'), JSON.stringify({ cliSessionId: 'other', priorCliSessionIds: [null] }));
  await writeFile(path.join(dir, 'local_null.json'), 'null');
  await writeFile(path.join(dir, 'deleted_old.json'), JSON.stringify({ cliSessionId: 'deleted', priorCliSessionIds: ['old'] }));
  await mkdir(path.join(dir, 'local_directory.json'));
  expect(await readClaudeDesktopSessions(root)).toEqual([{ sessionId: 'local_conversation', cliSessionId: 'current', priorCliSessionIds: ['first', 'second'], title: 'Desktop title', cwd: '/code/app', createdAt: 1, lastActivityAt: 2 }]);
});

it('works without Claude Desktop installed', async () => {
  expect(await readClaudeDesktopSessions(path.join(root, 'missing'))).toEqual([]);
});

it('accepts conversations without prior IDs and excludes archived and misidentified metadata', async () => {
  const dir = path.join(root, 'organization', 'account');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'local_new.json'), JSON.stringify({ sessionId: 'local_new', title: 'New conversation' }));
  await writeFile(path.join(dir, 'local_archive.json'), JSON.stringify({ sessionId: 'local_archive', cliSessionId: 'archived', isArchived: true }));
  await writeFile(path.join(dir, 'local_mismatch.json'), JSON.stringify({ sessionId: 'local_wrong', cliSessionId: 'wrong' }));
  expect(await readClaudeDesktopSessions(root)).toEqual([expect.objectContaining({ sessionId: 'local_new', priorCliSessionIds: [], title: 'New conversation' })]);
});
