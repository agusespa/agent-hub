import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { listSessions, query, type SDKControlGetUsageResponse, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { branchName } from '../git.js';
import type { LiveStatus, PlanUsage, SessionRecord, UsageWindow } from '../types.js';

const execFileAsync = promisify(execFile);

/** Found on PATH; the desktop app takes the login shell's PATH so it finds the same one. */
export const CLAUDE_BIN = 'claude';

/** One entry of `claude agents --json --all` (https://code.claude.com/docs/en/agent-view). */
export interface ClaudeAgent {
  cwd: string;
  kind: 'interactive' | 'background';
  startedAt: number;
  id?: string;
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
  pid?: number;
  status?: 'busy' | 'waiting' | 'idle';
  waitingFor?: string;
  sessionId?: string;
  name?: string;
}

/** Only the history fields the board uses; `summary` and `firstPrompt` can hold prompt text and are never read. */
export type ClaudeHistoryEntry = Pick<SDKSessionInfo, 'sessionId' | 'customTitle' | 'gitBranch' | 'cwd' | 'createdAt' | 'lastModified'>;

const FROM_STATUS: Record<NonNullable<ClaudeAgent['status']>, LiveStatus> = { busy: 'working', waiting: 'waiting', idle: 'idle' };
const FROM_STATE: Partial<Record<NonNullable<ClaudeAgent['state']>, LiveStatus>> = { working: 'working', blocked: 'waiting', done: 'idle' };

/** `status` describes a live process; `state` is all that is left once a background session's process has exited. */
export const toLiveStatus = (agent: ClaudeAgent): LiveStatus | null =>
  (agent.status && FROM_STATUS[agent.status]) ?? (agent.state && FROM_STATE[agent.state]) ?? null;

const agentKey = (agent: ClaudeAgent): string =>
  agent.sessionId ?? (agent.id ? `bg-${agent.id}` : `pid-${agent.pid ?? agent.startedAt}`);

/** A session from its history entry, its live agent, or both. */
const toRecord = (key: string, entry: ClaudeHistoryEntry | undefined, agent?: ClaudeAgent): SessionRecord => ({
  id: `claude:${key}`,
  source: 'claude',
  title: entry?.customTitle || agent?.name || `Claude session ${key.slice(0, 8)}`,
  cwd: agent?.cwd || entry?.cwd,
  branch: branchName(entry?.gitBranch),
  liveStatus: agent ? toLiveStatus(agent) : null,
  waitingFor: agent?.status === 'waiting' ? agent.waitingFor : undefined,
  lastActiveAt: entry?.lastModified ?? agent?.startedAt,
  createdAt: entry?.createdAt ?? agent?.startedAt,
});

/**
 * Merges live agents with session history. Every live agent and every history entry
 * becomes a record.
 */
export const mapClaudeSessions = (agents: ClaudeAgent[], history: ClaudeHistoryEntry[]): SessionRecord[] => {
  const historyById = new Map(history.map((entry) => [entry.sessionId, entry]));
  const records = new Map<string, SessionRecord>();
  for (const agent of agents) {
    const key = agentKey(agent);
    records.set(key, toRecord(key, agent.sessionId ? historyById.get(agent.sessionId) : undefined, agent));
  }
  for (const entry of history) {
    if (!records.has(entry.sessionId)) records.set(entry.sessionId, toRecord(entry.sessionId, entry));
  }
  return [...records.values()];
};

const fetchAgents = async (claudeBin: string): Promise<ClaudeAgent[]> => {
  const { stdout } = await execFileAsync(claudeBin, ['agents', '--json', '--all'], {
    cwd: homedir(),
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array');
  return parsed as ClaudeAgent[];
};

const fetchHistory = async (): Promise<ClaudeHistoryEntry[]> =>
  (await listSessions()).map(({ sessionId, customTitle, gitBranch, cwd, createdAt, lastModified }) => ({
    sessionId,
    customTitle,
    gitBranch,
    cwd,
    createdAt,
    lastModified,
  }));

/** `usageCwd` is where the board reads plan usage; the short-lived process there is not a session to show. */
export const fetchClaudeSessions = async (claudeBin: string, usageCwd: string): Promise<SessionRecord[]> => {
  const [agents, history] = await Promise.all([fetchAgents(claudeBin), fetchHistory()]);
  return mapClaudeSessions(agents.filter((agent) => agent.cwd !== usageCwd), history);
};

const NAMED_WINDOWS: Array<['five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet', string]> = [
  ['five_hour', '5h'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly Opus'],
  ['seven_day_sonnet', 'Weekly Sonnet'],
];

const toWindow = (label: string, window: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow[] =>
  typeof window?.utilization === 'number'
    ? [{ label, usedPercent: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) : undefined }]
    : [];

/** Only the plan fields of the `/usage` data; session cost and the transcript scan are not read. */
export const mapClaudeUsage = (
  usage: Pick<SDKControlGetUsageResponse, 'subscription_type' | 'rate_limits_available' | 'rate_limits'>,
  fetchedAt = Date.now(),
): PlanUsage => {
  const limits = usage.rate_limits;
  const base = { source: 'claude' as const, plan: usage.subscription_type, windows: [], fetchedAt };
  if (!usage.rate_limits_available) return { ...base, error: 'No plan limits for this login (API key or cloud provider)' };
  if (!limits) return { ...base, error: 'Claude did not report plan usage; trying again within the hour' };
  return {
    ...base,
    windows: [
      ...NAMED_WINDOWS.flatMap(([key, label]) => toWindow(label, limits[key])),
      ...(limits.model_scoped ?? []).flatMap((window) => toWindow(`Weekly ${window.display_name}`, window)),
    ],
  };
};

/**
 * Plan usage from the SDK's `/usage` call, the only way to read it from outside the app (the
 * SDK marks it experimental, so the shape may change). The process gets no prompt, so it makes
 * no model calls, saves no session and loads no settings or hooks; it runs in `cwd` so
 * `fetchClaudeSessions` can leave it off the board.
 */
export const fetchClaudeUsage = async (claudeBin: string, cwd: string): Promise<PlanUsage> => {
  await mkdir(cwd, { recursive: true });
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const session = query({
    prompt: (async function* () {
      await stopped;
    })(),
    options: { cwd, persistSession: false, settingSources: [], pathToClaudeCodeExecutable: claudeBin },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const usage = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('usage request timed out')), 30_000);
      }),
    ]);
    return mapClaudeUsage(usage);
  } finally {
    clearTimeout(timer);
    stop();
    session.close();
  }
};
