import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_HOLD_MS, HookStatusMerge, HookStatusStore, lastEventBySource, type HookStatus } from './hookStatus.js';
import type { LiveStatus, SessionRecord } from './types.js';

const record = (id: string, liveStatus: LiveStatus | null = null, waitingFor?: string): SessionRecord => ({
  id,
  source: id.startsWith('codex') ? 'codex' : 'claude',
  title: id,
  liveStatus,
  waitingFor,
});

const statuses = (...list: HookStatus[]) => new Map(list.map((status) => [status.id, status]));

describe('HookStatusMerge', () => {
  const now = 1_000_000_000;

  it('gives Codex records the hook status while it holds', () => {
    const merge = new HookStatusMerge();
    const [working, ended] = merge.apply(
      [record('codex:a'), record('codex:b')],
      statuses({ id: 'codex:a', status: 'working', at: now - 60_000 }, { id: 'codex:b', status: null, at: now }),
      now,
    );
    expect(working.liveStatus).toBe('working');
    expect(ended.liveStatus).toBeNull();
    // A working status with no event for 30 minutes is taken for a session that quit.
    const [stale] = merge.apply([record('codex:a')], statuses({ id: 'codex:a', status: 'working', at: now - 31 * 60_000 }), now);
    expect(stale.liveStatus).toBeNull();
  });

  it('shows a Claude hook status until claude agents reports a change', () => {
    const merge = new HookStatusMerge();
    const hook = statuses({ id: 'claude:a', status: 'waiting', at: now });
    expect(merge.apply([record('claude:a', 'working')], hook, now)[0].liveStatus).toBe('waiting');
    expect(merge.apply([record('claude:a', 'working')], hook, now + 5_000)[0].liveStatus).toBe('waiting');
    // claude agents catches up, then moves on after the user answers.
    expect(merge.apply([record('claude:a', 'waiting', 'permission')], hook, now + 10_000)[0]).toMatchObject({ liveStatus: 'waiting', waitingFor: 'permission' });
    expect(merge.apply([record('claude:a', 'working')], hook, now + 15_000)[0].liveStatus).toBe('working');
  });

  it('lets claude agents win once the hook status is old', () => {
    const merge = new HookStatusMerge();
    const hook = statuses({ id: 'claude:a', status: 'idle', at: now });
    expect(merge.apply([record('claude:a', 'working', 'x')], hook, now)[0]).toMatchObject({ liveStatus: 'idle', waitingFor: undefined });
    expect(merge.apply([record('claude:a', 'working')], hook, now + CLAUDE_HOLD_MS + 1)[0].liveStatus).toBe('working');
  });

  it('leaves records without a hook status alone', () => {
    const records = [record('claude:a', 'working'), record('codex:b')];
    expect(new HookStatusMerge().apply(records, new Map(), now)).toEqual(records);
  });

  it('follows the current execution while keeping the conversation ID stable across resumes', () => {
    const merge = new HookStatusMerge();
    const card = { ...record('claude:local_conversation'), activityId: 'claude:first' };
    const hooks = statuses({ id: 'claude:first', status: 'working', at: now }, { id: 'claude:second', status: 'waiting', at: now });
    expect(merge.apply([card], hooks, now)[0]).toMatchObject({ id: card.id, liveStatus: 'working' });
    expect(merge.apply([{ ...card, activityId: 'claude:second' }], hooks, now)[0]).toMatchObject({ id: card.id, liveStatus: 'waiting' });
    expect(merge.apply([{ ...card, activityId: 'claude:third' }], hooks, now)[0].liveStatus).toBeNull();
  });
});

describe('HookStatusStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'hook-status-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('reads nothing before any hook has run', async () => {
    expect(await new HookStatusStore(path.join(dir, 'missing')).read()).toEqual(new Map());
  });

  it('reads status files, skips others and removes old ones', async () => {
    const now = Date.now();
    await writeFile(path.join(dir, 'codex-a.json'), JSON.stringify({ id: 'codex:a', status: 'working', at: now }));
    await writeFile(path.join(dir, 'codex-old.json'), JSON.stringify({ id: 'codex:old', status: 'idle', at: now - 13 * 3_600_000 }));
    await writeFile(path.join(dir, 'claude-b.json'), '{"id": "claude:b"');
    await writeFile(path.join(dir, 'claude-c.json.123.tmp'), JSON.stringify({ id: 'claude:c', status: 'idle', at: now }));
    expect(await new HookStatusStore(dir).read(now)).toEqual(statuses({ id: 'codex:a', status: 'working', at: now }));
    expect((await readdir(dir)).sort()).toEqual(['claude-b.json', 'claude-c.json.123.tmp', 'codex-a.json']);
  });

  it('calls back once a burst of writes has landed', async () => {
    let calls = 0;
    const stop = await new HookStatusStore(dir).watch(() => calls++);
    for (const name of ['a', 'b', 'c']) await writeFile(path.join(dir, `codex-${name}.json`), '{}');
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    expect(calls).toBe(1);
  });
});

describe('lastEventBySource', () => {
  it("takes each source's latest event and leaves out sources with none", () => {
    const last = lastEventBySource(
      statuses({ id: 'claude:a', status: 'idle', at: 5 }, { id: 'claude:b', status: null, at: 9 }, { id: 'claude:c', status: 'working', at: 7 }),
    );
    expect(last).toEqual({ claude: 9 });
  });
});
