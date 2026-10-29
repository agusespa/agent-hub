import { describe, expect, it } from 'vitest';
import type { ClaudeDesktopSession } from './claudeDesktop.js';
import { mapClaudeSessions, mapClaudeUsage, toLiveStatus, type ClaudeAgent, type ClaudeHistoryEntry } from './claude.js';

const agent = (overrides: Partial<ClaudeAgent>): ClaudeAgent => ({
  cwd: '/code/my-app',
  kind: 'interactive',
  startedAt: 1_000,
  ...overrides,
});

const history = (overrides: Partial<ClaudeHistoryEntry>): ClaudeHistoryEntry => ({
  sessionId: 'sess-1',
  lastModified: 5_000,
  ...overrides,
});

describe('toLiveStatus', () => {
  it.each([
    [{ status: 'busy' }, 'working'],
    [{ status: 'waiting', waitingFor: 'permission prompt' }, 'waiting'],
    [{ status: 'idle' }, 'idle'],
    [{ status: 'idle', state: 'working' }, 'idle'],
    [{ kind: 'background', state: 'working' }, 'working'],
    [{ kind: 'background', state: 'blocked' }, 'waiting'],
    [{ kind: 'background', state: 'done' }, 'idle'],
    [{ kind: 'background', state: 'failed' }, null],
    [{ kind: 'background', state: 'stopped' }, null],
    [{}, null],
  ] as const)('%o → %s', (fields, expected) => {
    expect(toLiveStatus(agent(fields))).toBe(expected);
  });
});

const desktop = (overrides: Partial<ClaudeDesktopSession> = {}): ClaudeDesktopSession => ({
  sessionId: 'local_conversation', cliSessionId: 'sess-1', priorCliSessionIds: [],
  title: 'Desktop title', cwd: '/code/my-app', createdAt: 900, lastActivityAt: 6_000,
  ...overrides,
});

describe('mapClaudeSessions', () => {
  it('uses Desktop identity and metadata with the current execution status', () => {
    const [card] = mapClaudeSessions(
      [agent({ sessionId: 'sess-1', name: 'Execution name', status: 'waiting', waitingFor: 'permission' })],
      [history({ customTitle: 'Old title', gitBranch: 'PROJ-1-fix', createdAt: 800 })], [desktop()],
    );
    expect(card).toEqual({
      id: 'claude:local_conversation', aliases: ['claude:sess-1'], activityId: 'claude:sess-1',
      source: 'claude', title: 'Desktop title', cwd: '/code/my-app', branch: 'PROJ-1-fix',
      liveStatus: 'waiting', waitingFor: 'permission', lastActiveAt: 6_000, createdAt: 900,
    });
  });

  it('excludes terminal history, terminal processes and background agents', () => {
    const agents = [agent({ sessionId: 'terminal', status: 'busy' }), agent({ kind: 'background', id: 'background', state: 'working' })];
    expect(mapClaudeSessions(agents, [history({ sessionId: 'terminal' })], [])).toEqual([]);
    expect(mapClaudeSessions(agents, [history({ sessionId: 'terminal' })], [desktop()])).toEqual([
      expect.objectContaining({ id: 'claude:local_conversation', liveStatus: null }),
    ]);
  });

  it('keeps the same card through repeated CLI ID changes, even before new history is written', () => {
    const states = [
      desktop({ cliSessionId: 'first' }),
      desktop({ cliSessionId: 'second', priorCliSessionIds: ['first'] }),
      desktop({ cliSessionId: 'third', priorCliSessionIds: ['first', 'second'] }),
    ];
    for (const state of states) {
      const cards = mapClaudeSessions([agent({ sessionId: state.cliSessionId, status: 'busy' })],
        [history({ sessionId: 'first' })], [state]);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ id: 'claude:local_conversation', liveStatus: 'working', activityId: `claude:${state.cliSessionId}` });
    }
    expect(mapClaudeSessions([], [], [states[2]])[0].id).toBe('claude:local_conversation');
  });

  it('does not inherit live state from a superseded execution', () => {
    const cards = mapClaudeSessions([agent({ sessionId: 'old', status: 'busy' })], [history({ sessionId: 'old' })],
      [desktop({ priorCliSessionIds: ['old'] })]);
    expect(cards[0]).toMatchObject({ liveStatus: null, activityId: 'claude:sess-1', aliases: ['claude:sess-1', 'claude:old'] });
  });

  it('shows new Desktop conversations before a CLI ID or transcript exists', () => {
    const [card] = mapClaudeSessions([], [], [desktop({ cliSessionId: undefined })]);
    expect(card).toMatchObject({ id: 'claude:local_conversation', title: 'Desktop title', aliases: [], liveStatus: null });
  });

  it('keeps distinct Desktop conversations and forks with matching titles and ancestry', () => {
    const cards = mapClaudeSessions([], [], [
      desktop({ sessionId: 'local_parent', cliSessionId: 'parent' }),
      desktop({ sessionId: 'local_fork', cliSessionId: 'fork', priorCliSessionIds: ['parent'] }),
      desktop({ sessionId: 'local_other', cliSessionId: 'other' }),
    ]);
    expect(cards.map((card) => card.id)).toEqual(['claude:local_parent', 'claude:local_fork', 'claude:local_other']);
    expect(cards[0].aliases).toEqual(['claude:parent']);
    expect(cards[1].aliases).toEqual(['claude:fork']);
  });

  it('does not assign shared prior executions to either fork', () => {
    const cards = mapClaudeSessions([], [], [
      desktop({ sessionId: 'local_a', cliSessionId: 'a', priorCliSessionIds: ['shared'] }),
      desktop({ sessionId: 'local_b', cliSessionId: 'b', priorCliSessionIds: ['shared'] }),
    ]);
    expect(cards.map((card) => card.aliases)).toEqual([['claude:a'], ['claude:b']]);
  });

  it('only shows a waiting reason while waiting', () => {
    const [card] = mapClaudeSessions([agent({ sessionId: 'sess-1', status: 'idle', waitingFor: 'stale' })], [], [desktop()]);
    expect(card.waitingFor).toBeUndefined();
  });
});

describe('mapClaudeUsage', () => {
  it('maps plan windows to percentages and reset times', () => {
    const usage = mapClaudeUsage(
      {
        subscription_type: 'team',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: '2026-10-20T15:00:00Z' },
          seven_day: { utilization: 10, resets_at: null },
          seven_day_opus: { utilization: null, resets_at: null },
          model_scoped: [{ display_name: 'Fable', utilization: 80, resets_at: '2026-10-25T00:00:00Z' }],
        },
      },
      7,
    );
    expect(usage).toEqual({
      source: 'claude',
      plan: 'team',
      fetchedAt: 7,
      windows: [
        { label: '5h', usedPercent: 42.5, resetsAt: Date.parse('2026-10-20T15:00:00Z') },
        { label: 'Weekly', usedPercent: 10, resetsAt: undefined },
        { label: 'Weekly Fable', usedPercent: 80, resetsAt: Date.parse('2026-10-25T00:00:00Z') },
      ],
    });
  });

  it('explains logins without plan limits', () => {
    expect(mapClaudeUsage({ subscription_type: null, rate_limits_available: false, rate_limits: null })).toMatchObject({
      windows: [],
      error: expect.stringContaining('API key'),
    });
  });

  it('reports a missing answer', () => {
    expect(mapClaudeUsage({ subscription_type: 'pro', rate_limits_available: true, rate_limits: null })).toMatchObject({
      plan: 'pro',
      windows: [],
      error: expect.stringContaining('did not report plan usage'),
    });
  });
});
