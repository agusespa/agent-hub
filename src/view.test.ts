import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isViewPatch, ViewStore } from './view.js';

describe('file-backed view preferences', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'agent-hub-view-')); });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts with all filters visible and newest first', async () => {
    expect(await new ViewStore(path.join(dir, 'view.json')).read()).toEqual({
      hiddenRepos: [], hiddenSources: [], hiddenTickets: [], oldestFirst: [], layout: 'kanban', theme: 'system', usageAlerts: true, closePercent: 90, spareAlerts: true, sharedAlerts: false, conflictAlerts: true, keepDays: 45, quietHours: false, quietFrom: 18, quietTo: 8, quietWeekends: false,
    });
  });

  it('persists partial updates from separate instances without losing other preferences', async () => {
    const file = path.join(dir, 'view.json');
    const first = new ViewStore(file);
    const second = new ViewStore(file);
    await Promise.all([
      first.update({ hiddenRepos: ['project'] }),
      second.update({ hiddenSources: ['claude'], oldestFirst: ['parked'], layout: 'project', theme: 'dark', conflictAlerts: false, keepDays: 14, quietHours: true, quietFrom: 22 }),
    ]);
    expect(await new ViewStore(file).read()).toEqual({
      hiddenRepos: ['project'], hiddenSources: ['claude'], hiddenTickets: [], oldestFirst: ['parked'], layout: 'project', theme: 'dark', usageAlerts: true, closePercent: 90, spareAlerts: true,
      sharedAlerts: false, conflictAlerts: false, keepDays: 14, quietHours: true, quietFrom: 22, quietTo: 8, quietWeekends: false,
    });
    await first.update({ hiddenRepos: [] });
    expect((await second.read()).hiddenSources).toEqual(['claude']);
  });

  it('normalizes saved values and validates API patches', async () => {
    const file = path.join(dir, 'view.json');
    await writeFile(file, JSON.stringify({ hiddenRepos: ['project', 7, 'project'], oldestFirst: ['doing', 'done'], layout: 'ticket', theme: 'sepia', usageAlerts: 'no', keepDays: 30 }));
    expect(await new ViewStore(file).read()).toEqual({
      hiddenRepos: ['project'], hiddenSources: [], hiddenTickets: [], oldestFirst: ['done'], layout: 'kanban', theme: 'system', usageAlerts: true, closePercent: 90, spareAlerts: true, sharedAlerts: false, conflictAlerts: true, keepDays: 45, quietHours: false, quietFrom: 18, quietTo: 8, quietWeekends: false,
    });
    expect(isViewPatch({ hiddenRepos: [], oldestFirst: ['parked', 'done'] })).toBe(true);
    expect(isViewPatch({ layout: 'project', theme: 'light', usageAlerts: false, keepDays: 90, closePercent: 80, quietFrom: 0, quietTo: 23 })).toBe(true);
    for (const value of [null, [], {}, { unexpected: [] }, { hiddenRepos: 'project' }, { hiddenRepos: [1] }, { oldestFirst: ['doing'] }, { layout: 'ticket' }, { layout: ['project'] }, { theme: 'sepia' }, { usageAlerts: 'off' }, { keepDays: 30 }, { keepDays: '45' }, { closePercent: 85 }, { quietFrom: 24 }, { quietTo: 7.5 }]) {
      expect(isViewPatch(value)).toBe(false);
    }
  });
});
