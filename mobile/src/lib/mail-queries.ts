import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { keys } from "./queries";
import type { ListFolder, MessagePage } from "@/api/types";
import type { RuleInput } from "./mail-rules";

/** 1.10.7: the queries behind Inbox tabs, labels, Snoozed and Mail rules. */
export const mailKeys = {
  tabs: (mailboxId?: string) => ["mail-tabs", mailboxId ?? "all"] as const,
  tabSettings: ["mail-tabs", "settings"] as const,
  labels: ["mail-labels"] as const,
  snoozed: (view: "snoozed" | "returned", mailboxId?: string) => ["mail-snoozed", view, mailboxId ?? "all"] as const,
  rules: ["mail-rules"] as const,
  rule: (id: string) => ["mail-rules", "one", id] as const,
  runs: (id: string) => ["mail-rules", "runs", id] as const,
};

/** The Inbox tabs with unread counts. Offline it shows the last tabs it saw. */
export function useInboxTabs(mailboxId?: string, enabled = true) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: mailKeys.tabs(mailboxId),
    queryFn: () => cached(kv(), `tabs:${mode}:${mailboxId ?? "all"}`, () => api.inboxTabs(mailboxId)),
    enabled, refetchInterval: 60_000, staleTime: 20_000,
  });
}

/** A mail list with an Inbox tab or a label (the plain folders keep useMessages). */
export function useMessageList(folder: ListFolder, mailboxId: string | undefined, opts: { split?: string; label?: string; remote?: string }, enabled = true) {
  const { api, mode } = useSession();
  return useInfiniteQuery({
    queryKey: [...keys.messages(folder, mailboxId), opts.split ?? "", opts.label ?? "", opts.remote ?? ""] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      // MPAR3: a connected mailbox's own folder is read with ?remote= (never kept on the phone).
      const run = () => api.messages({ folder, mailboxId, cursor: pageParam, split: opts.split, label: opts.label, remote: opts.remote });
      return pageParam || opts.label || opts.remote ? run() : cached<MessagePage>(kv(), `list:${mode}:${folder}:${mailboxId ?? "all"}:${opts.split ?? ""}`, run);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 60_000,
    enabled,
  });
}

export function useSnoozed(view: "snoozed" | "returned", mailboxId?: string, enabled = true) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: mailKeys.snoozed(view, mailboxId),
    queryFn: () => cached(kv(), `snoozed:${mode}:${view}:${mailboxId ?? "all"}`, () => api.snoozed(view, mailboxId)),
    select: (d) => d.items.filter((i) => i.message),
    enabled, refetchInterval: 60_000,
  });
}

export function useLabels(enabled = true) {
  const { api } = useSession();
  return useQuery({ queryKey: mailKeys.labels, queryFn: () => api.labels(), select: (d) => d.labels, enabled, staleTime: 60_000 });
}

export function useTabSettings() {
  const { api } = useSession();
  return useQuery({ queryKey: mailKeys.tabSettings, queryFn: () => api.tabSettings() });
}

export function useMailRules() {
  const { api, mode } = useSession();
  return useQuery({ queryKey: mailKeys.rules, queryFn: () => cached(kv(), `rules:${mode}`, () => api.mailRules()), select: (d) => d.rules });
}

export function useMailRule(id: string) {
  const { api } = useSession();
  return useQuery({ queryKey: mailKeys.rule(id), queryFn: () => api.mailRule(id), select: (d) => d.rule, enabled: !!id && id !== "new" });
}

export function useMailRuleRuns(id: string) {
  const { api } = useSession();
  return useQuery({ queryKey: mailKeys.runs(id), queryFn: () => api.mailRuleRuns(id), select: (d) => d.runs, enabled: !!id && id !== "new" });
}

/** Everything that changes mail lists, tabs and counts afterwards. */
function useRefreshMail() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["messages"] });
    qc.invalidateQueries({ queryKey: ["mail-tabs"] });
    qc.invalidateQueries({ queryKey: ["mail-snoozed"] });
    qc.invalidateQueries({ queryKey: ["mail-labels"] });
    qc.invalidateQueries({ queryKey: keys.overview });
  };
}

export function useMailMutations() {
  const { api } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshMail();
  return {
    setStyle: useMutation({ mutationFn: (style: Parameters<typeof api.setTabStyle>[0]) => api.setTabStyle(style), onSettled: refresh }),
    teach: useMutation({ mutationFn: (v: { messageId: string; tab: string; sender: boolean }) => api.teachTab(v.messageId, v.tab, v.sender), onSettled: refresh }),
    restore: useMutation({ mutationFn: (v: Parameters<typeof api.restorePins>[0]) => api.restorePins(v), onSettled: refresh }),
    addLabel: useMutation({ mutationFn: (v: { threadId: string; label: string }) => api.addLabel(v.threadId, v.label), onSettled: refresh }),
    removeLabel: useMutation({ mutationFn: (v: { threadId: string; label: string }) => api.removeLabel(v.threadId, v.label), onSettled: refresh }),
    unsnooze: useMutation({ mutationFn: (scheduleId: string) => api.unsnooze(scheduleId), onSettled: refresh }),
    createRule: useMutation({ mutationFn: (input: RuleInput) => api.createMailRule(input), onSettled: () => qc.invalidateQueries({ queryKey: mailKeys.rules }) }),
    updateRule: useMutation({
      mutationFn: (v: { id: string; patch: Partial<RuleInput> }) => api.updateMailRule(v.id, v.patch),
      // A switch flips at once; a failure puts it back.
      onMutate: async (v) => {
        await qc.cancelQueries({ queryKey: mailKeys.rules });
        const prev = qc.getQueryData<{ rules: { id: string }[] }>(mailKeys.rules);
        if (prev && v.patch.enabled !== undefined) qc.setQueryData(mailKeys.rules, { rules: prev.rules.map((r) => (r.id === v.id ? { ...r, enabled: v.patch.enabled } : r)) });
        return { prev };
      },
      onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(mailKeys.rules, ctx.prev); },
      onSettled: (_r, _e, v) => { qc.invalidateQueries({ queryKey: mailKeys.rules }); qc.invalidateQueries({ queryKey: mailKeys.rule(v.id) }); },
    }),
    deleteRule: useMutation({ mutationFn: (id: string) => api.deleteMailRule(id), onSettled: () => qc.invalidateQueries({ queryKey: mailKeys.rules }) }),
    testRule: useMutation({ mutationFn: (v: Parameters<typeof api.testMailRule>[0]) => api.testMailRule(v) }),
    runRecent: useMutation({
      mutationFn: (id: string) => api.runMailRuleRecent(id),
      onSettled: (_r, _e, id) => { refresh(); qc.invalidateQueries({ queryKey: mailKeys.runs(id) }); qc.invalidateQueries({ queryKey: mailKeys.rules }); },
    }),
  };
}
