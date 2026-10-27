import type { Placements } from './placements.js';
import {
  COLUMNS,
  DEFAULT_COLUMN,
  type Card,
  type ColumnId,
  type LiveStatus,
  type SessionRecord,
} from './types.js';

interface CardContext {
  repo: string;
  placement: ColumnId | undefined;
  ticket?: string;
  notes?: string;
  lastPromptAt?: number;
}

/** How long a session can sit unused before it drops off the board. */
export const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * Sessions to show: those the user sent a prompt in the last 45 days, or started then if
 * the hooks saw no prompt, those running, and those kept by the user by moving the card
 * out of Parked, setting a ticket or adding notes. Last active only counts with neither time, as
 * it moves when Claude or Codex rewrite a session. A session with no timestamps is shown,
 * as its age is unknown. A hidden session comes back once it gets a prompt or runs again.
 */
export const isOnBoard = (
  record: SessionRecord,
  { placement, ticket, notes, lastPromptAt }: Pick<CardContext, 'placement' | 'ticket' | 'notes' | 'lastPromptAt'>,
  now = Date.now(),
): boolean => {
  const lastUsed = lastPromptAt ?? record.createdAt ?? record.lastActiveAt;
  const kept = (placement ?? DEFAULT_COLUMN) !== DEFAULT_COLUMN || ticket !== undefined || Boolean(notes?.trim());
  return record.liveStatus !== null || lastUsed === undefined || now - lastUsed <= STALE_AFTER_MS || kept;
};

/** Cards start in Parked until the user moves them or the session starts working (see `cardsStartedWorking`). */
export const toCard = (record: SessionRecord, { repo, placement, ticket, notes, lastPromptAt }: CardContext): Card => ({
  ...record,
  repo,
  ticket: ticket ?? null,
  notes: notes ?? '',
  column: placement ?? DEFAULT_COLUMN,
  lastPromptAt,
});

/** Working, or waiting on the user in the middle of a turn. */
const isActive = (status: LiveStatus | null | undefined) => status === 'working' || status === 'waiting';

/**
 * Cards whose session became active since the previous board, which move to Doing. A card
 * not seen before counts as idle unless the user has placed it, so a new session that
 * starts working lands in Doing, while a placed card that was already working when the
 * board started stays where the user put it.
 */
export const cardsStartedWorking = (
  cards: Card[],
  previous: ReadonlyMap<string, LiveStatus | null>,
  placed: ReadonlyMap<string, ColumnId>,
): Card[] =>
  cards.filter(
    (card) =>
      card.column !== 'doing' &&
      isActive(card.liveStatus) &&
      (previous.has(card.id) ? !isActive(previous.get(card.id)) : !placed.has(card.id)),
  );

const MANUAL_COLUMNS = new Set<ColumnId>(COLUMNS.filter((column) => column.manualOrder).map((column) => column.id));

/**
 * Puts the cards of each manually ordered column in the order the user dragged them
 * into. Cards not ordered yet, such as new sessions, come first, newest session first,
 * so they hold still while their session works. The other columns come by the user's
 * last prompt, newest first, or by when the session was created where the hooks saw
 * none. A session's last active time moves when Claude or Codex touch it, even with
 * no new prompt, so it would shuffle them.
 */
export const orderCards = (cards: Card[], order: Placements['order']): Card[] => {
  const ranks = new Map(
    cards.map((card) => [card, MANUAL_COLUMNS.has(card.column) ? (order[card.column]?.indexOf(card.id) ?? -1) : -1]),
  );
  const recency = (card: Card) =>
    (MANUAL_COLUMNS.has(card.column) ? undefined : card.lastPromptAt) ?? card.createdAt ?? card.lastActiveAt ?? 0;
  return [...cards].sort((a, b) => {
    const rankA = ranks.get(a) ?? -1;
    const rankB = ranks.get(b) ?? -1;
    if (rankA === -1 || rankB === -1) return rankA === rankB ? recency(b) - recency(a) : rankA === -1 ? -1 : 1;
    return rankA - rankB;
  });
};
