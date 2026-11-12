/**
 * K1 (owner's top item, 7 Nov): folding board columns. Which columns are folded is a per person view choice, kept on
 * the device per project and per grouping (status columns, a field's options, epics), like folded swimlanes (R34).
 * A folded column stays a drop target: a card dropped on it goes to its end.
 */

/** The local storage key for one project's folded columns under one grouping. */
export const foldedColumnsKey = (projectId: string, grouping: string) => `multies.board.cols.${projectId}.${grouping}`;

/** Reads a stored list of column ids; anything that is not a list of strings reads as none folded. */
export function parseFolded(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/** The set with `id` folded if it was open, or opened if it was folded (a new set; the old one is untouched). */
export function toggleFolded(folded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(folded);
  if (next.has(id)) next.delete(id); else next.add(id);
  return next;
}

/** Folded ids that are still columns on the board (a deleted status or option drops out when the list is saved). */
export function liveFolded(folded: ReadonlySet<string>, columnIds: readonly string[]): Set<string> {
  return new Set(columnIds.filter((id) => folded.has(id)));
}

/** What a folded column says to a screen reader: its name, how many cards, and its limit when it has one. */
export function foldedLabel(title: string, count: number, max?: number | null): string {
  const cards = `${count} ${count === 1 ? "card" : "cards"}`;
  return `Expand ${title}, ${cards}${max != null ? `, limit ${max}` : ""}`;
}
