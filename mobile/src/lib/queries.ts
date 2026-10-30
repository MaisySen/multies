import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached, setOffline } from "./offline";
import { kv } from "./kv";
import { CHAT_POLL, latestChange, mergeMessages } from "./chat";
import { useForeground, usePollWhileVisible } from "./visible";
import type { ConnectInput } from "./mail-connect";
import type { ChatMessage, ChatSend, NotificationSettings, Approval, ListFolder, MessagePage, SendInput, Task, TaskCreate, TaskPatch, TaskQuery, TaskView, MeetingCreate, TimeLog } from "@/api/types";
import { pendingTask } from "./pending";
import { ApiError } from "@/api/errors";
import { commandQueue, type NewCommand } from "./command-queue";
import { countsClient, COUNTS_POLL_MS, type Counts } from "./counts";
import { blockedIds, isMissingEndpoint, isUnblockDone, reportBody, withBlock, withoutBlock, type BlockedPerson, type ReportInput } from "./moderation";
import { success, warning } from "./haptics";
import { animateList } from "./motion";

/** R33: what a mutation answers when its call went into the offline command queue. */
export const QUEUED = "queued" as const;

/** Runs a call; when there is no connection and the queue exists, saves it as a command instead. */
export async function offlineOr<T>(call: () => Promise<T>, command: NewCommand): Promise<T | typeof QUEUED> {
  try { return await call(); }
  catch (err) {
    const q = commandQueue();
    if (!(err instanceof ApiError && err.isNetwork) || !q) throw err;
    setOffline(true);
    await q.enqueue(command);
    return QUEUED;
  }
}

export const keys = {
  counts: ["counts"] as const,
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
  connections: ["connections"] as const,
  freeAddress: ["free-address"] as const,
  chat: ["chat"] as const,
  chatChannels: ["chat", "channels"] as const,
  chatUnread: ["chat", "unread"] as const,
  chatPeople: ["chat", "people"] as const,
  blocks: ["blocks"] as const,
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

/** Tools: the catalogue, this month's runs and the plan's limits. A 404 means Tools are off (server or workspace). */
export function useTools() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: ["tools", mode], queryFn: () => api.tools(), staleTime: 60_000, retry: (n, e) => (e as { status?: number })?.status !== 404 && n < 2 });
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
    mutationFn: async (v: { id: string; action: "archive" | "inbox" | "star" | "unstar" | "read" | "unread" | "trash" }): Promise<unknown> => {
      // R33: with no connection the action waits in the command queue and runs when it is back.
      return offlineOr(() => {
        if (v.action === "trash") return api.trash(v.id);
        const patch = v.action === "archive" || v.action === "inbox" ? { folder: v.action } : v.action === "star" || v.action === "unstar" ? { isStarred: v.action === "star" } : { isRead: v.action === "read" };
        return api.updateMessage(v.id, patch);
      }, { kind: "mail.action", messageId: v.id, action: v.action });
    },
    onSettled: (r) => { if (r === QUEUED) return; qc.invalidateQueries({ queryKey: ["messages"] }); qc.invalidateQueries({ queryKey: ["thread"] }); },
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
    // R27: a query the server refuses (400 bad_query) won't get better by asking again.
    retry: (n, err) => n < 2 && ![400, 401].includes((err as { status?: number }).status ?? 0),
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
    // R33: the new task shows at once with a pending tint, and goes away again if the save fails.
    create: useMutation({
      mutationFn: async (v: TaskCreate & { tempId?: string }): Promise<Task | typeof QUEUED> => {
        const { tempId: temp, ...input } = v;
        return offlineOr(() => api.createTask(input).then((r) => r.task), { kind: "task.create", tempId: temp ?? "", input });
      },
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: keys.tasks });
        const lists = qc.getQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks });
        const temp = pendingTask(v);
        v.tempId = temp.id; // the queued command carries the same temp id as the row on screen
        qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: [temp, ...d.tasks] });
        return { lists, tempId: temp.id };
      },
      onError: (_e, _v, ctx) => { ctx?.lists.forEach(([k, d]) => qc.setQueryData(k, d)); },
      onSuccess: (t, _v, ctx) => {
        if (t === QUEUED) return; // waits offline with its Saving tint
        qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: d.tasks.map((x) => (x.id === ctx?.tempId ? t : x)) });
        qc.setQueryData(keys.task(t.id), undefined);
        refresh();
      },
    }),
    fromEmail: useMutation({ mutationFn: (v: { messageId?: string; threadId?: string }) => api.taskFromEmail(v).then((r) => r.task), onSuccess: () => refresh() }),
    update: useMutation({
      mutationFn: (v: { id: string; patch: TaskPatch }): Promise<Task | typeof QUEUED> =>
        offlineOr(() => api.updateTask(v.id, v.patch).then((r) => r.task), { kind: "task.update", taskId: v.id, patch: v.patch }),
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
      onSuccess: (t) => { if (t !== QUEUED) put(t); },
      onSettled: (t, _e, v) => { if (t !== QUEUED) refresh(v.id); },
    }),
    remove: useMutation({
      mutationFn: (id: string) => offlineOr<unknown>(() => api.deleteTask(id), { kind: "task.delete", taskId: id }),
      onSuccess: (r, id) => {
        qc.setQueriesData<{ tasks: Task[] }>({ queryKey: keys.tasks }, (d) => d && { tasks: d.tasks.filter((x) => x.id !== id) });
        qc.removeQueries({ queryKey: keys.task(id) });
        if (r !== QUEUED) refresh();
      },
    }),
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

