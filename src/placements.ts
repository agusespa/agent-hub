import { readJsonFile, updateJsonFile } from './jsonFile.js';
import { isColumnId, type ColumnId } from './types.js';

export interface Placements {
  /** The column the user moved each card to. */
  columns: Map<string, ColumnId>;
  /** Card ids per column, in the order the user dragged them into. */
  order: Partial<Record<ColumnId, string[]>>;
}

/**
 * Where the user moved each card, persisted as JSON. The file is re-read on every
 * access so the browser and desktop versions can run side by side without
 * overwriting each other's moves. Ids from older column sets are dropped.
 */
export class PlacementStore {
  constructor(private readonly file: string) {}

  async read(): Promise<Placements> {
    const parsed = (await readJsonFile(this.file)) as { placements?: Record<string, unknown>; order?: Record<string, unknown> } | undefined;
    if (!parsed) return { columns: new Map(), order: {} };
    const order: Placements['order'] = {};
    for (const [column, ids] of Object.entries(parsed.order ?? {})) {
      if (isColumnId(column) && Array.isArray(ids)) order[column] = ids.filter((id): id is string => typeof id === 'string');
    }
    return {
      columns: new Map(
        Object.entries(parsed.placements ?? {}).filter((entry): entry is [string, ColumnId] => isColumnId(entry[1])),
      ),
      order,
    };
  }

  /** Moves a card to a column and, when given, saves the full card order of that column. */
  set(cardId: string, column: ColumnId, columnOrder?: string[]): Promise<void> {
    return updateJsonFile(this.file, async () => {
      const { columns, order } = await this.read();
      columns.set(cardId, column);
      if (columnOrder) {
        const reordered = new Set(columnOrder);
        for (const [other, ids] of Object.entries(order) as [ColumnId, string[]][]) {
          order[other] = ids.filter((id) => !reordered.has(id));
        }
        order[column] = columnOrder;
      }
      return { placements: Object.fromEntries(columns), order };
    });
  }
}
