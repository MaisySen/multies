import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { useSession } from "./session";
import { isMissingEndpoint } from "./moderation";
import { API_BASE, WEB_PAGES } from "@/config";
import { mergePosts, stillSending, syncIds, type NewSocialPost, type SocialPostView } from "./social";

/** 1.10.5: social posts and accounts on the phone. Never cached on the phone: they change on the server. */
export const socialKeys = {
  posts: ["social", "posts"] as const,
  accounts: ["social", "accounts"] as const,
  status: ["social", "status"] as const,
  direct: ["social", "direct"] as const,
  health: ["social", "health"] as const,
  targets: (id: string) => ["social", "targets", id] as const,
  post: (id: string) => ["social", "post", id] as const,
};

/** Polls while anything is still on its way, so a post set for now turns Posted or Not posted on its own. */
export function useSocialPosts(enabled = true) {
  const { api } = useSession();
  return useQuery({
    queryKey: socialKeys.posts,
    enabled,
    queryFn: () => api.socialPosts(),
    select: (d) => d.posts,
    refetchInterval: (q) => ((q.state.data?.posts ?? []).some((p: SocialPostView) => p.status === "sending" || (p.status === "scheduled" && Date.parse(p.runAt) <= Date.now() + 60_000)) ? 4000 : false),
  });
}

/**
 * 1.10.6: one post, read on its own. While a post set for now is still going out it is read again every 1.5
 * seconds, so the screen after Post now follows each network to its tick (the server sends right after it answers).
 * The list's copy shows at once while the read runs.
 */
export function useSocialPost(id: string | null | undefined, opts: { follow?: boolean } = {}) {
  const { api } = useSession();
  const qc = useQueryClient();
  return useQuery({
    queryKey: socialKeys.post(id ?? ""),
    enabled: !!id,
    queryFn: async () => {
      const post = (await api.socialPost(id!)).post;
      qc.setQueryData<{ posts: SocialPostView[] }>(socialKeys.posts, (d) => (d ? { posts: mergePosts(d.posts, [post]) } : d));
      return post;
    },
    initialData: () => qc.getQueryData<{ posts: SocialPostView[] }>(socialKeys.posts)?.posts.find((p) => p.id === id),
    initialDataUpdatedAt: 0,
    refetchInterval: (q) => (opts.follow && q.state.data && stillSending(q.state.data) ? 1500 : false),
  });
}

/**
 * 1.10.6: asks the server to check the posts on screen against their network (Facebook only; the server holds each
 * post to one check per 5 minutes and only checks posts sent in the last 30 days), then shows the answer. Servers
 * from before this answer 404: nothing to do then. A failed check never changes what is shown.
 */
export function useSocialSync() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (posts: SocialPostView[] | undefined) => {
      const ids = syncIds(posts);
      if (!ids.length) return [] as SocialPostView[];
      try { return (await api.syncSocialPosts(ids)).posts ?? []; } catch { return [] as SocialPostView[]; }
    },
    onSuccess: (fresh) => {
      if (!fresh.length) return;
      qc.setQueryData<{ posts: SocialPostView[] }>(socialKeys.posts, (d) => (d ? { posts: mergePosts(d.posts, fresh) } : d));
      for (const p of fresh) qc.setQueryData(socialKeys.post(p.id), p);
    },
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

/** Pull to refresh on Accounts: a fresh check of every account (the server still holds it to one per 30 seconds). */
export function useFreshHealth() {
  const { api } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => { try { return (await api.socialHealth(true)).accounts; } catch { return null; } },
    onSuccess: (accounts) => { if (accounts) qc.setQueryData(socialKeys.health, accounts); },
  });
}

export function useSocialTargets(accountId: string | null) {
  const { api } = useSession();
  return useQuery({ queryKey: socialKeys.targets(accountId ?? ""), queryFn: () => api.appTargets(accountId!), select: (d) => d.targets, enabled: !!accountId, staleTime: 5 * 60_000 });
}

