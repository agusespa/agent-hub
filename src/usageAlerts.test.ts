import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanUsage, UsageWindow } from './types.js';
import { UsageAlertLog, usageAlerts, type UsageAlert } from './usageAlerts.js';

const HOUR = 60 * 60_000;
const NOW = new Date(2026, 9, 26, 12, 0).getTime();

const usage = (...windows: UsageWindow[]): PlanUsage[] => [{ source: 'claude', plan: 'max', windows, fetchedAt: NOW }];

describe('usageAlerts', () => {
  it('alerts on a limit at 90% used or more', () => {
    const [alert] = usageAlerts(usage({ label: '5h', usedPercent: 92, resetsAt: NOW + 2 * HOUR }), NOW);
    expect(alert.title).toBe('Claude 5h limit: 8% left');
    expect(alert.body).toMatch(/^Resets today /);
  });

  it('says nothing below 90%, or once a limit is used up', () => {
    expect(usageAlerts(usage({ label: '5h', usedPercent: 89, resetsAt: NOW + HOUR }, { label: '5h', usedPercent: 100, resetsAt: NOW + HOUR }), NOW)).toEqual([]);
  });

  it('alerts at the level set in Settings instead', () => {
    const at = (closePercent: number) => usageAlerts(usage({ label: '5h', usedPercent: 85, resetsAt: NOW + HOUR }), NOW, closePercent);
    expect(at(80).map((alert) => alert.kind)).toEqual(['close']);
    expect(at(90)).toEqual([]);
  });

  it('alerts on a weekly limit with room left that resets within a day', () => {
    const [alert] = usageAlerts(usage({ label: 'Weekly', usedPercent: 55, resetsAt: NOW + 20 * HOUR }), NOW);
    expect(alert.title).toBe('Claude weekly limit: 45% left');
    expect(alert.kind).toBe('spare');
    expect(alert.body).toMatch(/^Resets tomorrow .*Use it before then\.$/);
  });

  it('leaves out weekly limits that are mostly used, reset later, or are not weekly', () => {
    expect(
      usageAlerts(
        usage(
          { label: 'Weekly', usedPercent: 75, resetsAt: NOW + 20 * HOUR },
          { label: 'Weekly Opus', usedPercent: 10, resetsAt: NOW + 30 * HOUR },
          { label: '5h', usedPercent: 10, resetsAt: NOW + HOUR },
        ),
        NOW,
      ),
    ).toEqual([]);
  });

  it('holds the weekly alert while the 5h limit is nearly or fully used', () => {
    const weekly = { label: 'Weekly', usedPercent: 55, resetsAt: NOW + 20 * HOUR };
    const titles = (fiveHour: number) =>
      usageAlerts(usage(weekly, { label: '5h', usedPercent: fiveHour, resetsAt: NOW + 2 * HOUR }), NOW).map((alert) => alert.title);
    expect(titles(100)).toEqual([]);
    expect(titles(95)).toEqual(['Claude 5h limit: 5% left']);
    expect(titles(60)).toEqual(['Claude weekly limit: 45% left']);
  });

  it('gates a weekly bucket by the 5h limit of the same bucket', () => {
    const alerts = usageAlerts(
      usage(
        { label: 'Weekly Spark', usedPercent: 20, resetsAt: NOW + 20 * HOUR },
        { label: '5h Spark', usedPercent: 100, resetsAt: NOW + HOUR },
        { label: '5h', usedPercent: 10, resetsAt: NOW + HOUR },
      ),
      NOW,
    );
    expect(alerts).toEqual([]);
  });

  it('keeps the same key when the reset time moves by seconds', () => {
    const at = (resetsAt: number) => usageAlerts(usage({ label: '5h', usedPercent: 95, resetsAt }), NOW)[0].key;
    expect(at(NOW + 2 * HOUR + 3_000)).toBe(at(NOW + 2 * HOUR));
    expect(at(NOW + 7 * HOUR)).not.toBe(at(NOW + 2 * HOUR));
  });
});

describe('UsageAlertLog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'usage-alerts-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const alert = (key: string): UsageAlert => ({ key, kind: 'close', title: key, body: '' });

  it('returns each alert once, also to a new instance on the same file', async () => {
    const file = path.join(dir, 'usage-alerts.json');
    expect(await new UsageAlertLog(file).take([alert('a'), alert('b')], NOW)).toEqual([alert('a'), alert('b')]);
    expect(await new UsageAlertLog(file).take([alert('a'), alert('c')], NOW)).toEqual([alert('c')]);
  });

  it('forgets keys after eight days', async () => {
    const log = new UsageAlertLog(path.join(dir, 'usage-alerts.json'));
    await log.take([alert('a')], NOW);
    expect(await log.take([alert('a')], NOW + 9 * 24 * HOUR)).toEqual([alert('a')]);
  });
});
