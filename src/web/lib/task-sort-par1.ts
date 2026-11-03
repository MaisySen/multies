import type { Priority, Project, Task } from "@/web/pages/app/work/data";

/**
 * PAR1: the phone task list sorts by the same keys as the list's column headers on a computer (?sort=, ?dir=), so a
 * phone user can order the list too and a shared link sorts the same on both. Unknown keys keep the given order.
 */
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

export const PHONE_SORTS = [
  { value: "", label: "Default order" },
  { value: "due", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "status", label: "Status" },
  { value: "title", label: "Title" },
  { value: "assignee", label: "Assignee" },
  { value: "updated:desc", label: "Recently updated" },
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

export function sortTasks(tasks: Task[], sort: { id: string; desc: boolean } | null, projects: Project[] = []): Task[] {
  if (!sort) return tasks;
  const statusIndex = (t: Task) => projects.find((p) => p.id === t.projectId)?.statuses.findIndex((s) => s.id === t.statusId) ?? 0;
  const key: ((t: Task) => string | number) | null =
    sort.id === "title" ? (t) => t.title.toLocaleLowerCase()
    : sort.id === "due" ? (t) => t.due ?? "9999"
    : sort.id === "priority" ? (t) => PRIORITY_RANK[t.priority]
    : sort.id === "status" ? statusIndex
    : sort.id === "assignee" ? (t) => (t.assignee?.name ?? "~").toLocaleLowerCase()
    : sort.id === "updated" ? (t) => t.updatedAt
    : null;
  if (!key) return tasks;
  const dir = sort.desc ? -1 : 1;
  return tasks.map((t, i) => ({ t, i, k: key(t) })).sort((a, b) => (a.k < b.k ? -dir : a.k > b.k ? dir : a.i - b.i)).map((x) => x.t);
}
