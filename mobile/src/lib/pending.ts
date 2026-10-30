import type { Task, TaskCreate } from "@/api/types";

/**
 * R33: rows that exist on this phone before the server has them. A temp id starts with "tmp_";
 * the server's answer swaps in the real id.
 */
export const TEMP_PREFIX = "tmp_";
let seq = 0;
export function tempId(now = Date.now()): string { seq = (seq + 1) % 1e6; return `${TEMP_PREFIX}${now.toString(36)}${seq.toString(36)}`; }
export function isTempId(id: string | null | undefined): boolean { return !!id && id.startsWith(TEMP_PREFIX); }

/** A task row to show at once while the create call runs. */
export function pendingTask(v: TaskCreate, id = tempId(), now = new Date()): Task {
  const at = now.toISOString();
  return {
    id, ref: "", projectId: v.projectId ?? null, number: 0, title: v.title, notes: v.notes ?? "",
    statusId: null, statusName: "", statusColor: null, status: v.status ?? "todo",
    assignee: null, assigneeId: v.assigneeId ?? null, priority: v.priority ?? "none", labels: v.labels ?? [],
    start: null, due: v.due ?? null, parentId: v.parentId ?? null, position: -1,
    source: null, subtasks: { total: 0, done: 0 }, commentCount: 0, completedAt: null,
    createdBy: { type: "member", id: "me" }, createdAt: at, updatedAt: at, version: 0,
  };
}
