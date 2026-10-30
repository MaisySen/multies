import { useEffect, useState } from "react";
import type { TimeEntry } from "@/api/types";

/** A live timer: "04:07" under an hour, then "1:05" (hours and minutes). */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  return `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}`;
}

/** A total: "45m", "2h", "1h 25m". */
export function duration(seconds: number): string {
  const m = Math.round(Math.max(0, seconds) / 60);
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Seconds on an entry right now: counted from startedAt while it runs. */
export function elapsed(entry: Pick<TimeEntry, "running" | "seconds" | "startedAt">, now: number): number {
  if (!entry.running) return entry.seconds;
  return Math.max(0, Math.floor((now - Date.parse(entry.startedAt)) / 1000));
}

/** Reads a minutes field: whole or decimal minutes, or h:mm. Null when it isn't a usable amount. */
export function parseMinutes(input: string): number | null {
  const v = input.trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v);
  const n = hm ? Number(hm[1]) * 60 + Number(hm[2]) : Number(v);
  if (!v || !Number.isFinite(n) || n <= 0 || n > 1440) return null;
  return Math.round(n * 100) / 100;
}

/** The current time, ticking every second while `on` is true. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [on]);
  return now;
}
