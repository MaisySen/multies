/** Types and data hooks for the suite pages (tasks, projects, docs, contacts, deals, automations). */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";

export type Category = "todo" | "doing" | "done";
export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export interface Status { id: string; name: string; category: Category; color: string; position: number }
export interface Project { id: string; name: string; description: string; key: string; color: string; archived: boolean; statuses: Status[]; counts: Record<Category, number>; version: number }
export interface Assignee { type: "member" | "agent"; id: string; name: string; email: string | null; /** R26: an AI agent member. */ isAgent?: boolean }
export interface Task {
  id: string; ref: string; projectId: string; number: number; title: string; notes: string;
  statusId: string; statusName: string; statusColor: string; status: Category;
  assignee: Assignee | null; assigneeId: string | null; priority: Priority; labels: string[];
  start: string | null; due: string | null; parentId: string | null; position: number;
  source: { threadId: string | null; messageId: string | null; from: string; subject: string } | null;
  subtasks: { total: number; done: number }; commentCount: number; completedAt: string | null;
  repeat?: { freq: "daily" | "weekly" | "monthly" | "yearly"; interval?: number; weekdays?: number[]; monthDay?: number; until?: string | null; text: string } | null;
  createdBy: { type: string; id: string | null }; createdAt: string; updatedAt: string; version: number;
  fields?: Record<string, FieldValue>;
  /** R24.1: why a formula or rollup cell shows #ERROR, per field id. */
  fieldErrors?: Record<string, string>;
  /** R21: task, story, bug or epic. */
  type?: "task" | "story" | "bug" | "epic";
  /** Round 21: the sprint (null: backlog) and the estimate. */
  sprintId?: string | null; points?: number | null;
}
export type FieldType = "text" | "number" | "currency" | "date" | "select" | "multiselect" | "person" | "checkbox" | "url" | "formula" | "rollup";
export type FieldValue = string | number | boolean | string[] | null;
export interface FieldOption { id: string; label: string; color: string }
export interface CustomField { id: string; projectId: string; name: string; type: FieldType; options: FieldOption[]; position: number; /** R24.1: formula or rollup settings. */ config?: import("./computed-fields").ComputedConfig }
export interface TaskFile { id: string; filename: string; contentType: string; sizeBytes: number; uploadedBy: { type: string; name: string }; createdAt: string }
export interface Comment { id: string; body: string; author: { type: string; id: string | null; name: string }; createdAt: string }
export interface ActivityEntry { id: string; actor: { type: string; id: string | null; name: string | null }; verb: string; data: Record<string, unknown>; at: string }
export interface ThreadMessage { id: string; mailboxId: string; direction: "inbound" | "outbound"; from: { address: string; name: string }; subject: string; date: string; latestText: string; byAgent: boolean }
export interface Contact {
  id: string; name: string; email: string; phone: string | null; title: string | null; notes: string; source: string;
  company: { id: string; name: string; domain: string | null } | null; messageCount: number; firstContactAt: string | null; lastContactAt: string | null; version: number;
}
export interface TaskDetail {
  task: Task; subtasks: Task[]; comments: Comment[]; thread: ThreadMessage[]; activity: ActivityEntry[]; docs: { id: string; title: string; updatedAt: string }[]; contacts: Contact[];
  blockedBy?: Task[]; blocking?: Task[]; time?: { totalSeconds: number; entries: import("./time").TimeEntry[] };
  customFields?: CustomField[];
}
export interface AssigneeOption { id: string; type: "member" | "agent"; name: string; email: string | null; /** R26: an AI agent member (type member). */ isAgent?: boolean; paused?: boolean }
/** R26 (DF-3): agent inboxes and AI agent members both get the Agent badge. */
export const isAgentLike = (p: { type: string; isAgent?: boolean }) => p.type === "agent" || !!p.isAgent;
export interface SavedView { id: string; projectId: string | null; name: string; view: ViewKind; filters: Record<string, string>; shared: boolean }
export type ViewKind = "board" | "list" | "calendar" | "timeline" | "sprints" | "workload";

