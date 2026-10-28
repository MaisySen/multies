/**
 * R54 (plan idea 8): the command menu acts on typed words. Reads the words with the shared parser
 * (src/shared/command-actions.ts), finds the task the words name (a loaded list first, else one GET by ref),
 * and works out the change. Nothing is written here: the menu applies it on Enter through the same task
 * PATCH the focused task pickers use (task-pickers.ts).
 */
import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/web/lib/api";
import { useMe } from "@/web/lib/queries";
import { parseCommand, resolveCommand, type CmdPerson, type ResolvedCommand } from "@/shared/command-actions";
import type { AssigneeOption, Project, Task, TaskDetail } from "@/web/pages/app/work/data";

export type TypedAction =
  | { state: "loading"; ref: string; label: string }
  | { state: "missing"; ref: string; label: string }
  | { state: "ready"; ref: string; label: string; task: Task; resolved: ResolvedCommand };

/** What the server gets, what the lists show at once, and the same two to put it back (Undo). */
export function typedActionChange(task: Task, r: ResolvedCommand, project: Project | undefined) {
  const patch: Record<string, unknown> = {};
  const view: Partial<Task> = {};
  const undoPatch: Record<string, unknown> = {};
  const undoView: Partial<Task> = {};
  if (r.assignee !== undefined) {
    patch.assignee = r.assignee ? r.assignee.id : null;
    view.assigneeId = r.assignee?.id ?? null;
    view.assignee = r.assignee ? ({ type: r.assignee.type, id: r.assignee.id, name: r.assignee.name, email: r.assignee.email ?? null } as Task["assignee"]) : null;
    undoPatch.assignee = task.assigneeId ?? null;
    Object.assign(undoView, { assigneeId: task.assigneeId, assignee: task.assignee });
  }
  if (r.due !== undefined) { patch.due = r.due; view.due = r.due; undoPatch.due = task.due ? task.due.slice(0, 10) : null; undoView.due = task.due; }
  if (r.status) {
    const s = project?.statuses.find((x) => x.id === r.status!.id);
    patch.statusId = r.status.id;
    Object.assign(view, { statusId: r.status.id, statusName: r.status.name, ...(s ? { statusColor: s.color, status: s.category } : {}) });
    undoPatch.statusId = task.statusId;
    Object.assign(undoView, { statusId: task.statusId, statusName: task.statusName, statusColor: task.statusColor, status: task.status });
  }
  if (r.priority) { patch.priority = r.priority; view.priority = r.priority; undoPatch.priority = task.priority; undoView.priority = task.priority; }
  if (r.labels) { patch.labels = r.labels; view.labels = r.labels; undoPatch.labels = task.labels; undoView.labels = task.labels; }
  return { patch, view, undoPatch, undoView };
}

export function useTypedAction(search: string, o: { enabled: boolean; focusedTask: Task | null; people: AssigneeOption[] | undefined; projects: Project[] | undefined }): TypedAction | null {
  const qc = useQueryClient();
  const me = useMe();
  const user = me.data?.user;
  const people = o.people;
  const parsed = useMemo(() => {
    if (!o.enabled || !people) return null;
    const list: CmdPerson[] = people.map((p) => ({ id: p.id, type: p.type, name: p.name, email: p.email }));
    const mine = user ? list.find((p) => p.id === user.id) ?? { id: user.id, type: "member" as const, name: user.name || user.email, email: user.email } : null;
    const timeZone = user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    return parseCommand(search, { people: list, me: mine, now: new Date(), timeZone, defaultRef: o.focusedTask?.ref ?? null });
  }, [search, o.enabled, people, user, o.focusedTask?.ref]);
  const ref = parsed?.ref ?? null;

  // The task: the focused one, any loaded list, else one read by its ref (404 or 403: not found for this person).
  const local = useMemo(() => {
    if (!ref) return null;
    if (o.focusedTask?.ref.toUpperCase() === ref) return o.focusedTask;
    for (const [, list] of qc.getQueriesData<Task[]>({ queryKey: ["tasks"] })) {
      const t = Array.isArray(list) ? list.find((x) => x.ref.toUpperCase() === ref) : undefined;
      if (t) return t;
    }
    return null;
  }, [ref, o.focusedTask, qc]);
  const remote = useQuery({
    queryKey: ["task-ref", ref ?? ""],
    enabled: !!ref && !local,
    retry: false,
    staleTime: 15_000,
    queryFn: async () => {
      try { return (await api.get<TaskDetail>(`/tasks/${encodeURIComponent(ref!)}`)).task; } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 403 || e.status === 400)) return null;
        throw e;
      }
    },
  });

  return useMemo<TypedAction | null>(() => {
    if (!parsed || !ref) return null;
    const task = local ?? remote.data ?? null;
    if (!task) {
      if (!local && (remote.isLoading || remote.isFetching) && remote.data === undefined) return { state: "loading", ref, label: `Looking up ${ref}` };
      return { state: "missing", ref, label: `${ref} was not found, or you cannot see it` };
    }
    const project = o.projects?.find((p) => p.id === task.projectId);
    const resolved = resolveCommand(parsed, { ref: task.ref, labels: task.labels, statusId: task.statusId, assigneeId: task.assigneeId }, project?.statuses ?? [], new Date());
    return { state: "ready", ref, label: resolved.preview, task, resolved };
  }, [parsed, ref, local, remote.data, remote.isLoading, remote.isFetching, o.projects]);
}
