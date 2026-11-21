/**
 * OPS1 Trends: the trends block of the console Overview. One range picker (7, 30 or 90 days, kept in ?range=), six
 * KPI tiles with the change against the previous period of the same length, and four charts: growth, mail, workspaces
 * by state and reliability. Daily counts come from GET /api/console/metrics (stored days plus today live); a day with
 * no stored value is "no data", never zero. Workspace counts by state only start on the day the daily rollup first
 * ran, so their charts say since when. When no daily counts are stored yet, operators who run the platform see a
 * small "Fill in history" action (POST /api/console/metrics/backfill, with a reason).
 */
import { useMemo, useState } from "react";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState } from "@/web/components/ui/misc";
import { Field, Select } from "@/web/components/ui/input";
import { IconWarning } from "@/web/components/ui/icon";
import { errorMessage } from "@/web/lib/api";
import { ChartCard, formatDay, formatNumber, hasData, KpiTile, LazyTrendBars, LazyTrendLine, RangePicker } from "./components/kpi";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { ViewChips } from "./trends-chips";
import {
  lastOf, noStoredDays, pointsOf, previousRange, sinceOf, sumOf, trendsApi, useMetricsRead, useMetricsRegistry, useTrendRange,
  type MetricsRead, type RunSummary,
} from "./trends-data";

const TILE_METRICS = ["signups", "workspaces_created", "workspaces_paid", "deliveries_sent", "deliveries_failed", "ai_calls"] as const;
const STATE_METRICS = ["workspaces_paid", "workspaces_past_due", "workspaces_suspended"] as const;
const RELIABILITY_METRICS = ["jobs_dead", "webhook_deliveries_failed", "uptime_pct"] as const;
const ALL_METRICS = [...new Set<string>([...TILE_METRICS, ...STATE_METRICS, ...RELIABILITY_METRICS])];
/** Counts that can be filled in for past days; when none has a stored day, offer the backfill. */
const FLOW_METRICS = ["signups", "workspaces_created", "deliveries_sent", "deliveries_failed", "jobs_dead", "webhook_deliveries_failed"] as const;
const STOCK = new Set<string>(["workspaces_paid"]);

type StateView = (typeof STATE_METRICS)[number];
const STATE_VIEWS: { id: StateView; label: string }[] = [
  { id: "workspaces_paid", label: "Paid" },
  { id: "workspaces_past_due", label: "Past due" },
  { id: "workspaces_suspended", label: "Suspended" },
];

const percent = (n: number) => `${formatNumber(n)}%`;

function sinceText(day: string | null) {
  return day ? `Recorded daily since ${formatDay(day, "medium")}.` : undefined;
}

function FillInHistory() {
  const [days, setDays] = useState(90);
  const action = useOperatorAction<void, RunSummary>({
    title: "Fill in history",
    description: "Counts sign ups, new workspaces, mail, agent runs, dead jobs and failed webhooks for past days from the records Multies still keeps. Workspace counts by state can't be filled in; they start with the first daily rollup.",
    confirmLabel: "Fill in history",
    fields: (
      <Field label="How far back">
        {(p) => (
          <Select {...p} value={String(days)} onChange={(e) => setDays(Number(e.target.value))} data-testid="console-trends-backfill-days">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        )}
      </Field>
    ),
    run: (_v, reason) => trendsApi.backfill({ days, reason }),
    success: "History filled in",
  });
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => action.open()} data-testid="console-trends-backfill">Fill in history</Button>
      {action.dialog}
    </>
  );
}

function Tiles({ current, previous, loading, days, aiDays }: {
  current: MetricsRead | undefined; previous: MetricsRead | undefined; loading: boolean; days: number; aiDays: number | null;
}) {
  const value = (read: MetricsRead | undefined, key: string) => {
    const pts = pointsOf(read, key);
    return STOCK.has(key) ? lastOf(pts) : sumOf(pts);
  };
  const tile = (key: (typeof TILE_METRICS)[number], label: string, extra: { higherIsBetter?: boolean; to?: string; hint?: string } = {}) => (
    <KpiTile
      key={key}
      label={label}
      loading={loading}
      value={value(current, key)}
      previous={previous ? value(previous, key) : undefined}
      periodLabel={`vs previous ${days} days`}
      trend={pointsOf(current, key)}
      since={STOCK.has(key) ? sinceOf(current, [key]) : undefined}
      higherIsBetter={extra.higherIsBetter}
      to={extra.to}
      hint={extra.hint}
      testId={`console-trends-tile-${key}`}
    />
  );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6" data-testid="console-trends-tiles">
      {tile("signups", "New sign ups", { to: "/console/users" })}
      {tile("workspaces_created", "New workspaces", { to: "/console/workspaces" })}
      {tile("workspaces_paid", "Paid workspaces", { to: "/console/billing" })}
      {tile("deliveries_sent", "Mail sent", { to: "/console/mail" })}
      {tile("deliveries_failed", "Failed deliveries", { higherIsBetter: false, to: "/console/mail" })}
      {tile("ai_calls", "AI calls", { hint: aiDays ? `Only the last ${aiDays} days are kept` : undefined })}
    </div>
  );
}