export const PRIORITY_LABEL: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
export const PRIORITY_COLOR: Record<Priority, string> = { none: "text-subtle", low: "text-muted", medium: "text-brand-hover", high: "text-warn", urgent: "text-bad" };

export const sk = {
  projects: ["projects"] as const,
  tasks: (f: Record<string, string | undefined>) => ["tasks", f] as const,
  task: (id: string) => ["task", id] as const,
  assignees: ["assignees"] as const,
  views: ["task-views"] as const,
};

export const useProjects = () => useQuery({ queryKey: sk.projects, queryFn: async () => (await api.get<{ projects: Project[] }>("/projects")).projects, staleTime: 30_000 });
export const useAssignees = () => useQuery({ queryKey: sk.assignees, queryFn: async () => (await api.get<{ assignees: AssigneeOption[] }>("/tasks/assignees")).assignees.filter((p) => !p.paused), staleTime: 120_000 });
export const useFields = (projectId: string | undefined) =>
  useQuery({ queryKey: ["fields", projectId ?? ""], enabled: !!projectId, staleTime: 30_000, queryFn: async () => (await api.get<{ fields: CustomField[] }>(`/fields?projectId=${projectId}`)).fields });
export const useViews = () => useQuery({ queryKey: sk.views, queryFn: async () => (await api.get<{ views: SavedView[] }>("/tasks/views")).views });

export function useTasks(f: Record<string, string | undefined>, opts: { enabled?: boolean } = {}) {
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString();
  // Polls the change feed's effect cheaply: lists refresh every 20 s and on focus.
  return useQuery({ queryKey: sk.tasks(f), queryFn: async () => (await api.get<{ tasks: Task[] }>(`/tasks${qs ? `?${qs}` : ""}`)).tasks, refetchInterval: 20_000, enabled: opts.enabled ?? true });
}

export const useTaskDetail = (id: string | null) =>
  useQuery({ queryKey: sk.task(id ?? ""), queryFn: () => api.get<TaskDetail>(`/tasks/${id}`), enabled: !!id, refetchInterval: 20_000 });

export function useTaskMutations() {
  const qc = useQueryClient();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["tasks"] }); void qc.invalidateQueries({ queryKey: ["task"] }); void qc.invalidateQueries({ queryKey: sk.projects }); refreshSprints(); };
  // Round 21: the Sprints view and its counts follow task edits.
  const refreshSprints = () => { for (const k of ["sprint", "sprints", "sprint-backlog"]) void qc.invalidateQueries({ queryKey: [k] }); };
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api.patch<{ task: Task }>(`/tasks/${id}`, patch),
    // Optimistic: lists show the change at once; the server's answer replaces it.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["tasks"] });
      const snapshots = qc.getQueriesData<Task[]>({ queryKey: ["tasks"] });
      const merge = (t: Task) => ({ ...t, ...(patch as Partial<Task>), ...(patch.fields ? { fields: { ...t.fields, ...(patch.fields as Record<string, FieldValue>) } } : {}) });
      for (const [key, list] of snapshots) if (list) qc.setQueryData<Task[]>(key, list.map((t) => (t.id === id ? merge(t) : t)));
      return { snapshots };
    },
    onError: (e, _v, ctx) => { for (const [key, list] of ctx?.snapshots ?? []) qc.setQueryData(key, list); showError(e as Error); },
    onSettled: refresh,
  });
  const create = useMutation({ mutationFn: (body: Record<string, unknown>) => api.post<{ task: Task }>("/tasks", body), onSuccess: refresh, onError: (e) => showError(e as Error) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/tasks/${id}`), onSuccess: refresh, onError: (e) => showError(e as Error) });
  return { update, create, remove, refresh };
}

/** Position between two neighbours, for a card dropped in a column. */
export function positionBetween(before?: number, after?: number) {
  if (before === undefined && after === undefined) return 1024;
  if (before === undefined) return after! - 1024;
  if (after === undefined) return before + 1024;
  return (before + after) / 2;
}

export const dueLabel = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
};
export const isOverdue = (t: Pick<Task, "due" | "status">) => !!t.due && t.status !== "done" && new Date(t.due).getTime() < Date.now() - 86_400_000 + 1;
