/**
 * R30: what an empty task view says and offers. Pure, so the copy and the choice of action are unit tested.
 */
export type TaskViewKind = "list" | "board" | "calendar" | "timeline" | "workload" | "sprints";
export interface EmptyCopy { title: string; body: string; action: "clear" | "new" | null; actionLabel: string | null }

/** True when the address carries a task filter (the search box, a chip, or a custom field filter). */
export function hasTaskFilters(params: Iterable<[string, string]>, keys: readonly string[]): boolean {
  for (const [k, v] of params) if (v && (keys.includes(k) || k.startsWith("field."))) return true;
  return false;
}

export function emptyTasksCopy(view: TaskViewKind, filtered: boolean): EmptyCopy {
  if (filtered) return { title: "No tasks match these filters", body: "Try fewer filters, or clear them to see every task.", action: "clear", actionLabel: "Clear filters" };
  if (view === "calendar") return { title: "Nothing on the calendar", body: "Tasks with a due date show here. Drag one to another day to move it.", action: null, actionLabel: null };
  return { title: "No tasks yet", body: "Add the first one, or make a task from any email or chat message.", action: "new", actionLabel: "New task" };
}
