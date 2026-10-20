import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import { APP_VERSION } from '../app.js';
import { branchName } from '../git.js';
import type { PlanUsage, SessionRecord, UsageWindow } from '../types.js';

/** The `thread/list` fields the board reads (https://learn.chatgpt.com/docs/app-server). `preview` is prompt text and is never read. */
export interface CodexThread {
  id: string;
  name?: string | null;
  cwd?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  recencyAt?: number | null;
  gitInfo?: { branch?: string | null; originUrl?: string | null } | null;
}

interface ThreadListResult {
  data: CodexThread[];
  nextCursor?: string | null;
}

/** `git@github.com:org/repo.git` / `https://github.com/org/repo` → `repo`. */
export const repoNameFromRemote = (url: string | null | undefined): string | undefined =>
  url?.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || undefined;

// The app server reports Unix seconds.
const toMillis = (seconds: number | null | undefined): number | undefined =>
  typeof seconds === 'number' ? seconds * 1000 : undefined;

export const mapCodexThread = (thread: CodexThread): SessionRecord => ({
  id: `codex:${thread.id}`,
  source: 'codex',
  title: thread.name || `Codex thread ${thread.id.slice(0, 8)}`,
  cwd: thread.cwd ?? undefined,
  branch: branchName(thread.gitInfo?.branch),
  repoHint: repoNameFromRemote(thread.gitInfo?.originUrl),
  // Threads loaded in the Codex app always read `notLoaded` here, so there is no live status.
  liveStatus: null,
  lastActiveAt: toMillis(thread.recencyAt ?? thread.updatedAt),
  createdAt: toMillis(thread.createdAt),
  openId: thread.id,
});

interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRateLimit {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  planType?: string | null;
}

/** The `account/rateLimits/read` fields the board reads; account ids and reset credits are not. */
export interface RateLimitsResult {
  rateLimits: CodexRateLimit;
  rateLimitsByLimitId?: Record<string, CodexRateLimit> | null;
}

/** 300 → `5h`, 10080 → `Weekly`. */
export const windowLabel = (minutes: number | null | undefined): string => {
  if (!minutes) return 'Limit';
  if (minutes === 7 * 24 * 60) return 'Weekly';
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
};

const toUsageWindows = (limit: CodexRateLimit, prefix?: string): UsageWindow[] =>
  [limit.primary, limit.secondary].flatMap((window) =>
    window
      ? [{
          label: prefix ? `${windowLabel(window.windowDurationMins)} ${prefix}` : windowLabel(window.windowDurationMins),
          usedPercent: window.usedPercent,
          resetsAt: toMillis(window.resetsAt),
        }]
      : [],
  );

/** The main Codex limit, then any other limit buckets (e.g. per model) under their names. */
export const mapCodexRateLimits = (result: RateLimitsResult, fetchedAt = Date.now()): PlanUsage => {
  const main = result.rateLimits;
  const others = Object.values(result.rateLimitsByLimitId ?? {}).filter((limit) => limit.limitId !== main.limitId);
  return {
    source: 'codex',
    plan: main.planType ?? null,
    windows: [
      ...toUsageWindows(main),
      ...others.flatMap((limit) => toUsageWindows(limit, limit.limitName ?? limit.limitId ?? undefined)),
    ],
    fetchedAt,
  };
};

const PAGE_SIZE = 50;

/** The CLI inside the Codex app. */
export const CODEX_BIN = '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex';

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived `codex app-server` over stdio (newline-delimited JSON-RPC without the
 * `jsonrpc` field). Only read methods are sent; the process restarts on the next
 * request if it exits.
 */
export class CodexAppServer {
  private proc?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly bin: string) {}

  async listThreads(): Promise<SessionRecord[]> {
    const threads: CodexThread[] = [];
    let cursor: string | null | undefined;
    let page: ThreadListResult;
    do {
      page = (await this.request('thread/list', {
        limit: PAGE_SIZE,
        sortKey: 'updated_at',
        ...(cursor ? { cursor } : {}),
      })) as ThreadListResult;
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && page.data.length > 0);
    return threads.map(mapCodexThread);
  }

  async readUsage(): Promise<PlanUsage> {
    return mapCodexRateLimits((await this.request('account/rateLimits/read', undefined)) as RateLimitsResult);
  }

  stop(): void {
    this.proc?.kill();
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    this.ready ??= this.start();
    await this.ready;
    return this.send(method, params);
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server: ${method} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  private async start(): Promise<void> {
    const proc = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr.resume();
    proc.stdin.on('error', () => {});

    const fail = (error: Error) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.ready = undefined;
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(error);
        this.pending.delete(id);
      }
    };
    // The cause keeps the spawn error's code, which says when Codex is not installed.
    proc.on('error', (error) => fail(new Error(`codex app-server: ${error.message}`, { cause: error })));
    proc.on('exit', (code) => fail(new Error(`codex app-server exited (${code ?? 'signal'})`)));

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === undefined) return; // notification
      if (message.method) {
        // A request from the server; the board never loads threads, so it has nothing to answer.
        proc.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'not supported' } })}\n`);
        return;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`codex app-server: ${message.error.message ?? 'request failed'}`));
      else pending.resolve(message.result);
    });

    try {
      await this.send('initialize', {
        clientInfo: { name: 'agent_hub', title: 'Agent Hub', version: APP_VERSION },
      });
    } catch (error) {
      proc.kill();
      throw error;
    }
    proc.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
  }
}
