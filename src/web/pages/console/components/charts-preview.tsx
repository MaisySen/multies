/**
 * OPS1 Trends: a preview of the console charts and KPI tiles with sample data (gaps, zeros, one day, empty, loading
 * and error). Not routed; used to check the components by eye in light and dark, desktop and phone widths. Mount it
 * inside a router (the tiles link). Safe to delete once the Overview uses the components.
 */
import { useState } from "react";
import { ChartCard, fillDays, hasData, KpiTile, LazyTrendBars, LazyTrendLine, rangeStart, RangePicker, type RangeDays, type TrendPoint } from "./kpi";

const TODAY = "2026-11-21";

/** A deterministic wavy series with a weekly dip, so screenshots do not change between runs. */
function sample(days: number, base: number, swing: number, seed: number): TrendPoint[] {
  return fillDays(rangeStart(TODAY, days), TODAY, []).map((p, i) => {
    const weekend = (i + seed) % 7 >= 5 ? 0.55 : 1;
    const v = Math.round((base + swing * Math.sin((i + seed) / 3.1) + (i * base) / 400) * weekend);
    return { day: p.day, value: Math.max(0, v) };
  });
}
const withGaps = (rows: TrendPoint[]) => rows.map((r, i) => ((i >= 9 && i <= 12) || i === 20 || i === 22 ? { ...r, value: null } : r));
const withZeros = (rows: TrendPoint[]) => rows.map((r, i) => (i % 6 === 2 ? { ...r, value: 0 } : r));

export default function ChartsPreview() {
  const [days, setDays] = useState<RangeDays>(30);
  const sent = sample(days, 1200, 380, 1);
  const failed = sample(days, 40, 25, 4);
  const signups = withGaps(sample(days, 14, 8, 2));
  const deadJobs = withZeros(sample(days, 3, 3, 3));
  const single = fillDays(rangeStart(TODAY, days), TODAY, [{ day: rangeStart(TODAY, 4), value: 18 }]);
  const empty = fillDays(rangeStart(TODAY, days), TODAY, []);
  const since = rangeStart(TODAY, 12);
  const stock = fillDays(rangeStart(TODAY, days), TODAY, sample(12, 900, 40, 5));
  const period = `vs previous ${days} days`;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6" data-testid="charts-preview">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Charts preview</h1>
        <RangePicker value={days} onChange={setDays} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Sign ups" value={412} previous={380} periodLabel={period} trend={signups} to="/console/users" />
        <KpiTile label="Failed deliveries" value={1843} previous={1290} higherIsBetter={false} periodLabel={period} trend={failed} />
        <KpiTile label="Paid workspaces" value={2_340_120} previous={2_340_120} periodLabel={period} trend={stock} since={since} />
        <KpiTile label="Dead jobs" value={0} previous={7} higherIsBetter={false} periodLabel={period} trend={deadJobs} />
        <KpiTile label="Storage used" value={null} previous={null} hint="Waiting for the first daily roll up" />
        <KpiTile label="New domains" value={40} previous={0} higherIsBetter={null} periodLabel={period} />
        <KpiTile label="AI calls" value={12} previous={12} periodLabel={period} />
        <KpiTile label="Loading tile" value={0} loading />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Deliveries" description="Sent and failed per day" action={<RangePicker value={days} onChange={setDays} />}>
          <LazyTrendLine label="Deliveries" series={[{ label: "Sent", rows: sent }, { label: "Failed", rows: failed, tone: "bad" }]} />
        </ChartCard>
        <ChartCard title="Sign ups" description="New accounts per day, with gaps where no data was recorded">
          <LazyTrendLine label="Sign ups" series={[{ label: "Sign ups", rows: signups }]} />
        </ChartCard>
        <ChartCard title="Dead jobs" description="Jobs that ran out of retries, per day (zeros included)">
          <LazyTrendBars label="Dead jobs" series={[{ label: "Dead jobs", rows: deadJobs }]} />
        </ChartCard>
        <ChartCard title="Deliveries (bars)" description="Sent and failed per day as grouped bars">
          <LazyTrendBars label="Deliveries" series={[{ label: "Sent", rows: sample(days, 120, 40, 1) }, { label: "Failed", rows: withGaps(sample(days, 30, 20, 4)) }]} />
        </ChartCard>
        <ChartCard title="Paid workspaces" description="Recorded daily since the console shipped">
          <LazyTrendLine label="Paid workspaces" series={[{ label: "Paid workspaces", rows: stock }]} />
        </ChartCard>
        <ChartCard title="One day of data" description="Only a single day has a value">
          <LazyTrendLine label="Reports" series={[{ label: "Reports", rows: single }]} />
        </ChartCard>
        <ChartCard title="Abuse events" description="Signals raised per day" empty={!hasData(empty)} emptyText="Numbers appear after the first daily roll up.">
          <LazyTrendLine label="Abuse events" series={[{ label: "Abuse events", rows: empty }]} />
        </ChartCard>
        <ChartCard title="AI calls" description="Calls per day" loading>
          <LazyTrendBars label="AI calls" series={[]} />
        </ChartCard>
        <ChartCard title="Webhook failures" description="Failed deliveries per day" error={new Error("The server answered 503.")} onRetry={() => undefined}>
          <LazyTrendLine label="Webhook failures" series={[]} />
        </ChartCard>
      </div>
    </div>
  );
}
