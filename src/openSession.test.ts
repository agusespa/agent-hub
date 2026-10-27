import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { projectUrl, sessionUrl, vscodeUrl } from './openSession.js';

describe('sessionUrl', () => {
  it('links Codex threads', () => {
    expect(sessionUrl({ source: 'codex', openId: 't1' })).toBe('codex://threads/t1');
  });

  it('encodes the id', () => {
    expect(sessionUrl({ source: 'codex', openId: 'a/b?c' })).toBe('codex://threads/a%2Fb%3Fc');
  });

  it('has no Claude link', () => {
    expect(sessionUrl({ source: 'claude', openId: 'abc-123' })).toBeUndefined();
  });

  it('has no link without an id', () => {
    expect(sessionUrl({ source: 'codex' })).toBeUndefined();
  });
});

describe('VS Code projects', () => {
  it('encodes reserved characters and requests a new window', () => {
    const url = new URL(vscodeUrl('/Users/test/my project/#review?100%')!);
    expect(url.protocol).toBe('vscode:');
    expect(url.host).toBe('file');
    expect(decodeURIComponent(url.pathname)).toBe('/Users/test/my project/#review?100%');
    expect(url.searchParams.get('windowId')).toBe('_blank');
    expect(url.hash).toBe('');
    expect(vscodeUrl('relative/path')).toBeUndefined();
  });

  it('opens the checkout root from a session in a nested folder and rejects missing folders', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-open-'));
    try {
      const nested = path.join(dir, 'src');
      await mkdir(nested);
      await promisify(execFile)('git', ['init', '--initial-branch=main'], { cwd: dir });
      expect(await projectUrl({ cwd: nested })).toBe(vscodeUrl(await realpath(dir)));
      expect(await projectUrl({ cwd: path.join(dir, 'missing') })).toBeUndefined();
      expect(await projectUrl({})).toBeUndefined();
      expect(await projectUrl({ cwd: 'relative/path' })).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
