import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";

/**
 * Live mail (round 19). While the mail view is open and visible, the app keeps one heartbeat open
 * at a time (POST /api/connections/live with `wait`, a long poll of up to 25 seconds, reads only)
 * and pokes once a minute, which keeps each connected mailbox's live window open on the server
 * (IDLE on the Inbox). The heartbeat answers as soon as new mail is stored, and the mail lists
 * refresh straight away instead of at their 30 second refetch. A server that answers at once
 * (live mail off) is asked again every 10 seconds.
 */
export interface LiveAnswer {
  live: boolean;
  stamp: number;
  connections: { id: string; lastSyncAt: string | null; messagesSynced: number; mode: string | null }[];
}

export const BEAT_MS = 10_000;
export const POKE_MS = 60_000;
/** How long one heartbeat may wait on the server for new mail. */
export const WAIT_MS = 25_000;

/** The beat's logic without React: decides when to poke and reports when the synced mail changed. */
export function liveBeat(opts: { post: (body: { poke: boolean; wait?: number; since?: number }) => Promise<LiveAnswer>; onChange: () => void; now?: () => number; pokeEveryMs?: number; waitMs?: number }) {
  const now = opts.now ?? Date.now;
  let lastPoke = -Infinity;
  let last: string | null = null;
  let stamp = 0;
  let live = false;
  let off = false;
  return {
    /** One beat. Returns false once the server says there is nothing to watch (no connections, or live mail off). */
    async beat(force = false): Promise<boolean> {
      if (off) return false;
      const poke = force || now() - lastPoke >= (opts.pokeEveryMs ?? POKE_MS);
      if (poke) lastPoke = now();
      // The first beat takes the baseline at once; later beats may wait on the server for a change.
      const a = await opts.post({ poke, ...(opts.waitMs && last !== null ? { wait: opts.waitMs, since: stamp } : {}) });
      if (!a.connections.length) { off = true; return false; }
      const key = `${a.stamp}|${a.connections.map((c) => c.lastSyncAt ?? "").join(",")}`;
      if (last !== null && key !== last) opts.onChange();
      last = key;
      stamp = a.stamp;
      live = a.live;
      return true;
    },
    /** Whether the server holds heartbeats (live mail on): then the next one can go at once. */
    get live() { return live && !!opts.waitMs; },
    /** Starts beating again (a mailbox was connected). */
    reset() { off = false; last = null; lastPoke = -Infinity; },
  };
}

/** Keeps connected mailboxes live while this view is open and the tab is visible. */
export function useLiveMail(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const b = liveBeat({
      post: (body) => api.post<LiveAnswer>("/connections/live", body),
      onChange: () => { void qc.invalidateQueries({ queryKey: ["mail"] }); },
      waitMs: WAIT_MS,
    });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const run = async (force = false) => {
      if (stopped || running) return;
      running = true;
      clearTimeout(timer);
      let keep = true;
      let next = BEAT_MS;
      if (document.visibilityState === "visible") {
        try {
          keep = await b.beat(force);
          // Live mail on: the server holds each heartbeat until mail comes in (or 25 seconds), so the next one goes at once.
          if (b.live) next = 0;
        } catch { keep = true; /* offline or rate limited: try again at the next beat */ }
      }
      running = false;
      if (keep && !stopped) timer = setTimeout(() => { void run(); }, next);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void run(true); };
    document.addEventListener("visibilitychange", onVisible);
    void run(true);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, qc]);
}
