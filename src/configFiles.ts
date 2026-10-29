import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Source } from './types.js';

/**
 * A file Claude or Codex takes its config from, where their docs put it. The board never
 * reads these; it only says whether each exists and opens their folder in VS Code.
 */
export interface ConfigFile {
  source: Source;
  /** What the file holds. */
  label: string;
  path: string;
  /** The path as the page shows it: under `~` globally, or from the project's root. */
  shown: string;
  exists: boolean;
}

type FileSpec = [Source, string, string];

// Claude keeps MCP servers for all projects, and a project's just-you ones, outside these
// files; the page points to `claude mcp` for those.
const GLOBAL_FILES: FileSpec[] = [
  ['claude', 'Settings: model, permissions, env and hooks', '.claude/settings.json'],
  ['claude', 'Instructions for every project', '.claude/CLAUDE.md'],
  ['codex', 'Settings and MCP servers', '.codex/config.toml'],
  ['codex', 'Instructions for every project', '.codex/AGENTS.md'],
];

const PROJECT_FILES: FileSpec[] = [
  ['claude', 'Settings, shared through git', '.claude/settings.json'],
  ['claude', 'Settings, just you', '.claude/settings.local.json'],
  ['claude', 'MCP servers, shared through git', '.mcp.json'],
  ['claude', 'Instructions', 'CLAUDE.md'],
  ['codex', 'Settings and MCP servers, in trusted projects', '.codex/config.toml'],
  ['codex', 'Instructions', 'AGENTS.md'],
];

/** The folder that holds each tool's config files: the project's root, or each tool's own under `home`. */
export const configFolders = (root: string | null, home = homedir()): Record<Source, string> =>
  root ? { claude: root, codex: root } : { claude: path.join(home, '.claude'), codex: path.join(home, '.codex') };

/** The config files for a project's root folder, or with none, the global ones under `home`. */
export const configFiles = (root: string | null, home = homedir()): Promise<ConfigFile[]> =>
  Promise.all(
    (root ? PROJECT_FILES : GLOBAL_FILES).map(async ([source, label, file]) => {
      const full = path.join(root ?? home, file);
      return { source, label, path: full, shown: root ? file : `~/${file}`, exists: Boolean((await stat(full).catch(() => undefined))?.isFile()) };
    }),
  );