function refreshSocial(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [socialKeys.posts, socialKeys.accounts, socialKeys.direct, socialKeys.health]) void qc.invalidateQueries({ queryKey: k });
  void qc.invalidateQueries({ queryKey: ["social", "post"] });
}

/* 1.10.6: the short message at the bottom of Social ("Post deleted from Facebook and LinkedIn"). A delete runs on the post
   page and the message shows on Posts after going back, so it lives outside both screens. */
export interface SocialToast { id: number; text: string; tone: "ok" | "bad" }
let toast: SocialToast | null = null;
const toastListeners = new Set<() => void>();
export function showSocialToast(text: string, tone: "ok" | "bad" = "ok") {
  toast = { id: Date.now(), text, tone };
  toastListeners.forEach((l) => l());
}
export function clearSocialToast(id?: number) {
  if (id !== undefined && toast?.id !== id) return;
  toast = null;
  toastListeners.forEach((l) => l());
}
export function subscribeSocialToast(l: () => void) { toastListeners.add(l); return () => { toastListeners.delete(l); }; }
export const currentSocialToast = () => toast;

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
  const putPost = (post: SocialPostView | undefined) => {
    if (!post) return;
    qc.setQueryData(socialKeys.post(post.id), post);
    qc.setQueryData<{ posts: SocialPostView[] }>(socialKeys.posts, (d) => (d ? { posts: mergePosts(d.posts, [post]) } : d));
  };
  const retry = useMutation({ mutationFn: (id: string) => api.retrySocialPost(id), onSuccess: (r) => putPost(r?.post), onSettled: () => refreshSocial(qc) });
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelSocialPost(id), onSuccess: (r) => putPost(r?.post), onSettled: () => refreshSocial(qc) });
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
  /**
   * 1.10.6: Delete in Multies, which also deletes the post on Facebook and LinkedIn. The post leaves the list only when
   * the server says deleted; otherwise it stays with the rows that didn't delete marked.
   */
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSocialPost(id),
    onSuccess: (r, id) => {
      qc.setQueryData<{ posts: SocialPostView[] }>(socialKeys.posts, (d) => {
        if (!d) return d;
        if (r.deleted) return { posts: d.posts.filter((p) => p.id !== id) };
        return r.post ? { posts: mergePosts(d.posts, [r.post]) } : d;
      });
      if (r.deleted) qc.removeQueries({ queryKey: socialKeys.post(id) });
      else if (r.post) qc.setQueryData(socialKeys.post(id), r.post);
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: socialKeys.posts }); },
  });
  return { create, retry, cancel, connect, reconnect, remove };
}

/** TikTok and Threads sign in runs on multies.si itself (it needs the web session), so it opens the web page. */
export async function openWebSocialAccounts() {
  await WebBrowser.openBrowserAsync(WEB_PAGES.socialAccounts);
}

/* 1.10.6: which part of Social to show when going back to it (the screen after posting opens Posts with "View in Posts"). */
export type SocialTab = "posts" | "new" | "accounts";
let wantedTab: { tab: SocialTab; n: number } | null = null;
const tabListeners = new Set<() => void>();
export function requestSocialTab(tab: SocialTab) { wantedTab = { tab, n: (wantedTab?.n ?? 0) + 1 }; tabListeners.forEach((l) => l()); }
export function subscribeSocialTab(l: () => void) { tabListeners.add(l); return () => { tabListeners.delete(l); }; }
export const currentSocialTab = () => wantedTab;

/* 1.10.6: the post just sent, kept so "Edit post" after a post that didn't go out puts the words back in the composer. */
export interface SocialDraft { text: string; image: { name: string; type: string; uri: string; size?: number; base64?: string } | null; chosen: Record<string, { target: string | null; targetName: string | null }> }
let lastDraft: SocialDraft | null = null;
let restore: SocialDraft | null = null;
export function rememberDraft(d: SocialDraft) { lastDraft = d; }
/** Asks the composer to show the last sent post's words again. */
export function restoreLastDraft() { restore = lastDraft; }
/** The composer takes the words back once. */
export function takeRestoredDraft(): SocialDraft | null { const d = restore; restore = null; return d; }
