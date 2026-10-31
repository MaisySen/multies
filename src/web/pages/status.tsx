import { useQuery } from "@tanstack/react-query";
import { IconRefresh } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { LOCALE } from "@/shared/locale";
import { cn } from "@/web/lib/cn";
import { statusHeadline } from "@/web/lib/status-headline";

type State = "operational" | "degraded" | "down" | "not_configured";
interface Day { date: string; checks: number; uptime: number | null; worst: State | null }
interface Status {
  overall: Exclude<State, "not_configured">;
  checkedAt: string;
  components: { id: string; name: string; state: State; detail: string; latencyMs?: number }[];
  history: { days: Day[]; uptime30d: number | null; uptime90d: number | null } | null;
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? "No data yet" : `${(Math.floor(v * 10000) / 100).toFixed(2)}%`);

const label: Record<State, string> = { operational: "Operational", degraded: "Degraded", down: "Down", not_configured: "Not offered" };
const dot: Record<State, string> = { operational: "bg-ok", degraded: "bg-warn", down: "bg-bad", not_configured: "bg-subtle/40" };

export function StatusPage() {
  const q = useQuery({
    queryKey: ["status"],
    // A 503 still carries the status body; show it rather than an error.
    queryFn: async () => {
      const res = await fetch("/api/status");
      if (!res.ok && res.status !== 503) throw new Error(`Status check failed (${res.status})`);
      return (await res.json()) as Status;
    },
    refetchInterval: 60_000,
  });
  const s = q.data;
  return (
    <section className="mx-auto max-w-3xl px-5 pb-24 pt-32 sm:pt-36">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">System status</h1>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-y border-line py-5" role="status" aria-live="polite">
        {s ? (
          <div className="flex items-center gap-3">
            <span className={cn("h-3 w-3 rounded-full", dot[s.overall])} aria-hidden />
            <span className="text-lg font-medium">{statusHeadline(s.overall, s.components)}</span>
          </div>
        ) : <span className="text-muted">{q.error ? "Couldn't reach the status check." : "Checking..."}</span>}
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} loading={q.isFetching && (!!s || !!q.error)}><IconRefresh className="h-3.5 w-3.5" />Check again</Button>
      </div>
      {!s && (
        // Placeholder rows hold the layout while the first check runs (no layout shift).
        <ul className="divide-y divide-line" aria-hidden>
          {Array.from({ length: 7 }, (_, i) => (
            <li key={i} className="flex h-[73px] items-center justify-between gap-4 py-4">
              <div className="h-4 w-40 rounded bg-fill" />
              <div className="h-4 w-24 rounded bg-fill" />
            </li>
          ))}
        </ul>
      )}
      {!s && <div className="mt-10 h-[148px] rounded bg-fill/60" aria-hidden />}
      {s && (
        <>
          <ul className="divide-y divide-line">
            {s.components.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-4 py-4">
                <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="mt-0.5 text-sm text-muted">{c.detail}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  {typeof c.latencyMs === "number" && c.state !== "not_configured" && <span className="font-mono text-xs tabular-nums text-subtle">{c.latencyMs} ms</span>}
                  <span className={cn("h-2 w-2 rounded-full", dot[c.state])} aria-hidden />
                  <span className={c.state === "not_configured" ? "text-subtle" : ""}>{label[c.state]}</span>
                </div>
              </li>
            ))}
          </ul>
          {s.history && <UptimeHistory history={s.history} />}
          <p className="mt-6 text-xs text-subtle">
            Checked {new Date(s.checkedAt).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" })}, your time. Refreshes every minute.
          </p>
        </>
      )}
    </section>
  );
}

function UptimeHistory({ history }: { history: NonNullable<Status["history"]> }) {
  const color = (d: Day) => (d.worst === null ? "bg-fill" : d.worst === "down" ? "bg-bad" : d.worst === "degraded" ? "bg-warn" : "bg-ok");
  return (
    <section className="mt-10" aria-labelledby="uptime-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="uptime-heading" className="text-lg font-semibold">Uptime, last 90 days</h2>
        <p className="text-sm text-muted">
          <span className="font-mono tabular-nums text-fg">{pct(history.uptime30d)}</span> over 30 days, <span className="font-mono tabular-nums text-fg">{pct(history.uptime90d)}</span> over 90
        </p>
      </div>
      <ol className="mt-4 flex h-9 items-stretch gap-[2px]" aria-label="Daily uptime">
        {history.days.map((d) => (
          <li key={d.date} className={cn("min-w-0 flex-1 rounded-[2px]", color(d))} title={`${d.date}: ${d.checks ? pct(d.uptime) : "no checks"}`}>
            <span className="sr-only">{d.date}: {d.checks ? pct(d.uptime) : "no checks"}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex justify-between text-xs text-subtle"><span>90 days ago</span><span>Today</span></div>
      <p className="mt-3 text-xs text-subtle">A self check runs every 5 minutes and an outside monitor checks the API every 10 minutes. Targets are in the service level objectives.</p>
    </section>
  );
}
