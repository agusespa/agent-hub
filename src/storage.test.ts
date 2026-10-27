import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { PROJECT_ROOT } from './app.js';

const appSources = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return appSources(file);
    return /\.(?:js|ts|html)$/.test(file) && !file.endsWith('.test.ts') ? [file] : [];
  }))).flat();
};

it('keeps app persistence out of browser storage APIs', async () => {
  const files = (await Promise.all(['src', 'public'].map((dir) => appSources(path.join(PROJECT_ROOT, dir))))).flat();
  const browserStorage = /\b(?:localStorage|sessionStorage|indexedDB|cookieStore|CacheStorage)\b|\bdocument\s*\.\s*cookie\b|\bnavigator\s*\.\s*storage\b|\bcaches\s*\./;
  for (const file of files) expect(await readFile(file, 'utf8'), path.relative(PROJECT_ROOT, file)).not.toMatch(browserStorage);
});
