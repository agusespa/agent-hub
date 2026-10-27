import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isNotesText, MAX_NOTES_LENGTH, NotesStore } from './notes.js';

describe('local notes', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-notes-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('persists multiline notes across store instances without changing other cards', async () => {
    const file = path.join(dir, 'notes.json');
    const first = new NotesStore(file);
    const second = new NotesStore(file);
    expect(await first.read()).toEqual(new Map());
    const text = 'Review migration\n\nCheck <staging> & Swedish characters: åäö';
    await Promise.all([first.set('claude:a', text), second.set('codex:b', 'Check tests')]);
    expect(await new NotesStore(file).read()).toEqual(new Map([['claude:a', text], ['codex:b', 'Check tests']]));
    await second.set('claude:a', '');
    expect(await first.read()).toEqual(new Map([['codex:b', 'Check tests']]));
  });

  it('keeps the latest edit when saves are queued', async () => {
    const store = new NotesStore(path.join(dir, 'notes.json'));
    await Promise.all([store.set('codex:a', 'First'), store.set('codex:a', 'Updated')]);
    expect((await store.read()).get('codex:a')).toBe('Updated');
  });

  it('rejects invalid note values and ignores invalid saved entries', async () => {
    expect(isNotesText('')).toBe(true);
    expect(isNotesText('x'.repeat(MAX_NOTES_LENGTH))).toBe(true);
    for (const value of [null, 4, {}, 'x'.repeat(MAX_NOTES_LENGTH + 1)]) expect(isNotesText(value)).toBe(false);
    const file = path.join(dir, 'notes.json');
    await writeFile(file, JSON.stringify({ cards: { 'claude:a': { text: 'wrong shape' }, 'codex:b': 'Saved note' } }));
    expect(await new NotesStore(file).read()).toEqual(new Map([['codex:b', 'Saved note']]));
  });
});
