import path from 'node:path';
import { readJsonFile, updateJsonFile } from './jsonFile.js';
import type { SessionRecord } from './types.js';

/** Only aliases explicitly owned by one conversation can move saved state. */
export const sessionAliases = (records: SessionRecord[]): Map<string, string> => {
  const owners = new Map<string, Set<string>>();
  for (const record of records) {
    for (const alias of record.aliases ?? []) {
      const ids = owners.get(alias) ?? new Set<string>();
      ids.add(record.id);
      owners.set(alias, ids);
    }
  }
  return new Map([...owners].flatMap(([alias, ids]) => ids.size === 1 ? [[alias, [...ids][0]]] : []));
};

/**
 * Move legacy CLI-keyed annotations to permanent conversation IDs once. Removing the
 * old keys means clearing a value later cannot resurrect an inherited annotation.
 * Each file is updated through the same queue used by its normal save operations.
 */
export const migrateBoardState = async (dataDir: string, records: SessionRecord[]): Promise<void> => {
  const aliases = sessionAliases(records);
  if (!aliases.size) return;
  for (const [name, property] of [['placements.json', 'placements'], ['tickets.json', 'cards'], ['notes.json', 'cards']] as const) {
    const file = path.join(dataDir, name);
    type State = { cards?: Record<string, unknown>; placements?: Record<string, unknown>; order?: Record<string, string[]> };
    const read = async () => (await readJsonFile(file) ?? {}) as State;
    const needsMigration = (state: State) => [...aliases.keys()].some((alias) =>
      Object.hasOwn(state[property] ?? {}, alias) || Object.values(state.order ?? {}).some((ids) => Array.isArray(ids) && ids.includes(alias)));
    if (!needsMigration(await read())) continue;
    await updateJsonFile(file, async () => {
      const state = await read();
      const values = { ...state[property] };
      for (const record of records) {
        // A canonical value wins; otherwise prefer the current execution, then recent predecessors.
        for (const alias of record.aliases ?? []) {
          if (aliases.get(alias) !== record.id || !Object.hasOwn(values, alias)) continue;
          if (!Object.hasOwn(values, record.id)) values[record.id] = values[alias];
          delete values[alias];
        }
      }
      const order = state.order && Object.fromEntries(Object.entries(state.order).map(([column, ids]) => {
        if (!Array.isArray(ids)) return [column, ids];
        const preferred = new Map(records.map((record) => [record.id,
          [record.id, ...(record.aliases ?? [])].find((id) => ids.includes(id) && (id === record.id || aliases.get(id) === record.id))]));
        return [column, [...new Set(ids.flatMap((id) => {
          const canonical = aliases.get(id);
          return canonical ? (preferred.get(canonical) === id ? [canonical] : []) : [id];
        }))]];
      }));
      return { ...state, [property]: values, ...(order ? { order } : {}) };
    });
  }
};
