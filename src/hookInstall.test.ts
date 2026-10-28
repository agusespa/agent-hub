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

  it('as a hook, records only the paths of file edits and resets them when a turn starts or stops', async () => {
    await new HookInstaller(dataDir, home).set(true);
    const run = async (source: string, status: string, event: object) => {
      const child = execFileAsync(path.join(dataDir, 'agent-hub-hook'), [source, status]);
      child.child.stdin?.end(JSON.stringify({ session_id: 's1', cwd: '/repo', ...event }));
      await child;
    };
    const activity = path.join(dataDir, 'file-activity');
    const recorded = async () => Promise.all((await readdir(activity)).sort().map(async (name) => readFile(path.join(activity, name), 'utf8')));
    await run('claude', 'working', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'secret', new_string: 'secret' } });
    await run('claude', 'working', { hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/n.ipynb' } });
    // Shell commands cannot be attributed to paths, so they are skipped.
    await run('claude', 'working', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo secret > x.ts' } });
    const patch = '*** Begin Patch\n*** Add File: new.ts\n+secret\n*** Update File: /repo/old.ts\n*** Move to: moved.ts\n*** Delete File: gone.ts\n*** End Patch';
    await run('codex', 'working', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: 'Success. Updated the following files:\nA new.ts' });
    await run('codex', 'working', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, tool_response: { output: 'apply_patch verification failed' } });
    const edits = (await recorded()).map((text) => JSON.parse(text));
    expect(edits.map(({ id, files }) => ({ id, files })).sort((a, b) => a.id.localeCompare(b.id) || a.files[0].localeCompare(b.files[0]))).toEqual([
      { id: 'claude:s1', files: ['/repo/n.ipynb'] },
      { id: 'claude:s1', files: ['/repo/src/a.ts'] },
      { id: 'codex:s1', files: ['/repo/new.ts', '/repo/old.ts', '/repo/moved.ts', '/repo/gone.ts'] },
    ]);
    expect((await recorded()).join('')).not.toContain('secret');
    await run('claude', 'idle', { hook_event_name: 'Stop' });
    expect((await recorded()).map((text) => JSON.parse(text)).filter((event) => event.reset)).toEqual([
      { id: 'claude:s1', at: expect.any(Number), files: [], reset: true },
    ]);
  });

  it('as a hook, still records the status when file activity cannot be written', async () => {
    await new HookInstaller(dataDir, home).set(true);
    await writeFile(path.join(dataDir, 'file-activity'), 'not a folder');
    const child = execFileAsync(path.join(dataDir, 'agent-hub-hook'), ['claude', 'working']);
    child.child.stdin?.end(JSON.stringify({ session_id: 's1', cwd: '/repo', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } }));
    await child;
    expect(JSON.parse(await readFile(path.join(dataDir, 'live-status', 'claude-s1.json'), 'utf8'))).toMatchObject({ status: 'working' });
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
