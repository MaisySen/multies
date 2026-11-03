import type { Task } from "@/web/pages/app/work/data";

/**
 * PAR1: the phone task list sorts by the same keys as the list's column headers on a computer (?sort=, ?dir=, the
 * table's own sort keys), so a phone user can order the list too and a shared link sorts the same on both.
 */
export const PHONE_SORTS = [
  { value: "", label: "Default order" },
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "title", label: "Title" },
  { value: "assignee", label: "Assignee" },
  { value: "start", label: "Start date" },
  { value: "type", label: "Type" },
  { value: "points", label: "Estimate" },
] as const;

export function sortValue(sort: { id: string; desc: boolean } | null) {
  if (!sort) return "";
  return sort.desc ? `${sort.id}:desc` : sort.id;
}
export function parseSortValue(v: string): { sort: string | null; dir: "asc" | "desc" | null } {
  if (!v) return { sort: null, dir: null };
  const [id, d] = v.split(":");
  return { sort: id || null, dir: d === "desc" ? "desc" : "asc" };
}

/** Stable sort by the key the table uses for that column; an unknown column keeps the given order. */
export function sortTasks(tasks: Task[], sort: { id: string; desc: boolean } | null, keyFor: (id: string) => ((t: Task) => string | number) | null): Task[] {
  const key = sort ? keyFor(sort.id) : null;
  if (!sort || !key) return tasks;
  const dir = sort.desc ? -1 : 1;
  return tasks.map((t, i) => ({ t, i, k: key(t) })).sort((a, b) => (a.k < b.k ? -dir : a.k > b.k ? dir : a.i - b.i)).map((x) => x.t);
}
