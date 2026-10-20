import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanUsage } from './types.js';
import { UsageMeter } from './usage.js';

const usage = (source: PlanUsage['source'], usedPercent?: number): PlanUsage => ({
  source,
  plan: 'pro',
  windows: usedPercent === undefined ? [] : [{ label: '5h', usedPercent }],
  fetchedAt: 1,
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const later = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UsageMeter', () => {
  it('answers from the last read and refreshes each source on its own interval', async () => {
    const claude = vi.fn(async () => usage('claude', 10));
    const codex = vi.fn(async () => usage('codex', 20));
    const meter = new UsageMeter({ claude: { read: claude, ttlMs: 600_000 }, codex: { read: codex, ttlMs: 60_000 } });
    expect(meter.get()).toEqual([]);
    await flush();
    expect(meter.get().map((u) => u.windows[0].usedPercent)).toEqual([10, 20]);

    later(120_000);
    meter.get();
    await flush();
    expect(claude).toHaveBeenCalledTimes(1);
    expect(codex).toHaveBeenCalledTimes(2);
  });

  it('keeps the last good numbers when a read fails or comes back empty', async () => {
    const answers: Array<() => Promise<PlanUsage>> = [
      async () => usage('claude', 10),
      async () => usage('claude'),
      async () => {
        throw new Error('offline\nstack');
      },
    ];
    const meter = new UsageMeter({
      claude: { read: () => answers.shift()!(), ttlMs: 0 },
      codex: {
        read: async () => {
          throw new Error('codex app-server exited (1)');
        },
        ttlMs: 0,
      },
    });
    for (let i = 0; i < 3; i++) {
      later(i + 1);
      meter.get();
      await flush();
    }
    const [claude, codex] = meter.get();
    expect(claude.windows[0].usedPercent).toBe(10);
    expect(codex).toMatchObject({ source: 'codex', windows: [], error: 'codex app-server exited (1)' });
  });

  it('waits longer after an empty answer', async () => {
    const read = vi.fn(async () => usage('claude'));
    const meter = new UsageMeter({
      claude: { read, ttlMs: 60_000, retryMs: 600_000 },
      codex: { read: async () => usage('codex', 1), ttlMs: 60_000 },
    });
    meter.get();
    await flush();
    later(120_000);
    meter.get();
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    later(700_000);
    meter.get();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('neither reads nor returns skipped sources', async () => {
    const codex = vi.fn(async () => usage('codex', 20));
    const meter = new UsageMeter({ claude: { read: async () => usage('claude', 10), ttlMs: 60_000 }, codex: { read: codex, ttlMs: 60_000 } });
    meter.get(new Set(['codex']));
    await flush();
    expect(meter.get(new Set(['codex'])).map((u) => u.source)).toEqual(['claude']);
    expect(codex).not.toHaveBeenCalled();
  });
});
