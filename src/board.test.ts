import { describe, expect, it } from 'vitest';
import { cardsStartedWorking, DAY_MS, isOnBoard, orderCards, STALE_AFTER_MS, toCard } from './board.js';
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

  it('shows sessions started in the last 45 days', () => {
    expect(isOnBoard({ ...idle, createdAt: now - STALE_AFTER_MS }, nothingKept, now)).toBe(true);
  });

  it('shows older sessions the user sent a prompt in the last 45 days', () => {
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: undefined, lastPromptAt: now - STALE_AFTER_MS }, now)).toBe(true);
  });

  it('hides idle sessions started or prompted longer ago, however recently last active', () => {
    expect(isOnBoard({ ...idle, createdAt: now - STALE_AFTER_MS - 1, lastActiveAt: now }, nothingKept, now)).toBe(false);
    expect(isOnBoard({ ...idle, createdAt: 0, lastActiveAt: now }, { placement: undefined, lastPromptAt: 1 }, now)).toBe(false);
  });

  it('uses the number of days set in Settings', () => {
    const twoWeeks = 14 * DAY_MS;
    expect(isOnBoard({ ...idle, createdAt: now - twoWeeks }, nothingKept, now, twoWeeks)).toBe(true);
    expect(isOnBoard({ ...idle, createdAt: now - twoWeeks - 1 }, nothingKept, now, twoWeeks)).toBe(false);
  });

  it('shows old sessions that are running', () => {
    expect(isOnBoard({ ...record, liveStatus: 'idle', createdAt: 0 }, nothingKept, now)).toBe(true);
  });

  it('shows old sessions the user moved out of Parked or set a ticket on', () => {
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: 'done' }, now)).toBe(true);
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: undefined, ticket: 'PROJ-7' }, now)).toBe(true);
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: undefined, notes: 'Continue after release' }, now)).toBe(true);
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: undefined, notes: '   ' }, now)).toBe(false);
  });

  it('hides old sessions the user moved to Parked', () => {
    expect(isOnBoard({ ...idle, createdAt: 0 }, { placement: 'parked' }, now)).toBe(false);
  });

  it('falls back to last active with no start time, and shows sessions with neither', () => {
    expect(isOnBoard({ ...idle, lastActiveAt: 0 }, nothingKept, now)).toBe(false);
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

  it('carries local notes, defaulting to an empty string', () => {
    expect(toCard(record, { repo: 'r', placement: undefined }).notes).toBe('');
    expect(toCard(record, { repo: 'r', placement: undefined, notes: 'Review this' }).notes).toBe('Review this');
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

  it.each(['parked', 'done'] as const)('keeps %s newest session first, ignoring a saved order', (column) => {
    const cards = [card('claude:a', column, 1), card('claude:b', column, 3), card('claude:c', column, 2)];
    expect(ids(orderCards(cards, { [column]: ['claude:a', 'claude:c', 'claude:b'] }))).toEqual(['claude:b', 'claude:c', 'claude:a']);
  });

  it('sorts Parked by the last prompt, then by when the session was created, never by last active', () => {
    const cards = [
      { ...card('claude:created-old', 'parked', 9), createdAt: 1 },
      { ...card('claude:created-new', 'parked', 2), createdAt: 3 },
      { ...card('claude:prompted', 'parked', 1), createdAt: 0, lastPromptAt: 5 },
    ];
    expect(ids(orderCards(cards, {}))).toEqual(['claude:prompted', 'claude:created-new', 'claude:created-old']);
  });

  it('keeps cards not ordered yet in Doing by when the session was created, whatever their last prompt', () => {
    const cards = [
      { ...card('claude:old', 'doing', 1), createdAt: 1, lastPromptAt: 9 },
      { ...card('claude:new', 'doing', 1), createdAt: 2 },
    ];
    expect(ids(orderCards(cards, {}))).toEqual(['claude:new', 'claude:old']);
  });

  it('ignores an order saved for a column the card has left', () => {
    const cards = [card('claude:a', 'standby', 1), card('claude:b', 'standby', 2)];
    expect(ids(orderCards(cards, { doing: ['claude:a'], standby: ['claude:b'] }))).toEqual(['claude:a', 'claude:b']);
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
