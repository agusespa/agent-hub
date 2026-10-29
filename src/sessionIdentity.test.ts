import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { migrateBoardState, sessionAliases } from './sessionIdentity.js';
import { NotesStore } from './notes.js';
import type { SessionRecord } from './types.js';

let dir: string;
const conversation: SessionRecord = {
  id: 'claude:local_conversation', source: 'claude', title: 'Conversation', liveStatus: null,
  aliases: ['claude:current', 'claude:second', 'claude:first'], activityId: 'claude:current',
};
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-identity-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const read = async (name: string) => JSON.parse(await readFile(path.join(dir, name), 'utf8'));

it('migrates legacy state and order once to the permanent ID, preserving unrelated cards', async () => {
  await writeFile(path.join(dir, 'placements.json'), JSON.stringify({
    placements: { 'claude:first': 'doing', 'claude:current': 'standby', 'codex:other': 'doing' },
    order: { standby: ['claude:first', 'codex:other', 'claude:current', 'claude:second'] },
  }));
  await writeFile(path.join(dir, 'notes.json'), JSON.stringify({ cards: { 'claude:first': 'Older note', 'claude:second': 'Recent note', 'codex:other': 'Unrelated note' } }));
  await writeFile(path.join(dir, 'tickets.json'), JSON.stringify({ cards: { 'claude:first': 'PROJ-1' } }));
  await migrateBoardState(dir, [conversation]);
  expect(await read('placements.json')).toEqual({
    placements: { 'claude:local_conversation': 'standby', 'codex:other': 'doing' },
    order: { standby: ['codex:other', 'claude:local_conversation'] },
  });
  expect(await read('notes.json')).toEqual({ cards: { 'claude:local_conversation': 'Recent note', 'codex:other': 'Unrelated note' } });
  expect(await read('tickets.json')).toEqual({ cards: { 'claude:local_conversation': 'PROJ-1' } });
  const modified = (await stat(path.join(dir, 'notes.json'))).mtimeMs;
  await migrateBoardState(dir, [conversation]);
  expect((await stat(path.join(dir, 'notes.json'))).mtimeMs).toBe(modified);

  // Clearing the permanent value, then restarting or rotating the CLI ID, cannot revive old data.
  await new NotesStore(path.join(dir, 'notes.json')).set(conversation.id, '');
  await migrateBoardState(dir, [{ ...conversation, aliases: ['claude:next', ...conversation.aliases!] }]);
  expect(await read('notes.json')).toEqual({ cards: { 'codex:other': 'Unrelated note' } });
});

it('preserves canonical state over legacy values and avoids moving shared aliases', async () => {
  const other = { ...conversation, id: 'claude:local_other', aliases: ['claude:shared'] };
  const original = { ...conversation, aliases: ['claude:current', 'claude:shared'] };
  await writeFile(path.join(dir, 'notes.json'), JSON.stringify({ cards: {
    [original.id]: 'Canonical note', 'claude:current': 'Legacy note', 'claude:shared': 'Ambiguous note',
  } }));
  await migrateBoardState(dir, [original, other]);
  expect(await read('notes.json')).toEqual({ cards: { [original.id]: 'Canonical note', 'claude:shared': 'Ambiguous note' } });
  expect(sessionAliases([original, other])).toEqual(new Map([['claude:current', original.id]]));
});
