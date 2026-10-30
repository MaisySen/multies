/**
 * R34: every badge in the app reads one query, GET /api/counts (mail, chat, notifications, triage, tasks). It
 * refetches on focus, every 30 s, on a push for an open page, and whenever one of the older per-area count queries is
 * invalidated (chat unread, triage count, notifications count, mail), so code that already says "counts changed"
 * keeps working. The server answers 304 when nothing moved.
 */
import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { PUSH_ON_PAGE_EVENT } from "./sw-client";

export interface Counts {
  mail: { inbox: number; important: number; other: number };
  chat: { unread: number; mentions: number };
  notifications: { unread: number };
  triage: number;
  tasks: { dueToday: number; overdue: number };
  at: string;
}

export const COUNTS_KEY = ["counts"] as const;
/** Query keys whose invalidation means a badge may have moved. */
const WATCH = new Set(["chat|unread", "triage|count", "notifications|count", "notifications", "mail", "threads", "triage"]);

function tz() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}

/** Badge total for the tab title and the app icon: unread chat, unread notifications and Inbox mail. */
export function badgeTotal(c: Counts | undefined): number {
  if (!c) return 0;
  return c.chat.unread + c.notifications.unread + c.mail.inbox;
}

/** "(3) Mail · Multies" from "Mail · Multies" and 3; a 0 drops the prefix. */
export function titleWithCount(title: string, n: number): string {
  const bare = title.replace(/^\(\d+\+?\) /, "");
  return n > 0 ? `(${n > 99 ? "99+" : n}) ${bare}` : bare;
}

export function watchCountInvalidations(qc: QueryClient) {
  return qc.getQueryCache().subscribe((e) => {
    if (e.type !== "updated" || e.action.type !== "invalidate") return;
    const key = e.query.queryKey as unknown[];
    if (key[0] === "counts") return;
    if (WATCH.has(`${String(key[0])}|${String(key[1])}`) || WATCH.has(String(key[0]))) void qc.invalidateQueries({ queryKey: COUNTS_KEY });
  });
}

export function useCounts(enabled: boolean) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: COUNTS_KEY, enabled, refetchInterval: 60_000, refetchOnWindowFocus: true, staleTime: 10_000, // R59 hotfix (D1 reads): 60 s like the phone app; pushes and mail changes still refresh at once
    queryFn: () => api.get<Counts>(`/counts${tz() ? `?tz=${encodeURIComponent(tz())}` : ""}`),
  });
  useEffect(() => {
    if (!enabled) return;
    const off = watchCountInvalidations(qc);
    const onPush = () => void qc.invalidateQueries({ queryKey: COUNTS_KEY });
    window.addEventListener(PUSH_ON_PAGE_EVENT, onPush);
    return () => { off(); window.removeEventListener(PUSH_ON_PAGE_EVENT, onPush); };
  }, [enabled, qc]);
  return q;
}

/** Keeps "(n) " in front of the tab title, even when a page sets its own title later. */
export function useTitleCount(n: number) {
  useEffect(() => {
    const apply = () => { const next = titleWithCount(document.title, n); if (next !== document.title) document.title = next; };
    apply();
    const el = document.querySelector("title");
    if (!el || typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(apply);
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => { mo.disconnect(); document.title = titleWithCount(document.title, 0); };
  }, [n]);
}
