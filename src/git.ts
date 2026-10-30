import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitWork } from './types.js';

const execFileAsync = promisify(execFile);

/** A branch as the sources report it, or undefined for `HEAD`: a detached HEAD, or a repo without commits yet. */
export const branchName = (branch: string | null | undefined): string | undefined =>
  branch && branch !== 'HEAD' ? branch : undefined;

const repoNames = new Map<string, Promise<string>>();

/**
 * Repo name for a working directory. Uses the git common dir so linked worktrees
 * (…/.claude/worktrees/foo) are named after their main repository.
 */
export const repoNameForCwd = (cwd: string | undefined): Promise<string> => {
  if (!cwd) return Promise.resolve('(no folder)');
  let name = repoNames.get(cwd);
  if (!name) {
    name = execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 5_000 })
      .then(({ stdout }) => {
        const commonDir = stdout.trim();
        return path.basename(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir.replace(/\.git$/, ''));
      })
      .catch(() => path.basename(cwd));
    repoNames.set(cwd, name);
  }
  return name;
};

/**
 * What a folder's worktree has that is not on a remote yet. Read afresh, since agents change it
 * as they work, and without optional locks, so it never holds the index lock an agent may need.
 */
export const readGitWork = async (cwd: string): Promise<GitWork | undefined> => {
  const run = async (args: string[]) => (await execFileAsync('git', ['--no-optional-locks', ...args], { cwd, timeout: 5_000 })).stdout;
  try {
    const [status, remotes] = await Promise.all([run(['status', '--porcelain']), run(['remote'])]);
    const changed = status.split('\n').filter(Boolean).length;
    if (!remotes.trim()) return { changed };
    // A repository without commits yet has no HEAD to count from.
    const unpushed = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes']).then(Number, () => 0);
    return { changed, unpushed };
  } catch {
    return undefined;
  }
};
