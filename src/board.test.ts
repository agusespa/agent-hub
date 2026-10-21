import { describe, expect, it } from 'vitest';
import { cardsStartedWorking, isOnBoard, orderCards, STALE_AFTER_MS, toCard } from './board.js';
import type { Card, ColumnId, LiveStatus, SessionRecord } from './types.js';

const record: SessionRecord = {
  id: 'claude:abc',
  source: 'claude',
  title: 'Add dark mode',
  branch: 'feature/PROJ-42-dark-mode',
  liveStatus: 'working',
};

describe('isOnBoard', () => {
  const now = 100 * STALE_AFTER_MS;
  const idle = { ...record, liveStatus: null };
  const nothingKept = { placement: undefined };

  it('shows sessions active in the last 45 days', () => {
    expect(isOnBoard({ ...idle, lastActiveAt: now - STALE_AFTER_MS }, nothingKept, now)).toBe(true);
  });

  it('hides idle sessions unused for longer', () => {
    expect(isOnBoard({ ...idle, lastActiveAt: now - STALE_AFTER_MS - 1 }, nothingKept, now)).toBe(false);
  });

  it('shows old sessions that are running', () => {
    expect(isOnBoard({ ...record, liveStatus: 'idle', lastActiveAt: 0 }, nothingKept, now)).toBe(true);
  });

  it('shows old sessions the user moved out of Parked or set a ticket on', () => {
    expect(isOnBoard({ ...idle, lastActiveAt: 0 }, { placement: 'done' }, now)).toBe(true);
    expect(isOnBoard({ ...idle, lastActiveAt: 0 }, { placement: undefined, ticket: 'PROJ-7' }, now)).toBe(true);
  });

  it('hides old sessions the user moved to Parked', () => {
    expect(isOnBoard({ ...idle, lastActiveAt: 0 }, { placement: 'parked' }, now)).toBe(false);
  });

  it('falls back to the creation time, and shows sessions with neither', () => {
    expect(isOnBoard({ ...idle, createdAt: 0 }, nothingKept, now)).toBe(false);
    expect(isOnBoard(idle, nothingKept, now)).toBe(true);
  });
});

describe('toCard', () => {
  it('starts in Parked whatever the session is doing', () => {
    expect(toCard(record, { repo: 'r', placement: undefined })).toMatchObject({
      liveStatus: 'working',
      column: 'parked',
    });
  });

  it('keeps the column the user moved the card to', () => {
    expect(toCard(record, { repo: 'r', placement: 'done' }).column).toBe('done');
  });

  it('carries the ticket the user set, and none from the branch', () => {
    expect(toCard(record, { repo: 'r', placement: undefined }).ticket).toBeNull();
    expect(toCard(record, { repo: 'r', placement: undefined, ticket: 'PROJ-7' }).ticket).toBe('PROJ-7');
  });
});

describe('orderCards', () => {
  const card = (id: string, column: Card['column'], lastActiveAt: number): Card =>
    toCard({ ...record, id, lastActiveAt }, { repo: 'r', placement: column });
  const ids = (cards: Card[]) => cards.map((c) => c.id);

  it('follows the saved order within each column', () => {
    const cards = [card('claude:a', 'doing', 3), card('claude:b', 'doing', 2), card('claude:c', 'doing', 1)];
    expect(ids(orderCards(cards, { doing: ['claude:c', 'claude:a', 'claude:b'] }))).toEqual(['claude:c', 'claude:a', 'claude:b']);
  });

  it('puts cards not ordered yet first, newest session first', () => {
    const cards = [card('claude:a', 'doing', 1), card('claude:old', 'doing', 2), card('claude:new', 'doing', 3)];
    expect(ids(orderCards(cards, { doing: ['claude:a'] }))).toEqual(['claude:new', 'claude:old', 'claude:a']);
  });

  it('keeps cards not ordered yet in place when an older session becomes active', () => {
    const cards = [
      { ...card('claude:old', 'doing', 9), createdAt: 1 },
      { ...card('claude:new', 'doing', 2), createdAt: 2 },
    ];
    expect(ids(orderCards(cards, {}))).toEqual(['claude:new', 'claude:old']);
  });

  it('keeps Parked most recently active first, ignoring a saved order', () => {
    const cards = [card('claude:a', 'parked', 1), card('claude:b', 'parked', 3), card('claude:c', 'parked', 2)];
    expect(ids(orderCards(cards, { parked: ['claude:a', 'claude:c', 'claude:b'] }))).toEqual(['claude:b', 'claude:c', 'claude:a']);
  });

  it('ignores an order saved for a column the card has left', () => {
    const cards = [card('claude:a', 'done', 1), card('claude:b', 'done', 2)];
    expect(ids(orderCards(cards, { doing: ['claude:a'], done: ['claude:b'] }))).toEqual(['claude:a', 'claude:b']);
  });
});

describe('cardsStartedWorking', () => {
  const card = (liveStatus: LiveStatus | null, column: ColumnId = 'standby'): Card =>
    toCard({ ...record, liveStatus }, { repo: 'r', placement: column });
  const started = (current: Card, previous: LiveStatus | null | undefined, placed = true) =>
    cardsStartedWorking(
      [current],
      new Map(previous === undefined ? [] : [[current.id, previous]]),
      new Map(placed ? [[current.id, current.column]] : []),
    ).length === 1;

  it('moves a card whose session went from idle to working or waiting', () => {
    expect(started(card('working'), 'idle')).toBe(true);
    expect(started(card('waiting'), 'idle')).toBe(true);
    expect(started(card('working', 'done'), null)).toBe(true);
  });

  it('leaves a card that was already active, so the user can move it out of Doing', () => {
    expect(started(card('working'), 'waiting')).toBe(false);
    expect(started(card('working'), 'working')).toBe(false);
  });

  it('leaves idle cards and cards already in Doing', () => {
    expect(started(card('idle'), 'working')).toBe(false);
    expect(started(card(null), 'idle')).toBe(false);
    expect(started(card('working', 'doing'), 'idle')).toBe(false);
  });

  it('moves a new working session, but not a placed card first seen working', () => {
    expect(started(card('working'), undefined, false)).toBe(true);
    expect(started(card('working'), undefined, true)).toBe(false);
  });
});
