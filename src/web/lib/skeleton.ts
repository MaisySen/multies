/** R30: varied, stable bar widths for skeleton rows (same every render, so no flicker). */
export function skeletonWidths(rows: number): number[] {
  const pattern = [62, 48, 74, 55, 68, 41, 58];
  return Array.from({ length: Math.max(0, Math.min(rows, 50)) }, (_, i) => pattern[i % pattern.length]);
}
