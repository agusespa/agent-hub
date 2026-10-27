import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isNotInstalled, startBoardServer, type BoardServer } from './boardServer.js';
import * as claudeSource from './sources/claude.js';
import { CodexAppServer } from './sources/codex.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionRecord } from './types.js';

let dataDir: string;
let server: BoardServer | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'agent-hub-server-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  server?.close();
  server = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

/** The second board, by when usage has been read in the background. */
const boardWith = async (bins: { claudeBin: string; codexBin: string }) => {
  server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), ...bins });
  await fetch(`${server.url}/api/board`).then((response) => response.json());
  await new Promise((resolve) => setTimeout(resolve, 50));
  return (await fetch(`${server.url}/api/board`)).json();
};

describe('isNotInstalled', () => {
  it('is true for a missing command, also when wrapped as the cause', () => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    expect(isNotInstalled(missing)).toBe(true);
    expect(isNotInstalled(new Error('codex app-server: spawn codex ENOENT', { cause: missing }))).toBe(true);
    expect(isNotInstalled(new Error('codex app-server exited (1)'))).toBe(false);
    expect(isNotInstalled(undefined)).toBe(false);
  });
});

describe('board sources', () => {
  it('leaves out a source that is not installed and still shows the other one failing', async () => {
    const board = await boardWith({ claudeBin: path.join(dataDir, 'no-claude'), codexBin: '/usr/bin/false' });
    expect(board.missingSources).toEqual(['claude']);
    expect(board.errors).toEqual([expect.stringMatching(/^Codex: codex app-server exited/)]);
    expect(board.usage.map((usage: { source: string }) => usage.source)).toEqual(['codex']);
  });

  it('says so when neither source is installed', async () => {
    const board = await boardWith({ claudeBin: path.join(dataDir, 'no-claude'), codexBin: path.join(dataDir, 'no-codex') });
    expect(board.missingSources.sort()).toEqual(['claude', 'codex']);
    expect(board.errors).toEqual([expect.stringContaining('Neither Claude Code nor Codex was found')]);
    expect(board.usage).toEqual([]);
    expect(board.cards).toEqual([]);
  });
});

describe('hooks', () => {
  const noSources = () => ({ claudeBin: path.join(dataDir, 'no-claude'), codexBin: path.join(dataDir, 'no-codex') });

  it('turns the hooks on in the tools found under home', async () => {
    const home = path.join(dataDir, 'home');
    await mkdir(path.join(home, '.codex'), { recursive: true });
    server = await startBoardServer({ dataDir, port: 0, home, ...noSources() });
    expect((await (await fetch(`${server.url}/api/board`)).json()).hooks).toEqual({ claude: 'unavailable', codex: 'off' });
    const response = await fetch(`${server.url}/api/hooks`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true }),
    });
    expect(await response.json()).toEqual({ hooks: { claude: 'unavailable', codex: 'on' } });
    expect(await readFile(path.join(home, '.codex', 'hooks.json'), 'utf8')).toContain('agent-hub-hook');
    expect((await (await fetch(`${server.url}/api/board`)).json()).hooks.codex).toBe('on');
  });

  it('tells open pages when a hook reports a status', async () => {
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), ...noSources() });
    const controller = new AbortController();
    const events = await fetch(`${server.url}/api/events`, { signal: controller.signal });
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader();
    await reader.read(); // the retry line
    await writeFile(path.join(dataDir, 'live-status', 'codex-a.json'), JSON.stringify({ id: 'codex:a', status: 'working', at: Date.now() }));
    expect((await reader.read()).value).toBe('event: board\ndata: \n\n');
    controller.abort();
  });
});

describe('concurrent work alerts', () => {
  it('includes conflicts on the board and notifies only when a Working overlap starts', async () => {
    const repo = path.join(dataDir, 'repo');
    await mkdir(repo);
    await promisify(execFile)('git', ['init', '--initial-branch=main'], { cwd: repo });
    const records: SessionRecord[] = [
      { id: 'claude:a', source: 'claude', title: 'Implement', cwd: repo, liveStatus: 'working' },
      { id: 'codex:b', source: 'codex', title: 'Review', cwd: repo, liveStatus: 'working' },
    ];
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockImplementation(async () => [{ ...records[0] }]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockImplementation(async () => [{ ...records[1] }]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    const notify = vi.fn();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), onConflictAlert: notify });
    // No page has requested the board: the desktop monitor still notifies.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    expect((await read()).conflicts).toEqual([expect.objectContaining({ kind: 'worktree', sessionIds: ['claude:a', 'codex:b'] })]);
    expect(notify).toHaveBeenCalledTimes(1);
    await read();
    expect(notify).toHaveBeenCalledTimes(1);
    records[1].liveStatus = 'waiting';
    expect((await read()).conflicts).toEqual([]);
    records[1].liveStatus = 'working';
    await read();
    expect(notify).toHaveBeenCalledTimes(2);
    records[0].liveStatus = 'idle';
    expect((await read()).conflicts).toEqual([]);
  });
});
