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
      { id: 'claude:local_a', activityId: 'claude:a', aliases: ['claude:a'], source: 'claude', title: 'Implement', cwd: repo, liveStatus: 'working' },
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
    expect((await read()).conflicts).toEqual([expect.objectContaining({ kind: 'worktree', sessionIds: ['claude:local_a', 'codex:b'], files: ['shared.ts'] })]);
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

  it('keeps the board warning but sends no alert while alerts are off, and does not replay it when turned on', async () => {
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
    await writeFile(path.join(dataDir, 'view.json'), JSON.stringify({ conflictAlerts: false }));
    const notify = vi.fn();
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), onConflictAlert: notify });
    const activity = path.join(dataDir, 'file-activity');
    await mkdir(activity);
    const shared = path.join(repo, 'shared.ts');
    for (const id of ['claude:a', 'codex:b']) {
      await writeFile(path.join(activity, `${id.replace(':', '-')}.json`), JSON.stringify({ id, at: Date.now(), files: [shared] }));
    }
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    expect((await read()).conflicts[0].files).toEqual(['shared.ts']);
    await fetch(`${server.url}/api/view`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflictAlerts: true }),
    });
    expect((await read()).conflicts[0].files).toEqual(['shared.ts']);
    expect(notify).not.toHaveBeenCalled();
  });
  it('alerts once for possible concurrent work when that setting is on', async () => {
    const repo = path.join(dataDir, 'repo');
    await mkdir(repo);
    await promisify(execFile)('git', ['init', '--initial-branch=main'], { cwd: repo });
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([{ id: 'claude:a', source: 'claude', title: 'Implement', cwd: repo, liveStatus: 'working' }]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([{ id: 'codex:b', source: 'codex', title: 'Review', cwd: repo, liveStatus: 'working' }]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    await writeFile(path.join(dataDir, 'view.json'), JSON.stringify({ sharedAlerts: true }));
    const notify = vi.fn();
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), onConflictAlert: notify });
    await fetch(`${server.url}/api/board`);
    await fetch(`${server.url}/api/board`);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'worktree', files: [] });
  });
});

describe('usage alerts', () => {
  it('alerts at the chosen level, leaves out muted kinds, and waits out quiet hours', async () => {
    const hour = 60 * 60_000;
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockImplementation(async () => ({
      source: 'claude', plan: 'max', fetchedAt: Date.now(), windows: [
        { label: '5h', usedPercent: 85, resetsAt: Date.now() + 2 * hour },
        { label: 'Weekly', usedPercent: 50, resetsAt: Date.now() + 20 * hour },
      ],
    }));
    // A window around now that still holds if the hour turns during the test.
    const hourNow = new Date().getHours();
    await writeFile(path.join(dataDir, 'view.json'), JSON.stringify({
      closePercent: 80, spareAlerts: false, quietHours: true, quietFrom: (hourNow + 23) % 24, quietTo: (hourNow + 2) % 24, quietWeekends: false,
    }));
    const notify = vi.fn();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), onUsageAlert: notify });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notify).not.toHaveBeenCalled();
    await fetch(`${server.url}/api/view`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quietHours: false }),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'close', title: 'Claude 5h limit: 15% left' });
  });
});

describe('desktop only', () => {
  it('answers only requests with the desktop token, and tells a browser where to go', async () => {
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), desktopToken: 'secret' });
    const page = await fetch(server.url);
    expect(page.status).toBe(403);
    expect(await page.text()).toMatch(/desktop app/);
    expect((await fetch(`${server.url}/api/board`)).status).toBe(403);
    expect((await fetch(`${server.url}/app.js`, { headers: { 'x-agent-hub-token': 'wrong' } })).status).toBe(403);
    expect((await fetch(server.url, { headers: { 'x-agent-hub-token': 'secret' } })).status).toBe(200);
  });
});

