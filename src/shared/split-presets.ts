/**
 * R74: Split PDF presets, so splitting needs no typing. Each preset turns into the same ranges text the Split tool has
 * always sent ("1-3, 4-6, 7"), so the engine and the server are unchanged. parseRanges reads typed ranges back into
 * parts for the live preview under the choices.
 */
export const SPLIT_RANGES_MAX = 200; // the Split tool's ranges field takes up to 200 characters
export const SPLIT_EVERY: readonly number[] = [2, 3, 5, 10];
export type SplitPreset = "each" | "every" | "halves" | "custom";
export interface Part { from: number; to: number }

const fmt = (p: Part) => (p.from === p.to ? String(p.from) : `${p.from}-${p.to}`);
export const rangesOf = (parts: Part[]) => parts.map(fmt).join(", ");

/** Parts of n pages each (the last one shorter). */
export function everyN(pages: number, n: number): Part[] {
  if (!Number.isInteger(pages) || pages < 1 || !Number.isInteger(n) || n < 1) return [];
  const out: Part[] = [];
  for (let a = 1; a <= pages; a += n) out.push({ from: a, to: Math.min(pages, a + n - 1) });
  return out;
}

/** Two parts: the first half (the larger, for an odd count) and the rest. */
export function halves(pages: number): Part[] {
  if (!Number.isInteger(pages) || pages < 2) return [];
  const k = Math.ceil(pages / 2);
  return [{ from: 1, to: k }, { from: k + 1, to: pages }];
}

export function presetParts(preset: SplitPreset, pages: number, n = 2): Part[] {
  if (preset === "each") return everyN(pages, 1);
  if (preset === "every") return everyN(pages, n);
  if (preset === "halves") return halves(pages);
  return [];
}

/** Whether a preset fits the ranges field (every page of a 120 page PDF does not). */
export const presetFits = (preset: SplitPreset, pages: number, n = 2) => preset === "custom" || (presetParts(preset, pages, n).length > 1 && rangesOf(presetParts(preset, pages, n)).length <= SPLIT_RANGES_MAX);

/** Typed ranges to parts; an error line for a page past the end or a backwards range; null parts while incomplete. */
export function parseRanges(text: string, pages: number | null): { parts: Part[]; error: string | null } {
  const t = text.trim();
  if (!t) return { parts: [], error: null };
  if (!/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*,?\s*$/.test(t)) return { parts: [], error: "Use page numbers and ranges, like 1-3, 5." };
  const parts: Part[] = [];
  for (const bit of t.split(",").map((b) => b.trim()).filter(Boolean)) {
    const [a, b] = bit.split("-").map((x) => Number(x.trim()));
    const p = { from: a, to: b ?? a };
    if (p.from < 1 || p.to < 1) return { parts: [], error: "Pages start at 1." };
    if (p.to < p.from) return { parts: [], error: `${p.from}-${p.to} goes backwards. Try ${p.to}-${p.from}.` };
    if (pages && p.to > pages) return { parts: [], error: `This PDF has ${pages} ${pages === 1 ? "page" : "pages"}, so page ${p.to} is not there.` };
    parts.push(p);
  }
  return { parts, error: null };
}

/** Which preset (and n) a ranges text came from, so the choice shows what is in the field. */
export function presetOf(text: string, pages: number): { preset: SplitPreset; n: number } {
  const t = text.replace(/\s+/g, "");
  if (!t) return { preset: pages <= 30 ? "each" : "every", n: pages <= 30 ? 2 : 10 };
  const same = (parts: Part[]) => rangesOf(parts).replace(/\s+/g, "") === t;
  if (same(everyN(pages, 1))) return { preset: "each", n: 2 };
  if (same(halves(pages))) return { preset: "halves", n: 2 };
  for (const n of SPLIT_EVERY) if (same(everyN(pages, n))) return { preset: "every", n };
  return { preset: "custom", n: 2 };
}

/** "pages 1 to 3", "page 4" */
export const partLabel = (p: Part) => (p.from === p.to ? `page ${p.from}` : `pages ${p.from} to ${p.to}`);
