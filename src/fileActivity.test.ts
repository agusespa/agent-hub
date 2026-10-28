import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileActivityStore } from './fileActivity.js';
import { HookInstaller } from './hookInstall.js';

const execFileAsync = promisify(execFile);
let home: string;
let dir: string;
let store: FileActivityStore;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'file-activity-'));
  dir = path.join(home, 'Agent Hub');
  await new HookInstaller(dir, home).writeScript();
  store = new FileActivityStore(path.join(dir, 'file-activity'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const hook = async (source: string, payload: object, status = 'working') => {
  const child = execFileAsync(path.join(dir, 'agent-hub-hook'), [source, status]);
  child.child.stdin?.end(JSON.stringify({ session_id: 'a', cwd: '/repo', ...payload }));
  expect(await child).toEqual({ stdout: '', stderr: '' });
};

describe('file activity from real hooks', () => {
  it('tracks Claude direct edits but never reads, shell commands or content', async () => {
    await hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', new_string: 'secret content' } });
    await hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/b.ipynb' } });
    await hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/repo/read.ts' } });
    await hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'touch /repo/shell.ts' } });
    expect((await store.read()).get('claude:a')?.sort()).toEqual(['/repo/b.ipynb', '/repo/src/a.ts']);
    const contents = await Promise.all((await readdir(path.join(dir, 'file-activity'))).map((name) => readFile(path.join(dir, 'file-activity', name), 'utf8')));
    expect(contents.join('')).not.toMatch(/secret|new_string|command/);
  });

  it('tracks all paths in successful Codex patches, including moves and deletes', async () => {
    const command = '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-secret\n+content\n*** Delete File: old.ts\n*** Add File: new.ts\n+hello\n*** End Patch';
    await hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command }, tool_response: { output: 'Success. Updated the following files:\nM src/b.ts\nD old.ts\nA new.ts' } });
    expect((await store.read()).get('codex:a')?.sort()).toEqual(['/repo/new.ts', '/repo/old.ts', '/repo/src/a.ts', '/repo/src/b.ts']);
    await hook('codex', { hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Update File: failed.ts' }, tool_response: 'Failed to apply patch' });
    expect((await store.read()).get('codex:a')).not.toContain('/repo/failed.ts');
  });

  it('keeps parallel edits, then clears them on stop and on a new prompt', async () => {
    await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((file) => hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file } })));
    expect((await store.read()).get('claude:a')).toHaveLength(3);
    await hook('claude', { hook_event_name: 'Stop' }, 'idle');
    expect(await store.read()).toEqual(new Map());
    await hook('claude', { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'next.ts' } });
    expect((await store.read()).get('claude:a')).toEqual(['/repo/next.ts']);
    await hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'secret prompt' });
    expect(await store.read()).toEqual(new Map());
  });
});

describe('FileActivityStore', () => {
  it('ignores incomplete events, expires old paths and respects a reset even if an old edit arrives late', async () => {
    expect(await store.read()).toEqual(new Map());
    const activity = path.join(dir, 'file-activity');
    await mkdir(activity);
    const now = Date.now();
    const save = (name: string, value: unknown) => writeFile(path.join(activity, name), JSON.stringify(value));
    await save('reset.json', { id: 'claude:a', at: now - 10, files: [], reset: true });
    await save('late.json', { id: 'claude:a', at: now - 20, files: ['/repo/old.ts'] });
    await save('current.json', { id: 'claude:a', at: now, files: ['/repo/new.ts'] });
    await save('expired.json', { id: 'codex:b', at: now - 13 * 3_600_000, files: ['/repo/expired.ts'] });
    await save('invalid.json', { id: 'codex:b', at: now, files: ['relative.ts'] });
    await writeFile(path.join(activity, 'partial.json.1.tmp'), '{');
    expect(await store.read(now)).toEqual(new Map([['claude:a', ['/repo/new.ts']]]));
    expect(await readdir(activity)).not.toContain('late.json');
    expect(await readdir(activity)).not.toContain('expired.json');
  });
});
