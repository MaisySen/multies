/**
 * R36: inline edits on board cards and task rows. Optimistic: every loaded task list shows the change at once,
 * and a refusal puts every list back and says so. Uses the existing PATCH /tasks/:id (no new endpoint); one
 * write per committed edit, essential (it is the user's own change, nothing is written on open or cancel).
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import type { Task } from "@/web/pages/app/work/data";

export type TaskDisplay = (t: Task) => Task;
type Snapshot = [readonly unknown[], Task[] | undefined][];

/** Applies `display` to one task in every list, returning the lists as they were. */
export function applyToLists(lists: Snapshot, id: string, display: TaskDisplay): Snapshot {
  return lists.map(([key, list]) => [key, Array.isArray(list) ? list.map((t) => (t.id === id ? display(t) : t)) : list]);
}

/** A title worth saving: trimmed, not empty, changed, at most 500 characters. Null means keep the old one. */
export function cleanTitle(next: string, prev: string): string | null {
  const v = next.replace(/\s+/g, " ").trim().slice(0, 500);
  return v && v !== prev ? v : null;
}

/** "YYYY-MM-DD" from an ISO due date, for a date input. */
export const dueInputValue = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

export async function editTask(qc: QueryClient, t: Task, patch: Record<string, unknown>, display: TaskDisplay, done?: string): Promise<boolean> {
  await qc.cancelQueries({ queryKey: ["tasks"] });
  const before = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
  for (const [key, list] of applyToLists(before, t.id, display)) qc.setQueryData(key, list);
  try {
    await api.patch(`/tasks/${t.id}`, patch);
    if (done) toast.success(done, { duration: 1600 });
    void qc.invalidateQueries({ queryKey: ["task", t.id] });
    return true;
  } catch (e) {
    for (const [key, list] of before) qc.setQueryData(key, list);
    toast.error("That change did not save, so it was undone.", { description: e instanceof Error ? e.message : undefined });
    return false;
  }
}
