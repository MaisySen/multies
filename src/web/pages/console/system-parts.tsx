/**
 * OPS1: the parts of /console/system: database usage meters (the R32 write budget meter's look, fed by the snapshot),
 * busiest workspaces today, uptime history and provider health.
 */
import type { ReactNode } from "react";
import { LOCALE } from "@/shared/locale";
import { Card, tableStyles } from "@/web/components/ui/misc";
import { IconActivity, IconBuilding, IconDatabase } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { consoleTable as T } from "./components/data-table";
import { EmptyRow, formatDay, RelTime, StatusBadge, WorkspaceLink } from "./components/format";
import { providerLabel, type SystemReads, type SystemSnapshot, type SystemWrites } from "./system-api";

const fmt = (n: number) => n.toLocaleString(LOCALE);
type Tone = "ok" | "warn" | "bad";

const WRITE_LEVEL: Record<SystemWrites["level"], { label: string; tone: Tone; note: string }> = {
  ok: { label: "Normal", tone: "ok", note: "Every write goes through." },
  warn: { label: "Watch", tone: "warn", note: "Visits and last used times are written at most every 15 minutes. The alert mail has gone out." },
  shed: { label: "Saving writes", tone: "bad", note: "Visits, read markers and last used times are skipped and new demos are paused. Mail, sign in and people's work keep writing." },
  off: { label: "Off", tone: "ok", note: "" },
};
const BAR: Record<Tone, string> = { ok: "bg-brand", warn: "bg-warn", bad: "bg-bad" };
const TEXT: Record<Tone, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };

function untilReset(resetAt: string, now = Date.now()) {
  const mins = Math.max(0, Math.round((Date.parse(resetAt) - now) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

function Meter({ label, value, max, pct, tone, marks }: { label: string; value: number; max: number; pct: number; tone: Tone; marks: number[] }) {
  return (
    <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-fill" role="meter" aria-label={label}
      aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${fmt(value)} of ${fmt(max)} rows, ${pct}%`}>
      <div className={cn("h-full rounded-full transition-[width] duration-200 motion-reduce:transition-none", BAR[tone])} style={{ width: `${Math.min(100, pct)}%` }} />
      {marks.map((m) => <span key={m} className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${m}%` }} aria-hidden="true" />)}
    </div>
  );
}

function MeterCard({ icon, title, subtitle, level, tone, today, budget, pct, children, testid }: {
  icon: ReactNode; title: string; subtitle: ReactNode; level: string; tone: Tone; today: number; budget: number; pct: number; children: ReactNode; testid: string;
}) {
  return (
    <Card className="p-5" data-testid={testid}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-hover">{icon}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            <p className="text-xs text-muted">{subtitle}</p>
          </div>
        </div>
        <span className={cn("shrink-0 whitespace-nowrap rounded-full border border-current/20 px-2.5 py-0.5 text-xs font-medium", TEXT[tone])} data-testid={`${testid}-level`}>{level}</span>
      </div>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl font-semibold tabular-nums tracking-tight" data-testid={`${testid}-today`}>{fmt(today)}</span>
        <span className="text-sm text-muted tabular-nums">of {fmt(budget)} rows</span>
        <span className="ml-auto text-sm font-medium tabular-nums" data-testid={`${testid}-pct`}>{pct}%</span>
      </div>
      {children}
    </Card>
  );
}

