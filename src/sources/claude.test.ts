import { describe, expect, it } from 'vitest';
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

describe('mapClaudeSessions', () => {
  it('merges a live agent with its history entry', () => {
    const [card] = mapClaudeSessions(
      [agent({ sessionId: 'sess-1', name: 'default name', status: 'waiting', waitingFor: 'permission prompt' })],
      [history({ customTitle: 'Fix login redirect', gitBranch: 'PROJ-1-fix', createdAt: 900 })],
    );
    expect(card).toEqual({
      id: 'claude:sess-1',
      source: 'claude',
      title: 'Fix login redirect',
      cwd: '/code/my-app',
      branch: 'PROJ-1-fix',
      liveStatus: 'waiting',
      waitingFor: 'permission prompt',
      lastActiveAt: 5_000,
      createdAt: 900,
    });
  });

  it('falls back to the agent name, then a short id', () => {
    const cards = mapClaudeSessions([agent({ sessionId: 'aaaa1111-x', name: 'Named' }), agent({ sessionId: 'bbbb2222-y' })], []);
    expect(cards.map((c) => c.title)).toEqual(['Named', 'Claude session bbbb2222']);
  });

  it('keys background sessions without a session id by their short id', () => {
    const [card] = mapClaudeSessions([agent({ kind: 'background', id: 'k3', state: 'working' })], []);
    expect(card.id).toBe('claude:bg-k3');
  });

  it('keeps all history without a live agent, however old, with no live status', () => {
    const cards = mapClaudeSessions([], [history({ sessionId: 'new', lastModified: 10 }), history({ sessionId: 'old', lastModified: 1 })]);
    expect(cards.map((c) => [c.id, c.liveStatus])).toEqual([
      ['claude:new', null],
      ['claude:old', null],
    ]);
  });

  it('makes one card for a live agent and its history entry', () => {
    const cards = mapClaudeSessions([agent({ sessionId: 'sess-1', status: 'idle' })], [history({ lastModified: 1 })]);
    expect(cards).toHaveLength(1);
  });

  it('only shows the waiting reason while waiting', () => {
    const [card] = mapClaudeSessions([agent({ sessionId: 's', status: 'idle', waitingFor: 'stale' })], []);
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
