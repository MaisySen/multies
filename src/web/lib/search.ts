/** Search everything (Cmd+K) and My Work: the client side of /api/search and /api/my-work. */
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { readLastCopy, withOfflineCopy } from "@/web/lib/offline-lists"; // R33, R45

export type SearchType = "mail" | "tasks" | "docs" | "chat" | "contacts" | "deals" | "attachments" | "files" | "notes"; // Tools P2: attachments; R98: files, notes
export interface SearchItem { type: SearchType; id: string; title: string; subtitle: string; snippet: string; url: string; at: string | null }
export interface SearchGroup { type: SearchType; label: string; items: SearchItem[] }
export interface SearchResult { query: string; groups: SearchGroup[]; tookMs: number; partial: boolean }

export interface MyWorkItem { id: string; title: string; subtitle: string; url: string; at: string | null }
export interface MyWork {
  date: string; timeZone: string;
  overdue: MyWorkItem[]; dueToday: MyWorkItem[]; mentions: MyWorkItem[]; threads: MyWorkItem[]; assignedThreads?: MyWorkItem[]; approvals: MyWorkItem[]; meetings: MyWorkItem[];
  snoozed: MyWorkItem[] | null; tookMs: number;
}

export const SEARCH_MIN_CHARS = 2;

/** The value after it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** Content search for the command menu: debounced, at least two characters, cached for a minute. */
export function useContentSearch(raw: string, enabled = true) {
  const q = useDebounced(raw.trim(), 200);
  const on = enabled && q.length >= SEARCH_MIN_CHARS;
  const res = useQuery({
    queryKey: ["search", q], enabled: on, staleTime: 60_000, placeholderData: keepPreviousData, retry: false,
    queryFn: () => api.get<SearchResult>(`/search?q=${encodeURIComponent(q)}`),
  });
  // Loading covers the debounce wait too, so the menu never flashes "nothing matches" mid typing.
  const typing = raw.trim() !== q && raw.trim().length >= SEARCH_MIN_CHARS;
  return { query: q, active: on, loading: on && (res.isFetching || typing), data: on ? res.data : undefined, error: res.error };
}

/** "Today" is the person's own time zone (or the workspace's), worked out on the server. */
export function useMyWork() {
  // R33: offline, the last stored copy for this person and workspace shows instead of the empty state.
  const q = useQuery({ queryKey: ["my-work"], refetchInterval: 60_000, networkMode: "offlineFirst", queryFn: withOfflineCopy("my-work", () => api.get<MyWork>("/my-work")) });
  // R45 (MB-203): on a slow link the last stored copy draws at once and the page says it is updating.
  const [copy, setCopy] = useState<{ data: MyWork; at: number } | null>(null);
  const waiting = q.data === undefined;
  useEffect(() => {
    if (!waiting) return;
    let on = true;
    void readLastCopy<MyWork>("my-work").then((c) => { if (on && c) setCopy(c); });
    return () => { on = false; };
  }, [waiting]);
  const cached = waiting && !!copy;
  return { ...q, data: cached ? copy.data : q.data, cachedAt: cached ? copy.at : null };
}
