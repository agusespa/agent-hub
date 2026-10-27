import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SessionRecord } from './types.js';

const execFileAsync = promisify(execFile);

export interface Worktree {
  root: string;
  commonDir: string;
  branch?: string;
}

export interface SessionConflict {
  key: string;
  kind: 'worktree' | 'branch';
  location: string;
  branch?: string;
  sessionIds: [string, string];
}

/** Read afresh: a running session can change branches or recreate its worktree. */
export const readWorktree = async (cwd: string): Promise<Worktree | undefined> => {
  try {
    const run = (args: string[]) => execFileAsync('git', args, { cwd, timeout: 5_000 });
    const [paths, branch] = await Promise.all([
      run(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']),
      run(['symbolic-ref', '--quiet', '--short', 'HEAD']).then(({ stdout }) => stdout.trim()).catch(() => undefined),
    ]);
    const [root, commonDir] = paths.stdout.trim().split('\n');
    return { root: await realpath(root), commonDir: await realpath(commonDir), branch };
  } catch {
    // Missing folders and non-Git sessions have no trustworthy worktree identity.
    return undefined;
  }
};

/** Only Working counts; board columns and historical branch names are not evidence. */
export const sessionConflicts = async (
  sessions: SessionRecord[],
  resolveWorktree = readWorktree,
): Promise<SessionConflict[]> => {
  const working = sessions.filter((session) => session.liveStatus === 'working' && session.cwd);
  const locations = new Map(await Promise.all(
    [...new Set(working.map((session) => session.cwd!))].map(async (cwd) => [cwd, await resolveWorktree(cwd)] as const),
  ));
  const conflicts: SessionConflict[] = [];
  for (let i = 0; i < working.length; i++) {
    const a = locations.get(working[i].cwd!);
    if (!a) continue;
    for (let j = i + 1; j < working.length; j++) {
      const b = locations.get(working[j].cwd!);
      if (!b) continue;
      const kind = a.root === b.root ? 'worktree'
        : a.commonDir === b.commonDir && a.branch && a.branch === b.branch ? 'branch' : undefined;
      if (!kind) continue;
      const sessionIds = [working[i].id, working[j].id].sort() as [string, string];
      const identity = kind === 'worktree' ? a.root : a.commonDir;
      const location = kind === 'worktree' ? a.root : [a.root, b.root].sort().join('\n');
      conflicts.push({
        key: JSON.stringify([kind, identity, kind === 'branch' ? a.branch : null, ...sessionIds]),
        kind, location, branch: a.branch, sessionIds,
      });
    }
  }
  return conflicts;
};

/** Alert once per overlap, rearming after it ends. Failed sources cannot end an overlap. */
export class ConflictAlerts {
  private active = new Map<string, SessionConflict>();

  take(conflicts: SessionConflict[], unavailableSources: string[] = []): SessionConflict[] {
    const fresh = conflicts.filter((conflict) => !this.active.has(conflict.key));
    const next = new Map(conflicts.map((conflict) => [conflict.key, conflict]));
    for (const [key, conflict] of this.active) {
      if (conflict.sessionIds.some((id) => unavailableSources.includes(id.split(':')[0]))) next.set(key, conflict);
    }
    this.active = next;
    return fresh;
  }
}
