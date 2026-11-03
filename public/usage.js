export const usageLevel = (used) => (used >= 90 ? 'high' : used >= 70 ? 'mid' : 'low');

const mostUsed = (windows) => windows.reduce((most, window) => (!most || window.usedPercent > most.usedPercent ? window : most), null);

/**
 * The limit to show in the top bar: the 5h one, unless a longer limit is nearly used up
 * (the meter's red level), since that one would then stop the session first.
 */
export const headlineWindow = (windows) => {
  const fiveHour = windows.find((window) => window.label === '5h');
  const nearlyUsed = mostUsed(windows.filter((window) => window !== fiveHour && window.usedPercent >= 90));
  return nearlyUsed ?? fiveHour ?? mostUsed(windows);
};

const DAY_MS = 24 * 60 * 60_000;

/** Why a source has no figures: its read failed, it has no plan limits, or it has not answered yet. */
const noUsageReason = (source) => source.error ?? (source.fetchedAt ? 'No limits reported' : 'No usage data yet');

/**
 * One state for a source's limits, worst first: a limit used up, one running low (the
 * meter's yellow or red), a weekly limit with room left that resets within a day (so
 * it is worth spending), or all fine. Unknown, with the reason, when there are no figures.
 */
export const usageState = ({ windows, ...source }, now = Date.now()) => {
  if (!windows.length) return { state: 'unknown', text: noUsageReason(source) };
  const out = windows.filter((window) => window.usedPercent >= 100);
  if (out.length) return { state: 'out', text: `Used up: ${out.map((window) => window.label).join(', ')}` };
  const low = windows.filter((window) => usageLevel(window.usedPercent) !== 'low');
  if (low.length) return { state: 'low', text: `Running low: ${low.map((window) => `${window.label} ${Math.round(100 - window.usedPercent)}% left`).join(', ')}` };
  const spare = windows.filter((window) => window.label.startsWith('Weekly') && window.resetsAt > now && window.resetsAt - now < DAY_MS);
  if (spare.length) {
    return { state: 'spare', text: 'Use it before it resets' };
  }
  return { state: 'ok', text: 'All limits fine' };
};
