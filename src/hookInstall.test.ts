import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasBoardHooks, HookInstaller, withBoardHooks, withoutBoardHooks } from './hookInstall.js';

const execFileAsync = promisify(execFile);

const WRAPPER = '/data/Agent Hub/agent-hub-hook';

const userHooks = {
  model: 'opus',
  hooks: {
    PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npm run lint' }] }],
  },
};

describe('withBoardHooks and withoutBoardHooks', () => {
  it("adds the board's hooks after the user's own, quoting the wrapper path", () => {
    const config = withBoardHooks(userHooks, 'claude', WRAPPER) as typeof userHooks & { hooks: Record<string, unknown[]> };
    expect(config.model).toBe('opus');
    expect(config.hooks.PostToolUse).toEqual([
      userHooks.hooks.PostToolUse[0],
      { hooks: [{ type: 'command', command: `'${WRAPPER}' claude working`, async: true, timeout: 3 }] },
    ]);
    expect(config.hooks.Notification).toEqual([
      { matcher: 'permission_prompt|elicitation_dialog', hooks: [expect.objectContaining({ command: `'${WRAPPER}' claude waiting` })] },
    ]);
    expect(hasBoardHooks(config)).toBe(true);
    expect(hasBoardHooks(userHooks)).toBe(false);
  });

  it('adds them once however often it runs', () => {
    const once = withBoardHooks(userHooks, 'codex', WRAPPER);
    expect(withBoardHooks(once, 'codex', WRAPPER)).toEqual(once);
  });

  it('removes only what it added', () => {
    expect(withoutBoardHooks(withBoardHooks(userHooks, 'codex', WRAPPER))).toEqual(userHooks);
    expect(withoutBoardHooks(withBoardHooks({}, 'claude', WRAPPER))).toEqual({});
    // A handler the user added to one of the board's groups stays.
    const config = withBoardHooks({}, 'claude', WRAPPER) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };
    config.hooks.Stop[0].hooks.push({ type: 'command', command: 'say done' });
    expect(withoutBoardHooks(config)).toEqual({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
  });
});

describe('HookInstaller', () => {
  let home: string;
  let dataDir: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'hook-install-'));
    dataDir = path.join(home, 'Agent Hub');
    await mkdir(path.join(home, '.claude'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('turns on only for tools whose config folder exists, keeping the user settings', async () => {
    await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify(userHooks));
    const installer = new HookInstaller(dataDir, home);
    expect(await installer.state()).toEqual({ claude: 'off', codex: 'unavailable' });
    expect(await installer.set(true)).toEqual({ claude: 'on', codex: 'unavailable' });
    const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.model).toBe('opus');
    expect(settings.hooks.PostToolUse[0]).toEqual(userHooks.hooks.PostToolUse[0]);
    expect(await readdir(home)).not.toContain('.codex');
    expect(await installer.set(false)).toEqual({ claude: 'off', codex: 'unavailable' });
    expect(JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'))).toEqual(userHooks);
  });

  it('writes through a symlinked config', async () => {
    await mkdir(path.join(home, 'dotfiles'));
    await writeFile(path.join(home, 'dotfiles', 'claude.json'), '{}');
    await symlink(path.join(home, 'dotfiles', 'claude.json'), path.join(home, '.claude', 'settings.json'));
    await new HookInstaller(dataDir, home).set(true);
    expect(hasBoardHooks(JSON.parse(await readFile(path.join(home, 'dotfiles', 'claude.json'), 'utf8')))).toBe(true);
  });

  it('leaves a config that is not JSON alone and says why', async () => {
    await writeFile(path.join(home, '.claude', 'settings.json'), '{ "model": ');
    const installer = new HookInstaller(dataDir, home);
    expect(await installer.state()).toEqual({ claude: 'off', codex: 'unavailable' });
    await expect(installer.set(true)).rejects.toThrow(/settings\.json could not be read/);
    expect(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ "model": ');
  });

  it('runs as a hook: keeps the session id and status and nothing else from the event', async () => {
    await new HookInstaller(dataDir, home).set(true);
    const settings = JSON.parse(await readFile(path.join(home, '.claude', 'settings.json'), 'utf8'));
    const command: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    const event = { session_id: 'abc-123', prompt: 'the secret prompt', transcript_path: '/x.jsonl', cwd: '/repo' };
    const child = execFileAsync('/bin/sh', ['-c', command]);
    child.child.stdin?.end(JSON.stringify(event));
    expect(await child).toEqual({ stdout: '', stderr: '' });
    const written = await readFile(path.join(dataDir, 'live-status', 'claude-abc-123.json'), 'utf8');
    expect(Object.keys(JSON.parse(written))).toEqual(['id', 'status', 'at']);
    expect(JSON.parse(written)).toMatchObject({ id: 'claude:abc-123', status: 'working' });
    expect(written).not.toContain('secret');
  });

  it('as a hook, records the time of a prompt the user sent, and of nothing else', async () => {
    await new HookInstaller(dataDir, home).set(true);
    const run = async (event: string, sessionId: string) => {
      const child = execFileAsync(path.join(dataDir, 'agent-hub-hook'), ['codex', 'working']);
      child.child.stdin?.end(JSON.stringify({ session_id: sessionId, hook_event_name: event, prompt: 'the secret prompt' }));
      await child;
    };
    await run('UserPromptSubmit', 'prompted');
    await run('PostToolUse', 'tool-only');
    expect(await readdir(path.join(dataDir, 'last-prompt'))).toEqual(['codex-prompted.json']);
    const written = await readFile(path.join(dataDir, 'last-prompt', 'codex-prompted.json'), 'utf8');
    expect(Object.keys(JSON.parse(written))).toEqual(['id', 'at']);
    expect(JSON.parse(written).id).toBe('codex:prompted');
    expect(written).not.toContain('secret');
  });

  it('as a hook, ignores a session id that is not a plain name and still exits 0', async () => {
    await new HookInstaller(dataDir, home).set(true);
    const child = execFileAsync(path.join(dataDir, 'agent-hub-hook'), ['claude', 'idle']);
    child.child.stdin?.end(JSON.stringify({ session_id: '../../escape' }));
    await child;
    const bad = execFileAsync(path.join(dataDir, 'agent-hub-hook'), ['claude', 'idle']);
    bad.child.stdin?.end('not json');
    await bad;
    await expect(readdir(path.join(dataDir, 'live-status'))).rejects.toThrow(/ENOENT/);
  });
});
