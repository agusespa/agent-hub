import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, updateJsonFile } from './jsonFile.js';

/** Where hooks/agent-hub-hook.mjs writes when each session last got a prompt, next to itself in the data folder. */
export const LAST_PROMPT_DIR = 'last-prompt';

/** A hook's file, once its time is in the board's own file, is removed when this old. */
const KEEP_MS = 12 * 3_600_000;

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * When the user last sent each session a prompt, as the board's hooks saw it. The hooks write
 * a file per session; the board copies the times into its own JSON file, which outlives those
 * and, like tickets, keeps a session's time after it drops off the board.
 */
export class LastPromptStore {
  constructor(
    private readonly hookDir: string,
    private readonly file: string,
  ) {}

  async read(now = Date.now()): Promise<Map<string, number>> {
    const fromHooks = await this.readHookFiles();
    const saved = await this.readSaved();
    if (fromHooks.some(({ id, at }) => at > (saved.get(id) ?? 0))) {
      await updateJsonFile(this.file, async () => {
        const current = await this.readSaved();
        for (const { id, at } of fromHooks) if (at > (current.get(id) ?? 0)) current.set(id, at);
        return { cards: Object.fromEntries(current) };
      });
      for (const { id, at } of fromHooks) if (at > (saved.get(id) ?? 0)) saved.set(id, at);
    }
    await Promise.all(fromHooks.filter(({ at }) => now - at > KEEP_MS).map(({ file }) => unlink(file).catch(() => {})));
    return saved;
  }

  private async readSaved(): Promise<Map<string, number>> {
    const parsed = (await readJsonFile(this.file)) as { cards?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.cards ?? {}).filter((entry): entry is [string, number] => isTime(entry[1])));
  }

  private async readHookFiles(): Promise<Array<{ id: string; at: number; file: string }>> {
    let names: string[];
    try {
      names = await readdir(this.hookDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const file = path.join(this.hookDir, name);
          // A file removed since the listing, or not JSON, is skipped; the hook only ever renames whole files in.
          const value = (await readFile(file, 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => undefined)) as { id?: unknown; at?: unknown } | undefined;
          return typeof value?.id === 'string' && isTime(value.at) ? [{ id: value.id, at: value.at, file }] : [];
        }),
    );
    return entries.flat();
  }
}
