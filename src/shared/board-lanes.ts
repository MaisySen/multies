/**
 * R34 (MB-186): board swimlanes and WIP limits, the pure part shared by the server (validation) and the web board
 * (grouping, limit state). No I/O here, so it is cheap to unit test and safe to memoize on 200+ cards.
 */
export const SWIMLANES = ["none", "assignee", "epic", "priority", "project"] as const;
export type Swimlanes = (typeof SWIMLANES)[number];
export type ColumnLimit = { max?: number; min?: number };
export type BoardLimits = Record<string, ColumnLimit>;
export type BoardSettings = { swimlanes: Swimlanes; limits: BoardLimits };
export const DEFAULT_BOARD: BoardSettings = { swimlanes: "none", limits: {} };
/** The lane for cards with no value: always listed last. */
export const NO_LANE = "__none";
export const LIMIT_MAX = 999;
const MAX_COLUMNS = 100;

/** Cleans a limits map: whole numbers 1 to 999, min not above max, empty entries dropped. Throws a plain message. */
export function normaliseLimits(raw: unknown): BoardLimits {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("limits must be an object of column id to { max, min }.");
  const out: BoardLimits = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_COLUMNS) throw new Error(`At most ${MAX_COLUMNS} column limits.`);
  for (const [col, v] of entries) {
    if (!col || col.length > 64) throw new Error("A column id is missing or too long.");
    if (v == null) continue;
    if (typeof v !== "object") throw new Error(`The limit for ${col} must be { max, min }.`);
    const { max, min } = v as { max?: unknown; min?: unknown };
    const lim: ColumnLimit = {};
    for (const [k, n] of [["max", max], ["min", min]] as const) {
      if (n == null || n === 0) continue;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > LIMIT_MAX) throw new Error(`${k} for ${col} must be a whole number from 1 to ${LIMIT_MAX}.`);
      lim[k] = n;
    }
    if (lim.max !== undefined && lim.min !== undefined && lim.min > lim.max) throw new Error(`The minimum for ${col} is above its maximum.`);
    if (lim.max !== undefined || lim.min !== undefined) out[col] = lim;
  }
  return out;
}

export type LimitState = "ok" | "over" | "under" | "at";
/** "over" past max, "at" exactly max, "under" below a set min, else "ok". */
export function limitState(count: number, lim: ColumnLimit | undefined): LimitState {
  if (!lim) return "ok";
  if (lim.max !== undefined && count > lim.max) return "over";
  if (lim.min !== undefined && count < lim.min) return "under";
  if (lim.max !== undefined && count === lim.max) return "at";
  return "ok";
}

/** True when one more card would go past the column's max (the drop still happens; the board shows a toast). */
export function wouldExceed(countAfterDrop: number, lim: ColumnLimit | undefined) {
  return !!lim && lim.max !== undefined && countAfterDrop > lim.max;
}

/** "4 / 5" for a header with a max; "4" without; "4 (min 2)" with only a min. */
export function limitLabel(count: number, lim: ColumnLimit | undefined) {
  if (lim?.max !== undefined) return `${count} / ${lim.max}`;
  if (lim?.min !== undefined) return `${count} (min ${lim.min})`;
  return String(count);
}

export type Lane = { id: string; name: string; color?: string; avatar?: string | null };
type LaneCard = { id: string; position: number };

/**
 * Buckets cards into lane x column: { [laneId]: { [colId]: cards sorted by position } }. Every lane and column
 * appears even when empty; a card whose lane or column is unknown goes to NO_LANE or is dropped from columns it
 * cannot sit in. Lanes come in the order given (NO_LANE is expected last). One pass, O(n log n).
 */
export function bucketLanes<T extends LaneCard>(cards: T[], lanes: Lane[], colIds: string[], laneOf: (t: T) => string, colOf: (t: T) => string) {
  const laneSet = new Set(lanes.map((l) => l.id));
  const colSet = new Set(colIds);
  const out: Record<string, Record<string, T[]>> = {};
  for (const l of lanes) out[l.id] = Object.fromEntries(colIds.map((c) => [c, [] as T[]]));
  for (const t of cards) {
    const c = colOf(t);
    if (!colSet.has(c)) continue;
    let l = laneOf(t);
    if (!laneSet.has(l)) { if (!laneSet.has(NO_LANE)) continue; l = NO_LANE; }
    out[l]![c]!.push(t);
  }
  for (const byCol of Object.values(out)) for (const list of Object.values(byCol)) list.sort((a, b) => a.position - b.position);
  return out;
}

/** Cards per column across all lanes (what a WIP limit counts). */
export function columnTotals(buckets: Record<string, Record<string, unknown[]>>, colIds: string[]) {
  const out: Record<string, number> = Object.fromEntries(colIds.map((c) => [c, 0]));
  for (const byCol of Object.values(buckets)) for (const c of colIds) out[c]! += byCol[c]?.length ?? 0;
  return out;
}

/** Drag ids inside a lane board: "lane|col" for a cell drop target. */
export const cellId = (lane: string, col: string) => `cell:${lane}|${col}`;
export function parseCellId(id: string): { lane: string; col: string } | null {
  if (!id.startsWith("cell:")) return null;
  const rest = id.slice(5);
  const i = rest.indexOf("|");
  return i < 0 ? null : { lane: rest.slice(0, i), col: rest.slice(i + 1) };
}

/** Priority lanes in a fixed order, then "No priority". */
export const PRIORITY_LANES = ["urgent", "high", "medium", "low"] as const;

/**
 * R35: a saved board view can carry its own swimlanes (and its own grouping). In the page they ride the URL as
 * ?lanes= and ?group=, over the board's saved setting, so opening the view shows its lanes without changing the
 * board for everyone else. Unknown values are ignored.
 */
export function lanesFrom(param: string | null | undefined, boardDefault: Swimlanes): Swimlanes {
  return param && (SWIMLANES as readonly string[]).includes(param) ? (param as Swimlanes) : boardDefault;
}

/** The board keys a saved view stores beside its filters: lanes always (so "No swimlanes" is kept too), group when set. */
export function boardViewKeys(view: string, lanes: Swimlanes, group: string | null): Record<string, string> {
  if (view !== "board") return {};
  return { lanes, ...(group ? { group } : {}) };
}
