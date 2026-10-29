import { watch } from 'node:fs';
import { mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { LiveStatus, SessionRecord, Source } from './types.js';

/** What hooks/agent-hub-hook.mjs writes for a session's latest hook event. `status` is null once it ended. */
export interface HookStatus {
  id: string;
  status: LiveStatus | null;
  at: number;
}

/** Where hooks/agent-hub-hook.mjs writes, next to itself in the data folder. */
export const HOOK_STATUS_DIR = 'live-status';

/**
 * How long a Codex hook's status holds after its event. Codex reports no status of its own, so a
 * session that quits without its SessionEnd hook, as in a crash, keeps its last status that long.
 */
const CODEX_HOLD_MS: Record<LiveStatus, number> = { working: 30 * 60_000, waiting: 12 * 3_600_000, idle: 12 * 3_600_000 };

/** Older files are of no use to either source and are removed when read. */
const KEEP_MS = Math.max(...Object.values(CODEX_HOLD_MS));

/**
 * How long a Claude hook's status can stand in for `claude agents`, which may report the change a
 * poll or two after the hook fires.
 */
export const CLAUDE_HOLD_MS = 30_000;

const STATUSES = new Set<unknown>(['working', 'waiting', 'idle', null]);

const isHookStatus = (value: unknown): value is HookStatus => {
  const { id, status, at } = (value ?? {}) as Partial<HookStatus>;
  return typeof id === 'string' && STATUSES.has(status) && typeof at === 'number';
};

/** When each source's hooks last reported, as far back as the status files go. */
export const lastEventBySource = (statuses: ReadonlyMap<string, HookStatus>): Partial<Record<Source, number>> => {
  const last: Partial<Record<Source, number>> = {};
  for (const { id, at } of statuses.values()) {
    const source = id.split(':')[0] as Source;
    if (at > (last[source] ?? 0)) last[source] = at;
  }
  return last;
};

/** The status files hooks write, read on each board and watched so a hook event updates the board at once. */
export class HookStatusStore {
  constructor(private readonly dir: string) {}

  async read(now = Date.now()): Promise<Map<string, HookStatus>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const statuses = new Map<string, HookStatus>();
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const file = path.join(this.dir, name);
          // A file removed since the listing, or not JSON, is skipped; the hook only ever renames whole files in.
          const value: unknown = await readFile(file, 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => undefined);
          if (!isHookStatus(value)) return;
          if (now - value.at > KEEP_MS) return unlink(file).catch(() => {});
          statuses.set(value.id, value);
        }),
    );
    return statuses;
  }

  /** Calls `onChange` once a burst of hook events has landed. Returns a function that stops watching. */
  async watch(onChange: () => void): Promise<() => void> {
    await mkdir(this.dir, { recursive: true });
    let timer: NodeJS.Timeout | undefined;
    const watcher = watch(this.dir, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 100);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  }
}

/**
 * Puts hook statuses on records. A Codex record takes its hook's status while it holds. A Claude
 * record takes it only until `claude agents` catches up: while `claude agents` still reports what
 * it did when the hook's event was first seen, for up to CLAUDE_HOLD_MS. Past that, its own status wins.
 */
export class HookStatusMerge {
  /**
   * Per Claude card, the hook event last seen, the status `claude agents` reported then, and
   * whether it has reported another since.
   */
  private readonly polledAtEvent = new Map<string, { at: number; polled: LiveStatus | null; caughtUp: boolean }>();

  apply(records: SessionRecord[], statuses: ReadonlyMap<string, HookStatus>, now = Date.now()): SessionRecord[] {
    return records.map((record) => {
      const activityId = record.activityId ?? record.id;
      const hook = statuses.get(activityId);
      if (!hook) return record;
      if (record.source === 'codex') {
        return hook.status && now - hook.at <= CODEX_HOLD_MS[hook.status] ? { ...record, liveStatus: hook.status } : record;
      }
      if (now - hook.at > CLAUDE_HOLD_MS) {
        this.polledAtEvent.delete(activityId);
        return record;
      }
      let seen = this.polledAtEvent.get(activityId);
      if (seen?.at !== hook.at) this.polledAtEvent.set(activityId, (seen = { at: hook.at, polled: record.liveStatus, caughtUp: false }));
      if (record.liveStatus !== seen.polled) seen.caughtUp = true;
      if (seen.caughtUp || record.liveStatus === hook.status) return record;
      return { ...record, liveStatus: hook.status, waitingFor: undefined };
    });
  }
}
