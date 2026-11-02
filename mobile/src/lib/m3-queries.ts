/**
 * M3 (1.10.11): React Query hooks for Goals, Forms, Time and Automations. Answers come from the server each time.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import { noAccess, notFoundErr } from "./contacts-queries";
import type { TimeEntry } from "@/api/types";
import { weekStart, type AutomationsResponse, type FormResponses, type FormsResponse, type GoalsResponse } from "./m3";

const retry = (k: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && k < 2;
export const m3Keys = { goals: ["goals"] as const, forms: ["forms"] as const, time: ["time", "week"] as const, automations: ["automations"] as const };

export function useGoals() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m3Keys.goals, mode], retry, networkMode: "always", queryFn: () => transport.request<GoalsResponse>("GET", "/goals") });
}
export function useForms() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m3Keys.forms, mode], retry, networkMode: "always", queryFn: () => transport.request<FormsResponse>("GET", "/forms") });
}
export function useFormResponses(id: string | undefined) {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m3Keys.forms, mode, "responses", id ?? ""], enabled: !!id, retry, networkMode: "always",
    queryFn: () => transport.request<FormResponses>("GET", `/forms/${encodeURIComponent(id!)}/responses?limit=50`) });
}
export function useWeekTime() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m3Keys.time, mode], retry, networkMode: "always",
    queryFn: () => transport.request<{ entries: TimeEntry[] }>("GET", `/time?from=${encodeURIComponent(weekStart(Date.now()))}`) });
}
export function useAutomations() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...m3Keys.automations, mode], retry, networkMode: "always", queryFn: () => transport.request<AutomationsResponse>("GET", "/automations") });
}
/** Turns an automation on or off (admins). The switch moves at once and moves back if the server says no. */
export function useToggleAutomation() {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  const key = [...m3Keys.automations, mode];
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => transport.request("PATCH", `/automations/${encodeURIComponent(id)}`, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<AutomationsResponse>(key);
      qc.setQueryData<AutomationsResponse>(key, (o) => (o ? { ...o, automations: o.automations.map((a) => (a.id === id ? { ...a, enabled } : a)) } : o));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: m3Keys.automations }); },
  });
}
