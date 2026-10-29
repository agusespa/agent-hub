import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LastPromptStore } from './lastPrompt.js';

describe('LastPromptStore', () => {
  let dir: string;
  let hookDir: string;
  let file: string;
  const hookFile = (name: string, value: unknown) => writeFile(path.join(hookDir, `${name}.json`), JSON.stringify(value));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'last-prompt-'));
    hookDir = path.join(dir, 'last-prompt');
    file = path.join(dir, 'last-prompts.json');
    await mkdir(hookDir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads nothing before any hook has run', async () => {
    expect(await new LastPromptStore(path.join(dir, 'missing'), file).read()).toEqual(new Map());
  });

  it("copies the hooks' times into its own file, keeping the later of the two", async () => {
    await writeFile(file, JSON.stringify({ cards: { 'claude:a': 5, 'claude:b': 5 } }));
    await hookFile('claude-a', { id: 'claude:a', at: 9 });
    await hookFile('claude-b', { id: 'claude:b', at: 1 });
    await hookFile('codex-c', { id: 'codex:c', at: 7 });
    await writeFile(path.join(hookDir, 'codex-d.json'), '{"id": "codex:d"');
    const expected = new Map([['claude:a', 9], ['claude:b', 5], ['codex:c', 7]]);
    expect(await new LastPromptStore(hookDir, file).read(10)).toEqual(expected);
    expect(JSON.parse(await readFile(file, 'utf8')).cards).toEqual(Object.fromEntries(expected));
  });

  it('removes a hook file once its time is saved and it is old, and keeps the time', async () => {
    const now = 100 * 3_600_000;
    await hookFile('claude-old', { id: 'claude:old', at: now - 13 * 3_600_000 });
    await hookFile('claude-new', { id: 'claude:new', at: now });
    const store = new LastPromptStore(hookDir, file);
    await store.read(now);
    expect(await readdir(hookDir)).toEqual(['claude-new.json']);
    expect((await store.read(now)).get('claude:old')).toBe(now - 13 * 3_600_000);
  });

  it('persists recency under the permanent conversation ID as executions rotate', async () => {
    const id = 'claude:local_conversation';
    const aliases = new Map([['claude:first', id], ['claude:second', id]]);
    await writeFile(file, JSON.stringify({ cards: { [id]: 10, 'claude:first': 20, 'codex:other': 5 } }));
    await hookFile('claude-second', { id: 'claude:second', at: 30 });
    const store = new LastPromptStore(hookDir, file);
    expect(await store.read(30, aliases)).toEqual(new Map([[id, 30], ['codex:other', 5]]));
    expect(JSON.parse(await readFile(file, 'utf8')).cards).toEqual({ [id]: 30, 'codex:other': 5 });
    expect((await new LastPromptStore(hookDir, file).read(40, aliases)).get(id)).toBe(30);
  });
});
