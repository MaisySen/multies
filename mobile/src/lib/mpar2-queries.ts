/** MPAR2: React Query hooks for the account, plan and billing (read only) and Get started screens. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import type { BillingView, ToursMe } from "./mpar2";

export const mpar2Keys = { billing: ["billing"] as const, tours: ["tours", "me"] as const, me: ["me"] as const };
const retry = (k: number, e: unknown) => {
  const s = (e as { status?: number } | null)?.status;
  return !(s && s >= 400 && s < 500) && k < 2;
};

/** GET /api/billing: the plan, the subscription state and usage. Read only; nothing here can change the plan. */
export function useBilling() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar2Keys.billing, mode], retry, networkMode: "always", queryFn: () => transport.request<BillingView>("GET", "/billing") });
}

/** GET /api/tours/me: the Get started checklist (404 where the workspace has it switched off: reads as off). */
export function useToursMe() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar2Keys.tours, mode], retry, networkMode: "always", staleTime: 60_000,
    queryFn: async () => {
      try { return await transport.request<ToursMe>("GET", "/tours/me"); }
      catch (e) { if ((e as { status?: number }).status === 404) return { enabled: false, checklist: null } as ToursMe; throw e; }
    } });
}

export function useChecklistAction() {
  const { transport, mode } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: { action: "mark" | "dismiss" | "resume" | "celebrated"; step?: string }) => transport.request<ToursMe>("POST", "/tours/checklist", b),
    onSuccess: (r) => { qc.setQueryData([...mpar2Keys.tours, mode], r); },
  });
}

/** The person's name (Better Auth update-user). The session's own copy refreshes after. */
export function useUpdateName() {
  const qc = useQueryClient();
  const { transport, refreshMe } = useSession();
  return useMutation({
    mutationFn: (name: string) => transport.request<unknown>("POST", "/auth/update-user", { name }),
    onSuccess: async () => { try { await refreshMe(); } catch { /* the next start reads it */ } qc.invalidateQueries({ queryKey: mpar2Keys.me }); },
  });
}

/** Changes the password through the web's own flow (Better Auth change-password); other devices are signed out. */
export function useChangePassword() {
  const { transport } = useSession();
  return useMutation({
    mutationFn: (p: { currentPassword: string; newPassword: string }) =>
      transport.request<unknown>("POST", "/auth/change-password", { ...p, revokeOtherSessions: true }),
  });
}

/** Saves the language or time zone on the web account too (PATCH /api/account/preferences). */
export function useSavePreferences() {
  const { transport } = useSession();
  return useMutation({ mutationFn: (p: { locale?: string; timezone?: string }) => transport.request<{ ok: true }>("PATCH", "/account/preferences", p) });
}

/** The fuller GET /api/account/me (has the password flag, time zone and language). */
export function useMeFull() {
  const { transport, mode } = useSession();
  return useQuery({ queryKey: [...mpar2Keys.me, mode], retry, networkMode: "always",
    queryFn: () => transport.request<{ user: { id: string; email: string; name: string; timezone?: string | null; locale?: string | null }; hasPassword?: boolean; organization: { name: string; role: string; plan: string } | null }>("GET", "/account/me") });
}