// ---------------------------------------------------------------- email addresses

/** Connected mailboxes (IMAP and SMTP), with status and last sync. Never cached on the phone. */
export function useConnections() {
  const { api } = useSession();
  return useQuery({ queryKey: keys.connections, queryFn: () => api.connections() });
}

/** The free address offer: the shared domain, a suggested name and any address already taken. */
export function useFreeAddress() {
  const { api } = useSession();
  return useQuery({ queryKey: keys.freeAddress, queryFn: () => api.freeAddress(), staleTime: 60_000 });
}

/** After an address is added or removed, the mailbox list, the inbox and both offers are stale. */
function refreshAddresses(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [keys.connections, keys.freeAddress, keys.overview, ["messages"]]) void qc.invalidateQueries({ queryKey: k });
}

export function useConnectMailbox() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: ConnectInput) => api.connect(input), onSuccess: () => refreshAddresses(qc) });
}

export function useConnectionActions() {
  const { api } = useSession();
  const qc = useQueryClient();
  const sync = useMutation({ mutationFn: (id: string) => api.syncConnection(id), onSettled: () => refreshAddresses(qc) });
  const remove = useMutation({ mutationFn: (id: string) => api.removeConnection(id), onSuccess: () => refreshAddresses(qc) });
  const reconnect = useMutation({ mutationFn: (v: { id: string; password: string }) => api.reconnect(v.id, v.password), onSuccess: () => refreshAddresses(qc) });
  return { sync, remove, reconnect };
}

/** R26: the name check while typing, 400 ms after the last key, only for names that pass the local rules. */
export function useFreeAddressCheck(localPart: string, enabled: boolean) {
  const { api } = useSession();
  const [debounced, setDebounced] = useState(localPart);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(localPart), 400);
    return () => clearTimeout(t);
  }, [localPart]);
  return useQuery({ queryKey: ["free-address-check", debounced], queryFn: () => api.checkFreeAddress(debounced), enabled: enabled && !!debounced && debounced === localPart, staleTime: 30_000, retry: false });
}

export function useClaimFreeAddress() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // No device id is sent: the server's per person, per network and daily limits still apply, and the
    // store privacy answers stay as they are (the only device id the app sends is the push token).
    mutationFn: (localPart: string) => api.claimFreeAddress(localPart),
    onSuccess: () => refreshAddresses(qc),
  });
}

/**
 * R34: every badge count from GET /api/counts, with If-None-Match. Asks on start, when the app
 * comes back to the foreground, when a push arrives (the tab layout invalidates keys.counts) and
 * every 60 s while in the foreground. Answers null on a server without the endpoint (404), so the
 * caller counts its lists instead.
 */
