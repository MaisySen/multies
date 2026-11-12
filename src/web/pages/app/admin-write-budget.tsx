import { useQuery } from "@tanstack/react-query";
import { IconDatabase } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { Card } from "@/web/components/ui/misc";
import { LOCALE } from "@/shared/locale";

/** R32: the account's D1 writes today, from /api/admin/health (QUAL1: operators only; Cloudflare analytics, cached a few minutes). */
export interface HealthWrites {
  today: number; budget: number; level: "ok" | "warn" | "shed"; at: string;
  pct?: number; warnAt?: number; shedAt?: number; resetAt?: string; byEnvironment?: Record<string, number>;
  deferred?: { written: number; coalesced: number; skipped: number };
}

const LEVEL: Record<HealthWrites["level"], { label: string; tone: string; bar: string; note: string }> = {
  ok: { label: "Normal", tone: "text-emerald-700 dark:text-emerald-400", bar: "bg-brand", note: "Every write goes through." },
  warn: { label: "Watch", tone: "text-amber-700 dark:text-amber-400", bar: "bg-amber-500", note: "Visits and last used times are written at most every 15 minutes. The alert mail has gone out." },
  shed: { label: "Saving writes", tone: "text-red-700 dark:text-red-400", bar: "bg-red-500", note: "Visits, read markers and last used times are skipped and new demos are paused. Mail, sign in and people's work keep writing." },
};

const fmt = (n: number) => n.toLocaleString(LOCALE);

function untilReset(resetAt: string | undefined, now = Date.now()) {
  const next = resetAt ? Date.parse(resetAt) : (() => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); })();
  const mins = Math.max(0, Math.round((next - now) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

/** The meter on the operator console. Hidden when the deployment has no analytics token (level off). */
export function WriteBudgetMeter() {
  const q = useQuery({ queryKey: ["health-writes"], queryFn: () => api.get<{ writes?: HealthWrites }>("/admin/health"), refetchInterval: 60_000 });
  const w = q.data?.writes;
  if (q.isPending) return <Card className="h-36 animate-pulse motion-reduce:animate-none" aria-hidden="true">{null}</Card>;
  if (!w) {
    return (
      <Card className="p-5 text-sm text-muted" data-testid="write-budget-off">
        D1 write meter is off on this deployment: set CF_ANALYTICS_TOKEN to read the account's daily writes.
      </Card>
    );
  }
  const pct = w.pct ?? Math.round((w.today / w.budget) * 1000) / 10;
  const level = LEVEL[w.level] ?? LEVEL.ok;
  const warnAt = w.warnAt ?? 60;
  const shedAt = w.shedAt ?? 85;
  const envs = Object.entries(w.byEnvironment ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="p-5" data-testid="write-budget">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand-hover"><IconDatabase className="h-4 w-4" aria-hidden="true" /></span>
          <div>
            <h2 className="text-sm font-semibold">D1 writes today</h2>
            <p className="text-xs text-muted">Production and staging share one daily budget. Resets at 00:00 UTC, in {untilReset(w.resetAt)}.</p>
          </div>
        </div>
        <span className={`rounded-full border border-current/20 px-2.5 py-0.5 text-xs font-medium ${level.tone}`} data-testid="write-budget-level">{level.label}</span>
      </div>
      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight" data-testid="write-budget-today">{fmt(w.today)}</span>
        <span className="text-sm text-muted tabular-nums">of {fmt(w.budget)} rows</span>
        <span className="ml-auto text-sm font-medium tabular-nums" data-testid="write-budget-pct">{pct}%</span>
      </div>
      <div
        className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-black/5 dark:bg-white/10"
        role="meter" aria-label="D1 rows written today" aria-valuemin={0} aria-valuemax={w.budget} aria-valuenow={w.today} aria-valuetext={`${fmt(w.today)} of ${fmt(w.budget)} rows, ${pct}%`}
      >
        <div className={`h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none ${level.bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
        <span className="absolute inset-y-0 w-px bg-black/25 dark:bg-white/30" style={{ left: `${warnAt}%` }} aria-hidden="true" />
        <span className="absolute inset-y-0 w-px bg-black/40 dark:bg-white/50" style={{ left: `${shedAt}%` }} aria-hidden="true" />
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted tabular-nums" aria-hidden="true">
        <span>0</span><span>Alert {warnAt}%, saving writes {shedAt}%</span><span>{fmt(w.budget)}</span>
      </div>
      <p className="mt-3 text-xs text-muted">{level.note}</p>
      {envs.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {envs.map(([k, n]) => (
            <div key={k} className="rounded-lg bg-black/[0.03] px-3 py-2 dark:bg-white/5">
              <dt className="text-[11px] capitalize text-muted">{k}</dt>
              <dd className="text-sm font-medium tabular-nums">{fmt(n)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="mt-3 text-[11px] text-muted">Read {new Date(w.at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" })} from Cloudflare analytics, a few minutes behind.</p>
    </Card>
  );
}
