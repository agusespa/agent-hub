import { CardStore } from './cardStore.js';

export const MAX_NOTES_LENGTH = 20_000;
export const isNotesText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_NOTES_LENGTH;

/** User-written notes belong to the board, not to the coding app's transcript. */
export class NotesStore extends CardStore<string> {
  protected isValue = isNotesText;

  set(cardId: string, text: string): Promise<void> {
    return this.setValue(cardId, text || undefined);
  }
}
