import type { ViewSettings } from './view.js';

export type QuietHours = Pick<ViewSettings, 'quietHours' | 'quietFrom' | 'quietTo' | 'quietWeekends'>;

/**
 * Whether `at` falls in the quiet hours set in Settings, in local time. The hours may wrap
 * past midnight (18 to 8), and the same hour twice sets no nightly window. Weekends are
 * Saturday and Sunday.
 */
export const isQuietTime = ({ quietHours, quietFrom, quietTo, quietWeekends }: QuietHours, at = new Date()): boolean => {
  if (!quietHours) return false;
  if (quietWeekends && (at.getDay() === 0 || at.getDay() === 6)) return true;
  const hour = at.getHours();
  if (quietFrom === quietTo) return false;
  return quietFrom < quietTo ? hour >= quietFrom && hour < quietTo : hour >= quietFrom || hour < quietTo;
};
