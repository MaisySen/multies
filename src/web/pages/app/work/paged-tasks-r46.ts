/**
 * R46 (MB-234): task lists that cover every task and stay fresh cheaply.
 *
 * The first read walks every page (paged=1, then the cursor the server hands back), so board, list and backlog counts
 * cover a project of any size. After that a refresh (the 20 s poll, a window focus, an edit of your own invalidating
 * the list) reads the change feed from where the last read stopped and asks only for the tasks it names (ids=a,b,c, with
 * the list's own filters), instead of reading the whole list again. A task that comes back is placed or replaced; one
 * that does not (deleted, or no longer matching the filters) leaves the list. A long gap, a big batch or ten minutes
 * since the last full read fall back to reading every page again.
 */
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { withOfflineCopy } from "@/web/lib/offline-lists";
import type { Task } from "./data";

export const PAGE_LIMIT = 40; // 40 pages of 500: 20,000 tasks
export const POLL_MS = 20_000;
export const FULL_READ_EVERY_MS = 10 * 60_000;
const MAX_IDS = 100;

interface Page { tasks: Task[]; next: string | null; changeCursor?: number }
interface Feed { changes: { entity: string; id: string }[]; cursor: number; more: boolean }
interface Track { cursor: number; fullAt: number }
const tracks = new Map<string, Track>();
const keyOf = (k: QueryKey) => JSON.stringify(k);
const join = (path: string, qs: string, extra: string) => `${path}?${qs ? `${qs}&` : ""}${extra}`;

/** Every page of a list, and the change feed cursor as of the first page. */
export async function readAllPages(path: string, qs: string, get: <T>(url: string) => Promise<T> = api.get) {
  const first = await get<Page>(join(path, qs, "paged=1"));
  const tasks = [...first.tasks];
  let next = first.next;
  for (let i = 1; next && i < PAGE_LIMIT; i++) {
    const page = await get<Page>(join(path, qs, `paged=1&cursor=${encodeURIComponent(next)}`));
    tasks.push(...page.tasks);
    next = page.next;
  }
  return { tasks, changeCursor: first.changeCursor ?? 0 };
}

const defaultOrder = (a: Task, b: Task) => a.position - b.position || Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Applies a refresh: each changed id either comes back (placed or replaced) or leaves the list. */
export function mergeChanged(list: Task[], changed: string[], fresh: Task[], resort: boolean): Task[] {
  const gone = new Set(changed);
  const byId = new Map(fresh.map((t) => [t.id, t]));
  const out: Task[] = [];
  for (const t of list) {
    if (!gone.has(t.id)) out.push(t);
    else if (byId.has(t.id)) { out.push(byId.get(t.id)!); byId.delete(t.id); }
  }
  out.push(...byId.values());
  return resort ? out.sort(defaultOrder) : out;
}

/** Reads a list the cheap way when it can: the change feed since the last read, then only the tasks it names. */
export async function refreshList(opts: {
  path: string; qs: string; old: Task[] | undefined; track: Track | undefined; now: number; resort: boolean;
  get?: <T>(url: string) => Promise<T>;
}): Promise<{ tasks: Task[]; track: Track; full: boolean }> {
  const get = opts.get ?? api.get;
  const { old, track } = opts;
  if (old && track && opts.now - track.fullAt < FULL_READ_EVERY_MS) {
    const feed = await get<Feed>(`/changes?since=${track.cursor}&limit=200`);
    const ids = [...new Set(feed.changes.filter((c) => c.entity === "task").map((c) => c.id))];
    if (!feed.more && ids.length <= MAX_IDS) {
      if (!ids.length) return { tasks: old, track: { ...track, cursor: feed.cursor }, full: false };
      const r = await get<Page>(join(opts.path, opts.qs, `ids=${ids.join(",")}`));
      return { tasks: mergeChanged(old, ids, r.tasks, opts.resort), track: { ...track, cursor: feed.cursor }, full: false };
    }
  }
  const all = await readAllPages(opts.path, opts.qs, get);
  return { tasks: all.tasks, track: { cursor: all.changeCursor, fullAt: opts.now }, full: true };
}

/** A task list query that covers every task and refreshes from the change feed. */
export function usePagedTasks(opts: { key: QueryKey; path: string; qs: string; enabled?: boolean; offlineKey: string; sorted?: boolean }) {
  const qc = useQueryClient();
  const k = keyOf(opts.key);
  return useQuery({
    queryKey: opts.key, enabled: opts.enabled ?? true, networkMode: "offlineFirst", refetchInterval: POLL_MS,
    queryFn: withOfflineCopy(opts.offlineKey, async () => {
      const r = await refreshList({ path: opts.path, qs: opts.qs, old: qc.getQueryData<Task[]>(opts.key), track: tracks.get(k), now: Date.now(), resort: !opts.sorted });
      tracks.set(k, r.track);
      return r.tasks;
    }),
  });
}
