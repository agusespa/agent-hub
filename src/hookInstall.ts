import { chmod, copyFile, mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './app.js';
import { readJsonFile, writeJsonFile } from './jsonFile.js';
import type { Source } from './types.js';

/** What hooks/agent-hub-hook.mjs takes; `ended` clears a session's status. */
type HookStatusName = 'working' | 'waiting' | 'idle' | 'ended';

/**
 * The hook events the board adds and the status each one reports. Claude's status comes from
 * `claude agents` too, so its hooks only make a change show at once; Codex has no other status.
 * PostToolUse marks a session working again once a permission prompt is answered.
 */
const EVENTS: Record<Source, Array<{ event: string; matcher?: string; status: HookStatusName }>> = {
  claude: [
    { event: 'UserPromptSubmit', status: 'working' },
    { event: 'PostToolUse', status: 'working' },
    { event: 'Notification', matcher: 'permission_prompt|elicitation_dialog', status: 'waiting' },
    { event: 'Stop', status: 'idle' },
    { event: 'StopFailure', status: 'idle' },
    { event: 'SessionEnd', status: 'ended' },
  ],
  codex: [
    { event: 'SessionStart', status: 'idle' },
    { event: 'UserPromptSubmit', status: 'working' },
    { event: 'PostToolUse', status: 'working' },
    { event: 'PermissionRequest', status: 'waiting' },
    { event: 'Stop', status: 'idle' },
    { event: 'Interrupt', status: 'idle' },
    { event: 'SessionEnd', status: 'ended' },
  ],
};

const SOURCES = Object.keys(EVENTS) as Source[];

/**
 * The user-level hook configs the board adds its hooks to (https://code.claude.com/docs/en/hooks,
 * https://learn.chatgpt.com/docs/hooks). Only the board's own entries are ever changed.
 */
export const hookConfigFiles = (home = homedir()): Record<Source, string> => ({
  claude: path.join(home, '.claude', 'settings.json'),
  codex: path.join(home, '.codex', 'hooks.json'),
});

const WRAPPER = 'agent-hub-hook';
const SCRIPT = 'agent-hub-hook.mjs';

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** Every hook command starts with the quoted wrapper path, which is how the board finds its own. */
const isBoardHandler = (handler: unknown): boolean =>
  typeof (handler as { command?: unknown } | null)?.command === 'string' && (handler as { command: string }).command.includes(`/${WRAPPER}'`);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export const hasBoardHooks = (config: Json): boolean =>
  isObject(config.hooks) &&
  Object.values(config.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isBoardHandler)),
  );

/** `config` without the board's hooks, dropping the matcher groups and events that only held them. */
export const withoutBoardHooks = (config: Json): Json => {
  if (!isObject(config.hooks)) return config;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isBoardHandler)) return [group];
      const handlers = group.hooks.filter((handler) => !isBoardHandler(handler));
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0) return { ...config, hooks };
  const { hooks: _, ...rest } = config;
  return rest;
};

/**
 * `config` with the board's hooks for `source` after any of the user's own. They run in the
 * background, so they never hold up the session.
 */
export const withBoardHooks = (config: Json, source: Source, wrapper: string): Json => {
  const base = withoutBoardHooks(config);
  const hooks: Json = isObject(base.hooks) ? { ...base.hooks } : {};
  for (const { event, matcher, status } of EVENTS[source]) {
    const handler = { type: 'command', command: `${shellQuote(wrapper)} ${source} ${status}`, async: true, timeout: 3 };
    const groups = hooks[event];
    hooks[event] = [...(Array.isArray(groups) ? groups : []), { ...(matcher ? { matcher } : {}), hooks: [handler] }];
  }
  return { ...base, hooks };
};

/** `on` or `off`, or `unavailable` when the tool's config folder does not exist, as when it is not installed. */
export type HookState = 'on' | 'off' | 'unavailable';

const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * Turns the board's hooks on and off. The hooks run `<dataDir>/agent-hub-hook`, a wrapper that
 * starts the hook script with this app's own Node, so the hook commands stay the same when the
 * app moves or updates and Codex does not ask to trust them again.
 */
export class HookInstaller {
  private readonly files: Record<Source, string>;

  constructor(
    private readonly dataDir: string,
    home = homedir(),
    private readonly runtime = process.execPath,
  ) {
    this.files = hookConfigFiles(home);
  }

  async state(): Promise<Record<Source, HookState>> {
    const states = await Promise.all(
      SOURCES.map(async (source): Promise<HookState> => {
        const file = this.files[source];
        if (!(await exists(path.dirname(file)))) return 'unavailable';
        // An unreadable config shows as off; turning the hooks on then says what is wrong with it.
        return hasBoardHooks(await this.readConfig(file).catch(() => ({}))) ? 'on' : 'off';
      }),
    );
    return Object.fromEntries(SOURCES.map((source, index) => [source, states[index]])) as Record<Source, HookState>;
  }

  /** Adds or removes the board's hooks in each available tool's config; a config that is not valid JSON is left alone. */
  async set(on: boolean): Promise<Record<Source, HookState>> {
    if (on) await this.writeScript();
    for (const source of SOURCES) {
      if (!(await exists(path.dirname(this.files[source])))) continue;
      // A symlinked config, as from a dotfiles repo, is written where it points.
      const file = await realpath(this.files[source]).catch(() => this.files[source]);
      const config = await this.readConfig(file);
      const next = on ? withBoardHooks(config, source, path.join(this.dataDir, WRAPPER)) : withoutBoardHooks(config);
      if (JSON.stringify(next) !== JSON.stringify(config)) await writeJsonFile(file, next);
    }
    return this.state();
  }

  /**
   * Brings the hooks of each tool that has them on up to this app's set, so an update that adds or
   * drops a hook takes effect without turning Live status off and on. Unchanged configs are not written.
   */
  async refresh(): Promise<void> {
    await this.writeScript();
    const states = await this.state();
    for (const source of SOURCES) {
      if (states[source] !== 'on') continue;
      const file = await realpath(this.files[source]).catch(() => this.files[source]);
      const config = await this.readConfig(file);
      const next = withBoardHooks(config, source, path.join(this.dataDir, WRAPPER));
      if (JSON.stringify(next) !== JSON.stringify(config)) await writeJsonFile(file, next);
    }
  }

  /** Writes the wrapper and the hook script from this copy of the app, so they follow its updates. */
  async writeScript(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await copyFile(path.join(PROJECT_ROOT, 'hooks', SCRIPT), path.join(this.dataDir, SCRIPT));
    const wrapper = path.join(this.dataDir, WRAPPER);
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        '# Written by Agent Hub: runs its hook script with the Node of the app that last started.',
        `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(this.runtime)} "$(dirname "$0")/${SCRIPT}" "$@"`,
        '',
      ].join('\n'),
    );
    await chmod(wrapper, 0o755);
  }

  private async readConfig(file: string): Promise<Json> {
    let config: unknown;
    try {
      config = (await readJsonFile(file)) ?? {};
    } catch (error) {
      throw new Error(`${file} could not be read: ${(error as Error).message}`);
    }
    if (!isObject(config)) throw new Error(`${file} does not hold a JSON object`);
    return config;
  }
}
