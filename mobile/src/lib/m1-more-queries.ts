/**
 * M1 (1.10.9): React Query hooks for Mail merge status, Mail archive and Calendar and contacts sync. Nothing is kept on
 * the phone: these answer from the server each time a screen opens.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session";
import type { JourneyView, JourneysResponse, ListsResponse, NewsletterView, NewslettersResponse } from "./mail-merge";
import type { ArchiveSearchResponse, CasesResponse, HoldsResponse, PolicyResponse } from "./mail-archive";
import type { AppPasswordList, CreatedAppPassword } from "./dav-sync";
import { noAccess, notFoundErr } from "./contacts-queries";

const retry = (k: number, e: unknown) => !noAccess(e) && !notFoundErr(e) && k < 2;

export const moreKeys = {
  newsletters: ["merge", "newsletters"] as const,
  newsletter: (id: string) => ["merge", "newsletter", id] as const,
  lists: ["merge", "lists"] as const,
  journeys: ["merge", "journeys"] as const,
  journey: (id: string) => ["merge", "journey", id] as const,
  policy: ["archive", "policy"] as const,
  holds: ["archive", "holds"] as const,
  cases: ["archive", "cases"] as const,
  dav: ["dav", "passwords"] as const,
};

const M = "/tools/campaigns";

export function useNewsletters(enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.newsletters, enabled, retry, queryFn: () => transport.request<NewslettersResponse>("GET", `${M}/newsletters`) });
}
export function useNewsletter(id: string | undefined) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.newsletter(id ?? ""), enabled: !!id, retry, queryFn: () => transport.request<NewsletterView>("GET", `${M}/newsletters/${encodeURIComponent(id!)}`) });
}
export function useMergeLists(enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.lists, enabled, retry, queryFn: () => transport.request<ListsResponse>("GET", `${M}/lists`) });
}
export function useJourneys(enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.journeys, enabled, retry, queryFn: () => transport.request<JourneysResponse>("GET", `${M}/journeys`) });
}
export function useJourney(id: string | undefined) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.journey(id ?? ""), enabled: !!id, retry, queryFn: () => transport.request<JourneyView>("GET", `${M}/journeys/${encodeURIComponent(id!)}`) });
}

export type NewsletterAction = "pause" | "resume" | "test";
export function useNewsletterAction(id: string) {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: NewsletterAction) => transport.request<NewsletterView | { to: string }>("POST", `${M}/newsletters/${encodeURIComponent(id)}/${a}`, {}),
    onSuccess: (r, a) => {
      if (a !== "test") { qc.setQueryData(moreKeys.newsletter(id), r); qc.invalidateQueries({ queryKey: moreKeys.newsletters }); }
    },
  });
}
export function useJourneyAction(id: string) {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: "pause" | "start") => transport.request<JourneyView>("POST", `${M}/journeys/${encodeURIComponent(id)}/${a}`, {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: moreKeys.journey(id) }); qc.invalidateQueries({ queryKey: moreKeys.journeys }); },
  });
}

export function useArchivePolicy() {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.policy, retry, queryFn: () => transport.request<PolicyResponse>("GET", "/mail-archive/policy") });
}
export function useArchiveHolds(enabled: boolean) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.holds, enabled, retry, queryFn: () => transport.request<HoldsResponse>("GET", "/mail-archive/holds") });
}
export function useArchiveCases(enabled: boolean) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.cases, enabled, retry, queryFn: () => transport.request<CasesResponse>("GET", "/mail-archive/cases") });
}
export function useArchiveSearch() {
  const { transport } = useSession();
  return useMutation({
    mutationFn: (v: { q: string; cursor?: string }) =>
      transport.request<ArchiveSearchResponse>("POST", "/mail-archive/search", { filters: v.q ? { q: v.q } : {}, ...(v.cursor ? { cursor: v.cursor } : {}) }),
  });
}

export function useAppPasswords(enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: moreKeys.dav, enabled, retry, queryFn: () => transport.request<AppPasswordList>("GET", "/dav/passwords") });
}
export function useCreateAppPassword() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => transport.request<CreatedAppPassword>("POST", "/dav/passwords", { name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: moreKeys.dav }),
  });
}
export function useRevokeAppPassword() {
  const { transport } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => transport.request<{ id: string; revoked: true }>("DELETE", `/dav/passwords/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: moreKeys.dav }),
  });
}
