/**
 * R32: multi-select in the mail list, pure so tests/mail-selection-r32.test.ts covers it without a browser.
 * X toggles the focused row, Shift+X (or Shift+click) selects a range from the last toggled row,
 * Cmd/Ctrl+A selects every visible row, Escape clears. Bulk actions go through POST /api/mail/messages/bulk
 * and every one that can be undone gets its inverse here (undoPlan), which Undo and Cmd/Ctrl+Z run.
 */
import type { MessageListItem } from "@/web/lib/types";

/** How many rows are selected on the Mail page now, so the command menu offers "Archive selected" only then. */
let selectionCount = 0;
export const setSelectionCount = (n: number) => { selectionCount = n; };
export const getSelectionCount = () => selectionCount;

export interface Selection { ids: string[]; anchor: string | null }
export const emptySelection = (): Selection => ({ ids: [], anchor: null });

/** Visible order is kept, so a range and "select all" read naturally. */
function ordered(rows: string[], ids: Set<string>) { return rows.filter((r) => ids.has(r)); }

export function toggleOne(sel: Selection, id: string, rows: string[]): Selection {
  const s = new Set(sel.ids);
  if (s.has(id)) s.delete(id); else s.add(id);
  return { ids: ordered(rows, s), anchor: id };
}

/** Adds every row between the anchor (or the first selected row) and `id`, both included. */
export function selectRange(sel: Selection, id: string, rows: string[]): Selection {
  const from = sel.anchor && rows.includes(sel.anchor) ? sel.anchor : sel.ids[0] ?? id;
  const a = rows.indexOf(from);
  const b = rows.indexOf(id);
  if (a < 0 || b < 0) return toggleOne(sel, id, rows);
  const s = new Set(sel.ids);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(rows[i]);
  return { ids: ordered(rows, s), anchor: id };
}

export const selectAll = (rows: string[]): Selection => ({ ids: [...rows], anchor: rows[rows.length - 1] ?? null });

/** Rows that left the list (archived elsewhere, a refetch) drop out of the selection. */
export function prune(sel: Selection, rows: string[]): Selection {
  if (!sel.ids.length) return sel;
  const live = new Set(rows);
  const ids = sel.ids.filter((i) => live.has(i));
  return ids.length === sel.ids.length ? sel : { ids, anchor: sel.anchor && live.has(sel.anchor) ? sel.anchor : null };
}

export type BulkAction = "archive" | "inbox" | "spam" | "trash" | "delete" | "read" | "unread" | "star" | "unstar" | "move" | "snooze" | "unsnooze";
export interface BulkCall { ids: string[]; action: BulkAction; to?: string; preset?: "later_today" | "tomorrow" | "next_week" }

const RESTORABLE = new Set(["inbox", "archive", "spam", "trash"]);

/**
 * The calls that put things back as they were before `call`, from the rows as they were. Moves go back to
 * each row's own folder, read and star go back only where they changed, snooze is undone by unsnooze.
 * Delete forever and a move to a provider folder have no undo (null).
 */
export function undoPlan(call: BulkCall, before: Pick<MessageListItem, "id" | "folder" | "isRead" | "isStarred">[]): BulkCall[] | null {
  const rows = before.filter((m) => call.ids.includes(m.id));
  const only = (pred: (m: (typeof rows)[number]) => boolean, action: BulkAction): BulkCall[] => {
    const ids = rows.filter(pred).map((m) => m.id);
    return ids.length ? [{ ids, action }] : [];
  };
  switch (call.action) {
    case "read": return only((m) => !m.isRead, "unread");
    case "unread": return only((m) => m.isRead, "read");
    case "star": return only((m) => !m.isStarred, "unstar");
    case "unstar": return only((m) => m.isStarred, "star");
    case "snooze": return [{ ids: call.ids, action: "unsnooze" }];
    case "archive": case "inbox": case "spam": case "trash": {
      const groups = new Map<string, string[]>();
      for (const m of rows) {
        if (m.folder === call.action || !RESTORABLE.has(m.folder)) continue;
        groups.set(m.folder, [...(groups.get(m.folder) ?? []), m.id]);
      }
      return [...groups].map(([folder, ids]) => ({ ids, action: folder as BulkAction }));
    }
    default: return null;
  }
}

const SNOOZE_WORDS = { later_today: "until later today", tomorrow: "until tomorrow", next_week: "until next week" } as const;

/** The toast after a bulk action: "Archived 3 conversations". */
export function bulkLabel(call: BulkCall, folderLabel?: string): string {
  const n = call.ids.length;
  const what = n === 1 ? "1 conversation" : `${n} conversations`;
  switch (call.action) {
    case "archive": return `Archived ${what}`;
    case "inbox": return `Moved ${what} to Inbox`;
    case "spam": return `Marked ${what} as spam`;
    case "trash": return `Moved ${what} to Trash`;
    case "delete": return `Deleted ${what} forever`;
    case "read": return `Marked ${what} as read`;
    case "unread": return `Marked ${what} as unread`;
    case "star": return `Starred ${what}`;
    case "unstar": return `Unstarred ${what}`;
    case "move": return `Moved ${what}${folderLabel ? ` to ${folderLabel}` : ""}`;
    case "snooze": return `Snoozed ${what} ${call.preset ? SNOOZE_WORDS[call.preset] : ""}`.trim();
    case "unsnooze": return `Brought back ${what}`;
  }
}

/** How long Undo (the toast button and Cmd/Ctrl+Z) stays available. */
export const UNDO_MS = 8000;
