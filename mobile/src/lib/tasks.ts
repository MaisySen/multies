import type { Priority, Task, TaskStatus } from "@/api/types";

export type { Task, TaskStatus, Priority } from "@/api/types";

/** The three status groups every project's custom statuses fall into. Boards use them as columns. */
export const STATUSES: { id: TaskStatus; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "Doing" },
  { id: "done", label: "Done" },
];

export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: "none", label: "None" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "urgent", label: "Urgent" },
];

export function nextStatus(s: TaskStatus): TaskStatus { return s === "todo" ? "doing" : s === "doing" ? "done" : "todo"; }
export function statusLabel(s: TaskStatus) { return STATUSES.find((x) => x.id === s)!.label; }
export function priorityLabel(p: Priority) { return PRIORITIES.find((x) => x.id === p)?.label ?? "None"; }

/** Orders a column: urgent first, then by due date, then by the board position. */
export function sortTasks(list: Task[]): Task[] {
  const rank: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  return [...list].sort((a, b) =>
    rank[a.priority] - rank[b.priority] || (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.position - b.position);
}

/** A calendar day (YYYY-MM-DD) in local time, `days` from `from`. */
export function dayFrom(days: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The next Monday after `from`, for "Next week". */
export function nextMonday(from = new Date()): string {
  const add = ((8 - from.getDay()) % 7) || 7;
  return dayFrom(add, from);
}

/** "Due today", "Overdue 2 days", "Due Fri 30 Oct" and so on, in en-AU. */
export function dueLabel(due: string | null, now = new Date()): { text: string; tone: "bad" | "warn" | "plain" } | null {
  if (!due) return null;
  const day = due.slice(0, 10);
  const today = dayFrom(0, now);
  const diff = Math.round((Date.parse(`${day}T00:00:00`) - Date.parse(`${today}T00:00:00`)) / 86_400_000);
  if (diff < 0) return { text: diff === -1 ? "Overdue 1 day" : `Overdue ${-diff} days`, tone: "bad" };
  if (diff === 0) return { text: "Due today", tone: "warn" };
  if (diff === 1) return { text: "Due tomorrow", tone: "plain" };
  const d = new Date(`${day}T00:00:00`);
  return { text: `Due ${d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}`, tone: "plain" };
}

/** "Fri 30 Oct" for a due date. */
export function dayLabel(due: string): string {
  return new Date(`${due.slice(0, 10)}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

/** "Alex Rivera" from "Alex Rivera <alex@example.com.au>", or the address when there is no name. */
export function senderName(from: string | null | undefined): string {
  if (!from) return "";
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m) return from.trim();
  return m[1].trim() || m[2].trim();
}

/** A sensible next action for a task on the board, by its status group. */
export function moveLabel(s: TaskStatus) { return `Move to ${statusLabel(nextStatus(s))}`; }

/** Version 1.0.0 kept tasks on the phone under this key, before the tasks API existed. Sign out clears it. */
export const LEGACY_KEY = "tasks:v1";
