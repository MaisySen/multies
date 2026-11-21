import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { api } from "./api";
import { clearMeCache, isSignedOut, meRetry, meRetryDelay, readMeCache, writeMeCache } from "./me-cache";
import type { Alias, Dashboard, Domain, Mailbox, MailboxOverview, Me, OrgInfo, PublicConfig, TeamInfo, Workspace } from "./types";
import { openableOnly } from "./mail-level-priv1b";

export const qk = {
  me: ["me"] as const,
  config: ["config"] as const,
  dashboard: ["dashboard"] as const,
  domains: ["domains"] as const,
  domain: (id: string) => ["domains", id] as const,
  mailboxes: ["mailboxes"] as const,
  aliases: ["aliases"] as const,
  org: ["org"] as const,
  overview: ["mail", "overview"] as const,
  team: ["team"] as const,
  workspaces: ["workspaces"] as const,
};

/**
 * Whether a session exists, without a 401 for signed-out visitors (public pages use
 * this; Better Auth answers get-session with null when nobody is signed in).
 */
export const useSession = () => useQuery({
  queryKey: ["session"],
  queryFn: async () => {
    const res = await fetch("/api/auth/get-session", { credentials: "same-origin" });
    return res.ok ? ((await res.json()) as { user?: { email?: string } } | null) : null;
  },
  retry: false,
  staleTime: 60_000,
});
export const useSignedIn = () => !!useSession().data?.user;

/** OPS1 announcements: how often an open, visible session reads /me again (announcements, flags). */
export const ME_POLL_MS = 5 * 60_000;
/**
 * R40 (MB-200): the account check retries with backoff on a dropped request or an empty 5xx, starts from the
 * last good copy (so the shell paints at once and refreshes behind it), and keeps polling calmly while
 * Multies is unreachable. Only a 401 means signed out; it also drops the saved copy.
 */
export const useMe = () => useQuery({
  queryKey: qk.me,
  queryFn: async () => {
    try {
      const me = await api.get<Me>("/account/me");
      writeMeCache(me);
      return me;
    } catch (err) {
      if (isSignedOut(err)) clearMeCache();
      throw err;
    }
  },
  initialData: readMeCache,
  initialDataUpdatedAt: 0,
  retry: meRetry,
  retryDelay: meRetryDelay,
  staleTime: 60_000,
  // OPS1 announcements: a healthy session reads /me again every 5 minutes while the tab is visible (TanStack pauses it
  // in the background; a refocus refetches once it is a minute old), so an announcement shows in open sessions.
  refetchInterval: (query) => (query.state.status === "error" ? (isSignedOut(query.state.error) ? false : 15_000) : query.state.status === "success" ? ME_POLL_MS : false),
});
/**
 * OPS1 feature flags: the workspace's flag differences from a fetched /account/me (an operator's workspace override),
 * read from the query cache without starting a request, so signed out pages (no /me) are untouched. A copy painted
 * from the saved me (initialData, updatedAt 0) is not used: it can belong to another workspace or be old.
 */
export function meFlagsFrom(qc: QueryClient): Record<string, boolean> | undefined {
  const state = qc.getQueryState<Me>(qk.me);
  if (!state?.dataUpdatedAt || !state.data) return undefined;
  const flags = state.data.flags;
  return flags && Object.keys(flags).length ? flags : undefined;
}

/** The public config with the workspace's flag differences on top (the same object when there are none). */
export function mergeConfigFlags(config: PublicConfig | undefined, flags: Record<string, boolean> | undefined): PublicConfig | undefined {
  if (!config || !flags) return config;
  return { ...config, ...flags } as PublicConfig;
}

function useMeFlags(): Record<string, boolean> | undefined {
  const qc = useQueryClient();
  return useSyncExternalStore(
    (onChange) => qc.getQueryCache().subscribe((e) => { if (e.query.queryHash === ME_HASH) onChange(); }),
    () => meFlagsFrom(qc),
    () => undefined,
  );
}
const ME_HASH = JSON.stringify(qk.me);

/**
 * The public config (fetched once). OPS1: merged with /account/me's `flags` for signed in people, so every call site
 * sees its workspace's value. A workspace switch clears the query cache (layouts/app.tsx), so /me, and with it the
 * merge, is evaluated again for the new workspace.
 */
export const useConfig = () => {
  const query = useQuery({ queryKey: qk.config, queryFn: () => api.get<PublicConfig>("/config"), staleTime: Infinity });
  const flags = useMeFlags();
  const data = useMemo(() => mergeConfigFlags(query.data, flags), [query.data, flags]);
  return data === query.data ? query : ({ ...query, data } as typeof query);
};
export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>("/dashboard") });
export const useDomains = () => useQuery({ queryKey: qk.domains, queryFn: async () => (await api.get<{ domains: Domain[] }>("/domains")).domains });
export const useDomain = (id: string) => useQuery({ queryKey: qk.domain(id), queryFn: async () => (await api.get<{ domain: Domain }>(`/domains/${id}`)).domain });
export const useMailboxes = () => useQuery({ queryKey: qk.mailboxes, queryFn: async () => (await api.get<{ mailboxes: Mailbox[] }>("/mailboxes")).mailboxes });
const openRows = (l: Mailbox[]) => openableOnly(l);
/** PRIV1b (WC5): the same list, only rows this person can open (an admin also sees others' private mailboxes as rows). For pickers. */
export const useOpenableMailboxes = () => useQuery({ queryKey: qk.mailboxes, queryFn: async () => (await api.get<{ mailboxes: Mailbox[] }>("/mailboxes")).mailboxes, select: openRows });
/** PRIV1b (WC3): the mailboxes this person can open with their level in each (shared with Mail and the shared inbox). */
export const useMailOverview = () => useQuery({ queryKey: qk.overview, queryFn: async () => (await api.get<{ mailboxes: MailboxOverview[] }>("/mail/overview")).mailboxes });
export const useAliases = () => useQuery({ queryKey: qk.aliases, queryFn: async () => (await api.get<{ aliases: Alias[] }>("/aliases")).aliases });
export const useOrg = () => useQuery({ queryKey: qk.org, queryFn: () => api.get<OrgInfo>("/org") });
export const useTeam = () => useQuery({ queryKey: qk.team, queryFn: () => api.get<TeamInfo>("/team") });
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: () => api.get<{ workspaces: Workspace[]; currentId: string }>("/account/workspaces") });
