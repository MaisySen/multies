import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { taskStore, type Task } from "./tasks";
import type { Approval, ListFolder, MessagePage, SendInput } from "@/api/types";

export const keys = {
  overview: ["overview"] as const,
  agents: ["agents"] as const,
  messages: (folder: ListFolder, mailboxId?: string) => ["messages", folder, mailboxId ?? "all"] as const,
  search: (q: string) => ["search", q] as const,
  thread: (id: string) => ["thread", id] as const,
  approvals: (status: Approval["status"] | "all") => ["approvals", status] as const,
  tasks: ["tasks"] as const,
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

export function useTasks() {
  return useQuery({ queryKey: keys.tasks, queryFn: () => taskStore(kv()).list() });
}

export function useTaskMutations() {
  const qc = useQueryClient();
  const store = taskStore(kv());
  const done = () => qc.invalidateQueries({ queryKey: keys.tasks });
  return {
    create: useMutation({ mutationFn: (v: Parameters<typeof store.create>[0]) => store.create(v), onSuccess: done }),
    update: useMutation({ mutationFn: (v: { id: string; patch: Partial<Task> }) => store.update(v.id, v.patch), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => store.remove(id), onSuccess: done }),
  };
}