export function DatabaseUsage({ s }: { s: SystemSnapshot }) {
  const { writes: w, reads: r } = s.database;
  if (!w) {
    return (
      <EmptyRow icon={<IconDatabase />} testId="console-system-meter-off">
        <span title="Needs the CF_ANALYTICS_TOKEN and CF_ACCOUNT_ID settings">The database write meter isn't connected on this deployment, so today's writes and reads can't be shown here.</span>
      </EmptyRow>
    );
  }
  const level = WRITE_LEVEL[w.level] ?? WRITE_LEVEL.ok;
  const envs = Object.entries(w.byEnvironment).sort((a, b) => b[1] - a[1]);
  const readTone: Tone = r?.level === "limit" ? "bad" : r?.level === "warn" ? "warn" : "ok";
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <MeterCard testid="console-system-writes" icon={<IconDatabase className="h-4 w-4" aria-hidden />} title="Writes today"
        subtitle={<>Production and staging share one daily budget. Resets at 00:00 UTC, in {untilReset(w.resetAt)}.</>}
        level={level.label} tone={level.tone} today={w.today} budget={w.budget} pct={w.pct}>
        <Meter label="Database rows written today" value={w.today} max={w.budget} pct={w.pct} tone={level.tone} marks={[w.warnAt, w.shedAt]} />
        <p className="mt-1.5 text-[11px] text-muted tabular-nums">Alert at {w.warnAt}%, saving writes from {w.shedAt}%.</p>
        {level.note && <p className="mt-2 text-xs text-muted">{level.note}</p>}
        {envs.length > 0 && (
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {envs.map(([k, n]) => (
              <div key={k} className="rounded-lg bg-fill px-3 py-2">
                <dt className="text-[11px] capitalize text-muted">{k}</dt>
                <dd className="text-sm font-medium tabular-nums">{fmt(n)}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-3 text-[11px] text-muted">Read <RelTime at={w.at} /> from Cloudflare analytics, a few minutes behind.</p>
      </MeterCard>
      {r ? <ReadsCard r={r} tone={readTone} /> : (
        <EmptyRow icon={<IconDatabase />} className="self-start">Today's reads aren't available from Cloudflare analytics yet.</EmptyRow>
      )}
    </div>
  );
}

function ReadsCard({ r, tone }: { r: SystemReads; tone: Tone }) {
  return (
    <MeterCard testid="console-system-reads" icon={<IconDatabase className="h-4 w-4" aria-hidden />} title="Reads today"
      subtitle="Rows read across every database on the account." level={tone === "ok" ? "Normal" : tone === "warn" ? "Watch" : "At the limit"} tone={tone}
      today={r.today} budget={r.budget} pct={r.pct}>
      <Meter label="Database rows read today" value={r.today} max={r.budget} pct={r.pct} tone={tone} marks={[r.warnAt]} />
      <p className="mt-1.5 text-[11px] text-muted tabular-nums">Alert at {r.warnAt}%. Heavy pages stop loading extras from {r.loadStopAt}%.</p>
    </MeterCard>
  );
}

const WS_LEVEL: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  ok: { label: "Normal", tone: "ok" }, near: { label: "Near budget", tone: "warn" }, over: { label: "Over budget", tone: "bad" }, off: { label: "No budget", tone: "neutral" },
};

export function BusiestWorkspaces({ b }: { b: SystemSnapshot["busiestWorkspaces"] }) {
  if (!b.items.length) return <EmptyRow icon={<IconBuilding />}>No writes counted yet today. Workspaces show here as they write to the database.</EmptyRow>;
  return (
    <div className={T.wrap} tabIndex={0} role="region" aria-label="Busiest workspaces today" data-testid="console-system-busiest">
      <table className={cn(tableStyles.table, "sm:min-w-[480px]")}>
        <thead className={T.head}><tr>
          <th className={T.th}>Workspace</th><th className={cn(T.th, "text-right")}>Rows written</th>
          {b.budget > 0 && <th className={cn(T.th, "text-right", T.secondary)}>Of daily budget</th>}<th className={T.th}>Status</th>
        </tr></thead>
        <tbody className={T.body}>
          {b.items.map((w) => {
            const l = WS_LEVEL[w.level] ?? WS_LEVEL.off;
            return (
              <tr key={w.orgId} className={T.row}>
                <td className={T.td}><WorkspaceLink id={w.orgId} name={w.workspaceName} className="max-w-[16rem]" /></td>
                <td className={cn(T.td, "text-right tabular-nums")}>{fmt(w.rowsWritten)}</td>
                {b.budget > 0 && <td className={cn(T.td, "text-right tabular-nums text-muted", T.secondary)}>{Math.round((w.rowsWritten / b.budget) * 100)}%</td>}
                <td className={T.td}><StatusBadge state={w.level} tone={l.tone} label={l.label} dot={false} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const pctText = (n: number) => `${(Math.round(n * 1000) / 10).toLocaleString(LOCALE)}%`;
/** The status check's days are UTC days ("2026-11-21"), so they read as UTC dates. */
const utcDay = (day: string) => formatDay(`${day}T00:00:00Z`, { timeZone: "UTC" });
type UptimeDay = NonNullable<SystemSnapshot["uptime"]>["days"][number];

/**
 * A window's uptime in words. A figure needs at least one whole day of checks before today (today alone is a part of a
 * day and would read as a misleading "100%"); a window the checks only partly cover says how many days it rests on.
 */
export function uptimeFigure(days: readonly UptimeDay[], value: number | null, windowDays: number, today: string): { text: string; note?: string } {
  const counted = days.filter((d) => d.checks > 0);
  if (value === null || !counted.some((d) => d.date !== today)) return { text: "No data yet" };
  if (counted.length >= windowDays) return { text: pctText(value) };
  return { text: pctText(value), note: counted.length === 1 ? "from 1 day of checks" : `from ${counted.length} days of checks` };
}

function Figure({ label, f, testId }: { label: string; f: { text: string; note?: string }; testId: string }) {
  return (
    <span data-testid={testId}>
      <span className="text-muted">{label}: </span>
      <span className="font-semibold tabular-nums">{f.text}</span>
      {f.note && <span className="text-xs text-subtle"> {f.note}</span>}
    </span>
  );
}

export function UptimeHistory({ u }: { u: SystemSnapshot["uptime"] }) {
  if (!u || !u.days.some((d) => d.checks > 0)) {
    return <EmptyRow icon={<IconActivity />}>No uptime checks yet. The status check runs every few minutes and days fill in here as it records them.</EmptyRow>;
  }
  const days = u.days.slice(-90);
  const today = days[days.length - 1]?.date ?? "";
  const tone = (d: UptimeDay) => (d.checks === 0 || d.uptime === null ? "bg-fill" : d.uptime >= 0.999 ? "bg-ok" : d.uptime >= 0.98 ? "bg-warn" : "bg-bad");
  return (
    <Card className="p-5" data-testid="console-system-uptime">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <Figure label="Last 30 days" f={uptimeFigure(days.slice(-30), u.uptime30d, 30, today)} testId="console-system-uptime-30" />
        <Figure label="Last 90 days" f={uptimeFigure(days, u.uptime90d, 90, today)} testId="console-system-uptime-90" />
      </div>
      <div className="mt-3 flex h-8 items-end gap-px" role="img" aria-label={`Daily uptime for the last ${days.length} days`}>
        {days.map((d) => (
          <span key={d.date} className={cn("h-full min-w-0 flex-1 rounded-sm", tone(d))} title={`${utcDay(d.date)}: ${d.checks && d.uptime !== null ? pctText(d.uptime) : "no checks"}`} />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-muted" aria-hidden="true"><span>{days[0] ? utcDay(days[0].date) : ""}</span><span>Today</span></div>
    </Card>
  );
}

const BREAKER: Record<string, { label: string; tone: "ok" | "warn" | "bad"; note: string }> = {
  closed: { label: "Healthy", tone: "ok", note: "Calls go through." },
  "half-open": { label: "Recovering", tone: "warn", note: "Trying again after failures." },
  open: { label: "Paused", tone: "bad", note: "Failing, so calls are paused for a short while." },
};

export function ProviderHealth({ c }: { c: SystemSnapshot["circuitBreakers"] }) {
  return (
    <div className="space-y-2">
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" data-testid="console-system-breakers">
        {c.providers.map((p) => {
          const b = BREAKER[p.state] ?? BREAKER.closed;
          return (
            <li key={p.provider} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span className="font-medium">{providerLabel(p.provider)}</span>
              <span className="flex items-center gap-2"><span className="text-xs text-subtle">{b.note}</span><StatusBadge state={p.state} tone={b.tone} label={b.label} /></span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-subtle">This shows only the server that answered this page. Other servers keep their own state and may differ.</p>
    </div>
  );
}
