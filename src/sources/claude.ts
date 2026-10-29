import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { listSessions, query, type SDKControlGetUsageResponse, type SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { branchName } from '../git.js';
import type { LiveStatus, PlanUsage, SessionRecord, UsageWindow } from '../types.js';
import { readClaudeDesktopSessions, type ClaudeDesktopSession } from './claudeDesktop.js';

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

/**
 * Desktop defines the cards and their permanent IDs. CLI history only enriches a
 * known conversation; terminal sessions and background agents never create cards.
 */
export const mapClaudeSessions = (
  agents: ClaudeAgent[], history: ClaudeHistoryEntry[], desktop: ClaudeDesktopSession[] = [],
): SessionRecord[] => {
  const historyById = new Map(history.map((entry) => [entry.sessionId, entry]));
  const liveById = new Map(agents.filter((agent) => agent.kind === 'interactive' && agent.sessionId)
    .map((agent) => [agent.sessionId!, agent]));
  const conversations = [...new Map(desktop.map((session) => [session.sessionId, session])).values()];
  const owners = new Map<string, Set<string>>();
  const currentOwners = new Map<string, Set<string>>();
  for (const session of conversations) {
    if (session.cliSessionId) {
      const ids = currentOwners.get(session.cliSessionId) ?? new Set<string>();
      ids.add(session.sessionId);
      currentOwners.set(session.cliSessionId, ids);
    }
    for (const id of [session.cliSessionId, ...session.priorCliSessionIds]) {
      if (!id) continue;
      const ids = owners.get(id) ?? new Set<string>();
      ids.add(session.sessionId);
      owners.set(id, ids);
    }
  }
  return conversations.map((session) => {
    // Shared ancestry is not evidence that two Desktop conversations are the same.
    const cliIds = [...new Set([session.cliSessionId, ...[...session.priorCliSessionIds].reverse()])]
      .filter((id): id is string => Boolean(id) && (currentOwners.get(id!) ?? owners.get(id!))?.size === 1 &&
        (currentOwners.get(id!) ?? owners.get(id!))?.has(session.sessionId) === true);
    const currentId = session.cliSessionId && cliIds.includes(session.cliSessionId) ? session.cliSessionId : undefined;
    const entry = cliIds.map((id) => historyById.get(id)).find((entry) => entry !== undefined);
    const agent = currentId ? liveById.get(currentId) : undefined;
    return {
      id: `claude:${session.sessionId}`,
      aliases: cliIds.map((id) => `claude:${id}`),
      activityId: currentId ? `claude:${currentId}` : undefined,
      source: 'claude',
      title: session.title || entry?.customTitle || agent?.name || `Claude conversation ${session.sessionId.slice(6, 14)}`,
      cwd: session.cwd || agent?.cwd || entry?.cwd,
      branch: branchName(entry?.gitBranch),
      liveStatus: agent ? toLiveStatus(agent) : null,
      waitingFor: agent?.status === 'waiting' ? agent.waitingFor : undefined,
      lastActiveAt: session.lastActivityAt ?? entry?.lastModified ?? agent?.startedAt,
      createdAt: session.createdAt ?? entry?.createdAt ?? agent?.startedAt,
    };
  });
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

export const fetchClaudeSessions = async (claudeBin: string): Promise<SessionRecord[]> => {
  const [agents, history, desktop] = await Promise.all([fetchAgents(claudeBin), fetchHistory(), readClaudeDesktopSessions()]);
  return mapClaudeSessions(agents, history, desktop);
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
 * no model calls, saves no session and loads no settings or hooks. Desktop-only
 * discovery never creates a card for this internal process.
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
