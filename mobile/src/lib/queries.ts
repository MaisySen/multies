import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import type { Approval, ListFolder, MessagePage, SendInput, Task, TaskCreate, TaskPatch, TaskQuery, TaskView, MeetingCreate, TimeLog } from "@/api/types";

export const keys = {
  overview: ["overview"] as const,
  agents: ["agents"] as const,
  messages: (folder: ListFolder, mailboxId?: string) => ["messages", folder, mailboxId ?? "all"] as const,
  search: (q: string) => ["search", q] as const,
  thread: (id: string) => ["thread", id] as const,
  approvals: (status: Approval["status"] | "all") => ["approvals", status] as const,
  tasks: ["tasks"] as const,
  taskList: (f: TaskQuery) => ["tasks", "list", JSON.stringify(f)] as const,
  task: (id: string) => ["task", id] as const,
  projects: ["projects"] as const,
  assignees: ["assignees"] as const,
  timer: ["time", "running"] as const,
  meetings: ["meetings"] as const,
  portfolio: ["portfolio"] as const,
};

export function useOverview() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.overview, queryFn: () => cached(kv(), `meta:${mode}:overview`, () => api.overview()), select: (d) => d.mailboxes });
}

export function useAgents() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.agents, queryFn: () => cached(kv(), `meta:${mode}:agents`, () => api.agents()), select: (d) => d.agents, staleTime: 5 * 60_000 });
}

export function useMessages(folder: ListFolder, mailboxId?: string) {
  const { api, mode } = useSession();
  return useInfiniteQuery({
    queryKey: keys.messages(folder, mailboxId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const run = () => api.messages({ folder, mailboxId, cursor: pageParam });
      // Only the first page of each folder is kept offline.
      return pageParam ? run() : cached<MessagePage>(kv(), `list:${mode}:${folder}:${mailboxId ?? "all"}`, run);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
  });
}

export function useSearch(q: string) {
  const { api } = useSession();
  return useQuery({ queryKey: keys.search(q), queryFn: () => api.messages({ q, limit: 50 }), enabled: q.trim().length >= 2 });
}

export function useThread(id: string, enabled = true) {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.thread(id), queryFn: () => cached(kv(), `thread:${mode}:${id}`, () => api.message(id)), enabled: enabled && !!id });
}

export function useApprovals(status: Approval["status"] | "all") {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: keys.approvals(status),
    queryFn: () => cached(kv(), `meta:${mode}:approvals:${status}`, () => api.approvals(status === "all" ? undefined : status)),
    select: (d) => d.approvals,
    refetchInterval: status === "pending" ? 30_000 : false,
  });
}

export function useDecide() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; decision: "approve" | "reject"; subject?: string; text?: string; note?: string }) =>
      v.decision === "approve" ? api.approve(v.id, { subject: v.subject, text: v.text }) : api.reject(v.id, v.note),
    onMutate: async (v) => {
      // Take it off the waiting list straight away; put it back if the server says no.
      await qc.cancelQueries({ queryKey: keys.approvals("pending") });
      const prev = qc.getQueryData<{ approvals: Approval[] }>(keys.approvals("pending"));
      if (prev) qc.setQueryData(keys.approvals("pending"), { approvals: prev.approvals.filter((a) => a.id !== v.id) });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(keys.approvals("pending"), ctx.prev); },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["approvals"] }); qc.invalidateQueries({ queryKey: keys.agents }); },
  });
}

export function useSend() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { input: SendInput; idempotencyKey: string }) => api.send(v.input, v.idempotencyKey),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["messages"] }); qc.invalidateQueries({ queryKey: ["thread"] }); },
  });
}

export function useMessageAction() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; action: "archive" | "inbox" | "star" | "unstar" | "unread" | "trash" }) => {
      if (v.action === "trash") return api.trash(v.id);
      const patch = v.action === "archive" || v.action === "inbox" ? { folder: v.action } : v.action === "star" || v.action === "unstar" ? { isStarred: v.action === "star" } : { isRead: false };
      return api.updateMessage(v.id, patch);
    },
    onSettled: () => { qc.invalidateQueries({ queryKey: ["messages"] }); qc.invalidateQueries({ queryKey: ["thread"] }); },
  });
}

/** The task list, from the API. The last copy of each list stays on the phone for offline use. */
export function useTasks(filter: TaskQuery = {}) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: keys.taskList(filter),
    queryFn: () => cached(kv(), `worklist:${mode}:${JSON.stringify(filter)}`, () => api.tasks(filter)),
    select: (d) => d.tasks,
    refetchInterval: 60_000,
  });
}

/** One task with its subtasks, comments and the email thread it came from. */
export function useTask(id: string) {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.task(id), queryFn: () => cached<TaskView>(kv(), `task:${mode}:${id}`, () => api.task(id)), enabled: !!id });
}

