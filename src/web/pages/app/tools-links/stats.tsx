/** R87: click stats for a link or a bio page: per day, unique visitors, where clicks came from. */
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Skeleton, StatTile } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconChart, IconDownload, IconUser, IconShield } from "@/web/components/ui/icon";
import { STATS_DAYS, type LinkStats, type StatRow } from "@/shared/links";
import { cn } from "@/web/lib/cn";

const axis = { stroke: "var(--color-subtle)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = { cursor: { fill: "var(--color-hover)" }, contentStyle: { background: "var(--color-elevated)", border: "1px solid var(--color-line)", borderRadius: 10, fontSize: 12, color: "var(--color-fg)" } } as const;
const regionName = (() => { try { return new Intl.DisplayNames(undefined, { type: "region" }); } catch { return null; } })();
const country = (k: string) => (k === "Unknown" ? "Unknown" : regionName?.of(k) ?? k);

export function DaysSwitch({ days, onDays }: { days: number; onDays: (d: number) => void }) {
  return (
    <div role="radiogroup" aria-label="Period" className="inline-flex rounded-lg bg-fill p-0.5">
      {STATS_DAYS.map((d) => (
        <button key={d} type="button" role="radio" aria-checked={days === d} onClick={() => onDays(d)}
          className={cn("h-7 rounded-md px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-10 max-sm:px-3.5", days === d ? "bg-surface text-fg shadow-[var(--shadow-e1)]" : "text-muted hover:text-fg")}>{d} days</button>
      ))}
    </div>
  );
}

function TopList({ title, rows, label = (k) => k }: { title: string; rows: StatRow[]; label?: (k: string) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <section className="min-w-0 rounded-xl border border-line p-3.5" aria-label={title}>
      <h3 className="mb-2 text-[12.5px] font-medium text-muted">{title}</h3>
      {rows.length ? (
        <ul className="space-y-1.5">
          {rows.slice(0, 6).map((r) => (
            <li key={r.key} className="relative flex items-center justify-between gap-2 overflow-hidden rounded-md px-2 py-1 text-[13px]">
              <span className="absolute inset-y-0 left-0 rounded-md bg-brand-soft" style={{ width: `${(r.n / max) * 100}%` }} aria-hidden />
              <span className="relative min-w-0 truncate">{label(r.key)}</span>
              <span className="relative tabular-nums text-muted">{r.n}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[13px] text-subtle">Nothing yet</p>}
    </section>
  );
}

export function StatsView({ data, loading, error, days, onDays, csvHref, onRetry }: { data?: LinkStats; loading: boolean; error?: boolean; days: number; onDays: (d: number) => void; csvHref?: string; onRetry?: () => void }) {
  const rows = (data?.days ?? []).map((d) => ({ ...d, label: new Date(`${d.day}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }) }));
  return (
    <div className="space-y-4" data-testid="link-stats">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DaysSwitch days={days} onDays={onDays} />
        {csvHref && <a href={csvHref} download className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-[13px] font-medium hover:bg-hover max-sm:min-h-11" data-testid="stats-csv"><IconDownload className="h-4 w-4" aria-hidden />Export CSV</a>}
      </div>
      {error ? (
        <div className="rounded-xl border border-line p-4 text-sm"><p>Couldn't load the stats.</p>{onRetry && <Button size="sm" variant="outline" className="mt-2" onClick={onRetry}>Try again</Button>}</div>
      ) : loading || !data ? (
        <div className="space-y-3" aria-busy="true"><div className="grid grid-cols-3 gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[92px] rounded-xl" />)}</div><Skeleton className="h-52 rounded-xl" /></div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <StatTile label="Clicks" value={data.total} icon={<IconChart />} tone="brand" className="max-sm:p-3" />
            <StatTile label="Visitors" value={data.visitors} icon={<IconUser />} hint="Unique" className="max-sm:p-3" />
            <StatTile label="Bots left out" value={data.botClicks} icon={<IconShield />} hint="All time" className="max-sm:p-3" />
          </div>
          <div className="h-52 rounded-xl border border-line p-2 pt-3">
            <ResponsiveContainer><BarChart data={rows} margin={{ left: -20, right: 8 }}>
              <CartesianGrid vertical={false} stroke="var(--color-line)" /><XAxis dataKey="label" {...axis} minTickGap={16} /><YAxis {...axis} allowDecimals={false} /><Tooltip {...tip} />
              <Bar dataKey="clicks" name="Clicks" fill="var(--color-brand)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            </BarChart></ResponsiveContainer>
          </div>
          {data.total === 0 && <p className="text-[13px] text-muted">No clicks in this period yet. Share the link and check back.</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <TopList title="Countries" rows={data.countries} label={country} />
            <TopList title="Referrers" rows={data.referrers} />
            <TopList title="Devices" rows={data.devices} />
            <TopList title="Browsers" rows={data.browsers} />
          </div>
          <p className="text-[12px] text-subtle">Bots and link previews in chats are not counted. Multies never stores visitor addresses.</p>
        </>
      )}
    </div>
  );
}

export function useDays(initial = 30) { return useState(initial); }
