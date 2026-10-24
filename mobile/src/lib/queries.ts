import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { CHAT_POLL, latestChange, mergeMessages } from "./chat";
import { useForeground, usePollWhileVisible } from "./visible";
import type { ChatMessage, ChatSend, NotificationSettings, Approval, ListFolder, MessagePage, SendInput, Task, TaskCreate, TaskPatch, TaskQuery, TaskView, MeetingCreate, TimeLog } from "@/api/types";

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
  people: ["people"] as const,
  chat: ["chat"] as const,
  chatChannels: ["chat", "channels"] as const,
  chatUnread: ["chat", "unread"] as const,
  chatPeople: ["chat", "people"] as const,
  chatChannel: (id: string) => ["chat", "channel", id] as const,
  chatMessages: (id: string) => ["chat", "messages", id] as const,
  chatThread: (id: string) => ["chat", "thread", id] as const,
  notifications: ["notifications"] as const,
  notificationList: (category: string) => ["notifications", "list", category] as const,
  notificationCount: ["notifications", "count"] as const,
  notificationSettings: ["notificationSettings"] as const,
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

/** Everyone in the workspace: people first, then AI agents. Saved on the phone for offline reading. */
export function usePeople() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.people, queryFn: () => cached(kv(), `meta:${mode}:people`, () => api.people()), select: (d) => d.people, staleTime: 5 * 60_000 });
}

// ---------------------------------------------------------------- team chat

export function useChatChannels() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: keys.chatChannels, queryFn: () => cached(kv(), `meta:${mode}:chat:channels`, () => api.chatChannels()), select: (d) => d.channels });
}

/** Unread and mention counts for the Chat tab badge: every 15 s while the app is in the foreground. */
export function useChatUnread() {
  const { api } = useSession();
  const foreground = useForeground();
  return useQuery({ queryKey: keys.chatUnread, queryFn: () => api.chatUnread(), refetchInterval: foreground ? CHAT_POLL.unreadMs : false });
}

export function useChatPeople() {
  const { api } = useSession();
  return useQuery({ queryKey: keys.chatPeople, queryFn: () => api.chatPeople(), select: (d) => d.people, staleTime: 5 * 60_000 });
}

export function useChatChannel(id: string) {
  const { api } = useSession();
  return useQuery({ queryKey: keys.chatChannel(id), queryFn: () => api.chatChannel(id), select: (d) => d.channel, enabled: !!id });
}

interface Feed { messages: ChatMessage[]; hasMore: boolean }

/**
 * The open channel's messages, oldest first. The first load takes the newest 50; after that it
 * asks only for what changed (?since=) every 4 s, and only while the screen is focused and the
 * app is in the foreground.
 */
export function useChannelMessages(id: string) {
  const { api } = useSession();
  const qc = useQueryClient();
  const interval = usePollWhileVisible(CHAT_POLL.channelMs);
  return useQuery({
    queryKey: keys.chatMessages(id),
    enabled: !!id,
    refetchInterval: interval,
    queryFn: async (): Promise<Feed> => {
      const prev = qc.getQueryData<Feed>(keys.chatMessages(id));
      const since = prev ? latestChange(prev.messages) : null;
      if (!prev || !since) return api.chatMessages(id, { limit: 50 });
      const r = await api.chatMessages(id, { since });
      return { messages: mergeMessages(prev.messages, r.messages), hasMore: prev.hasMore };
    },
  });
}

/** Loads the page of messages before the oldest one on screen. */
export function useEarlierMessages(id: string) {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const prev = qc.getQueryData<Feed>(keys.chatMessages(id));
      const first = prev?.messages[0];
      if (!first) return null;
      return api.chatMessages(id, { limit: 50, before: first.id });
    },
    onSuccess: (r) => {
      if (!r) return;
      qc.setQueryData<Feed>(keys.chatMessages(id), (prev) => prev ? { messages: mergeMessages(prev.messages, r.messages), hasMore: r.hasMore } : prev);
    },
  });
}

