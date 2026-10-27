import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { Card } from './types.js';
import { readWorktree } from './conflicts.js';

const execFileAsync = promisify(execFile);

/**
 * The link that opens the session in its app: `codex://threads/<id>` for Codex
 * (https://developers.openai.com/codex/app/commands). Claude documents none, so its cards have no open button.
 */
export const sessionUrl = ({ source, openId }: Pick<Card, 'source' | 'openId'>): string | undefined =>
  source === 'codex' && openId ? `codex://threads/${encodeURIComponent(openId)}` : undefined;

/** Request a new VS Code window; VS Code focuses an existing window for the same folder. */
export const vscodeUrl = (folder: string): string | undefined =>
  path.isAbsolute(folder) ? `vscode://file${pathToFileURL(folder).pathname}?windowId=_blank` : undefined;

/** Open the session's checkout root, including linked worktrees and nested project folders. */
export const projectUrl = async ({ cwd }: Pick<Card, 'cwd'>): Promise<string | undefined> => {
  if (!cwd || !path.isAbsolute(cwd)) return;
  if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) return;
  const folder = (await readWorktree(cwd))?.root ?? cwd;
  return vscodeUrl(folder);
};

/** Opens a session or project link in its app. */
export const openInApp = async (url: string): Promise<void> => {
  await execFileAsync('open', [url]);
};
