import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Immutable hook events avoid losing edits when parallel tool hooks finish together. */
export const FILE_ACTIVITY_DIR = 'file-activity';
const KEEP_MS = 12 * 3_600_000;

interface FileActivity {
  id: string;
  at: number;
  files: string[];
  reset?: boolean;
}

const isActivity = (value: unknown): value is FileActivity => {
  const event = value as Partial<FileActivity> | null;
  return typeof event?.id === 'string' && typeof event.at === 'number' && Number.isFinite(event.at)
    && Array.isArray(event.files) && event.files.every((file) => typeof file === 'string' && path.isAbsolute(file))
    && (event.reset === undefined || event.reset === true);
};

/** Paths changed in each session's current turn. No prompts, patches or file contents are stored. */
export class FileActivityStore {
  constructor(private readonly dir: string) {}

  async read(now = Date.now()): Promise<Map<string, string[]>> {
    const names = await readdir(this.dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const entries = (await Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => {
      const file = path.join(this.dir, name);
      const value: unknown = await readFile(file, 'utf8').then(JSON.parse).catch(() => undefined);
      return isActivity(value) ? [{ file, value }] : [];
    }))).flat();
    const resets = new Map<string, number>();
    for (const { value } of entries) {
      if (value.reset) resets.set(value.id, Math.max(resets.get(value.id) ?? 0, value.at));
    }
    const files = new Map<string, Set<string>>();
    await Promise.all(entries.map(async ({ file, value }) => {
      const resetAt = resets.get(value.id) ?? 0;
      if (now - value.at > KEEP_MS || value.at < resetAt || (!value.reset && value.at === resetAt)) {
        await unlink(file).catch(() => {});
      } else if (!value.reset) {
        const paths = files.get(value.id) ?? new Set<string>();
        for (const changed of value.files) paths.add(changed);
        files.set(value.id, paths);
      }
    }));
    return new Map([...files].map(([id, paths]) => [id, [...paths]]));
  }
}