describe('notifications API', () => {
  const post = (action: unknown) => fetch(`${server!.url}/api/notifications`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
  });

  it('tests notifications and opens their settings only in the desktop app', async () => {
    const notifications = { test: vi.fn(), openSettings: vi.fn().mockResolvedValue(undefined) };
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home'), notifications });
    expect((await (await fetch(`${server.url}/api/board`)).json()).notifications).toBe(true);
    expect((await post('test')).status).toBe(200);
    expect((await post('settings')).status).toBe(200);
    expect((await post('other')).status).toBe(400);
    expect(notifications.test).toHaveBeenCalledTimes(1);
    expect(notifications.openSettings).toHaveBeenCalledTimes(1);
    server.close();
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
    expect((await (await fetch(`${server.url}/api/board`)).json()).notifications).toBe(false);
    expect((await post('test')).status).toBe(404);
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

describe('config files', () => {
  it('lists config files and opens only the folders that hold them', async () => {
    const home = path.join(dataDir, 'home');
    const cwd = path.join(dataDir, 'project');
    await mkdir(path.join(home, '.claude'), { recursive: true });
    await writeFile(path.join(home, '.claude', 'settings.json'), '{}');
    await mkdir(cwd);
    await writeFile(path.join(cwd, '.mcp.json'), '{}');
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([
      { id: 'claude:a', source: 'claude', title: 'Project', cwd, liveStatus: null },
      { id: 'claude:home', source: 'claude', title: 'In the home folder', cwd: home, liveStatus: 'working' },
    ]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    const open = vi.spyOn(sessionOpening, 'openInApp').mockResolvedValue();
    server = await startBoardServer({ dataDir, port: 0, home });
    // The home folder is no project, so its sessions stay off the board and out of the config list.
    expect((await (await fetch(`${server.url}/api/board`)).json()).cards.map((card: { id: string }) => card.id)).toEqual(['claude:a']);
    const request = (pathname: string, body: object) => fetch(`${server!.url}${pathname}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    const global = await (await request('/api/config', {})).json();
    expect(global.root).toBeNull();
    expect(global.folders).toEqual({ claude: path.join(home, '.claude'), codex: path.join(home, '.codex') });
    expect(global.files).toContainEqual(expect.objectContaining({ source: 'claude', shown: '~/.claude/settings.json', exists: true }));
    expect(global.files).toContainEqual(expect.objectContaining({ source: 'codex', shown: '~/.codex/config.toml', exists: false }));

    const project = await (await request('/api/config', { cwd })).json();
    expect(project.root).toBe(cwd);
    expect(project.folders).toEqual({ claude: cwd, codex: cwd });
    expect(project.files.find((file: { shown: string }) => file.shown === '.mcp.json')).toMatchObject({ path: path.join(cwd, '.mcp.json'), exists: true });

    expect((await request('/api/config/open', { folder: path.join(home, '.codex') })).status).toBe(200);
    expect((await request('/api/config/open', { cwd, folder: cwd })).status).toBe(200);
    expect(open.mock.calls).toEqual([[sessionOpening.vscodeUrl(path.join(home, '.codex'))], [sessionOpening.vscodeUrl(cwd)]]);
    // Only those folders, and only for folders of sessions on the board.
    expect((await request('/api/config/open', { cwd, folder: path.join(cwd, '.mcp.json') })).status).toBe(400);
    expect((await request('/api/config/open', { folder: cwd })).status).toBe(400);
    expect((await request('/api/config', { cwd: dataDir })).status).toBe(400);
    expect((await request('/api/config', { cwd: home })).status).toBe(400);
    expect((await request('/api/config', { cwd: 42 })).status).toBe(400);
    expect(open).toHaveBeenCalledTimes(2);
  });
});

describe('renaming sessions', () => {
  const records: SessionRecord[] = [
    { id: 'claude:a', source: 'claude', renameId: 'claude-session', title: 'Claude title', liveStatus: null },
    { id: 'codex:b', source: 'codex', renameId: 'codex-thread', title: 'Codex title', liveStatus: null },
    { id: 'claude:bg-c', source: 'claude', title: 'Background agent', liveStatus: null },
  ];

  beforeEach(async () => {
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue(records.filter((record) => record.source === 'claude'));
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue(records.filter((record) => record.source === 'codex'));
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
  });

  const rename = (id: unknown, title: unknown) => fetch(`${server!.url}/api/title`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, title }),
  });

  it('renames Codex threads using their real id, including before the first board poll', async () => {
    const codex = vi.spyOn(CodexAppServer.prototype, 'renameThread').mockResolvedValue();
    const result = await rename('codex:b', '  Review login  ');
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ title: 'Review login' });
    expect(codex).toHaveBeenCalledExactlyOnceWith('codex-thread', 'Review login');
  });

  it('rejects Claude, unknown or synthetic sessions and invalid titles without calling a source', async () => {
    const codex = vi.spyOn(CodexAppServer.prototype, 'renameThread').mockResolvedValue();
    for (const [id, title] of [
      // Claude renames stay off until they can also reach Claude Desktop.
      ['claude:a', 'Name'], ['codex:unknown', 'Name'], ['claude:bg-c', 'Name'], ['codex:../../escape', 'Name'],
      ['codex:b', '   '], ['codex:b', 'x'.repeat(201)], ['codex:b', 'a\nb'],
      ['codex:b', '\u001b[2J'], ['codex:b', { title: 'Name' }],
    ]) expect((await rename(id, title)).status).toBe(400);
    expect(codex).not.toHaveBeenCalled();
  });

  it('reports source failures so the editor can retain the draft and retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const codex = vi.spyOn(CodexAppServer.prototype, 'renameThread').mockRejectedValueOnce(new Error('Thread unavailable')).mockResolvedValue();
    const response = await rename('codex:b', 'New title');
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Thread unavailable' });
    expect((await rename('codex:b', 'New title')).status).toBe(200);
    expect(codex).toHaveBeenCalledTimes(2);
  });
});

describe('notes API', () => {
  it('keeps card state and live tracking through execution changes and stale-window saves', async () => {
    const id = 'claude:local_conversation';
    const record: SessionRecord = {
      id, source: 'claude', title: 'Conversation', createdAt: Date.now(), liveStatus: 'working',
      aliases: ['claude:first'], activityId: 'claude:first',
    };
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockImplementation(async () => [{ ...record }]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    await writeFile(path.join(dataDir, 'placements.json'), JSON.stringify({ placements: { 'claude:first': 'done' } }));
    server = await startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    const save = (endpoint: string, patch: object) => fetch(`${server!.url}/api/${endpoint}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    expect((await read()).cards).toEqual([expect.objectContaining({ id, column: 'done', liveStatus: 'working' })]);
    await save('notes', { id, text: 'Permanent note' });
    await save('ticket', { id, key: 'PROJ-9' });
    // Desktop resumes the same conversation with a new CLI execution.
    record.activityId = 'claude:second';
    record.aliases = ['claude:second', 'claude:first'];
    const at = Date.now();
    await writeFile(path.join(dataDir, 'live-status', 'claude-first.json'), JSON.stringify({ id: 'claude:first', status: 'idle', at }));
    expect((await read()).cards).toEqual([expect.objectContaining({ id, column: 'done', notes: 'Permanent note', ticket: 'PROJ-9', liveStatus: 'working' })]);
    await writeFile(path.join(dataDir, 'live-status', 'claude-second.json'), JSON.stringify({ id: 'claude:second', status: 'waiting', at }));
    expect((await read()).cards[0]).toMatchObject({ id, liveStatus: 'waiting', column: 'done' });
    // A save carrying a pre-migration ID resolves to the same permanent card.
    await save('notes', { id: 'claude:first', text: 'Updated note' });
    expect(JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8')).cards).toEqual({ [id]: 'Updated note' });
    expect((await read()).cards[0]).toMatchObject({ id, notes: 'Updated note' });
  });

  it('keeps saved state after a Claude CLI ID change and lets inherited values be cleared', async () => {
    vi.spyOn(claudeSource, 'fetchClaudeSessions').mockResolvedValue([
      { id: 'claude:local_conversation', aliases: ['claude:current', 'claude:second', 'claude:first'], activityId: 'claude:current', source: 'claude', title: 'Conversation', createdAt: 0, liveStatus: null },
    ]);
    vi.spyOn(CodexAppServer.prototype, 'listThreads').mockResolvedValue([]);
    vi.spyOn(claudeSource, 'fetchClaudeUsage').mockResolvedValue({ source: 'claude', plan: null, windows: [], fetchedAt: 0 });
    vi.spyOn(CodexAppServer.prototype, 'readUsage').mockResolvedValue({ source: 'codex', plan: null, windows: [], fetchedAt: 0 });
    await writeFile(path.join(dataDir, 'placements.json'), JSON.stringify({ placements: { 'claude:first': 'standby' }, order: { standby: ['claude:first'] } }));
    await writeFile(path.join(dataDir, 'tickets.json'), JSON.stringify({ cards: { 'claude:second': 'PROJ-7' } }));
    await writeFile(path.join(dataDir, 'notes.json'), JSON.stringify({ cards: { 'claude:first': 'Keep this note' } }));
    await writeFile(path.join(dataDir, 'last-prompts.json'), JSON.stringify({ cards: { 'claude:first': Date.now() } }));
    const start = () => startBoardServer({ dataDir, port: 0, home: path.join(dataDir, 'home') });
    server = await start();
    const read = async () => (await fetch(`${server!.url}/api/board`)).json();
    expect((await read()).cards).toEqual([expect.objectContaining({
      id: 'claude:local_conversation', column: 'standby', ticket: 'PROJ-7', notes: 'Keep this note', lastPromptAt: expect.any(Number),
    })]);
    for (const [endpoint, patch] of [['ticket', { key: null }], ['notes', { text: '' }]] as const) {
      const response = await fetch(`${server.url}/api/${endpoint}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'claude:local_conversation', ...patch }),
      });
      expect(response.status).toBe(200);
    }
    server.close();
    server = await start();
    expect((await read()).cards).toEqual([expect.objectContaining({ id: 'claude:local_conversation', ticket: null, notes: '', column: 'standby' })]);
  });

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
  it('reads local defaults and preserves filters, sorting and layout across restarts', async () => {
    const themes: string[] = [];
    const start = () => startBoardServer({
      dataDir, port: 0, home: path.join(dataDir, 'home'), onThemeChange: (theme) => themes.push(theme),
      claudeBin: path.join(dataDir, 'no-claude'), codexBin: path.join(dataDir, 'no-codex'),
    });
    server = await start();
    const read = async () => (await (await fetch(`${server!.url}/api/board`)).json()).view;
    const save = (patch: object) => fetch(`${server!.url}/api/view`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    expect(await read()).toEqual({ hiddenRepos: [], hiddenSources: [], hiddenTickets: [], oldestFirst: [], layout: 'kanban', theme: 'system', usageAlerts: true, closePercent: 90, spareAlerts: true, sharedAlerts: false, conflictAlerts: true, keepDays: 45, quietHours: false, quietFrom: 18, quietTo: 8, quietWeekends: false });
    expect((await save({ hiddenRepos: ['project'], hiddenTickets: ['PROJ-1'] })).status).toBe(200);
    expect((await save({ oldestFirst: ['parked'] })).status).toBe(200);
    expect((await save({ layout: 'project' })).status).toBe(200);
    expect((await save({ theme: 'dark' })).status).toBe(200);
    expect(themes).toEqual(['dark']);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'view.json'), 'utf8'));
    server.close();
    server = await start();
    expect(await read()).toEqual(saved);
    expect(saved.hiddenRepos).toEqual(['project']);
    expect(saved.oldestFirst).toEqual(['parked']);
    expect(saved.layout).toBe('project');
    expect(saved.theme).toBe('dark');
    expect((await save({ hiddenSources: 'claude' })).status).toBe(400);
    expect((await save({ arbitrary: [] })).status).toBe(400);
    expect(await read()).toEqual(saved);
  });
});
