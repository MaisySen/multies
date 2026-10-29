/**
 * R57: the full history backfill's progress as the connection screen and Mail show it, from the connection's sync state.
 * Standalone (no imports from the sync engine) so the connection view can use it without an import cycle.
 */
interface FolderLike { path: string; done?: boolean; left?: number }
interface StateLike {
  inbox?: FolderLike; sent?: FolderLike; boxes?: Record<string, FolderLike>;
  paths?: { inbox: string; sent?: string; archive?: string; drafts?: string; spam?: string; trash?: string };
  extra?: string[];
  bf?: { paused?: boolean; wait?: "daily" | "budget" | null };
}

export interface BackfillProgress {
  /** Every synced folder has been copied back to its first message. */
  done: boolean;
  /** Every synced folder has been counted at least once (before that, `total` is a lower bound). */
  counted: boolean;
  synced: number;
  total: number;
  paused: boolean;
  /** Why older mail waits right now: the day's share is used ("daily"), or the shared write budget is high ("budget"). */
  wait: "daily" | "budget" | null;
}

export function backfillProgress(state: StateLike, messagesSynced: number): BackfillProgress {
  const p = state.paths ?? { inbox: "INBOX" };
  const folders: FolderLike[] = [];
  const seen = new Set<string | undefined>([p.inbox, p.sent]);
  if (state.inbox) folders.push(state.inbox);
  if (state.sent) folders.push(state.sent);
  for (const k of ["archive", "drafts", "spam", "trash"] as const) {
    const path = p[k];
    if (path && !seen.has(path)) { seen.add(path); const st = state.boxes?.[k]; if (st) folders.push(st); }
  }
  for (const path of state.extra ?? []) if (!seen.has(path)) { seen.add(path); const st = state.boxes?.[`f:${path}`]; if (st) folders.push(st); }
  const done = folders.length > 0 && folders.every((f) => f.done);
  const counted = folders.every((f) => f.done || f.left !== undefined);
  const left = folders.reduce((n, f) => n + (f.done ? 0 : f.left ?? 0), 0);
  return { done, counted, synced: messagesSynced, total: messagesSynced + left, paused: !!state.bf?.paused, wait: state.bf?.wait ?? null };
}
