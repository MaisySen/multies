/**
 * The running timer's data and helpers, shared by the Timesheet page and the app frame's timer chip. Kept out of
 * ./time so the chip, on every page, does not load the Timesheet page with it (R40 first load budget).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";

export interface TimeEntry {
  id: string; taskId: string | null; task: { id: string; ref: string; title: string } | null; projectId: string | null;
  project: { id: string; name: string; key: string; color: string } | null; person: { type: "member" | "agent"; id: string; name: string }; personId: string;
  startedAt: string; endedAt: string | null; running: boolean; seconds: number; note: string; billable: boolean; billed?: boolean; source: "timer" | "manual";
  /** R95 */ tags?: string[];
}
/** 1:05:09 for a running timer, 2h 05m for totals. */
export const clockText = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`; };
export const hoursText = (s: number) => { if (!s) return "0m"; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`; };

export function useRunningTimer() {
  return useQuery({ queryKey: ["time-running"], queryFn: async () => (await api.get<{ entry: TimeEntry | null }>("/time/running")).entry, refetchInterval: 60_000, staleTime: 10_000 });
}

/** Seconds on a running entry, ticking every second. */
export function useElapsed(entry: TimeEntry | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!entry?.running) return; const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, [entry?.running, entry?.id]);
  if (!entry) return 0;
  return entry.running ? Math.max(0, Math.round((now - new Date(entry.startedAt).getTime()) / 1000)) : entry.seconds;
}

export function useTimerActions() {
  const qc = useQueryClient();
  const done = () => { void qc.invalidateQueries({ queryKey: ["time-running"] }); void qc.invalidateQueries({ queryKey: ["timesheet"] }); void qc.invalidateQueries({ queryKey: ["task"] }); };
  const start = useMutation({ mutationFn: (taskId: string) => api.post<{ entry: TimeEntry }>("/time/start", { taskId }), onSuccess: done, onError: (e) => showError(e as Error) });
  const stop = useMutation({ mutationFn: () => api.post<{ entry: TimeEntry | null }>("/time/stop", {}), onSuccess: done, onError: (e) => showError(e as Error) });
  return { start, stop, refresh: done };
}

