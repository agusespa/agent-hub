import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the page's files are; inside the app bundle for the desktop app. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP_VERSION: string = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version;

/** Saved card placements and Jira keys, shared by the browser and desktop versions. */
export const DATA_DIR = path.join(homedir(), 'Library', 'Application Support', 'Agent Hub');
