import { describe, expect, it } from 'vitest';
import { isQuietTime, type QuietHours } from './quietHours.js';

// Monday 26 October 2026, local time.
const monday = (hour: number) => new Date(2026, 9, 26, hour, 30);
const saturday = (hour: number) => new Date(2026, 9, 31, hour, 30);
const night: QuietHours = { quietHours: true, quietFrom: 18, quietTo: 8, quietWeekends: true };

describe('isQuietTime', () => {
  it('is never quiet while quiet hours are off', () => {
    expect(isQuietTime({ ...night, quietHours: false }, monday(23))).toBe(false);
    expect(isQuietTime({ ...night, quietHours: false }, saturday(12))).toBe(false);
  });

  it('wraps a window past midnight', () => {
    expect([7, 8, 17, 18, 23, 0].map((hour) => isQuietTime(night, monday(hour)))).toEqual([true, false, false, true, true, true]);
  });

  it('keeps a daytime window within the day', () => {
    const lunch = { ...night, quietFrom: 12, quietTo: 13 };
    expect([11, 12, 13].map((hour) => isQuietTime(lunch, monday(hour)))).toEqual([false, true, false]);
  });

  it('sets no nightly window with the same hour twice', () => {
    expect(isQuietTime({ ...night, quietFrom: 9, quietTo: 9 }, monday(9))).toBe(false);
  });

  it('is quiet all weekend only when chosen', () => {
    expect(isQuietTime(night, saturday(12))).toBe(true);
    expect(isQuietTime({ ...night, quietWeekends: false }, saturday(12))).toBe(false);
    expect(isQuietTime({ ...night, quietWeekends: false }, saturday(22))).toBe(true);
  });
});
