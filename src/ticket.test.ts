import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTicketId, TicketStore } from './ticket.js';

describe('isTicketId', () => {
  it.each(['PROJ-1234', 'AB2-17', 'AB-1'])('accepts %s', (key) => {
    expect(isTicketId(key)).toBe(true);
  });

  it.each(['proj-1234', 'PROJ-', 'PROJ1234', '1ST-12', 'A-1', ' PROJ-1', 'PROJ-1 ', 'PROJ-12345678', 'https://x/browse/PROJ-1', 42, null])(
    'rejects %s',
    (value) => {
      expect(isTicketId(value)).toBe(false);
    },
  );
});

describe('TicketStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ticket-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts empty without a file', async () => {
    expect(await new TicketStore(path.join(dir, 'nested', 'tickets.json')).read()).toEqual(new Map());
  });

  it('keeps keys set by another instance on the same file', async () => {
    const file = path.join(dir, 'tickets.json');
    const browser = new TicketStore(file);
    const desktop = new TicketStore(file);
    await browser.set('claude:a', 'PROJ-1');
    await desktop.set('codex:b', 'PROJ-2');
    expect(await browser.read()).toEqual(new Map([['claude:a', 'PROJ-1'], ['codex:b', 'PROJ-2']]));
  });

  it('applies concurrent changes from one instance in order', async () => {
    const store = new TicketStore(path.join(dir, 'tickets.json'));
    await Promise.all([store.set('claude:a', 'PROJ-1'), store.set('claude:a', 'PROJ-2')]);
    expect((await store.read()).get('claude:a')).toBe('PROJ-2');
  });

  it('removes a key set to null', async () => {
    const store = new TicketStore(path.join(dir, 'tickets.json'));
    await store.set('claude:a', 'PROJ-1');
    await store.set('claude:a', null);
    expect(await store.read()).toEqual(new Map());
  });

  it('drops entries that are not ticket IDs', async () => {
    await writeFile(path.join(dir, 'tickets.json'), JSON.stringify({ cards: { 'claude:a': { ticket: 'PROJ-1' }, 'claude:b': 'PROJ-2' } }));
    expect(await new TicketStore(path.join(dir, 'tickets.json')).read()).toEqual(new Map([['claude:b', 'PROJ-2']]));
  });
});
