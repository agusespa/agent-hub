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
  it('warns across sources and subfolders in one worktree, without a duplicate branch warning', async () => {
    const resolve = vi.fn(async () => worktree('/repo'));
    const conflicts = await sessionConflicts([session('claude:a', '/repo/src'), session('codex:b', '/repo')], resolve);
    expect(conflicts).toEqual([expect.objectContaining({ kind: 'worktree', location: '/repo', sessionIds: ['claude:a', 'codex:b'] })]);
  });

  it('requires both sessions to be Working, regardless of their recorded branch', async () => {
    for (const status of ['idle', 'waiting', null] as const) {
      expect(await sessionConflicts([session('claude:a', '/repo'), session('codex:b', '/repo', status)], async () => worktree('/repo'))).toEqual([]);
    }
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
  it('notifies once per overlap, rearms after it ends, and does not rearm on a source failure', async () => {
    const conflicts = await sessionConflicts([session('claude:a', '/repo'), session('codex:b', '/repo')], async () => worktree('/repo'));
    const alerts = new ConflictAlerts();
    expect(alerts.take(conflicts)).toEqual(conflicts);
    expect(alerts.take(conflicts)).toEqual([]);
    expect(alerts.take([], ['codex'])).toEqual([]);
    expect(alerts.take(conflicts)).toEqual([]);
    expect(alerts.take([])).toEqual([]);
    expect(alerts.take(conflicts)).toEqual(conflicts);
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
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial']);
    const other = path.join(dir, 'other');
    await git(['worktree', 'add', '--force', other, 'main']);
    const linked = await readWorktree(other);
    expect(linked?.commonDir).toBe(initial?.commonDir);
    expect(linked?.root).not.toBe(initial?.root);
    expect(linked?.branch).toBe('main');
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
