import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Alias, Dashboard, Domain, Mailbox, Me, OrgInfo, PublicConfig } from "./types";

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
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api.get<Me>("/auth/me"), retry: false, staleTime: 60_000 });
export const useConfig = () => useQuery({ queryKey: qk.config, queryFn: () => api.get<PublicConfig>("/config"), staleTime: Infinity });
export const useDashboard = () => useQuery({ queryKey: qk.dashboard, queryFn: () => api.get<Dashboard>("/dashboard") });
export const useDomains = () => useQuery({ queryKey: qk.domains, queryFn: async () => (await api.get<{ domains: Domain[] }>("/domains")).domains });
export const useDomain = (id: string) => useQuery({ queryKey: qk.domain(id), queryFn: async () => (await api.get<{ domain: Domain }>(`/domains/${id}`)).domain });
export const useMailboxes = () => useQuery({ queryKey: qk.mailboxes, queryFn: async () => (await api.get<{ mailboxes: Mailbox[] }>("/mailboxes")).mailboxes });
export const useAliases = () => useQuery({ queryKey: qk.aliases, queryFn: async () => (await api.get<{ aliases: Alias[] }>("/aliases")).aliases });
export const useOrg = () => useQuery({ queryKey: qk.org, queryFn: () => api.get<OrgInfo>("/org") });