export function useCounts() {
  const { api, mode } = useSession();
  const foreground = useForeground();
  // One client (ETag and last answer) per session transport; switching live and sample starts fresh.
  const client = useMemo(() => countsClient((opts) => api.counts(opts)), [api]);
  const q = useQuery<Counts | null>({
    queryKey: [...keys.counts, mode],
    queryFn: () => client.get(),
    refetchInterval: foreground ? COUNTS_POLL_MS : false,
    retry: 1,
  });
  const { refetch } = q;
  useEffect(() => { if (foreground) refetch().catch(() => {}); }, [foreground, refetch]);
  return q;
}

// ---------------------------------------------------------------- R35: report and block

export interface BlocksState { blocks: BlockedPerson[]; /** The server has no blocks endpoint yet (404): menus still show, nothing is hidden. */ missing: boolean }

/**
 * The people you blocked: asked on start and whenever the app comes back to the foreground, saved
 * on the phone for offline use. A server without the endpoint answers an empty list, silently.
 */
export function useBlocks() {
  const { api, mode } = useSession();
  const foreground = useForeground();
  const q = useQuery<BlocksState>({
    queryKey: [...keys.blocks, mode],
    queryFn: async () => {
      try {
        const r = await cached(kv(), `meta:${mode}:blocks`, () => api.blocks());
        return { blocks: r.blocks ?? [], missing: false };
      } catch (err) {
        if (isMissingEndpoint(err)) return { blocks: [], missing: true };
        throw err;
      }
    },
    staleTime: 60_000,
    retry: 1,
  });
  const { refetch } = q;
  useEffect(() => { if (foreground) refetch().catch(() => {}); }, [foreground, refetch]);
  return q;
}

/** The blocked people's ids as a set, for filtering message lists. Empty until the list loads. */
export function useBlockedSet(): Set<string> {
  const q = useBlocks();
  return useMemo(() => blockedIds(q.data?.blocks), [q.data]);
}

/** Blocks a person: the list updates at once (their messages vanish), then the server confirms. */
export function useBlockPerson() {
  const { api, mode } = useSession();
  const qc = useQueryClient();
  const key = [...keys.blocks, mode];
  return useMutation({
    mutationFn: async (p: { userId: string; name: string }) => { await api.block(p.userId); return p; },
    onMutate: (p) => {
      warning();
      animateList();
      const prev = qc.getQueryData<BlocksState>(key);
      qc.setQueryData<BlocksState>(key, { blocks: withBlock(prev?.blocks ?? [], p), missing: prev?.missing ?? false });
      return { prev };
    },
    onError: (err, _p, ctx) => {
      // A server without the endpoint keeps the block on this phone only, so the person still stops seeing them.
      if (isMissingEndpoint(err)) return;
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: (_r, err) => {
      if (!isMissingEndpoint(err)) qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: keys.counts });
    },
  });
}

export function useUnblockPerson() {
  const { api, mode } = useSession();
  const qc = useQueryClient();
  const key = [...keys.blocks, mode];
  return useMutation({
    // R35: the server answers 404 when there was no block to remove (it keeps other workspaces from being probed); that is the state we wanted.
    mutationFn: async (userId: string) => {
      try { await api.unblock(userId); } catch (e) { if (!isUnblockDone(e)) throw e; }
      return userId;
    },
    onMutate: (userId) => {
      animateList();
      const prev = qc.getQueryData<BlocksState>(key);
      qc.setQueryData<BlocksState>(key, { blocks: withoutBlock(prev?.blocks ?? [], userId), missing: prev?.missing ?? false });
      return { prev };
    },
    onError: (err, _id, ctx) => { if (!isMissingEndpoint(err) && ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSettled: (_r, err) => { if (!isMissingEndpoint(err)) qc.invalidateQueries({ queryKey: key }); },
  });
}

/** Sends a report. Success plays the success haptic; the sheet shows the thanks line. */
export function useReport() {
  const { api } = useSession();
  return useMutation({
    mutationFn: (input: ReportInput) => api.report(reportBody(input)),
    onSuccess: () => success(),
  });
}
