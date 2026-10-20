import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isJiraKey, JiraKeyStore } from './jira.js';

describe('isJiraKey', () => {
  it.each(['PROJ-1234', 'AB2-17', 'AB-1'])('accepts %s', (key) => {
    expect(isJiraKey(key)).toBe(true);
  });

  it.each(['proj-1234', 'PROJ-', 'PROJ1234', '1ST-12', 'A-1', ' PROJ-1', 'PROJ-1 ', 'PROJ-12345678', 'https://x/browse/PROJ-1', 42, null])(
    'rejects %s',
    (value) => {
      expect(isJiraKey(value)).toBe(false);
    },
  );
});

describe('JiraKeyStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jira-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts empty without a file', async () => {
    expect(await new JiraKeyStore(path.join(dir, 'nested', 'jira.json')).read()).toEqual(new Map());
  });

  it('keeps keys set by another instance on the same file', async () => {
    const file = path.join(dir, 'jira.json');
    const browser = new JiraKeyStore(file);
    const desktop = new JiraKeyStore(file);
    await browser.set('claude:a', 'PROJ-1');
    await desktop.set('codex:b', 'PROJ-2');
    expect(await browser.read()).toEqual(new Map([['claude:a', 'PROJ-1'], ['codex:b', 'PROJ-2']]));
  });

  it('applies concurrent changes from one instance in order', async () => {
    const store = new JiraKeyStore(path.join(dir, 'jira.json'));
    await Promise.all([store.set('claude:a', 'PROJ-1'), store.set('claude:a', 'PROJ-2')]);
    expect((await store.read()).get('claude:a')).toBe('PROJ-2');
  });

  it('removes a key set to null', async () => {
    const store = new JiraKeyStore(path.join(dir, 'jira.json'));
    await store.set('claude:a', 'PROJ-1');
    await store.set('claude:a', null);
    expect(await store.read()).toEqual(new Map());
  });

  it('drops entries that are not keys', async () => {
    await writeFile(path.join(dir, 'jira.json'), JSON.stringify({ cards: { 'claude:a': { Jira: 'PROJ-1' }, 'claude:b': 'PROJ-2' } }));
    expect(await new JiraKeyStore(path.join(dir, 'jira.json')).read()).toEqual(new Map([['claude:b', 'PROJ-2']]));
  });
});
