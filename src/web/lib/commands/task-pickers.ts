/**
 * R31: what each task picker (S, A, P, L, D) offers and the change it makes, pure so it is tested
 * without a browser. The command menu shows these as a nested page; picking one patches the task.
 */
import type { AssigneeOption, Priority, Project, Task } from "@/web/pages/app/work/data";
import { PRIORITY_LABEL } from "@/web/pages/app/work/data";
import type { TaskPickerPage } from "./modules/tasks";

export interface PickerItem {
  id: string;
  label: string;
  hint?: string;
  current?: boolean;
  /** What the server gets (PATCH /tasks/:id). */
  patch: Record<string, unknown>;
  /** What the lists show at once (optimistic), before the server answers. */
  view: Partial<Task>;
  /** The toast after it is saved. */
  done: string;
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plusDays = (now: Date, n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return d; };
/** Next Monday (or the Monday after, when today is Monday). */
const nextMonday = (now: Date) => plusDays(now, ((8 - now.getDay()) % 7) || 7);

export function taskPickerItems(page: TaskPickerPage, t: Task, ctx: { projects: Project[]; people: AssigneeOption[]; labels: string[]; search?: string; now?: Date }): PickerItem[] {
  switch (page) {
    case "status": {
      const project = ctx.projects.find((p) => p.id === t.projectId);
      return (project?.statuses ?? []).slice().sort((a, b) => a.position - b.position).map((s) => ({
        id: s.id, label: s.name, current: s.id === t.statusId, patch: { statusId: s.id },
        view: { statusId: s.id, statusName: s.name, statusColor: s.color, status: s.category }, done: `Status set to ${s.name}`,
      }));
    }
    case "assignee": {
      const none: PickerItem = { id: "nobody", label: "Nobody", current: !t.assigneeId, patch: { assignee: null }, view: { assigneeId: null, assignee: null }, done: "Unassigned" };
      return [none, ...ctx.people.map((p) => ({
        id: p.id, label: p.name, hint: p.type === "agent" || p.isAgent ? "Agent" : p.email ?? undefined, current: p.id === t.assigneeId,
        patch: { assignee: p.id }, view: { assigneeId: p.id, assignee: { type: p.type, id: p.id, name: p.name, email: p.email, isAgent: p.isAgent } }, done: `Assigned to ${p.name}`,
      }))];
    }
    case "priority":
      return (["urgent", "high", "medium", "low", "none"] as Priority[]).map((p) => ({
        id: p, label: PRIORITY_LABEL[p], current: p === t.priority, patch: { priority: p }, view: { priority: p }, done: `Priority set to ${PRIORITY_LABEL[p]}`,
      }));
    case "label": {
      const typed = (ctx.search ?? "").trim().replace(/,/g, "").slice(0, 40);
      const all = [...new Set([...ctx.labels, ...t.labels])].sort((a, b) => a.localeCompare(b));
      const toggle = (l: string): PickerItem => {
        const has = t.labels.includes(l);
        const next = has ? t.labels.filter((x) => x !== l) : [...t.labels, l];
        return { id: `label-${l}`, label: l, current: has, hint: has ? "Remove" : undefined, patch: { labels: next }, view: { labels: next }, done: has ? `Removed ${l}` : `Added ${l}` };
      };
      const items = all.map(toggle);
      if (typed && !all.some((l) => l.toLowerCase() === typed.toLowerCase())) items.unshift({ ...toggle(typed), id: "label-new", hint: "New label" });
      return items;
    }
    case "due": {
      const now = ctx.now ?? new Date();
      const opt = (id: string, label: string, d: Date | null): PickerItem => {
        const due = d ? day(d) : null;
        return { id, label, hint: due ?? undefined, current: (t.due ?? null)?.slice(0, 10) === due, patch: { due }, view: { due }, done: due ? `Due ${label.toLowerCase()}` : "Due date removed" };
      };
      return [opt("today", "Today", now), opt("tomorrow", "Tomorrow", plusDays(now, 1)), opt("next-week", "Next week", nextMonday(now)), opt("in-two-weeks", "In two weeks", plusDays(now, 14)), opt("none", "No due date", null)];
    }
  }
}
