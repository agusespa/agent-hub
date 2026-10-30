export type Source = 'claude' | 'codex';

/** Live state of a session's process. Only Claude reports it; Codex sessions are always `null`. */
export type LiveStatus = 'working' | 'waiting' | 'idle';

/**
 * Columns are the user's own planning; a card's status shows as a tag instead. The
 * one exception: a card whose session starts working moves to Doing. Parked is paused
 * work with no resume date, and holds every card the user has not moved yet. Parked and
 * Done go by the user's last prompt; the user orders Stand-by and Doing by dragging.
 */
export const COLUMNS = [
  { id: 'parked', title: 'Parked', manualOrder: false },
  { id: 'standby', title: 'Stand-by', manualOrder: true },
  { id: 'doing', title: 'Doing', manualOrder: true },
  { id: 'done', title: 'Done', manualOrder: false },
] as const;

export const DEFAULT_COLUMN: ColumnId = 'parked';

export type ColumnId = (typeof COLUMNS)[number]['id'];

export const isColumnId = (value: unknown): value is ColumnId =>
  COLUMNS.some((column) => column.id === value);

/**
 * A session as reported by one source, before column placement.
 * Holds titles and metadata only — never prompt or transcript text.
 */
export interface SessionRecord {
  /** Board-wide unique id, prefixed with the source. */
  id: string;
  /** Execution IDs belonging to this conversation, current first, for state migration. */
  aliases?: string[];
  /** Current execution's source-prefixed ID, used for hooks and file activity. */
  activityId?: string;
  source: Source;
  title: string;
  /** The source's real session id for renaming; absent where the source cannot rename it. */
  renameId?: string;
  cwd?: string;
  branch?: string;
  /** Repo name the source already knows (e.g. from a git remote), used before falling back to the cwd. */
  repoHint?: string;
  liveStatus: LiveStatus | null;
  waitingFor?: string;
  lastActiveAt?: number;
  createdAt?: number;
  /**
   * The id the session's own app opens it by: Codex's thread id. Claude documents no link to
   * open a session by, so its cards have none and show no open button (see `sessionUrl`).
   */
  openId?: string;
}

/** One plan rate-limit window, e.g. the 5-hour or weekly limit. */
export interface UsageWindow {
  /** e.g. `5h`, `Weekly`, `Weekly Opus`. */
  label: string;
  /** 0–100. */
  usedPercent: number;
  resetsAt?: number;
}

/** Plan limits for one source's logged-in account. Holds percentages and reset times only. */
export interface PlanUsage {
  source: Source;
  /** e.g. `pro`, `max`, `team`; null when the source does not say. */
  plan: string | null;
  windows: UsageWindow[];
  fetchedAt: number;
  /** Why there are no windows: a failed read, or a login without plan limits. */
  error?: string;
}

/** Codex either reviews a Claude session's work or takes it over. */
export type HandoverKind = 'review' | 'continue';

/** The last time the user handed a session over to Codex from the board. */
export interface Handover {
  kind: HandoverKind;
  at: number;
}

export interface Card extends SessionRecord {
  repo: string;
  /** The ticket the user set on the board, such as PROJ-1234. */
  ticket: string | null;
  /** Notes written in Agent Hub, stored locally per session. */
  notes: string;
  column: ColumnId;
  /** When the user last sent the session a prompt, as the board's hooks saw it. */
  lastPromptAt?: number;
  /** The last handover, until the session is used again. */
  handover?: Handover;
}
