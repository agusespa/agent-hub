import { readJsonFile, updateJsonFile } from './jsonFile.js';

export interface ViewSettings {
  hiddenRepos: string[];
  hiddenSources: string[];
  hiddenTickets: string[];
  oldestFirst: string[];
}

const KEYS = ['hiddenRepos', 'hiddenSources', 'hiddenTickets', 'oldestFirst'] as const;
type ViewKey = (typeof KEYS)[number];
export type ViewPatch = Partial<ViewSettings>;

const isEntry = (key: ViewKey, value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 500 &&
  (key !== 'oldestFirst' || value === 'parked' || value === 'done');

export const isViewPatch = (value: unknown): value is ViewPatch => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, values]) =>
    KEYS.includes(key as ViewKey) && Array.isArray(values) && values.length <= 2000 &&
    values.every((entry) => isEntry(key as ViewKey, entry)),
  );
};

/** Shared, file-backed filters and sorting; patches preserve changes to other fields. */
export class ViewStore {
  constructor(private readonly file: string) {}

  async read(): Promise<ViewSettings> {
    const parsed = (await readJsonFile(this.file)) as Partial<ViewSettings> | undefined;
    return Object.fromEntries(KEYS.map((key) => {
      const values = parsed?.[key];
      return [key, Array.isArray(values) ? [...new Set(values.filter((value) => isEntry(key, value)))].slice(0, 2000) : []];
    })) as unknown as ViewSettings;
  }

  update(patch: ViewPatch): Promise<void> {
    return updateJsonFile(this.file, async () => ({ ...await this.read(), ...patch }));
  }
}
