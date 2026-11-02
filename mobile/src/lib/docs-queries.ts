import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as WebBrowser from "expo-web-browser";
import { API_BASE } from "@/config";
import type { HttpTransport, Transport } from "@/api/transport";
import { useSession } from "./session";
import { canSearch, searchPath, type SearchResult, type TypeChoice } from "./global-search";
import { expiryDays, noAccess, type CommentList, type CommentStatus, type CommentView, type DocTree, type DocView, type Expiry, type ShareLink, type ShareList } from "./docs";

/** M1: global search, the Docs tree, the doc reader, comments and share links. Never kept on the phone. */
export const docsKeys = {
  all: ["docs"] as const,
  tree: ["docs", "tree"] as const,
  doc: (id: string) => ["docs", "doc", id] as const,
  comments: (id: string) => ["docs", "comments", id] as const,
  links: (id: string) => ["docs", "links", id] as const,
  search: (q: string, c: TypeChoice) => ["global-search", c, q] as const,
};

const enc = encodeURIComponent;
const retry = (n: number, e: unknown) => !noAccess(e) && (e as { status?: number })?.status !== 422 && n < 2;

/** The server's global search. Answers stay a minute so going back to the list is instant. */
export function useGlobalSearch(q: string, choice: TypeChoice, enabled = true) {
  const { transport } = useSession();
  return useQuery({
    queryKey: docsKeys.search(q, choice),
    enabled: enabled && canSearch(q),
    queryFn: ({ signal }) => transport.request<SearchResult>("GET", searchPath(q, choice), undefined, { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useDocTree(enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: docsKeys.tree, enabled, queryFn: () => transport.request<DocTree>("GET", "/docs/tree"), retry });
}

export function useDoc(id: string | undefined) {
  const { transport } = useSession();
  return useQuery({ queryKey: docsKeys.doc(id ?? ""), enabled: !!id, queryFn: () => transport.request<{ doc: DocView }>("GET", `/docs/${enc(id!)}`), select: (d) => d.doc, retry });
}

export function useDocComments(id: string | undefined, enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: docsKeys.comments(id ?? ""), enabled: enabled && !!id, queryFn: () => transport.request<CommentList>("GET", `/docs-plus/docs/${enc(id!)}/comments`), retry, refetchInterval: 60_000 });
}

export function useCommentActions(docId: string) {
  const { transport } = useSession();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: docsKeys.comments(docId) });
  const add = useMutation({ mutationFn: (body: string) => transport.request<{ comment: CommentView }>("POST", `/docs-plus/docs/${enc(docId)}/comments`, { body: body.trim(), thread: "team" }), onSuccess: done });
  const edit = useMutation({ mutationFn: (v: { id: string; body: string }) => transport.request<{ comment: CommentView }>("PATCH", `/docs-plus/comments/${enc(v.id)}`, { body: v.body.trim() }), onSuccess: done });
  const moderate = useMutation({ mutationFn: (v: { id: string; status: CommentStatus }) => transport.request<{ comment: CommentView }>("PATCH", `/docs-plus/comments/${enc(v.id)}`, { status: v.status }), onSuccess: done });
  const remove = useMutation({ mutationFn: (id: string) => transport.request<{ ok: true }>("DELETE", `/docs-plus/comments/${enc(id)}`), onSuccess: done });
  return { add, edit, moderate, remove };
}

export function useShareLinks(docId: string | undefined, enabled = true) {
  const { transport } = useSession();
  return useQuery({ queryKey: docsKeys.links(docId ?? ""), enabled: enabled && !!docId, queryFn: () => transport.request<ShareList>("GET", `/share-links?kind=doc&targetId=${enc(docId!)}`), retry });
}

export function useShareActions(docId: string) {
  const { transport } = useSession();
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: docsKeys.links(docId) });
  const create = useMutation({
    mutationFn: (v: { expiry: Expiry; showWorkspaceName: boolean }) => transport.request<{ link: ShareLink }>("POST", "/share-links", { kind: "doc", targetId: docId, expiresInDays: expiryDays(v.expiry), showWorkspaceName: v.showWorkspaceName }),
    onSuccess: done,
  });
  const revoke = useMutation({ mutationFn: (id: string) => transport.request<{ ok: true }>("DELETE", `/share-links/${enc(id)}`), onSuccess: done });
  return { create, revoke };
}

/** The session headers for a doc image on the workspace's own server (uploads need the cookie, as on the web). */
export function imageHeaders(transport: Transport): () => Record<string, string> {
  const t = transport as Partial<HttpTransport>;
  return () => (typeof t.fileAuth === "function" ? t.fileAuth().headers() : {});
}

/** Opens a web app page in the in-app browser (editing a doc, things the phone does not do). */
export async function openWebPath(path: string) {
  try { await WebBrowser.openBrowserAsync(`${API_BASE}${path}`); } catch { /* the person closed it or no browser */ }
}

/** Plain words for a failed request, never a code. */
export function plainProblem(e: unknown, fallback = "That didn't work. Try again."): string {
  const err = e as { status?: number; message?: string } | null;
  if (!err) return fallback;
  if (err.status === 0) return "No connection. Try again when you're back online.";
  if (err.status === 401 || err.status === 403) return err.message && !/^(forbidden|unauthori[sz]ed)$/i.test(err.message) ? err.message : "You don't have access to this.";
  if (err.status === 404) return "This isn't here any more. It may have been moved or deleted.";
  if (err.status === 429) return err.message || "Too many tries. Wait a minute and try again.";
  return err.message && err.status && err.status < 500 ? err.message : fallback;
}
