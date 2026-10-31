import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { clearMeCache, isSignedOut, meRetry, meRetryDelay, readMeCache, writeMeCache } from "./me-cache";
import type { Alias, Dashboard, Domain, Mailbox, Me, OrgInfo, PublicConfig, TeamInfo, Workspace } from "./types";

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
  refetchInterval: (query) => (query.state.status === "error" && !isSignedOut(query.state.error) ? 15_000 : false),
});
export const useConfig = () => useQuery({ queryKey: qk.config, queryFn: () => api.get<PublicConfig>("/config"), staleTime: Infinity });
export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>("/dashboard") });
export const useDomains = () => useQuery({ queryKey: qk.domains, queryFn: async () => (await api.get<{ domains: Domain[] }>("/domains")).domains });
export const useDomain = (id: string) => useQuery({ queryKey: qk.domain(id), queryFn: async () => (await api.get<{ domain: Domain }>(`/domains/${id}`)).domain });
export const useMailboxes = () => useQuery({ queryKey: qk.mailboxes, queryFn: async () => (await api.get<{ mailboxes: Mailbox[] }>("/mailboxes")).mailboxes });
export const useAliases = () => useQuery({ queryKey: qk.aliases, queryFn: async () => (await api.get<{ aliases: Alias[] }>("/aliases")).aliases });
export const useOrg = () => useQuery({ queryKey: qk.org, queryFn: () => api.get<OrgInfo>("/org") });
export const useTeam = () => useQuery({ queryKey: qk.team, queryFn: () => api.get<TeamInfo>("/team") });
export const useWorkspaces = () => useQuery({ queryKey: qk.workspaces, queryFn: () => api.get<{ workspaces: Workspace[]; currentId: string }>("/account/workspaces") });
