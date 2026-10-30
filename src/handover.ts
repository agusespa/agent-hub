import { query } from '@anthropic-ai/claude-agent-sdk';
import { readJsonFile, updateJsonFile } from './jsonFile.js';
import type { Card, Handover, HandoverKind } from './types.js';

export type { HandoverKind } from './types.js';

export const isHandoverKind = (value: unknown): value is HandoverKind => value === 'review' || value === 'continue';

const isHandover = (value: unknown): value is Handover =>
  isHandoverKind((value as Handover | null)?.kind) && Number.isFinite((value as Handover).at);

/** Each card's last handover, kept by the board; never the summary or prompt. */
export class HandoverStore {
  constructor(private readonly file: string) {}

  async read(): Promise<Map<string, Handover>> {
    const parsed = (await readJsonFile(this.file)) as { cards?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.cards ?? {}).filter((entry): entry is [string, Handover] => isHandover(entry[1])));
  }

  set(cardId: string, handover: Handover): Promise<void> {
    return updateJsonFile(this.file, async () => ({ cards: Object.fromEntries((await this.read()).set(cardId, handover)) }));
  }
}

/**
 * A handover still shows until the session is used again: a later prompt or Claude
 * activity means the review is done or the work came back. The summary fork does not
 * count, as it leaves the session untouched.
 */
export const currentHandover = (
  handover: Handover | undefined, { lastPromptAt, lastActiveAt }: Pick<Card, 'lastPromptAt' | 'lastActiveAt'>,
): Handover | undefined =>
  handover && Math.max(lastPromptAt ?? 0, lastActiveAt ?? 0) <= handover.at ? handover : undefined;

const PRIVACY = 'Plain text, no heading or preamble. Leave out secrets and personal data.';

/**
 * What the Claude session is asked for. Its reply goes only into the Codex composer; the
 * board never stores it. Taking work over needs more than a review: decisions, what is
 * left and what not to retry.
 */
export const SUMMARY_PROMPTS: Record<HandoverKind, string> = {
  review: [
    'Another agent will now review the work done in this session. Write the handover for that reviewer in at most 120 words:',
    'the goal, what changed and where (files or areas; uncommitted or committed, and on which branch),',
    `and anything the reviewer should check closely. ${PRIVACY}`,
  ].join(' '),
  continue: [
    'Another agent will now take over the work in this session and continue it. Write the handover for that agent in at most 250 words:',
    'the goal, decisions made and why, what is done and verified, what is left in order, dead ends not to retry,',
    `and the next concrete step. Name files, branches and commands where they help. ${PRIVACY}`,
  ].join(' '),
};

/**
 * Claude's current CLI session for a Desktop conversation, which is what the SDK resumes. Only
 * the current execution: when it is unknown or shared, aliases still hold superseded ones.
 */
export const claudeResumeId = (card: Pick<Card, 'source' | 'activityId'>): string | undefined =>
  card.source === 'claude' ? card.activityId?.replace(/^claude:/, '') : undefined;

/** The Codex prompt: what to do with the work, the summary, then how to go about it. */
export const handoverPrompt = (kind: HandoverKind, summary: string, { branch, ticket }: Pick<Card, 'branch' | 'ticket'>): string => {
  const where = `in this repository${branch ? ` on branch \`${branch}\`` : ''}${ticket ? ` for ${ticket}` : ''}`;
  return [
    kind === 'review' ? `Review the work a Claude session did ${where}.` : `Continue the work a Claude session started ${where}.`,
    `Handover from that session:\n${summary.trim()}`,
    kind === 'review'
      ? 'Review its changes, uncommitted and committed on this branch, for bugs, regressions and missing tests. ' +
        'Report findings by severity with file and line. Do not edit files.'
      : 'Check the repository against the handover first, then carry on from the next step.',
  ].join('\n\n');
};

/**
 * A new Codex chat in `folder` with the prompt in its composer, not sent
 * (https://learn.chatgpt.com/docs/reference/commands). Encoded by hand, since Codex's
 * own example uses `%20` and `URLSearchParams` would turn spaces into `+`.
 */
export const codexNewThreadUrl = (prompt: string, folder: string): string =>
  `codex://threads/new?prompt=${encodeURIComponent(prompt)}&path=${encodeURIComponent(folder)}`;

const SUMMARY_TIMEOUT_MS = 120_000;

/** Whatever model the session ran on, the summary comes from Sonnet. */
const SUMMARY_MODEL = 'claude-sonnet-5-5';

/**
 * Asks the Claude session itself for a handover summary. It resumes as a fork that is not
 * saved, has no tools and loads no settings, hooks or MCP servers (claude.ai connectors load
 * even without settings), so the session and its transcript stay as they were and the board
 * reads only the reply, never the transcript.
 */
export const summarizeClaudeSession = async (claudeBin: string, kind: HandoverKind, sessionId: string, cwd: string): Promise<string> => {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), SUMMARY_TIMEOUT_MS);
  try {
    for await (const message of query({
      prompt: SUMMARY_PROMPTS[kind],
      options: {
        cwd, resume: sessionId, forkSession: true, persistSession: false, settingSources: [], tools: [], strictMcpConfig: true,
        maxTurns: 1, model: SUMMARY_MODEL, effort: 'medium', abortController, pathToClaudeCodeExecutable: claudeBin,
      },
    })) {
      if (message.type !== 'result') continue;
      if (message.subtype === 'success' && !message.is_error && message.result.trim()) return message.result.trim();
      // A failed run says why in its result text or, for an error subtype, in `errors`.
      const reason = message.subtype === 'success' ? message.result : message.errors.join('; ');
      throw new Error(reason.trim().split('\n')[0] || 'Claude did not write a summary');
    }
    throw new Error('Claude did not write a summary');
  } catch (error) {
    if (abortController.signal.aborted) throw new Error('Claude took too long to write the summary');
    // The CLI's own sign-in, separate from Claude Desktop's, can expire on its own.
    if (/\b401\b|authenticate/i.test((error as Error).message)) {
      throw new Error(`${(error as Error).message.split('\n')[0]} Run \`claude auth login\` in a terminal.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
