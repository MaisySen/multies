/**
 * R30: optimistic mail actions. The list changes the moment you star, mark read, archive or move a
 * message; webmail.tsx keeps the snapshot and puts it back (with an error toast) if the server says no.
 * Pure, so tests/optimistic-mail-r30.test.ts covers every action without a browser.
 */
import type { MessageListItem } from "@/web/lib/types";

export type MailAction = "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "spam" | "trash" | "delete" | "move" | "snooze" | "unsnooze";
interface Page { messages: MessageListItem[]; nextCursor: string | null }
export interface MailListData { pages: Page[]; pageParams: unknown[] }

/** The folder a message lands in after an action, or null when the action does not move it. */
export function destination(action: MailAction): MessageListItem["folder"] | "gone" | "elsewhere" | null {
  switch (action) {
    case "archive": return "archive" as MessageListItem["folder"];
    case "inbox": return "inbox" as MessageListItem["folder"];
    case "spam": return "spam" as MessageListItem["folder"];
    case "trash": return "trash" as MessageListItem["folder"];
    case "delete": return "gone";
    case "move": return "elsewhere";
    default: return null;
  }
}

/**
 * The list as it should look right after the action. `folder` is the folder on screen; `searching`
 * means the list is search results across folders, where a moved message stays and only its folder changes.
 */
export function applyMailAction(data: MailListData | undefined, ids: string[], action: MailAction, folder: string, searching = false): MailListData | undefined {
  if (!data || !ids.length) return data;
  const hit = new Set(ids);
  const dest = destination(action);
  const patch = (m: MessageListItem): MessageListItem | null => {
    if (!hit.has(m.id)) return m;
    if (action === "read" || action === "unread") return { ...m, isRead: action === "read" };
    if (action === "star" || action === "unstar") return { ...m, isStarred: action === "star" };
    // R32: a snoozed thread leaves Inbox until its time; elsewhere (and in search) it stays. Unsnooze waits for the refetch.
    if (action === "unsnooze") return m;
    if (action === "snooze") return folder === "inbox" && !searching ? null : m;
    if (dest === "gone") return null;
    if (searching) return dest === "elsewhere" ? m : { ...m, folder: dest as MessageListItem["folder"] };
    // A move to the folder already on screen keeps it (e.g. "Move to inbox" while in Inbox).
    if (dest !== "elsewhere" && dest === folder) return m;
    return null;
  };
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, messages: p.messages.map(patch).filter((m): m is MessageListItem => m !== null) })),
  };
}
