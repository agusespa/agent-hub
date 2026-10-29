import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
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

/** The nearest existing folder above a file, so Git can place one that was deleted or not yet created. */
const existingFolder = async (file: string): Promise<string> => {
  const parent = path.dirname(file);
  if (parent === file) return file;
  return stat(parent).then((info) => (info.isDirectory() ? parent : existingFolder(parent)), () => existingFolder(parent));
};

const relativeTo = (root: string, file: string): string | undefined => {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
};

interface Workspace {
  worktree: Worktree;
  /** Paths changed this turn, relative to the worktree root. */
  files: Set<string>;
}

/**
 * Sessions mid-turn (Working, or Waiting on a prompt) that share a worktree or branch, with the
 * paths both changed this turn. A session works in its own folder's worktree and in any other
 * worktree it edited files in, since agents can change files outside their project. Board columns
 * and historical branch names are not evidence.
 */
export const sessionConflicts = async (
  sessions: SessionRecord[],
  resolveWorktree = readWorktree,
  changedFiles: ReadonlyMap<string, string[]> = new Map(),
): Promise<SessionConflict[]> => {
  // A permission prompt pauses a turn without ending it, so answering one must not rearm an alert.
  const working = sessions.filter((session) => (session.liveStatus === 'working' || session.liveStatus === 'waiting') && session.cwd);
  // One lookup per folder per check.
  const lookups = new Map<string, Promise<Worktree | undefined>>();
  const lookup = (folder: string) => {
    let found = lookups.get(folder);
    if (!found) lookups.set(folder, (found = resolveWorktree(folder)));
    return found;
  };
  const workspaces = await Promise.all(working.map(async (session) => {
    const home = await lookup(session.cwd!);
    const edits = await Promise.all((changedFiles.get(session.id) ?? []).filter(path.isAbsolute).map(async (changed) => {
      const file = await canonicalPath(changed);
      // Only edits outside the session's own worktree need a lookup of their own.
      const worktree = home && relativeTo(home.root, file) ? home : await lookup(await existingFolder(file));
      const relative = worktree && relativeTo(worktree.root, file);
      return worktree && relative ? [{ worktree, relative }] : [];
    }));
    const byRoot = new Map<string, Workspace>(home ? [[home.root, { worktree: home, files: new Set() }]] : []);
    for (const { worktree, relative } of edits.flat()) {
      const workspace = byRoot.get(worktree.root) ?? { worktree, files: new Set<string>() };
      workspace.files.add(relative);
      byRoot.set(worktree.root, workspace);
    }
    return [...byRoot.values()];
  }));
  const conflicts = new Map<string, SessionConflict>();
  for (let i = 0; i < working.length; i++) {
    for (let j = i + 1; j < working.length; j++) {
      const pairs = workspaces[i].flatMap((a) => workspaces[j].map((b) => [a, b] as const));
      // A shared worktree already covers the branch checked out in that repository.
      const sharedRepos = new Set(pairs.filter(([a, b]) => a.worktree.root === b.worktree.root).map(([a]) => a.worktree.commonDir));
      const sessionIds = [working[i].id, working[j].id].sort() as [string, string];
      for (const [a, b] of pairs) {
        const kind = a.worktree.root === b.worktree.root ? 'worktree'
          : a.worktree.commonDir === b.worktree.commonDir && !sharedRepos.has(a.worktree.commonDir)
            && a.worktree.branch && a.worktree.branch === b.worktree.branch ? 'branch' : undefined;
        if (!kind) continue;
        const files = [...a.files].filter((file) => b.files.has(file));
        const identity = kind === 'worktree' ? a.worktree.root : a.worktree.commonDir;
        const key = JSON.stringify([kind, identity, kind === 'branch' ? a.worktree.branch : null, ...sessionIds]);
        const previous = conflicts.get(key);
        const roots = new Set([...(previous?.location.split('\n') ?? []), a.worktree.root, b.worktree.root]);
        conflicts.set(key, {
          key, kind, location: [...roots].sort().join('\n'), branch: a.worktree.branch, sessionIds,
          files: [...new Set([...(previous?.files ?? []), ...files])].sort(),
        });
      }
    }
  }
  return [...conflicts.values()];
};

/** A conflict to alert about: sessions sharing a workspace, or, with `overlap`, editing the same files in it. */
export interface ConflictAlert {
  conflict: SessionConflict;
  overlap: boolean;
}

/**
 * Alert once when sessions start sharing a workspace and once when their edits overlap,
 * rearming after they stop sharing it. A conflict first seen with an overlap gets only that
 * alert. Settings decides which of the two are sent; parallel tasks in one worktree are often
 * independent, so sharing alone is off by default. Failed sources cannot end a conflict.
 */
export class ConflictAlerts {
  private active = new Map<string, SessionConflict>();
  private alerted = new Map<string, 'shared' | 'overlap'>();

  take(conflicts: SessionConflict[], unavailableSources: string[] = []): ConflictAlert[] {
    const fresh = conflicts.flatMap((conflict): ConflictAlert[] => {
      const sent = this.alerted.get(conflict.key);
      if (conflict.files.length > 0) return sent === 'overlap' ? [] : [{ conflict, overlap: true }];
      return sent ? [] : [{ conflict, overlap: false }];
    });
    const next = new Map(conflicts.map((conflict) => [conflict.key, conflict]));
    for (const [key, conflict] of this.active) {
      if (conflict.sessionIds.some((id) => unavailableSources.includes(id.split(':')[0]))) next.set(key, conflict);
    }
    this.active = next;
    for (const { conflict, overlap } of fresh) this.alerted.set(conflict.key, overlap ? 'overlap' : 'shared');
    for (const key of this.alerted.keys()) if (!next.has(key)) this.alerted.delete(key);
    return fresh;
  }
}
