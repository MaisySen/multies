import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "./api";

export const DEMO_PAUSED_TITLE = "The demo is resting for today";
export const DEMO_PAUSED_MESSAGE = "The demo is resting for today. Create a free account instead, or try the demo again tomorrow.";

/** Opens a sandbox workspace (server must run with DEMO_MODE) and goes to the dashboard. */
export function useStartDemo() {
  const [loading, setLoading] = useState(false);
  // R71 (MB-262): the demo rests when the day's write budget or demo count is used. The page says so where the
  // button is, with the way to start for real, instead of a toast that is gone in four seconds.
  const [paused, setPaused] = useState<string | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const start = async () => {
    setLoading(true);
    try {
      await api.post("/account/demo");
      qc.clear();
      navigate("/app");
      // Sample tasks, docs and deals are seeded in later requests while the dashboard loads,
      // a part per request. A request cut short is simply asked again.
      void finishDemoSeed(() => void qc.invalidateQueries());
    } catch (err) {
      if (err instanceof ApiError && err.code === "demo_paused") {
        setPaused(err.message || DEMO_PAUSED_MESSAGE);
        toast(DEMO_PAUSED_TITLE, { description: "Create a free account instead. No card needed.", duration: 10_000, action: { label: "Create account", onClick: () => navigate("/signup") } });
        return;
      }
      toast.error(err instanceof ApiError && err.status === 404 ? "The live demo isn't enabled on this server." : err instanceof Error ? err.message : "Couldn't open the demo.");
    } finally {
      setLoading(false);
    }
  };
  return { start, loading, paused };
}

let seeding: Promise<void> | null = null;
/** Runs the sample seed's remaining parts, one request each, until the server has none left. */
export function finishDemoSeed(onProgress: () => void) {
  seeding ??= (async () => {
    for (let i = 0, idle = 0; i < 10 && idle < 2; i++) {
      const r = await api.post<{ ran: number }>("/account/demo/seed").catch(() => null);
      if (r?.ran) { idle = 0; onProgress(); } else if (r) idle++;
      await new Promise((res) => setTimeout(res, r ? 600 : 4000));
    }
  })().finally(() => { seeding = null; });
  return seeding;
}

/** A demo whose first page load was cut short still finishes its sample data on the next app load. */
export function useDemoSeedCatchUp(isDemo: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (isDemo) void finishDemoSeed(() => void qc.invalidateQueries());
  }, [isDemo, qc]);
}