export function useChatThread(id: string) {
  const { api } = useSession();
  const interval = usePollWhileVisible(CHAT_POLL.channelMs);
  return useQuery({ queryKey: keys.chatThread(id), queryFn: () => api.chatThread(id), enabled: !!id, refetchInterval: interval });
}

export function useSendChat(channelId: string) {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ onProgress, ...input }: ChatSend & { onProgress?: (fraction: number) => void }) =>
      api.sendChat(channelId, input, onProgress ? { onUploadProgress: onProgress } : {}),
    onSuccess: ({ message }) => {
      if (message.parentId) {
        qc.invalidateQueries({ queryKey: keys.chatThread(message.parentId) });
        qc.invalidateQueries({ queryKey: keys.chatMessages(channelId) });
      } else {
        qc.setQueryData<Feed>(keys.chatMessages(channelId), (prev) => prev ? { ...prev, messages: mergeMessages(prev.messages, [message]) } : prev);
      }
      qc.invalidateQueries({ queryKey: keys.chatChannels });
    },
  });
}

export function useMarkChannelRead() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; messageId?: string }) => api.readChannel(v.id, v.messageId),
    onSuccess: (_r, v) => {
      qc.setQueryData<{ channels: { id: string; unread: number; mentions: number }[] }>(keys.chatChannels, (d) =>
        d ? { ...d, channels: d.channels.map((c) => (c.id === v.id ? { ...c, unread: 0, mentions: 0 } : c)) } : d);
      qc.invalidateQueries({ queryKey: keys.chatUnread });
    },
  });
}

export function useMessageToTask() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { messageId: string; title?: string }) => api.chatMessageToTask(v.messageId, v.title ? { title: v.title } : {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.tasks }); qc.invalidateQueries({ queryKey: keys.chat }); },
  });
}

export function useStartDm() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userIds: string[]) => api.startDm(userIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.chatChannels }),
  });
}

// ---------------------------------------------------------------- notifications inbox

export function useNotifications(category: string) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: keys.notificationList(category),
    queryFn: () => cached(kv(), `meta:${mode}:notifications:${category}`, () => api.notifications({ category: category === "all" ? undefined : category, limit: 50 })),
  });
}

/** The unread count for the bell and the Settings row, refreshed every minute while the app is open. */
export function useNotificationCount() {
  const { api } = useSession();
  const foreground = useForeground();
  return useQuery({
    queryKey: keys.notificationCount,
    queryFn: () => api.notifications({ unread: true, limit: 1 }),
    select: (d) => d.unread,
    refetchInterval: foreground ? 60_000 : false,
  });
}

export function useReadNotifications() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { ids?: string[]; category?: string }) => api.readNotifications(v),
    onMutate: (v) => {
      // Show it read straight away; the refetch after settles the counts.
      for (const [key, data] of qc.getQueriesData<{ notifications: { id: string; read: boolean; category?: string }[]; unread: number }>({ queryKey: ["notifications", "list"] })) {
        if (!data) continue;
        const hit = (n: { id: string; category?: string }) => (v.ids ? v.ids.includes(n.id) : v.category ? n.category === v.category : true);
        qc.setQueryData(key, { ...data, notifications: data.notifications.map((n) => (hit(n) ? { ...n, read: true } : n)) });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useNotificationSettings() {
  const { api } = useSession();
  return useQuery({ queryKey: keys.notificationSettings, queryFn: () => api.notificationSettings(), select: (d) => d.settings });
}

export function useSaveNotificationSetting() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { category: string; key: "inApp" | "push"; value: boolean }) => api.saveNotificationSettings({ [v.category]: { [v.key]: v.value } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: keys.notificationSettings });
      const before = qc.getQueryData<{ settings: NotificationSettings }>(keys.notificationSettings);
      if (before) qc.setQueryData(keys.notificationSettings, { settings: { ...before.settings, [v.category]: { ...before.settings[v.category], [v.key]: v.value } } });
      return { before };
    },
    onError: (_e, _v, ctx) => { if (ctx?.before) qc.setQueryData(keys.notificationSettings, ctx.before); },
    onSuccess: (r) => qc.setQueryData(keys.notificationSettings, r),
  });
}