export function OverviewTrends() {
  const [days, setDays] = useTrendRange();
  const [stateView, setStateView] = useState<StateView>("workspaces_paid");
  const canBackfill = usePermission("system.manage");
  const registry = useMetricsRegistry();
  const cur = useMetricsRead({ metrics: ALL_METRICS.join(","), days: String(days) });
  const prevQuery = useMemo(() => {
    if (!cur.data) return null;
    const r = previousRange(cur.data.from, days);
    return { metrics: TILE_METRICS.join(","), from: r.from, to: r.to };
  }, [cur.data, days]);
  const prev = useMetricsRead(prevQuery);
  const current = cur.data;
  const aiDays = registry.data?.metrics.find((m) => m.key === "ai_calls")?.retentionDays ?? null;

  const growth = [
    { label: "Sign ups", rows: pointsOf(current, "signups") },
    { label: "New workspaces", rows: pointsOf(current, "workspaces_created"), tone: "neutral" as const },
  ];
  const mail = [
    { label: "Sent", rows: pointsOf(current, "deliveries_sent") },
    // A bounce counts as sent and as failed, so the label says both.
    { label: "Failed or bounced", rows: pointsOf(current, "deliveries_failed"), tone: "bad" as const },
  ];
  const stateRows = pointsOf(current, stateView);
  const stateLabel = STATE_VIEWS.find((v) => v.id === stateView)!.label;
  const reliability = [
    { label: "Dead jobs", rows: pointsOf(current, "jobs_dead"), tone: "bad" as const },
    { label: "Failed webhooks", rows: pointsOf(current, "webhook_deliveries_failed"), tone: "neutral" as const },
  ];
  const uptimeRows = pointsOf(current, "uptime_pct");
  const uptime = lastOf(uptimeRows);
  const uptimeDay = [...uptimeRows].reverse().find((p) => typeof p.value === "number")?.day ?? null;
  const showBackfill = canBackfill && noStoredDays(current, FLOW_METRICS);
  const common = { loading: cur.isPending, error: cur.error ?? undefined, onRetry: () => void cur.refetch() };

  return (
    <section aria-labelledby="console-trends-h" className="space-y-3" data-testid="console-trends">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h2 id="console-trends-h" className="text-[15px] font-semibold">Trends</h2>
          <p className="text-[12.5px] text-muted">Daily totals in UTC. Today so far is included.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showBackfill && <FillInHistory />}
          <RangePicker value={days} onChange={setDays} />
        </div>
      </div>
      {cur.error ? (
        <Card className="p-0" data-testid="console-trends-error">
          <EmptyState icon={<IconWarning />} title="Couldn't load the trends" body={errorMessage(cur.error)} action={<Button variant="secondary" onClick={() => void cur.refetch()}>Try again</Button>} />
        </Card>
      ) : (
        <>
          <Tiles current={current} previous={prev.data} loading={cur.isPending} days={days} aiDays={aiDays} />
          <div className="grid gap-3 lg:grid-cols-2">
            <ChartCard {...common} title="Growth" description="New sign ups and new workspaces per day." empty={!hasData(growth)}
              emptyText="Past days show here once the daily rollup has run." testId="console-trends-growth">
              <LazyTrendBars label="Growth" series={growth} />
            </ChartCard>
            <ChartCard {...common} title="Mail" description="Outbound mail sent and failed per day." empty={!hasData(mail)} testId="console-trends-mail">
              <LazyTrendLine label="Mail" series={mail} />
            </ChartCard>
            <ChartCard {...common} title="Workspaces by state" description={sinceText(sinceOf(current, STATE_METRICS)) ?? "Workspaces at the end of each day."}
              empty={!hasData(stateRows)} emptyText="These counts are recorded once a day, starting with the first daily rollup."
              action={<ViewChips label="Workspace state" value={stateView} onChange={setStateView} options={STATE_VIEWS} testId="console-trends-state-view" />}
              testId="console-trends-state">
              <LazyTrendLine label={`${stateLabel} workspaces`} series={[{ label: stateLabel, rows: stateRows, tone: stateView === "workspaces_paid" ? "brand" : "bad" }]} />
            </ChartCard>
            <ChartCard {...common} title="Reliability" description={
              <>Dead jobs and failed webhook deliveries per day. {uptime !== null && uptimeDay
                ? <span data-testid="console-trends-uptime">Uptime {percent(uptime)} on {formatDay(uptimeDay, "medium")}.</span>
                : <span data-testid="console-trends-uptime">No uptime checks recorded yet.</span>}</>
            } empty={!hasData(reliability)} testId="console-trends-reliability">
              <LazyTrendBars label="Reliability" series={reliability} />
            </ChartCard>
          </div>
        </>
      )}
    </section>
  );
}
