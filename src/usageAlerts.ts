import { readJsonFile, updateJsonFile } from './jsonFile.js';
import type { PlanUsage, Source, UsageWindow } from './types.js';

export interface UsageAlert {
  /** The limit, the kind of alert and the reset it is about, so each is sent once. */
  key: string;
  /** A limit nearly used up, or weekly room to spend before it resets; Settings mutes each apart. */
  kind: 'close' | 'spare';
  title: string;
  body: string;
}

const SOURCE_NAMES: Record<Source, string> = { claude: 'Claude', codex: 'Codex' };
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** The board's red level: close enough that a busy session can use up the rest. Settings can move the alert's. */
export const CLOSE_PERCENT = 90;
/** Room left on a weekly limit that is worth spending before it resets. */
export const SPARE_LEFT_PERCENT = 30;

/** `today 3:01 PM`, `tomorrow 9:01 PM`, or the weekday further out. */
const resetText = (resetsAt: number, now: number): string => {
  const at = new Date(resetsAt);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (at.toDateString() === new Date(now).toDateString()) return `today ${time}`;
  if (at.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${at.toLocaleDateString([], { weekday: 'long' })} ${time}`;
};

/**
 * The 5h limit that gates a weekly one: the one with the same suffix (Codex's `5h Spark`
 * for `Weekly Spark`), else the plain 5h limit.
 */
const fiveHourFor = (weekly: UsageWindow, windows: UsageWindow[]): UsageWindow | undefined =>
  windows.find((window) => window.label === weekly.label.replace(/^Weekly/, '5h')) ?? windows.find((window) => window.label === '5h');

/**
 * Alerts for limits that are `closePercent` used, and for weekly limits with room left that
 * reset within a day, while the 5h limit leaves room to spend it. Until it does, the
 * weekly alert waits, and goes out on a later check if the room is still there. A
 * used-up limit gets none: Claude and Codex say so themselves. Keys hold the reset
 * hour, since a reset time can move by seconds between reads.
 */
export const usageAlerts = (usage: PlanUsage[], now = Date.now(), closePercent = CLOSE_PERCENT): UsageAlert[] =>
  usage.flatMap(({ source, windows }) =>
    windows.flatMap((window): UsageAlert[] => {
      const left = Math.round(100 - window.usedPercent);
      const name = `${SOURCE_NAMES[source]} ${window.label.replace(/^Weekly/, 'weekly')} limit`;
      const reset = window.resetsAt ? Math.round(window.resetsAt / HOUR_MS) : 'none';
      if (window.usedPercent >= closePercent && window.usedPercent < 100) {
        return [{
          key: `${source}:${window.label}:close:${reset}`,
          kind: 'close',
          title: `${name}: ${left}% left`,
          body: window.resetsAt ? `Resets ${resetText(window.resetsAt, now)}.` : 'Nearly used up.',
        }];
      }
      const resetsSoon = window.resetsAt !== undefined && window.resetsAt > now && window.resetsAt - now < DAY_MS;
      const fiveHour = fiveHourFor(window, windows);
      const canSpend = !fiveHour || fiveHour.usedPercent < CLOSE_PERCENT;
      if (window.label.startsWith('Weekly') && resetsSoon && left >= SPARE_LEFT_PERCENT && canSpend) {
        return [{
          key: `${source}:${window.label}:spare:${reset}`,
          kind: 'spare',
          title: `${name}: ${left}% left`,
          body: `Resets ${resetText(window.resetsAt!, now)}. Use it before then.`,
        }];
      }
      return [];
    }),
  );

/** How long a sent key is kept: past the weekly reset it was about. */
const KEEP_MS = 8 * DAY_MS;

/**
 * The alerts already sent, by key and when, persisted as JSON so a restart of the app
 * does not send them again.
 */
export class UsageAlertLog {
  constructor(private readonly file: string) {}

  async read(): Promise<Map<string, number>> {
    const parsed = (await readJsonFile(this.file)) as { sent?: Record<string, unknown> } | undefined;
    return new Map(Object.entries(parsed?.sent ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
  }

  /** The alerts not sent yet, which it records as sent. */
  async take(alerts: UsageAlert[], now = Date.now()): Promise<UsageAlert[]> {
    if (!alerts.length) return [];
    let fresh: UsageAlert[] = [];
    await updateJsonFile(this.file, async () => {
      const sent = await this.read();
      for (const [key, at] of sent) if (now - at > KEEP_MS) sent.delete(key);
      fresh = alerts.filter((alert) => !sent.has(alert.key));
      for (const alert of fresh) sent.set(alert.key, now);
      return { sent: Object.fromEntries(sent) };
    });
    return fresh;
  }
}
