import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

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
