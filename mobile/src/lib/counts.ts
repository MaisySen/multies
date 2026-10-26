import { ApiError } from "@/api/errors";
import type { RequestOptions } from "@/api/transport";

/** R34: the server's badge counts, GET /api/counts (session) or /api/v1/counts (API key). */
export interface Counts {
  mail: { inbox: number; important?: number; other?: number };
  chat: { unread: number; mentions: number };
  notifications: { unread: number };
  triage?: number;
  tasks: { dueToday: number; overdue: number };
  at?: string;
}

/** What the tab bar and the app icon show. */
export interface Badges { inbox: number; chat: number; mentions: number; activity: number; tasks: number; approvals: number; icon: number }

/** Counts the app can work out from lists it already loaded (the fallback when the server has no /counts). */
export interface ListCounts { inbox?: number; chat?: number; mentions?: number; activity?: number; tasks?: number; approvals?: number }

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * The badges. Server counts win when present; otherwise the list counts. Approvals always come from
 * the approvals list (the counts endpoint does not carry them). The app icon adds up unread mail,
 * unread Activity, unread chat and approvals waiting.
 */
export function badgesFrom(counts: Counts | null | undefined, lists: ListCounts = {}): Badges {
  const inbox = counts ? n(counts.mail?.inbox) : n(lists.inbox);
  const chat = counts ? n(counts.chat?.unread) : n(lists.chat);
  const mentions = counts ? n(counts.chat?.mentions) : n(lists.mentions);
  const activity = counts ? n(counts.notifications?.unread) : n(lists.activity);
  const tasks = counts ? n(counts.tasks?.dueToday) + n(counts.tasks?.overdue) : n(lists.tasks);
  const approvals = n(lists.approvals);
  return { inbox, chat, mentions, activity, tasks, approvals, icon: inbox + activity + chat + approvals };
}

type Fetch = (opts: RequestOptions) => Promise<Counts>;

/**
 * Remembers the last ETag and answer. A 304 hands back the last answer; a 404 (a server without
 * the endpoint) answers null so the caller falls back to counting lists, and stops asking for 10 min.
 */
export function countsClient(fetch: Fetch, now: () => number = Date.now) {
  let etag: string | null = null;
  let last: Counts | null = null;
  let missingUntil = 0;
  return {
    async get(): Promise<Counts | null> {
      if (now() < missingUntil) return null;
      let seen: string | null = null;
      try {
        const answer = await fetch({
          headers: etag && last ? { "if-none-match": etag } : undefined,
          onResponse: (_status, headers) => { seen = headers.get("etag"); },
        });
        if (seen) etag = seen;
        last = answer;
        return answer;
      } catch (err) {
        const status = err instanceof ApiError ? err.status : (err as { status?: number })?.status;
        if (status === 304 && last) return last;
        if (status === 404) { missingUntil = now() + 10 * 60_000; etag = null; last = null; return null; }
        throw err;
      }
    },
    reset() { etag = null; last = null; missingUntil = 0; },
  };
}

/** How often the app asks while it is in the foreground. */
export const COUNTS_POLL_MS = 60_000;
