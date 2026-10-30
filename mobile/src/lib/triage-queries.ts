import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { cached } from "./offline";
import { kv } from "./kv";
import { keys } from "./queries";
import { runKeys } from "./run-queries";
import { patchPage, type TriageChange, type TriageView } from "./triage";
import { snoozeUntil, type SnoozePreset } from "./snooze";
import type { NotificationPage } from "@/api/types";

/** R31: the notifications inbox by view (Inbox, Later, Done). Lives under keys.notifications so read marks refresh it. */
export const triageKeys = {
  view: (view: TriageView) => ["notifications", "triage", view] as const,
};

export function useTriage(view: TriageView) {
  const { api, mode } = useSession();
  return useQuery({
    queryKey: triageKeys.view(view),
    queryFn: () => cached(kv(), `meta:${mode}:triage:${view}`, () => api.notifications({ view, limit: 50 })),
  });
}

export type TriageAction = { id: string; action: "done" } | { id: string; action: "undone" } | { id: string; action: "snooze"; preset: SnoozePreset };

/** Done, back to Inbox and snooze, shown at once and put back if the server says no. */
export function useTriageAction() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: TriageAction) =>
      v.action === "done" ? api.notificationDone(v.id) : v.action === "undone" ? api.notificationUndone(v.id) : api.notificationSnooze(v.id, { preset: v.preset }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["notifications", "triage"] });
      const before = qc.getQueriesData<NotificationPage>({ queryKey: ["notifications", "triage"] });
      const change: TriageChange = v.action === "snooze" ? { action: "snooze", until: snoozeUntil(v.preset).toISOString() } : { action: v.action };
      for (const [key, page] of before) if (page) qc.setQueryData(key, patchPage(page, [v.id], change));
      return { before };
    },
    onError: (_e, _v, ctx) => { ctx?.before.forEach(([k, d]) => qc.setQueryData(k, d)); },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

/** R31: snooze a mail conversation with a preset. The list refreshes after. */
export function useMailSnooze() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; preset: SnoozePreset }) => api.snoozeMessage(v.id, v.preset),
    onSettled: () => { qc.invalidateQueries({ queryKey: ["messages"] }); qc.invalidateQueries({ queryKey: keys.overview }); },
  });
}

/** R31: cancel a queued or running agent run. */
export function useCancelRun() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelRun(id),
    onSettled: (_r, _e, id) => { qc.invalidateQueries({ queryKey: runKeys.one(id) }); qc.invalidateQueries({ queryKey: ["runs"] }); qc.invalidateQueries({ queryKey: ["task"] }); },
  });
}
