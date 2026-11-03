/**
 * M5: how counts read on screen. Grouped with commas up to 99,999 ("15,527"), compact beyond ("128K", "1.2M"),
 * and badges never longer than "99+" (the tab bar, chips and rows all use these).
 */
const int = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/** 15527 -> "15,527". Plain digits and commas, the same on every phone (no Intl needed). */
export function groupCount(n: number): string {
  return String(int(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Short form for tight spots: up to 9,999 grouped, then "15.5K", "128K", "1.2M". */
export function compactCount(n: number): string {
  const v = int(n);
  if (v < 10_000) return groupCount(v);
  const one = (x: number) => (x < 100 ? x.toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
  if (v < 999_500) return `${one(v / 1000)}K`;
  return `${one(v / 1_000_000)}M`;
}

/** A stat tile's big number: grouped up to 99,999, compact beyond. */
export function statCount(n: number): string {
  return int(n) < 100_000 ? groupCount(n) : compactCount(n);
}

/** A badge: nothing at zero, "99+" past the cap. */
export function capBadge(n: number | undefined, cap = 99): string | null {
  const v = int(n ?? 0);
  if (!v) return null;
  return v > cap ? `${cap}+` : String(v);
}
