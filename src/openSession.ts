import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Card } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * The link that opens the session in its app: `codex://threads/<id>` for Codex
 * (https://developers.openai.com/codex/app/commands). Claude documents none, so its cards have no open button.
 */
export const sessionUrl = ({ source, openId }: Pick<Card, 'source' | 'openId'>): string | undefined =>
  source === 'codex' && openId ? `codex://threads/${encodeURIComponent(openId)}` : undefined;

/** Opens a `sessionUrl` link in its app. */
export const openInApp = async (url: string): Promise<void> => {
  await execFileAsync('open', [url]);
};
