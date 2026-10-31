import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { useSession } from "./session";
import { isMissingEndpoint } from "./moderation";
import { API_BASE, WEB_PAGES } from "@/config";
import type { NewSocialPost, SocialPostView } from "./social";

/** 1.10.5: social posts and accounts on the phone. Never cached on the phone: they change on the server. */
export const socialKeys = {
  posts: ["social", "posts"] as const,
  accounts: ["social", "accounts"] as const,
  status: ["social", "status"] as const,
  direct: ["social", "direct"] as const,
  health: ["social", "health"] as const,
  targets: (id: string) => ["social", "targets", id] as const,
};

/** Polls while anything is still on its way, so a post set for now turns Posted or Not posted on its own. */
export function useSocialPosts() {
  const { api } = useSession();
  return useQuery({
    queryKey: socialKeys.posts,
    queryFn: () => api.socialPosts(),
    select: (d) => d.posts,
    refetchInterval: (q) => ((q.state.data?.posts ?? []).some((p: SocialPostView) => p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= Date.now() + 60_000)) ? 4000 : false),
  });
}

export function useSocialStatus() {
  const { api } = useSession();
  return useQuery({ queryKey: socialKeys.status, queryFn: () => api.appsStatus(), staleTime: 60_000, retry: (n, e) => !isMissingEndpoint(e) && n < 2 });
}

export function useSocialAccounts(enabled = true) {
  const { api } = useSession();
  return useQuery({ queryKey: socialKeys.accounts, queryFn: () => api.appAccounts(), select: (d) => d.accounts, enabled, retry: (n, e) => !isMissingEndpoint(e) && n < 2 });
}

/** TikTok and Threads (own sign in). Older servers answer 404: then there is nothing to show. */
export function useDirectStatus() {
  const { api } = useSession();
  return useQuery({
    queryKey: socialKeys.direct,
    queryFn: async () => { try { return await api.directStatus(); } catch (e) { if (isMissingEndpoint(e)) return { canManage: false, accounts: [] }; throw e; } },
    staleTime: 30_000,
  });
}

/** Account checks before writing, where the server has them. A missing route or a failed check means "no checks". */
export function useSocialHealth(enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: socialKeys.health,
    queryFn: async () => { try { return (await api.socialHealth()).accounts; } catch { return []; } },
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSocialTargets(accountId: string | null) {
  const { api } = useSession();
  return useQuery({ queryKey: socialKeys.targets(accountId ?? ""), queryFn: () => api.appTargets(accountId!), select: (d) => d.targets, enabled: !!accountId, staleTime: 5 * 60_000 });
}

function refreshSocial(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [socialKeys.posts, socialKeys.accounts, socialKeys.direct, socialKeys.health]) void qc.invalidateQueries({ queryKey: k });
}

/** Where a network sends the browser back after a sign in. Seeing it closes the in-app browser. */
export const APPS_RETURN = `${API_BASE}/app/settings/apps`;

/** Opens a sign in page in the in-app browser and waits until it closes or comes back to Multies. */
async function signInInBrowser(url: string) {
  try { await WebBrowser.openAuthSessionAsync(url, APPS_RETURN); }
  catch { await WebBrowser.openBrowserAsync(url); }
}

export function useSocialActions() {
  const { api } = useSession();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (v: { input: NewSocialPost; key: string }) => api.createSocialPost(v.input, v.key),
    onSuccess: () => refreshSocial(qc),
  });
  const retry = useMutation({ mutationFn: (id: string) => api.retrySocialPost(id), onSettled: () => refreshSocial(qc) });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelSocialPost(id), onSettled: () => refreshSocial(qc) });
  /** Connect a network through the platform sign in: browser, then confirm the new account here. */
  const connect = useMutation({
    mutationFn: async (app: string) => {
      const r = await api.connectApp(app);
      await signInInBrowser(r.redirectUrl);
      try { return (await api.confirmApp(r.accountId)).account; } catch { return null; }
    },
    onSettled: () => refreshSocial(qc),
  });
  /** Reconnect an account whose sign in expired or lost a permission, then check it again. */
  const reconnect = useMutation({
    mutationFn: async (accountId: string) => {
      const r = await api.reconnectApp(accountId);
      await signInInBrowser(r.redirectUrl);
      try { return (await api.confirmApp(accountId)).account; } catch { return null; }
    },
    onSettled: () => refreshSocial(qc),
  });
  return { create, retry, cancel, connect, reconnect };
}

/** TikTok and Threads sign in runs on multies.si itself (it needs the web session), so it opens the web page. */
export async function openWebSocialAccounts() {
  await WebBrowser.openBrowserAsync(WEB_PAGES.socialAccounts);
}
