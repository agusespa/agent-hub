import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlacementStore } from './placements.js';

describe('PlacementStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'placements-'));
    file = path.join(dir, 'nested', 'placements.json');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts empty without a file', async () => {
    expect(await new PlacementStore(file).read()).toEqual({ columns: new Map(), order: {} });
  });

  it('persists moves for a later instance', async () => {
    await new PlacementStore(file).set('claude:a', 'doing');
    expect((await new PlacementStore(file).read()).columns).toEqual(new Map([['claude:a', 'doing']]));
  });

  it('keeps moves made by another instance on the same file', async () => {
    const browser = new PlacementStore(file);
    const desktop = new PlacementStore(file);
    await browser.set('claude:a', 'doing');
    await desktop.set('codex:b', 'done');
    expect((await browser.read()).columns).toEqual(new Map([['claude:a', 'doing'], ['codex:b', 'done']]));
  });

  it('applies concurrent moves from one instance in order', async () => {
    const store = new PlacementStore(file);
    await Promise.all([store.set('claude:a', 'doing'), store.set('claude:a', 'done'), store.set('codex:b', 'standby')]);
    expect((await store.read()).columns).toEqual(new Map([['claude:a', 'done'], ['codex:b', 'standby']]));
  });

  it('drops placements in columns that no longer exist', async () => {
    await new PlacementStore(file).set('claude:a', 'doing');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(
      file,
      JSON.stringify({ placements: { ...saved.placements, 'claude:old': 'pr-open' }, order: { 'pr-open': ['claude:old'] } }),
    );
    expect(await new PlacementStore(file).read()).toEqual({ columns: new Map([['claude:a', 'doing']]), order: {} });
  });

  it('saves a column order and takes reordered cards out of other columns', async () => {
    const store = new PlacementStore(file);
    await store.set('claude:a', 'doing', ['claude:a', 'codex:b']);
    await store.set('codex:b', 'done', ['codex:b']);
    expect((await store.read()).order).toEqual({ doing: ['claude:a'], done: ['codex:b'] });
  });

  it('keeps the order when a move does not give one', async () => {
    const store = new PlacementStore(file);
    await store.set('claude:a', 'doing', ['codex:b', 'claude:a']);
    await store.set('claude:a', 'done');
    expect(await store.read()).toEqual({
      columns: new Map([['claude:a', 'done']]),
      order: { doing: ['codex:b', 'claude:a'] },
    });
  });
});
