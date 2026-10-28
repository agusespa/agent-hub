import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServer, mapCodexRateLimits, mapCodexThread, repoNameFromRemote, windowLabel, type CodexThread, type RateLimitsResult } from './codex.js';

describe('Codex title persistence', () => {
  it.each([false, true])('checks the persisted title after renaming (discard write: %s)', async (discardWrite) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'agent-hub-codex-title-'));
    const bin = path.join(directory, 'codex');
    await writeFile(bin, `#!/usr/bin/env node
const readline = require('node:readline');
let name = 'Old title';
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return console.log(JSON.stringify({ id, result: {} }));
  if (params.threadId !== 'test-thread') return console.log(JSON.stringify({ id, error: { message: 'Wrong thread id' } }));
  if (method === 'thread/name/set') { if (!${discardWrite}) name = params.name; return console.log(JSON.stringify({ id, result: {} })); }
  if (method === 'thread/read' && params.includeTurns === false) return console.log(JSON.stringify({ id, result: { thread: { id: params.threadId, name } } }));
  console.log(JSON.stringify({ id, error: { message: 'Unsupported request' } }));
});
`, { mode: 0o755 });
    const server = new CodexAppServer(bin);
    try {
      const rename = server.renameThread('test-thread', 'New title');
      if (discardWrite) await expect(rename).rejects.toThrow('did not retain');
      else await expect(rename).resolves.toBeUndefined();
    } finally {
      server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// Shape of a real `thread/list` item; text fields replaced with placeholders.
const thread = {
  id: '01a157fe-a8bc-7103-9a26-757b4b491657',
  sessionId: '01a157fe-a8bc-7103-9a26-757b4b491657',
  preview: 'prompt text that must not reach the board',
  ephemeral: false,
  modelProvider: 'openai',
  createdAt: 1792477669,
  updatedAt: 1792480824,
  recencyAt: 1792480449,
  status: { type: 'notLoaded' },
  cwd: '/Users/me/Code/my-app',
  source: 'vscode',
  originator: 'Codex Desktop',
  gitInfo: { sha: '641d705b', branch: 'feature/PROJ-7-thing', originUrl: 'git@github.com:acme/my-app.git' },
  name: 'Thread title',
} as CodexThread;

describe('mapCodexThread', () => {
  it('maps the thread to a session record without prompt text', () => {
    const record = mapCodexThread(thread);
    expect(record).toEqual({
      id: 'codex:01a157fe-a8bc-7103-9a26-757b4b491657',
      source: 'codex',
      title: 'Thread title',
      renameId: thread.id,
      cwd: '/Users/me/Code/my-app',
      branch: 'feature/PROJ-7-thing',
      repoHint: 'my-app',
      liveStatus: null,
      lastActiveAt: 1792480449000,
      createdAt: 1792477669000,
      openId: '01a157fe-a8bc-7103-9a26-757b4b491657',
    });
    expect(JSON.stringify(record)).not.toContain('prompt text');
  });

  it('uses updatedAt when there is no recencyAt', () => {
    expect(mapCodexThread({ ...thread, recencyAt: null }).lastActiveAt).toBe(1792480824000);
  });

  it('handles threads without a name or git info', () => {
    expect(mapCodexThread({ id: '019e3f8b-286d', name: null, gitInfo: null })).toMatchObject({
      title: 'Codex thread 019e3f8b',
      branch: undefined,
      repoHint: undefined,
      lastActiveAt: undefined,
    });
  });
});

describe('repoNameFromRemote', () => {
  it.each([
    ['git@github.com:acme/my-app.git', 'my-app'],
    ['https://github.com/acme/my-app', 'my-app'],
    ['https://github.com/acme/my-app.git/', 'my-app'],
    [null, undefined],
    ['', undefined],
  ])('%s → %s', (url, expected) => {
    expect(repoNameFromRemote(url)).toBe(expected);
  });
});

describe('mapCodexRateLimits', () => {
  // Shape of a real `account/rateLimits/read` answer; ids replaced with placeholders.
  const main = {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 51, windowDurationMins: 300, resetsAt: 1792496071 },
    secondary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1793082871 },
    credits: { hasCredits: true, unlimited: false, balance: null },
    planType: 'team',
  };
  const result = {
    ordinaryUsageAllowed: true,
    rateLimits: main,
    rateLimitsByLimitId: { codex: main },
    rateLimitResetCredits: { availableCount: 1, credits: [] },
    accountId: 'account-id-that-must-not-reach-the-board',
  } as RateLimitsResult;

  it('maps the 5-hour and weekly windows without account details', () => {
    const usage = mapCodexRateLimits(result, 7);
    expect(usage).toEqual({
      source: 'codex',
      plan: 'team',
      fetchedAt: 7,
      windows: [
        { label: '5h', usedPercent: 51, resetsAt: 1792496071000 },
        { label: 'Weekly', usedPercent: 8, resetsAt: 1793082871000 },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain('account-id');
  });

  it('adds other limit buckets under their names', () => {
    const other = { limitId: 'codex_mini', limitName: 'Mini', primary: { usedPercent: 3, windowDurationMins: 300 } };
    const usage = mapCodexRateLimits({ ...result, rateLimitsByLimitId: { codex: main, codex_mini: other } });
    expect(usage.windows.map((window) => window.label)).toEqual(['5h', 'Weekly', '5h Mini']);
  });
});

describe('windowLabel', () => {
  it.each([
    [300, '5h'],
    [60, '1h'],
    [10080, 'Weekly'],
    [1440, '1d'],
    [null, 'Limit'],
  ])('%s → %s', (minutes, expected) => {
    expect(windowLabel(minutes)).toBe(expected);
  });
});