export function useAssignees() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.assignees, queryFn: () => cached(kv(), `meta:${mode}:assignees`, () => api.assignees()), select: (d) => d.assignees, staleTime: 5 * 60_000 });
}

export function useProjects() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.projects, queryFn: () => cached(kv(), `meta:${mode}:projects`, () => api.projects()), select: (d) => d.projects, staleTime: 5 * 60_000 });
}

function patchTask(t: Task, patch: TaskPatch): Task {
  const { version: _v, assigneeId, fields, ...rest } = patch;
  const next: Task = { ...t, ...rest } as Task;
  if (assigneeId !== undefined) next.assigneeId = assigneeId;
  if (fields) {
    const merged = { ...(t.fields ?? {}) };
    for (const [k, v] of Object.entries(fields)) { if (v === null) delete merged[k]; else merged[k] = v; }
    next.fields = merged;
  }
  return next;
}

export function useTaskMutations() {
  const { api } = useSession();
  const qc = useQueryClient();
  const refresh = (id?: string) => {
    qc.invalidateQueries({ queryKey: keys.tasks });
    if (id) qc.invalidateQueries({ queryKey: keys.task(id) });
  };
  const put = (task: Task) => {
    qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: d.tasks.map((x) => (x.id === task.id ? task : x)) });
    qc.setQueryData<TaskView>(keys.task(task.id), (d) => d && { ...d, task });
  };
  return {
    create: useMutation({ mutationFn: (v: TaskCreate) => api.createTask(v).then((r) => r.task), onSuccess: (t) => { qc.setQueryData(keys.task(t.id), undefined); refresh(); } }),
    fromEmail: useMutation({ mutationFn: (v: { messageId?: string; threadId?: string }) => api.taskFromEmail(v).then((r) => r.task), onSuccess: () => refresh() }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: TaskPatch }) => api.updateTask(v.id, v.patch).then((r) => r.task),
      // Show the change at once; the server's copy replaces it, or the old one comes back on error.
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: keys.tasks });
        const lists = qc.getQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks });
        const detail = qc.getQueryData<TaskView>(keys.task(v.id));
        qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: d.tasks.map((x) => (x.id === v.id ? patchTask(x, v.patch) : x)) });
        if (detail) qc.setQueryData<TaskView>(keys.task(v.id), { ...detail, task: patchTask(detail.task, v.patch) });
        return { lists, detail };
      },
      onError: (_e, v, ctx) => {
        ctx?.lists.forEach(([k, d]) => qc.setQueryData(k, d));
        if (ctx?.detail) qc.setQueryData(keys.task(v.id), ctx.detail);
      },
      onSuccess: (t) => put(t),
      onSettled: (_t, _e, v) => refresh(v.id),
    }),
    remove: useMutation({ mutationFn: (id: string) => api.deleteTask(id), onSuccess: (_r, id) => { qc.removeQueries({ queryKey: keys.task(id) }); refresh(); } }),
    comment: useMutation({ mutationFn: (v: { id: string; body: string }) => api.addComment(v.id, v.body), onSuccess: (_r, v) => refresh(v.id) }),
  };
}

/** This person's running timer, if any. Polled so a timer started on the web shows up here too. */
export function useRunningTimer() {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: keys.timer,
    queryFn: () => cached(kv(), `meta:${mode}:timer`, () => api.runningTimer()),
    select: (d) => d.entry,
    refetchInterval: 30_000,
  });
}

export function useTimerMutations() {
  const { api } = useSession();
  const qc = useQueryClient();
  const refresh = (taskId?: string | null) => {
    qc.invalidateQueries({ queryKey: keys.timer });
    // The old timer may belong to another task, so every open task refreshes its total.
    qc.invalidateQueries({ queryKey: taskId ? keys.task(taskId) : ["task"] });
  };
  return {
    start: useMutation({
      mutationFn: (v: { taskId: string; note?: string }) => api.startTimer(v.taskId, v.note).then((r) => r.entry),
      onSuccess: (entry) => { qc.setQueryData(keys.timer, { entry }); qc.invalidateQueries({ queryKey: ["task"] }); },
    }),
    stop: useMutation({
      mutationFn: () => api.stopTimer().then((r) => r.entry),
      onSuccess: (entry) => { qc.setQueryData(keys.timer, { entry: null }); refresh(entry?.taskId); },
    }),
    log: useMutation({ mutationFn: (v: TimeLog) => api.logTime(v).then((r) => r.entry), onSuccess: (_e, v) => refresh(v.taskId) }),
  };
}

export function useMeetings() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.meetings, queryFn: () => cached(kv(), `meta:${mode}:meetings`, () => api.meetings(true)) });
}

export function useCreateMeeting() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: MeetingCreate) => api.createMeeting(v).then((r) => r.meeting),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.meetings }),
  });
}

/** Every project with its health, progress and next due date. Read only on the phone. */
export function usePortfolio() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.portfolio, queryFn: () => cached(kv(), `meta:${mode}:portfolio`, () => api.portfolio()) });
}
