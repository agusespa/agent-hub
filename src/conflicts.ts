import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
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
  /** Observed overlapping paths relative to each worktree root; empty for an early workspace warning. */
  files: string[];
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

/** Resolve symlinks even for newly created or deleted files whose leaf no longer exists. */
const canonicalPath = async (file: string): Promise<string> => {
  try { return await realpath(file); } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(await canonicalPath(parent), path.basename(file));
  }
};

/**
 * Sessions mid-turn (Working, or Waiting on a prompt) that share a worktree or branch, with the
 * paths both changed this turn. Board columns and historical branch names are not evidence.
 */
export const sessionConflicts = async (
  sessions: SessionRecord[],
  resolveWorktree = readWorktree,
  changedFiles: ReadonlyMap<string, string[]> = new Map(),
): Promise<SessionConflict[]> => {
  // A permission prompt pauses a turn without ending it, so answering one must not rearm an alert.
  const working = sessions.filter((session) => (session.liveStatus === 'working' || session.liveStatus === 'waiting') && session.cwd);
  const locations = new Map(await Promise.all(
    [...new Set(working.map((session) => session.cwd!))].map(async (cwd) => [cwd, await resolveWorktree(cwd)] as const),
  ));
  const filesBySession = new Map(await Promise.all(working.map(async (session) => {
    const worktree = locations.get(session.cwd!);
    const files = worktree ? await Promise.all((changedFiles.get(session.id) ?? []).filter(path.isAbsolute).map(async (file) => {
      const relative = path.relative(worktree.root, await canonicalPath(file));
      return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
    })) : [];
    return [session.id, new Set(files.filter((file): file is string => file !== undefined))] as const;
  })));
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
      const files = [...filesBySession.get(working[i].id)!].filter((file) => filesBySession.get(working[j].id)!.has(file)).sort();
      const sessionIds = [working[i].id, working[j].id].sort() as [string, string];
      const identity = kind === 'worktree' ? a.root : a.commonDir;
      const location = kind === 'worktree' ? a.root : [a.root, b.root].sort().join('\n');
      conflicts.push({
        key: JSON.stringify([kind, identity, kind === 'branch' ? a.branch : null, ...sessionIds]),
        kind, location, branch: a.branch, sessionIds, files,
      });
    }
  }
  return conflicts;
};

/**
 * Alert once per observed file overlap, rearming after the sessions stop sharing a workspace.
 * Sharing alone stays a board warning: parallel tasks in one worktree are often independent.
 * Failed sources cannot end an overlap.
 */
export class ConflictAlerts {
  private active = new Map<string, SessionConflict>();
  private alerted = new Set<string>();

  take(conflicts: SessionConflict[], unavailableSources: string[] = []): SessionConflict[] {
    const fresh = conflicts.filter((conflict) => conflict.files.length > 0 && !this.alerted.has(conflict.key));
    const next = new Map(conflicts.map((conflict) => [conflict.key, conflict]));
    for (const [key, conflict] of this.active) {
      if (conflict.sessionIds.some((id) => unavailableSources.includes(id.split(':')[0]))) next.set(key, conflict);
    }
    this.active = next;
    this.alerted = new Set([...this.alerted, ...fresh.map((conflict) => conflict.key)].filter((key) => next.has(key)));
    return fresh;
  }
}
