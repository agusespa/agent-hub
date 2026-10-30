import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchName, readGitWork } from './git.js';

describe('branchName', () => {
  it('keeps named branches', () => {
    expect(branchName('feature/PROJ-7-thing')).toBe('feature/PROJ-7-thing');
  });

  it('has none for HEAD or an empty branch', () => {
    expect(branchName('HEAD')).toBeUndefined();
    expect(branchName('')).toBeUndefined();
    expect(branchName(null)).toBeUndefined();
  });
});

describe('readGitWork', () => {
  it('counts uncommitted files and commits on no remote', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-git-'));
    const repo = path.join(dir, 'repo');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo });
    try {
      execFileSync('git', ['init', '--quiet', repo]);
      await writeFile(path.join(repo, 'a.txt'), 'a');
      // No remote: every commit would count as unpushed, so none are counted.
      expect(await readGitWork(repo)).toEqual({ changed: 1 });
      execFileSync('git', ['init', '--quiet', '--bare', path.join(dir, 'remote.git')]);
      git('remote', 'add', 'origin', path.join(dir, 'remote.git'));
      // A remote but no commits yet.
      expect(await readGitWork(repo)).toEqual({ changed: 1, unpushed: 0 });
      git('add', '.');
      git('commit', '--quiet', '-m', 'First');
      expect(await readGitWork(repo)).toEqual({ changed: 0, unpushed: 1 });
      git('push', '--quiet', 'origin', 'HEAD:main');
      await writeFile(path.join(repo, 'a.txt'), 'changed');
      await writeFile(path.join(repo, 'b.txt'), 'b');
      expect(await readGitWork(repo)).toEqual({ changed: 2, unpushed: 0 });
      expect(await readGitWork(path.join(dir, 'missing'))).toBeUndefined();
      expect(await readGitWork(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
