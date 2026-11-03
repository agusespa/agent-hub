import { readJsonFile, updateJsonFile } from './jsonFile.js';

/** Per-card annotations, re-read on access and updated through the shared JSON write queue. */
export abstract class CardStore<T> {
  constructor(private readonly file: string) {}

  protected abstract isValue(value: unknown): value is T;

  async read(): Promise<Map<string, T>> {
    const parsed = (await readJsonFile(this.file)) as { cards?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.cards ?? {}).filter((entry): entry is [string, T] => this.isValue(entry[1])));
  }

  /** Undefined removes an annotation; each store decides which user input means removal. */
  protected setValue(cardId: string, value: T | undefined): Promise<void> {
    return updateJsonFile(this.file, async () => {
      const cards = await this.read();
      if (value === undefined) cards.delete(cardId);
      else cards.set(cardId, value);
      return { cards: Object.fromEntries(cards) };
    });
  }
}
