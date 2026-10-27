import { readJsonFile, updateJsonFile } from './jsonFile.js';

export const MAX_NOTES_LENGTH = 20_000;
export const isNotesText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_NOTES_LENGTH;

/** User-written notes belong to the board, not to the coding app's transcript. */
export class NotesStore {
  constructor(private readonly file: string) {}

  async read(): Promise<Map<string, string>> {
    const parsed = (await readJsonFile(this.file)) as { cards?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.cards ?? {}).filter((entry): entry is [string, string] => isNotesText(entry[1])));
  }

  set(cardId: string, text: string): Promise<void> {
    return updateJsonFile(this.file, async () => {
      const cards = await this.read();
      if (text) cards.set(cardId, text);
      else cards.delete(cardId);
      return { cards: Object.fromEntries(cards) };
    });
  }
}
