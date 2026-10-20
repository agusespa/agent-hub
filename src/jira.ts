import { readJsonFile, updateJsonFile } from './jsonFile.js';

/** A Jira issue key such as PROJ-1234, in upper case as the page saves it. */
export const isJiraKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,9}-\d{1,7}$/.test(value);

/**
 * The Jira key the user set on each card, persisted as JSON so it outlives the app
 * and the session's process. Like placements, the file is re-read on every access so
 * the browser and desktop versions can run side by side. Keys stay saved after a
 * session drops off the board, and show again if it comes back.
 */
export class JiraKeyStore {
  constructor(private readonly file: string) {}

  async read(): Promise<Map<string, string>> {
    const parsed = (await readJsonFile(this.file)) as { cards?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.cards ?? {}).filter((entry): entry is [string, string] => isJiraKey(entry[1])));
  }

  /** Sets a card's key; null removes it. */
  set(cardId: string, key: string | null): Promise<void> {
    return updateJsonFile(this.file, async () => {
      const cards = await this.read();
      if (key) cards.set(cardId, key);
      else cards.delete(cardId);
      return { cards: Object.fromEntries(cards) };
    });
  }
}
