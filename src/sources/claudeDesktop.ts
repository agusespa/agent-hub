import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** One user-visible conversation; CLI IDs are replaceable execution identities. */
export interface ClaudeDesktopSession {
  sessionId: string;
  cliSessionId?: string;
  priorCliSessionIds: string[];
  title?: string;
  cwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]+$/.test(value);
const optionalString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const optionalTime = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Desktop metadata is authoritative. Never fall back to enumerating terminal sessions. */
export const readClaudeDesktopSessions = async (
  root = path.join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
): Promise<ClaudeDesktopSession[]> => {
  const directories = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  const accounts = (await Promise.all((await directories(root)).map(directories))).flat();
  const sessions = await Promise.all(accounts.map(async (dir) => {
    const files = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(files.filter((entry) => entry.isFile() && /^local_.*\.json$/.test(entry.name)).map(async (entry) => {
      // A concurrent Desktop write can briefly be incomplete; skip it until the next poll.
      let value;
      try { value = JSON.parse(await readFile(path.join(dir, entry.name), 'utf8')); }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      if (!isId(value?.sessionId) || `${value.sessionId}.json` !== entry.name || value.isArchived === true) return [];
      const prior = value.priorCliSessionIds ?? [];
      if ((value.cliSessionId !== undefined && !isId(value.cliSessionId)) || !Array.isArray(prior) || !prior.every(isId)) return [];
      // Select metadata fields explicitly: summaries, prompts and transcript snapshots stay out.
      return [{
        sessionId: value.sessionId, cliSessionId: value.cliSessionId, priorCliSessionIds: prior,
        title: optionalString(value.title), cwd: optionalString(value.cwd),
        createdAt: optionalTime(value.createdAt), lastActivityAt: optionalTime(value.lastActivityAt),
      }];
    }))).flat();
  }));
  return [...new Map(sessions.flat().map((session) => [session.sessionId, session])).values()];
};
