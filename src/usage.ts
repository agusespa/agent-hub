import type { PlanUsage, Source } from './types.js';

export interface UsageReader {
  read: () => Promise<PlanUsage>;
  /** How long an answer is reused before the next read. */
  ttlMs: number;
  /** How long to wait after a failed or empty read; defaults to `ttlMs`. */
  retryMs?: number;
}

interface Slot {
  usage?: PlanUsage;
  /** `ttlMs` after the last read, or `retryMs` after a failed or empty one. */
  nextReadAt: number;
  refreshing: boolean;
}

/**
 * Plan limits per source. Answers from the last read and refreshes in the background,
 * so a board poll never waits on either service. A failed read keeps the last good
 * numbers (their `fetchedAt` shows how old they are).
 */
export class UsageMeter {
  private readonly slots = new Map<Source, Slot>();

  constructor(private readonly readers: Record<Source, UsageReader>) {}

  /** `skip` lists sources to leave out and not read, such as ones that are not installed. */
  get(skip: ReadonlySet<Source> = new Set()): PlanUsage[] {
    const usage: PlanUsage[] = [];
    for (const [source, reader] of Object.entries(this.readers) as [Source, UsageReader][]) {
      if (skip.has(source)) continue;
      let slot = this.slots.get(source);
      if (!slot) this.slots.set(source, (slot = { nextReadAt: 0, refreshing: false }));
      if (!slot.refreshing && Date.now() > slot.nextReadAt) void this.refresh(source, reader, slot);
      if (slot.usage) usage.push(slot.usage);
    }
    return usage;
  }

  private async refresh(source: Source, reader: UsageReader, slot: Slot): Promise<void> {
    slot.refreshing = true;
    let next: PlanUsage;
    try {
      next = await reader.read();
    } catch (error) {
      const message = (error as Error).message.split('\n')[0];
      console.warn(`${source} usage: ${message}`);
      next = { source, plan: null, windows: [], fetchedAt: Date.now(), error: message };
    }
    if (next.windows.length || !slot.usage?.windows.length) slot.usage = next;
    slot.nextReadAt = Date.now() + (next.windows.length ? reader.ttlMs : (reader.retryMs ?? reader.ttlMs));
    slot.refreshing = false;
  }
}
