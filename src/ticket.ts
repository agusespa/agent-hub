import { CardStore } from './cardStore.js';

/** A ticket ID such as PROJ-1234, in upper case as the page saves it. */
export const isTicketId = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(value);

/**
 * The ticket the user set on each card, persisted as JSON so it outlives the app
 * and the session's process. Like placements, the file is re-read on every access so
 * the browser and desktop versions can run side by side. Keys stay saved after a
 * session drops off the board, and show again if it comes back.
 */
export class TicketStore extends CardStore<string> {
  protected isValue = isTicketId;

  /** Sets a card's key; null removes it. */
  set(cardId: string, key: string | null): Promise<void> {
    return this.setValue(cardId, key || undefined);
  }
}
