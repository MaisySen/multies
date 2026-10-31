/**
 * R84: groups for the task list (status, assignee, priority, due date, tag, project or a custom field). Pure, so the
 * list, the phone list and tests share it. A task sits in one group: its main assignee, its first tag (in the
 * workspace's tag order) or its field value. Groups come in a natural order, with the empty group last.
 */
export type GroupBy = "status" | "assignee" | "priority" | "due" | "tag" | "project" | `field:${string}`;
export const GROUP_LABEL: Record<string, string> = { status: "Status", assignee: "Assignee", priority: "Priority", due: "Due date", tag: "Tag", project: "Project" };

export interface GroupTask {
  id: string; projectId: string; statusId: string; statusName: string; statusColor: string; status: "todo" | "doing" | "done";
  assignee: { type: string; id: string; name: string } | null; priority: "none" | "low" | "medium" | "high" | "urgent"; due: string | null; labels: string[];
  fields?: Record<string, unknown>;
}
export interface GroupField { id: string; name: string; type: string; options: { id: string; label: string; color: string }[] }
export interface GroupContext {
  projects: { id: string; name: string; color?: string; statuses: { id: string; name: string; color: string }[] }[];
  tags: { name: string; color: string }[];
  fields: GroupField[];
  people: { id: string; name: string }[];
  /** Today, for due date groups (tests pass a fixed day). */
  now?: Date;
}
export interface TaskGroup<T> { key: string; label: string; color?: string; tasks: T[] }

const PRIORITY_ORDER = ["urgent", "high", "medium", "low", "none"] as const;
const PRIORITY_NAME: Record<string, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
const CATEGORY_ORDER = { todo: 0, doing: 1, done: 2 } as const;
const EMPTY = "\uffff";

export function isGroupBy(v: string | null | undefined): v is GroupBy {
  return !!v && (v in GROUP_LABEL || /^field:[A-Za-z0-9_-]{1,64}$/.test(v));
}

function dayStart(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }

/** Overdue, Today, Tomorrow, This week (next 7 days), Later, No due date. */
export function dueBucket(due: string | null, done: boolean, now = new Date()): { key: string; label: string; rank: number } {
  if (!due) return { key: "none", label: "No due date", rank: 9 };
  const t = dayStart(new Date(due.length === 10 ? `${due}T00:00:00` : due));
  const today = dayStart(now);
  const day = 86_400_000;
  if (t < today) return done ? { key: "past", label: "Earlier", rank: 0 } : { key: "overdue", label: "Overdue", rank: 0 };
  if (t === today) return { key: "today", label: "Today", rank: 1 };
  if (t === today + day) return { key: "tomorrow", label: "Tomorrow", rank: 2 };
  if (t < today + 7 * day) return { key: "week", label: "Next 7 days", rank: 3 };
  return { key: "later", label: "Later", rank: 4 };
}

export function groupTasks<T extends GroupTask>(tasks: T[], by: GroupBy, ctx: GroupContext): TaskGroup<T>[] {
  const groups = new Map<string, TaskGroup<T> & { rank: number | string }>();
  const put = (key: string, label: string, rank: number | string, t: T, color?: string) => {
    const g = groups.get(key) ?? { key, label, rank, color, tasks: [] as T[] };
    g.tasks.push(t);
    groups.set(key, g);
  };
  const tagIndex = new Map(ctx.tags.map((t, i) => [t.name.toLowerCase(), i]));
  const projectIndex = new Map(ctx.projects.map((p, i) => [p.id, i]));
  const field = by.startsWith("field:") ? ctx.fields.find((f) => f.id === by.slice(6)) : undefined;
  for (const t of tasks) {
    if (by === "status") {
      const pos = ctx.projects.find((p) => p.id === t.projectId)?.statuses.findIndex((s) => s.id === t.statusId) ?? 0;
      put(`status:${t.statusName.toLowerCase()}`, t.statusName || "No status", CATEGORY_ORDER[t.status] * 100 + Math.max(0, pos), t, t.statusColor);
    } else if (by === "assignee") {
      if (t.assignee) put(`assignee:${t.assignee.type}:${t.assignee.id}`, t.assignee.name, t.assignee.name.toLowerCase(), t);
      else put("assignee:none", "Nobody", EMPTY, t);
    } else if (by === "priority") {
      put(`priority:${t.priority}`, PRIORITY_NAME[t.priority], PRIORITY_ORDER.indexOf(t.priority), t);
    } else if (by === "due") {
      const b = dueBucket(t.due, t.status === "done", ctx.now);
      put(`due:${b.key}`, b.label, b.rank, t);
    } else if (by === "tag") {
      const sorted = [...t.labels].sort((a, b) => (tagIndex.get(a.toLowerCase()) ?? 999) - (tagIndex.get(b.toLowerCase()) ?? 999) || a.localeCompare(b));
      const first = sorted[0];
      if (first) put(`tag:${first.toLowerCase()}`, first, (tagIndex.get(first.toLowerCase()) ?? 500) * 1000 + 0, t, ctx.tags.find((x) => x.name.toLowerCase() === first.toLowerCase())?.color);
      else put("tag:none", "No tag", Number.MAX_SAFE_INTEGER, t);
    } else if (by === "project") {
      const p = ctx.projects.find((x) => x.id === t.projectId);
      put(`project:${t.projectId}`, p?.name ?? "Other project", projectIndex.get(t.projectId) ?? 999, t, p?.color);
    } else if (field) {
      const v = t.fields?.[field.id];
      const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
      if (empty) { put("field:none", `No ${field.name.toLowerCase()}`, EMPTY, t); continue; }
      if (field.type === "select" || field.type === "multiselect") {
        const id = Array.isArray(v) ? String(v[0]) : String(v);
        const i = field.options.findIndex((o) => o.id === id);
        const o = field.options[i];
        put(`field:${id}`, o?.label ?? "Removed option", i < 0 ? 999 : i, t, o?.color);
      } else if (field.type === "checkbox") {
        put(`field:${v ? "yes" : "no"}`, v ? "Ticked" : "Not ticked", v ? 0 : 1, t);
      } else if (field.type === "person") {
        const pid = String(v);
        const name = ctx.people.find((p) => p.id === pid)?.name ?? "Former member";
        put(`field:${pid}`, name, name.toLowerCase(), t);
      } else if (field.type === "number" || field.type === "currency") {
        put(`field:${v}`, String(v), Number(v), t);
      } else {
        put(`field:${String(v).toLowerCase()}`, String(v), String(v).toLowerCase(), t);
      }
    } else {
      put("all", "All tasks", 0, t);
    }
  }
  return [...groups.values()]
    .sort((a, b) => (typeof a.rank === "number" && typeof b.rank === "number" ? a.rank - b.rank : String(a.rank).localeCompare(String(b.rank))))
    .map(({ key, label, color, tasks: list }) => ({ key, label, color, tasks: list }));
}

/** Collapsed groups are remembered on this device per grouping (no server write). */
export function collapsedKey(by: string) { return `multies.tasks.collapsed.${by}`; }
