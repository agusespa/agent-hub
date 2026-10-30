import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claudeResumeId, codexNewThreadUrl, currentHandover, handoverPrompt, HandoverStore, summarizeClaudeSession, SUMMARY_PROMPTS,
} from './handover.js';
import type { ClaudeDesktopSession } from './sources/claudeDesktop.js';
import { mapClaudeSessions } from './sources/claude.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => ({ ...(await original<object>()), query }));

afterEach(() => {
  vi.useRealTimers();
  query.mockReset();
});

const desktop = (overrides: Partial<ClaudeDesktopSession>): ClaudeDesktopSession => ({
  sessionId: 'local_conversation', priorCliSessionIds: [], cwd: '/code/my-app', ...overrides,
});

/** A `query` that yields `messages`, or throws `error` after them. */
const replies = (messages: Partial<SDKMessage>[], error?: Error) =>
  query.mockImplementation(async function* () {
    yield* messages;
    if (error) throw error;
  });

describe('claudeResumeId', () => {
  it('resumes the current CLI session of a Claude conversation', () => {
    const [card] = mapClaudeSessions([], [], [desktop({ cliSessionId: 'current', priorCliSessionIds: ['old'] })]);
    expect(claudeResumeId(card)).toBe('current');
    expect(claudeResumeId({ source: 'codex', activityId: 'codex:t1' })).toBeUndefined();
  });

  it('never falls back to a superseded execution', () => {
    // No current execution yet, only an old one.
    const [unknown] = mapClaudeSessions([], [], [desktop({ priorCliSessionIds: ['old'] })]);
    expect(unknown.aliases).toEqual(['claude:old']);
    expect(claudeResumeId(unknown)).toBeUndefined();
    // Two conversations claim the same current execution, so it belongs to neither.
    const shared = mapClaudeSessions([], [], [
      desktop({ sessionId: 'local_a', cliSessionId: 'shared', priorCliSessionIds: ['a-old'] }),
      desktop({ sessionId: 'local_b', cliSessionId: 'shared', priorCliSessionIds: ['b-old'] }),
    ]);
    expect(shared.map((card) => card.aliases)).toEqual([['claude:a-old'], ['claude:b-old']]);
    expect(shared.map(claudeResumeId)).toEqual([undefined, undefined]);
  });
});

describe('handoverPrompt', () => {
  it('puts the summary, branch and ticket in the review prompt', () => {
    const prompt = handoverPrompt('review', '  Added the handover route.\n', { branch: 'main', ticket: 'PROJ-1' });
    expect(prompt).toMatch(/^Review the work a Claude session did in this repository on branch `main` for PROJ-1\./);
    expect(prompt).toContain('Handover from that session:\nAdded the handover route.\n\nReview its changes');
    expect(prompt).toContain('Do not edit files.');
    expect(handoverPrompt('review', 'Summary', { ticket: null })).toMatch(/^Review the work a Claude session did in this repository\.\n/);
  });

  it('asks Codex to check, then carry on, when continuing', () => {
    const prompt = handoverPrompt('continue', 'Next: add tests.', { branch: 'feature', ticket: null });
    expect(prompt).toMatch(/^Continue the work a Claude session started in this repository on branch `feature`\./);
    expect(prompt).toMatch(/Next: add tests\.\n\nCheck the repository against the handover first/);
    expect(prompt).not.toContain('Do not edit files.');
  });
});

describe('codexNewThreadUrl', () => {
  it('opens a new Codex chat in the folder with the prompt unsent', () => {
    const prompt = 'Check a+b & `c`, 100% correct and %20 kept\nnow';
    const url = codexNewThreadUrl(prompt, '/Users/test/my project');
    expect(url).toMatch(/^codex:\/\/threads\/new\?prompt=Check%20a%2Bb%20%26%20%60c%60%2C%20100%25%20correct%20and%20%2520%20kept%0Anow&path=/);
    const params = new URL(url).searchParams;
    expect(params.get('prompt')).toBe(prompt);
    expect(params.get('path')).toBe('/Users/test/my project');
  });
});

