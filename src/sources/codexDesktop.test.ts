import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServer } from './codex.js';

it('lists only desktop conversations across pages, excluding terminal, IDE and subagent sessions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-hub-codex-desktop-'));
  const bin = path.join(directory, 'codex');
  await writeFile(bin, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') return console.log(JSON.stringify({ id, result: {} }));
  if (method !== 'thread/list' || params.archived !== false || !params.sourceKinds.includes('vscode')) {
    return console.log(JSON.stringify({ id, error: { message: 'Expected desktop thread request' } }));
  }
  const data = params.cursor ? [
    { id: 'desktop', source: 'vscode', originator: 'Codex Desktop' },
    { id: 'app-server-desktop', source: 'appServer', originator: 'Codex Desktop' },
    { id: 'unknown', source: 'vscode' },
    { id: 'subagent', source: { subAgent: {} }, originator: 'Codex Desktop' }
  ] : [
    { id: 'terminal', source: 'cli', originator: 'codex_cli_rs' },
    { id: 'ide', source: 'vscode', originator: 'codex_vscode' }
  ];
  console.log(JSON.stringify({ id, result: { data, nextCursor: params.cursor ? null : 'next' } }));
});
`, { mode: 0o755 });
  const server = new CodexAppServer(bin);
  try {
    expect((await server.listThreads()).map((card) => card.id)).toEqual(['codex:desktop', 'codex:app-server-desktop']);
  } finally {
    server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
