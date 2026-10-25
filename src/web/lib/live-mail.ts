import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";

/**
 * Live mail (round 19). While the mail view is open and visible, the app beats every 10 seconds
 * (POST /api/connections/live, reads only) and pokes once a minute, which keeps each connected
 * mailbox's live window open on the server (IDLE on the Inbox). When a beat shows that new mail was
 * stored, the mail lists refresh straight away instead of at their 30 second refetch.
 */
export interface LiveAnswer {
  live: boolean;
  stamp: number;
  connections: { id: string; lastSyncAt: string | null; messagesSynced: number; mode: string | null }[];
}

export const BEAT_MS = 10_000;
export const POKE_MS = 60_000;

/** The beat's logic without React: decides when to poke and reports when the synced mail changed. */
export function liveBeat(opts: { post: (body: { poke: boolean }) => Promise<LiveAnswer>; onChange: () => void; now?: () => number; pokeEveryMs?: number }) {
  const now = opts.now ?? Date.now;
  let lastPoke = -Infinity;
  let last: string | null = null;
  let off = false;
  return {
    /** One beat. Returns false once the server says there is nothing to watch (no connections, or live mail off). */
    async beat(force = false): Promise<boolean> {
      if (off) return false;
      const poke = force || now() - lastPoke >= (opts.pokeEveryMs ?? POKE_MS);
      if (poke) lastPoke = now();
      const a = await opts.post({ poke });
      if (!a.connections.length) { off = true; return false; }
      const key = `${a.stamp}|${a.connections.map((c) => c.lastSyncAt ?? "").join(",")}`;
      if (last !== null && key !== last) opts.onChange();
      last = key;
      return true;
    },
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
    });
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (force = false) => {
      if (stopped) return;
      clearTimeout(timer);
      let keep = true;
      if (document.visibilityState === "visible") {
        try { keep = await b.beat(force); } catch { keep = true; /* offline or rate limited: try again at the next beat */ }
      }
      if (keep && !stopped) timer = setTimeout(() => { void run(); }, BEAT_MS);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void run(true); };
    document.addEventListener("visibilitychange", onVisible);
    void run(true);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, qc]);
}
