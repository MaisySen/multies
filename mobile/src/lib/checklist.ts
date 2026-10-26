import type { ChecklistItem } from "@/api/types";

export type { ChecklistItem, ChecklistView } from "@/api/types";

/** "3 of 5 done", or null when the task has no checklist. */
export function progressLabel(c: { total: number; done: number } | null | undefined): string | null {
  if (!c || !c.total) return null;
  return `${c.done} of ${c.total} done`;
}

/** The "3/5" badge on task rows. */
export function progressBadge(c: { total: number; done: number } | null | undefined): string | null {
  if (!c || !c.total) return null;
  return `${c.done}/${c.total}`;
}

/** 0 to 1, for the progress bar. */
export function progressFraction(c: { total: number; done: number } | null | undefined): number {
  if (!c || !c.total) return 0;
  return Math.min(1, Math.max(0, c.done / c.total));
}

export function summarise(items: ChecklistItem[]): { total: number; done: number } {
  return { total: items.length, done: items.filter((i) => i.done).length };
}

export function sortItems(items: ChecklistItem[]): ChecklistItem[] {
  return [...items].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
}

/** The list with one item changed, as the screen shows it before the server answers. */
export function patchItem(items: ChecklistItem[], id: string, patch: Partial<Pick<ChecklistItem, "title" | "done">>): ChecklistItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}

export function removeItem(items: ChecklistItem[], id: string): ChecklistItem[] {
  return items.filter((i) => i.id !== id);
}

/** A stand in for a new item until the server returns the real one. */
export function draftItem(taskId: string, title: string, items: ChecklistItem[], now = new Date().toISOString()): ChecklistItem {
  const pos = items.reduce((m, i) => Math.max(m, i.position), 0) + 1;
  return { id: `chk_draft_${pos}_${now}`, taskId, title, done: false, position: pos, assignee: null, due: null, createdAt: now, updatedAt: now };
}

/** Item ids after moving one up (-1) or down (+1). Null when it can't move. */
export function moveIds(items: ChecklistItem[], id: string, dir: -1 | 1): string[] | null {
  const ids = sortItems(items).map((i) => i.id);
  const at = ids.indexOf(id);
  const to = at + dir;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  [ids[at], ids[to]] = [ids[to], ids[at]];
  return ids;
}

/** Items in the order of ids, with positions 1..n. */
export function applyOrder(items: ChecklistItem[], ids: string[]): ChecklistItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return ids.map((id) => byId.get(id)).filter((i): i is ChecklistItem => !!i).map((i, n) => ({ ...i, position: n + 1 }));
}

/** Clean a typed title: trimmed, one line, at most 500 characters. Empty means nothing to save. */
export function cleanItemTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 500);
}
