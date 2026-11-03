import { describe, expect, it } from 'vitest';
import { headlineWindow, usageLevel, usageState } from '../public/usage.js';

const HOUR_MS = 3_600_000;
const now = 1_800_000_000_000;
const window = (label, usedPercent, resetsAt) => ({ label, usedPercent, resetsAt });

describe('usage display', () => {
  it('uses the 5h headline unless another limit is nearly used up', () => {
    const fiveHour = window('5h', 30);
    const weekly = window('Weekly', 80);
    const model = window('Weekly Opus', 95);
    expect(headlineWindow([fiveHour, weekly])).toBe(fiveHour);
    expect(headlineWindow([fiveHour, weekly, model])).toBe(model);
    expect(headlineWindow([weekly, model])).toBe(model);
    expect(headlineWindow([weekly])).toBe(weekly);
    expect(headlineWindow([])).toBeNull();
  });

  it.each([[69, 'low'], [70, 'mid'], [89, 'mid'], [90, 'high']])('shows the level for %i%% usage', (used, level) => {
    expect(usageLevel(used)).toBe(level);
  });

  it('explains missing usage figures', () => {
    expect(usageState({ windows: [], error: 'Offline' }, now)).toEqual({ state: 'unknown', text: 'Offline' });
    expect(usageState({ windows: [], fetchedAt: now }, now)).toEqual({ state: 'unknown', text: 'No limits reported' });
    expect(usageState({ windows: [] }, now)).toEqual({ state: 'unknown', text: 'No usage data yet' });
  });

  it('prioritizes exhausted and low limits over spare weekly capacity', () => {
    const spare = window('Weekly', 20, now + HOUR_MS);
    expect(usageState({ windows: [spare, window('5h', 100)] }, now)).toEqual({ state: 'out', text: 'Used up: 5h' });
    expect(usageState({ windows: [spare, window('5h', 75)] }, now)).toEqual({ state: 'low', text: 'Running low: 5h 25% left' });
  });

  it('shows spare weekly capacity only before an upcoming reset within a day', () => {
    const state = (resetsAt, label = 'Weekly') => usageState({ windows: [window(label, 20, resetsAt)] }, now).state;
    expect(state(now + HOUR_MS)).toBe('spare');
    expect(state(now + HOUR_MS, 'Weekly Opus')).toBe('spare');
    expect(state(now + HOUR_MS, '5h')).toBe('ok');
    expect(state(now - HOUR_MS)).toBe('ok');
    expect(state(now)).toBe('ok');
    expect(state(now + 24 * HOUR_MS)).toBe('ok');
    expect(state(undefined)).toBe('ok');
  });
});
