import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConflictAlerts, readWorktree, sessionConflicts, type Worktree } from './conflicts.js';
import type { LiveStatus, SessionRecord } from './types.js';

const execFileAsync = promisify(execFile);
const session = (id: string, cwd: string, liveStatus: LiveStatus | null = 'working'): SessionRecord => ({
  id, cwd, source: id.startsWith('claude:') ? 'claude' : 'codex', title: id, liveStatus,
});
const worktree = (root: string, branch: string | undefined = 'main', commonDir = '/repo/.git'): Worktree => ({ root, branch, commonDir });

describe('sessionConflicts', () => {
  it('warns without file evidence and only lists paths observed in both sessions', async () => {
    const records = [session('claude:a', '/repo'), session('codex:b', '/repo')];
    const resolve = async () => worktree('/repo');
    expect(await sessionConflicts(records, resolve)).toEqual([expect.objectContaining({ files: [] })]);
    expect(await sessionConflicts(records, resolve, new Map([['claude:a', ['/repo/a.ts']]]))).toEqual([expect.objectContaining({ files: [] })]);
    expect(await sessionConflicts(records, resolve, new Map([['claude:a', ['/repo/a.ts']], ['codex:b', ['/repo/b.ts']]]))).toEqual([expect.objectContaining({ files: [] })]);
    const files = new Map([['claude:a', ['/repo/shared.ts', '/outside.ts', '/repo/other.ts']], ['codex:b', ['/outside.ts', '/repo/shared.ts']]]);
    expect(await sessionConflicts(records, resolve, files)).toEqual([expect.objectContaining({ files: ['shared.ts'] })]);
  });

  it('compares paths relative to separate worktrees on the same branch', async () => {
    const records = [session('claude:a', '/one'), session('codex:b', '/two')];
    const files = new Map([['claude:a', ['/one/src/shared.ts']], ['codex:b', ['/two/src/shared.ts']]]);
    expect(await sessionConflicts(records, async (cwd) => worktree(cwd), files)).toEqual([expect.objectContaining({ kind: 'branch', files: ['src/shared.ts'] })]);
    files.set('codex:b', ['/two/src/other.ts']);
    expect(await sessionConflicts(records, async (cwd) => worktree(cwd), files)).toEqual([expect.objectContaining({ kind: 'branch', files: [] })]);
  });

  it('warns across sources and subfolders in one worktree, without a duplicate branch warning', async () => {
    const resolve = vi.fn(async () => worktree('/repo'));
    const conflicts = await sessionConflicts([session('claude:a', '/repo/src'), session('codex:b', '/repo')], resolve,
      new Map([['claude:a', ['/repo/shared.ts']], ['codex:b', ['/repo/shared.ts']]]));
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'worktree', location: '/repo', sessionIds: ['claude:a', 'codex:b'] })]);
  });

  it('follows edits outside a session\'s own project into the worktree they landed in', async () => {
    // Real folders: an edited file's worktree is looked up from its nearest existing folder.
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-hub-outside-')));
    try {
      const [hub, api, web] = ['hub', 'api', 'web'].map((name) => path.join(base, name));
      for (const folder of [path.join(hub, 'src'), path.join(api, 'src'), web]) await mkdir(folder, { recursive: true });
      const resolve = vi.fn(async (folder: string) => {
        const root = [hub, api, web].find((candidate) => folder === candidate || folder.startsWith(`${candidate}/`));
        return root ? worktree(root, 'main', `${root}/.git`) : undefined;
      });
      const records = [session('claude:a', hub), session('codex:b', api)];
      // Working in another session's project is concurrent work there, before any shared file.
      expect(await sessionConflicts(records, resolve, new Map([['claude:a', [`${api}/src/a.ts`, `${hub}/src/own.ts`]]])))
        .toEqual([expect.objectContaining({ kind: 'worktree', location: api, files: [] })]);
      expect(await sessionConflicts(records, resolve, new Map([['claude:a', [`${api}/src/a.ts`]], ['codex:b', [`${api}/src/a.ts`]]])))
        .toEqual([expect.objectContaining({ kind: 'worktree', location: api, files: ['src/a.ts'] })]);
      // Both outside their own projects, in a third one.
      expect(await sessionConflicts(records, resolve, new Map([['claude:a', [`${web}/x.ts`]], ['codex:b', [`${web}/x.ts`, `${base}/y.ts`]]])))
        .toEqual([expect.objectContaining({ kind: 'worktree', location: web, files: ['x.ts'] })]);
      // Edits inside a session's own worktree need no lookup of their own.
      expect(resolve).not.toHaveBeenCalledWith(path.join(hub, 'src'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('requires both sessions to be mid-turn, regardless of their recorded branch', async () => {
    for (const status of ['idle', null] as const) {
      expect(await sessionConflicts([session('claude:a', '/repo'), session('codex:b', '/repo', status)], async () => worktree('/repo'))).toEqual([]);
    }
    // A permission prompt pauses the turn without ending the overlap.
    expect(await sessionConflicts([session('claude:a', '/repo'), session('codex:b', '/repo', 'waiting')], async () => worktree('/repo'))).toHaveLength(1);
  });

  it('warns for matching branches only within the same local repository', async () => {
    const records = [session('claude:a', '/one'), session('codex:b', '/two')];
    expect(await sessionConflicts(records, async (cwd) => worktree(cwd))).toEqual([expect.objectContaining({ kind: 'branch', branch: 'main' })]);
    expect(await sessionConflicts(records, async (cwd) => worktree(cwd, 'main', `${cwd}/.git`))).toEqual([]);
    expect(await sessionConflicts(records, async (cwd) => worktree(cwd, cwd))).toEqual([]);
    expect(await sessionConflicts(records, async (cwd) => ({ ...worktree(cwd), branch: undefined }))).toEqual([]);
  });

  it('handles detached HEAD in a shared worktree and ignores unavailable folders', async () => {
    const records = [session('claude:a', '/repo'), session('codex:b', '/repo')];
    expect((await sessionConflicts(records, async () => ({ ...worktree('/repo'), branch: undefined })))[0]?.kind).toBe('worktree');
    expect(await sessionConflicts(records, async () => undefined)).toEqual([]);
    expect(await sessionConflicts([{ ...records[0], cwd: undefined }, records[1]], async () => worktree('/repo'))).toEqual([]);
  });

  it('resolves each working directory once per check and keeps keys stable when card order changes', async () => {
    const resolve = vi.fn(async () => worktree('/repo'));
    const records = [session('claude:a', '/repo'), session('codex:b', '/repo'), session('codex:c', '/repo')];
    const conflicts = await sessionConflicts(records, resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(conflicts).toHaveLength(3);
    const reversed = await sessionConflicts([...records].reverse(), resolve);
    expect(reversed.map((conflict) => conflict.key).sort()).toEqual(conflicts.map((conflict) => conflict.key).sort());
  });
});

describe('ConflictAlerts', () => {
  it('alerts once for a shared workspace and once files overlap, until the workspace overlap ends', async () => {
    const [shared] = await sessionConflicts([session('claude:a', '/repo'), session('codex:b', '/repo')], async () => worktree('/repo'));
    const overlap = { ...shared, files: ['shared.ts'] };
    const alerts = new ConflictAlerts();
    expect(alerts.take([shared])).toEqual([{ conflict: shared, overlap: false }]);
    expect(alerts.take([shared])).toEqual([]);
    expect(alerts.take([overlap])).toEqual([{ conflict: overlap, overlap: true }]);
    expect(alerts.take([overlap])).toEqual([]);
    // Starting another turn, changing files, or temporarily losing a source cannot repeat either alert.
    expect(alerts.take([shared])).toEqual([]);
    expect(alerts.take([{ ...overlap, files: ['another.ts'] }])).toEqual([]);
    expect(alerts.take([], ['claude'])).toEqual([]);
    expect(alerts.take([overlap])).toEqual([]);
    expect(alerts.take([])).toEqual([]);
    // Seen again with an overlap straight away, it gets only the overlap alert.
    expect(alerts.take([overlap])).toEqual([{ conflict: overlap, overlap: true }]);
    expect(alerts.take([shared])).toEqual([]);
  });
});

describe('readWorktree with Git', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('normalizes nested and symlinked folders and reads branch changes without a cache', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-conflicts-'));
    const repo = path.join(dir, 'repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    const git = (args: string[]) => execFileAsync('git', args, { cwd: repo });
    await git(['init', '--initial-branch=main']);
    const link = path.join(dir, 'linked');
    await symlink(repo, link);
    const initial = await readWorktree(path.join(link, 'src'));
    expect(initial).toEqual({ root: await realpath(repo), commonDir: await realpath(path.join(repo, '.git')), branch: 'main' });
    // A not-yet-created leaf still resolves through a symlinked parent.
    expect(await sessionConflicts([session('claude:a', path.join(link, 'src')), session('codex:b', repo)], readWorktree,
      new Map([['claude:a', [path.join(link, 'src', 'new.ts')]], ['codex:b', [path.join(repo, 'src', 'new.ts')]]])))
      .toEqual([expect.objectContaining({ files: ['src/new.ts'] })]);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial']);
    const other = path.join(dir, 'other');
    await git(['worktree', 'add', '--force', other, 'main']);
    const linked = await readWorktree(other);
    expect(linked?.commonDir).toBe(initial?.commonDir);
    expect(linked?.root).not.toBe(initial?.root);
    expect(linked?.branch).toBe('main');
    // An edit from a session whose own folder is outside any repository still lands in this one.
    const outside = path.join(dir, 'notes');
    await mkdir(outside);
    expect(await sessionConflicts([session('claude:a', outside), session('codex:b', other)], readWorktree,
      new Map([['claude:a', [path.join(repo, 'src', 'deep', 'new.ts')]], ['codex:b', [path.join(other, 'src', 'deep', 'new.ts')]]])))
      .toEqual([expect.objectContaining({ kind: 'branch', files: ['src/deep/new.ts'] })]);
    expect((await sessionConflicts([session('claude:a', repo), session('codex:b', other)]))[0]?.kind).toBe('branch');
    await git(['checkout', '-b', 'feature']);
    expect((await readWorktree(repo))?.branch).toBe('feature');
    expect(await sessionConflicts([session('claude:a', repo), session('codex:b', other)])).toEqual([]);
    await git(['checkout', '--detach']);
    expect((await readWorktree(repo))?.branch).toBeUndefined();
    expect(await readWorktree(dir)).toBeUndefined();
    expect(await readWorktree(path.join(dir, 'missing'))).toBeUndefined();
  });
});
