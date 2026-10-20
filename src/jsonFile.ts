import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A JSON file's parsed contents, or undefined when it does not exist yet. */
export const readJsonFile = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** Writes through a temp file and a rename, so a reader never sees half a file. */
export const writeJsonFile = async (file: string, value: unknown): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, file);
};

const updates = new Map<string, Promise<void>>();

/**
 * Writes the value `next` builds, after any earlier update of the same file has finished, so
 * `next` can re-read the file without losing a change made just before.
 */
export const updateJsonFile = (file: string, next: () => Promise<unknown>): Promise<void> => {
  const update = (updates.get(file) ?? Promise.resolve()).then(async () => writeJsonFile(file, await next()));
  updates.set(file, update.catch(() => {}));
  return update;
};
