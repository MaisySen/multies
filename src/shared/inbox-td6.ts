/**
 * TD6 One inbox: the pure sorting rules (Important or Noise), shared by the server and the page and unit tested.
 * Rules first, always: a remembered choice for the sender or source wins, then the kind of item. No AI is involved.
 */
export type InboxLane = "important" | "noise";
/** note: a notification; mail: an Inbox message; run: an assistant reply; ref: a record mention of a task assigned to the person (TD5 record_refs). */
export type InboxKind = "note" | "mail" | "run" | "ref";
export type InboxSource = "mail" | "chat" | "mention" | "task" | "assistant" | "other";
export const INBOX_SOURCES: InboxSource[] = ["mail", "chat", "mention", "task", "assistant", "other"];
export const INBOX_SOURCE_LABELS: Record<InboxSource | "all", string> = {
  all: "All", mail: "Mail", chat: "Chat", mention: "Mentions", task: "Tasks", assistant: "Assistant", other: "Other",
};
export const INBOX_VIEWS = ["inbox", "later", "done"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
export const INBOX_LANES: InboxLane[] = ["important", "noise"];
export const RULES_MAX = 500;
export const BULK_MAX = 200;

/** Notification types that go to Important by default (direct to the person, a mention, assigned, due soon). */
const IMPORTANT_TYPES = new Set([
  "chat.mention", "task.mentioned", "doc.mentioned", "thread_mention", "task.assigned", "thread_assigned", "approval.requested",
  "task.due_soon", "chat.dm", "portal.message", "call.started", "task.email_reply",
]);
const CHAT_TYPES = new Set(["chat.dm", "chat.reply", "portal.message", "call.started"]);
const TASK_TYPES = new Set(["task.assigned", "task.due_soon", "task.commented", "task.watch_comment", "task.watch_status", "task.recurred", "task.email_reply", "approval.requested", "thread_assigned"]);

/** Mentions adapter: any type naming a mention is a mention, so new mention types (record mentions) sort with no change here. */
export const isMentionType = (type: string) => /mention/i.test(type);

export function sourceOfNote(type: string): InboxSource {
  if (isMentionType(type)) return "mention";
  if (CHAT_TYPES.has(type) || type.startsWith("chat.")) return "chat";
  if (TASK_TYPES.has(type) || type.startsWith("task.")) return "task";
  return "other";
}

export interface RuleInput {
  kind: InboxKind;
  /** note: the notification type; mail: unused; run: the run status. */
  type?: string;
  /** mail only: the existing mail rule said Important (wrote to, thread, teammate, contact, authenticated first time). */
  mailImportant?: boolean;
  /** mail only: bulk headers or a robot sender. */
  mailBulk?: boolean;
  /** run only: started by a trigger (automated) rather than by the person. */
  runAutomated?: boolean;
}
export interface Sorted { lane: InboxLane; reason: string; remembered: boolean }

/** Sorts one item. `remembered` is the person's saved choice for this item's sender or source key, if any. */
export function sortItem(i: RuleInput, remembered?: InboxLane | null): Sorted {
  if (remembered === "important" || remembered === "noise") {
    return { lane: remembered, reason: remembered === "important" ? "You keep these in Important" : "You keep these in Noise", remembered: true };
  }
  if (i.kind === "mail") {
    if (i.mailBulk) return { lane: "noise", reason: "Newsletter or automated", remembered: false };
    if (i.mailImportant) return { lane: "important", reason: "From someone you know", remembered: false };
    return { lane: "noise", reason: "New sender", remembered: false };
  }
  if (i.kind === "ref") return { lane: "important", reason: "Your task was mentioned", remembered: false };
  if (i.kind === "run") {
    if (i.type === "failed") return { lane: "important", reason: "Assistant needs a look", remembered: false };
    if (i.runAutomated) return { lane: "noise", reason: "Automated run", remembered: false };
    return { lane: "important", reason: "Assistant replied", remembered: false };
  }
  const t = i.type ?? "";
  if (isMentionType(t)) return { lane: "important", reason: "Mentioned you", remembered: false };
  if (IMPORTANT_TYPES.has(t)) {
    const reason = t.endsWith("assigned") ? "Assigned to you" : t === "task.due_soon" ? "Due soon" : t === "approval.requested" ? "Needs your approval" : t === "task.email_reply" ? "Reply on your task" : "Sent to you";
    return { lane: "important", reason, remembered: false };
  }
  if (t === "automation.email" || t === "automation.status") return { lane: "noise", reason: "Automated", remembered: false };
  return { lane: "noise", reason: "Update", remembered: false };
}

/** The key a remembered choice is saved under. Built on the server from the item, never taken from the browser. */
export function ruleKey(i: { kind: InboxKind; type?: string; entityType?: string; entityId?: string; sender?: string; agentId?: string; channelId?: string | null }): string | null {
  if (i.kind === "mail") {
    const s = (i.sender ?? "").trim().toLowerCase();
    return s && s.length <= 320 && s.includes("@") ? `sender:${s}` : null;
  }
  if (i.kind === "run") return i.agentId ? `agent:${i.agentId}` : null;
  if (i.channelId) return `src:channel:${i.channelId}`;
  if (i.entityType && i.entityId) return `src:${i.entityType}:${i.entityId}`;
  return i.type ? `type:${i.type}` : null;
}

/** A remembered key in words for the rules list (no message content: an address, or the kind of source). */
export function ruleLabel(key: string): string {
  if (key.startsWith("sender:")) return key.slice(7);
  if (key.startsWith("agent:")) return "An assistant";
  if (key.startsWith("src:channel:")) return "A chat conversation";
  if (key.startsWith("src:task:")) return "A task";
  if (key.startsWith("src:doc:")) return "A doc";
  if (key.startsWith("src:")) return "A source";
  return "A kind of update";
}

/** Snooze wakeup: an item snoozed to a time that has passed is back in the inbox (and shows unread). */
export function viewOf(s: { doneAt?: Date | null; snoozedUntil?: Date | null }, now: Date): InboxView {
  if (s.doneAt) return "done";
  if (s.snoozedUntil && s.snoozedUntil.getTime() > now.getTime()) return "later";
  return "inbox";
}

/** Read state of a mail item: the person's own choice in this inbox, else the message's flag; a passed snooze shows unread. */
export function mailRead(own: boolean | null | undefined, messageRead: boolean): boolean {
  return own === true || own === false ? own : messageRead;
}

/** Keyboard keys for the page (pure so they are unit tested). */
export type InboxKeyAction = "next" | "prev" | "done" | "snooze" | "toggle-read" | "select" | "move" | "open";
export function inboxKeyAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): InboxKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "j": case "ArrowDown": return "next";
    case "k": case "ArrowUp": return "prev";
    case "e": return "done";
    case "s": return "snooze";
    case "u": return "toggle-read";
    case "x": return "select";
    case "m": return "move";
    case "o": case "Enter": return "open";
    default: return null;
  }
}
export const INBOX_KEYS: { key: string; label: string }[] = [
  { key: "j", label: "Next item" }, { key: "k", label: "Previous item" }, { key: "o", label: "Open" }, { key: "e", label: "Done" },
  { key: "s", label: "Snooze until tomorrow" }, { key: "u", label: "Read or unread" }, { key: "x", label: "Select" },
  { key: "m", label: "Move to the other tab" },
];
