/**
 * R115 (R99 low): the tabs keyboard pattern (WAI ARIA tabs, automatic activation). Left and Right arrows move to the
 * previous and next tab and wrap around; Home goes to the first tab and End to the last. Any other key returns null.
 */
export function nextTabKey<T>(tabs: readonly T[], current: T, key: string): T | null {
  if (tabs.length === 0) return null;
  const i = Math.max(0, tabs.indexOf(current));
  if (key === "ArrowRight") return tabs[(i + 1) % tabs.length];
  if (key === "ArrowLeft") return tabs[(i - 1 + tabs.length) % tabs.length];
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs[tabs.length - 1];
  return null;
}
