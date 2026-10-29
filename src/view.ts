import { readJsonFile, updateJsonFile } from './jsonFile.js';

/** The board as kanban columns, or as one lane per project. */
export type Layout = 'kanban' | 'project';
/** Follow macOS, or keep the board light or dark. */
export type Theme = 'system' | 'light' | 'dark';
/** How many days a session stays on the board without a prompt (see `isOnBoard`). */
export type KeepDays = 14 | 45 | 90;

export interface ViewSettings {
  hiddenRepos: string[];
  hiddenSources: string[];
  hiddenTickets: string[];
  oldestFirst: string[];
  layout: Layout;
  theme: Theme;
  /** Desktop alerts when a limit runs low or weekly room is about to reset. */
  usageAlerts: boolean;
  /** Desktop alerts when two sessions edit the same files. */
  conflictAlerts: boolean;
  keepDays: KeepDays;
}

const LIST_KEYS = ['hiddenRepos', 'hiddenSources', 'hiddenTickets', 'oldestFirst'] as const;
type ListKey = (typeof LIST_KEYS)[number];
export type ViewPatch = Partial<ViewSettings>;

const isEntry = (key: ListKey, value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 500 &&
  (key !== 'oldestFirst' || value === 'parked' || value === 'done');

/** The settings with one value each, their allowed values, and the first as the default. */
const CHOICES = {
  layout: ['kanban', 'project'],
  theme: ['system', 'light', 'dark'],
  usageAlerts: [true, false],
  conflictAlerts: [true, false],
  keepDays: [45, 14, 90],
} as const;
type ChoiceKey = keyof typeof CHOICES;

const isChoice = (key: ChoiceKey, value: unknown): boolean => (CHOICES[key] as readonly unknown[]).includes(value);

const isList = (key: ListKey, values: unknown): boolean =>
  Array.isArray(values) && values.length <= 2000 && values.every((entry) => isEntry(key, entry));

export const isViewPatch = (value: unknown): value is ViewPatch => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, values]) =>
    key in CHOICES ? isChoice(key as ChoiceKey, values) : LIST_KEYS.includes(key as ListKey) && isList(key as ListKey, values),
  );
};

/** Shared, file-backed filters, sorting, layout and settings; patches preserve changes to other fields. */
export class ViewStore {
  constructor(private readonly file: string) {}

  async read(): Promise<ViewSettings> {
    const parsed = (await readJsonFile(this.file)) as Partial<ViewSettings> | undefined;
    const lists = Object.fromEntries(LIST_KEYS.map((key) => {
      const values = parsed?.[key];
      return [key, Array.isArray(values) ? [...new Set(values.filter((value) => isEntry(key, value)))].slice(0, 2000) : []];
    })) as Pick<ViewSettings, ListKey>;
    const choices = Object.fromEntries(Object.entries(CHOICES).map(([key, values]) =>
      [key, isChoice(key as ChoiceKey, parsed?.[key as ChoiceKey]) ? parsed![key as ChoiceKey] : values[0]]));
    return { ...lists, ...choices } as ViewSettings;
  }

  update(patch: ViewPatch): Promise<void> {
    return updateJsonFile(this.file, async () => ({ ...await this.read(), ...patch }));
  }
}
