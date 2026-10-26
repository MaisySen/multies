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

/** R29: a copy of the list with the entry at `from` moved to `to` (both clamped into range). */
export function arrayMove<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (!out.length || from < 0 || from >= out.length) return out;
  const dest = Math.min(Math.max(to, 0), out.length - 1);
  const [x] = out.splice(from, 1);
  out.splice(dest, 0, x);
  return out;
}

/** R29: every item id in the new order after a drag from index `from` to `to`, or null when nothing moved. */
export function dragIds(items: ChecklistItem[], from: number, to: number): string[] | null {
  const ids = sortItems(items).map((i) => i.id);
  if (from < 0 || from >= ids.length) return null;
  const dest = Math.min(Math.max(to, 0), ids.length - 1);
  return dest === from ? null : arrayMove(ids, from, dest);
}

/**
 * R29: where a dragged row lands. The row at `from` has moved `dy` points; it takes a neighbour's
 * place once its middle passes the middle of that neighbour. `heights` are the rows' measured
 * heights in order and `gap` the space between rows.
 */
export function dropIndex(heights: readonly number[], gap: number, from: number, dy: number): number {
  const n = heights.length;
  if (from < 0 || from >= n || !Number.isFinite(dy)) return from;
  let at = from;
  let travelled = 0;
  if (dy > 0) {
    while (at + 1 < n) {
      const step = (heights[at + 1] ?? 0) + gap;
      if (dy <= travelled + step / 2) break;
      travelled += step;
      at++;
    }
  } else if (dy < 0) {
    while (at - 1 >= 0) {
      const step = (heights[at - 1] ?? 0) + gap;
      if (-dy <= travelled + step / 2) break;
      travelled += step;
      at--;
    }
  }
  return at;
}

/** R29: how far a row that is not being dragged moves aside while another row hovers at `to`. */
export function shiftFor(index: number, from: number, to: number, draggedHeight: number, gap: number): number {
  if (index === from || from === to) return 0;
  if (from < to && index > from && index <= to) return -(draggedHeight + gap);
  if (to < from && index >= to && index < from) return draggedHeight + gap;
  return 0;
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