describe('summarizeClaudeSession', () => {
  it('resumes an unsaved fork with no tools, settings or MCP servers', async () => {
    replies([{ type: 'assistant' }, { type: 'result', subtype: 'success', is_error: false, result: '  The summary.\n' }]);
    expect(await summarizeClaudeSession('claude', 'continue', 'sess-1', '/code/my-app')).toBe('The summary.');
    const { prompt, options } = query.mock.calls[0][0] as { prompt: string; options: Options };
    expect(prompt).toBe(SUMMARY_PROMPTS.continue);
    expect(options).toMatchObject({
      cwd: '/code/my-app', resume: 'sess-1', forkSession: true, persistSession: false,
      settingSources: [], tools: [], strictMcpConfig: true, model: 'claude-sonnet-5-5', effort: 'medium',
      pathToClaudeCodeExecutable: 'claude',
    });
  });

  it('reports why a run failed, with the sign-in step for an expired login', async () => {
    replies([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 401 OAuth access token is invalid.', 'more'] }]);
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toThrow(
      'API Error: 401 OAuth access token is invalid.; more Run `claude auth login` in a terminal.');

    replies([{ type: 'result', subtype: 'success', is_error: true, result: 'Prompt is too long\ndetails' }]);
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toThrow(/^Prompt is too long$/);

    replies([{ type: 'result', subtype: 'success', is_error: false, result: '  ' }]);
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toThrow('Claude did not write a summary');
  });

  it('passes on thrown errors, keeping the cause when it adds the sign-in step', async () => {
    const thrown = new Error('Failed to authenticate. API Error: 401');
    replies([], thrown);
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toMatchObject({
      message: 'Failed to authenticate. API Error: 401 Run `claude auth login` in a terminal.', cause: thrown,
    });
    replies([], new Error('No conversation found with session ID: s'));
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toThrow('No conversation found with session ID: s');
    replies([]);
    await expect(summarizeClaudeSession('claude', 'review', 's', '/c')).rejects.toThrow('Claude did not write a summary');
  });

  it('stops a summary that takes over two minutes', async () => {
    vi.useFakeTimers();
    query.mockImplementation(async function* ({ options }: { options: Options }) {
      await new Promise((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const summary = summarizeClaudeSession('claude', 'review', 's', '/c');
    const failed = expect(summary).rejects.toThrow('Claude took too long to write the summary');
    await vi.advanceTimersByTimeAsync(120_000);
    await failed;
  });
});

describe('handover record', () => {
  it('keeps each card\'s last handover and ignores invalid saved entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-handovers-'));
    try {
      const file = path.join(dir, 'handovers.json');
      const store = new HandoverStore(file);
      expect(await store.read()).toEqual(new Map());
      await Promise.all([store.set('claude:a', { kind: 'review', at: 1 }), store.set('claude:b', { kind: 'continue', at: 2 })]);
      await store.set('claude:a', { kind: 'continue', at: 3 });
      expect(await new HandoverStore(file).read()).toEqual(new Map([
        ['claude:a', { kind: 'continue', at: 3 }], ['claude:b', { kind: 'continue', at: 2 }],
      ]));
      await store.set('claude:b');
      expect(await new HandoverStore(file).read()).toEqual(new Map([['claude:a', { kind: 'continue', at: 3 }]]));
      await writeFile(file, JSON.stringify({ cards: { 'claude:a': { kind: 'rewrite', at: 1 }, 'claude:b': { kind: 'review' }, 'claude:c': { kind: 'review', at: 4 } } }));
      expect(await store.read()).toEqual(new Map([['claude:c', { kind: 'review', at: 4 }]]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('shows until the session is used again', () => {
    const handover = { kind: 'review' as const, at: 100 };
    expect(currentHandover(handover, {})).toBe(handover);
    expect(currentHandover(handover, { lastActiveAt: 100, lastPromptAt: 50 })).toBe(handover);
    expect(currentHandover(handover, { lastActiveAt: 101 })).toBeUndefined();
    expect(currentHandover(handover, { lastActiveAt: 50, lastPromptAt: 101 })).toBeUndefined();
    expect(currentHandover(undefined, {})).toBeUndefined();
  });
});
