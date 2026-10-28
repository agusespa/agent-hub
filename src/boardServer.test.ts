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
import * as sessionOpening from './openSession.js';
import { FileActivityStore } from './fileActivity.js';

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
  it('shows a shared workspace on the board, alerts only for shared files, and keeps the board warning if tracking fails', async () => {
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
    const activity = path.join(dataDir, 'file-activity');
    await mkdir(activity);
    const at = Date.now();
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    const write = (name: string, value: object) => writeFile(path.join(activity, `${name}.json`), JSON.stringify(value));
    const shared = path.join(repo, 'shared.ts');
    // Sharing a worktree is a board warning only, even once the desktop monitor has checked.
    await vi.advanceTimersByTimeAsync(5000);
    expect((await read()).conflicts).toEqual([expect.objectContaining({ kind: 'worktree', files: [] })]);
    await write('claude-edit', { id: 'claude:a', at, files: [shared] });
    await write('codex-other', { id: 'codex:b', at, files: [path.join(repo, 'other.ts')] });
    expect((await read()).conflicts[0].files).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
    await write('codex-edit', { id: 'codex:b', at, files: [shared] });
    // The desktop monitor delivers the alert without a page poll.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect((await read()).conflicts).toEqual([expect.objectContaining({ kind: 'worktree', sessionIds: ['claude:a', 'codex:b'], files: ['shared.ts'] })]);
    // Neither a new turn with the same overlap nor answering a permission prompt repeats it.
    await write('claude-turn', { id: 'claude:a', at: at + 1, files: [], reset: true });
    expect((await read()).conflicts[0].files).toEqual([]);
    await write('claude-again', { id: 'claude:a', at: at + 2, files: [shared] });
    records[1].liveStatus = 'waiting';
    expect((await read()).conflicts[0].files).toEqual(['shared.ts']);
    records[1].liveStatus = 'working';
    await read();
    expect(notify).toHaveBeenCalledTimes(1);
    // Once a turn ends the overlap rearms, but only new shared edits alert again.
    records[0].liveStatus = 'idle';
    await write('claude-stop', { id: 'claude:a', at: at + 3, files: [], reset: true });
    expect((await read()).conflicts).toEqual([]);
    records[0].liveStatus = 'working';
    expect((await read()).conflicts[0].files).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    await write('claude-shared', { id: 'claude:a', at: at + 4, files: [shared] });
    await read();
    expect(notify).toHaveBeenCalledTimes(2);
    vi.spyOn(FileActivityStore.prototype, 'read').mockRejectedValueOnce(new Error('tracking unavailable'));
    expect((await read()).conflicts).toEqual([expect.objectContaining({ kind: 'worktree', files: [] })]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});

describe('opening projects', () => {
  it('opens only the folder of a known board card and reports missing folders', async () => {
    const cwd = path.join(dataDir, 'project #1');
    await mkdir(cwd);
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([
      { id: 'claude:a', source: 'claude', title: 'Project', cwd, liveStatus: null },
      { id: 'claude:b', source: 'claude', title: 'No folder', liveStatus: null },
    ]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    const open = vi.spyOn(sessionOpening, 'openInApp').mockResolvedValue();
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
    const request = (body: object) => fetch(`${server!.url}/api/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    // A direct request also works before the page's first board poll.
    expect((await request({ id: 'claude:a', target: 'vscode' })).status).toBe(200);
    expect(open).toHaveBeenCalledExactlyOnceWith(sessionOpening.vscodeUrl(cwd));
    expect((await request({ id: 'claude:unknown', target: 'vscode', cwd })).status).toBe(400);
    expect((await request({ id: 'claude:b', target: 'vscode' })).status).toBe(400);
    expect((await request({ id: 'claude:a', target: 'arbitrary-app' })).status).toBe(400);
    await rm(cwd, { recursive: true });
    expect((await request({ id: 'claude:a', target: 'vscode' })).status).toBe(400);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('notes API', () => {
  it('persists notes through server restarts and retains annotated old cards', async () => {
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([
      { id: 'claude:a', source: 'claude', title: 'Old session', createdAt: 0, liveStatus: null },
    ]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    const start = () => startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
    server = await start();
    const save = (id: unknown, text: unknown) => fetch(`${server!.url}/api/notes`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, text }),
    });
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    expect((await read()).cards).toEqual([]);
    const text = 'Review changes\nDo not forget the migration';
    expect((await save('claude:a', text)).status).toBe(200);
    expect((await read()).cards[0].notes).toBe(text);
    expect(JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8')).cards['claude:a']).toBe(text);
    server.close();
    server = await start();
    expect((await read()).cards[0].notes).toBe(text);
    expect((await save('claude:../../escape', text)).status).toBe(400);
    expect((await save('claude:a', { text })).status).toBe(400);
    expect((await save('claude:a', 'x'.repeat(20_001))).status).toBe(400);
    expect((await save('claude:a', '')).status).toBe(200);
    expect((await read()).cards).toEqual([]);
  });
});

describe('view preferences API', () => {
  it('reads local defaults and preserves filters and sorting across restarts', async () => {
    const start = () => startBoardServer({
      dataDir, port: 0, home: path.join(dataDir, 'home'),
      claudeBin: path.join(dataDir, 'no-claude'), codexBin: path.join(dataDir, 'no-codex'),
    });
    server = await start();
    const read = async () => (await (await fetch(`${server!.url}/api/board`)).json()).view;
    const save = (patch: object) => fetch(`${server!.url}/api/view`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    expect(await read()).toEqual({ hiddenRepos: [], hiddenSources: [], hiddenTickets: [], oldestFirst: [] });
    expect((await save({ hiddenRepos: ['project'], hiddenTickets: ['PROJ-1'] })).status).toBe(200);
    expect((await save({ oldestFirst: ['parked'] })).status).toBe(200);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'view.json'), 'utf8'));
    server.close();
    server = await start();
    expect(await read()).toEqual(saved);
    expect(saved.hiddenRepos).toEqual(['project']);
    expect(saved.oldestFirst).toEqual(['parked']);
    expect((await save({ hiddenSources: 'claude' })).status).toBe(400);
    expect((await save({ arbitrary: [] })).status).toBe(400);
    expect(await read()).toEqual(saved);
  });
});
