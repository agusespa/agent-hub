import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Read completed hook files, skipping unreadable, malformed or invalid events. */
export const readHookFiles = async <T>(
  dir: string,
  isValue: (value: unknown) => value is T,
): Promise<Array<{ file: string; value: T }>> => {
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const entries = await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
    const file = path.join(dir, name);
    // Hooks rename whole files in; a file removed since the listing is harmless.
    const value: unknown = await readFile(file, 'utf8').then(JSON.parse).catch(() => undefined);
    return isValue(value) ? [{ file, value }] : [];
  }));
  return entries.flat();
};
