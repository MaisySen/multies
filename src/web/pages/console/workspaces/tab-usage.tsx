/** OPS1: the Usage tab of a workspace: this month's counters and a day by day series of sends and AI use. */
import { useState } from "react";
import { ChartCard, LazyTrendBars, LazyTrendLine, RangePicker, hasData, type RangeDays, type TrendPoint } from "../components/kpi";
import { KvList } from "../components/kv-list";
import { ErrorBlock, LoadingBlock, Section, useWorkspacePart, type PlanLimits, type UsageTotals } from "./tab-shared";

interface UsageDay { day: string; aiUnits: number; aiCalls: number; outbound: number; outboundFailed: number; inbound: number; counters: Record<string, number> }
interface WorkspaceUsage {
  totals: UsageTotals; limits: PlanLimits;
  month: { period: string; counters: Record<string, number> };
  range: { from: string; to: string; days: number };
  daily: UsageDay[];
}

const series = (rows: UsageDay[], pick: (d: UsageDay) => number): TrendPoint[] => rows.map((d) => ({ day: d.day, value: pick(d) }));
const counterLabel = (k: string) => { const s = k.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

export function WorkspaceUsageTab({ orgId }: { orgId: string }) {
  const [days, setDays] = useState<RangeDays>(30);
  const q = useWorkspacePart<WorkspaceUsage>(orgId, "usage", `/usage?days=${days}`);
  const picker = <RangePicker value={days} onChange={setDays} />;
  if (q.error) return <ErrorBlock error={q.error} retry={() => void q.refetch()} />;
  const d = q.data;
  const sent = d ? series(d.daily, (x) => x.outbound) : [];
  const failed = d ? series(d.daily, (x) => x.outboundFailed) : [];
  const inbound = d ? series(d.daily, (x) => x.inbound) : [];
  const ai = d ? series(d.daily, (x) => x.aiCalls) : [];
  const counters = d ? Object.entries(d.month.counters).sort(([a], [b]) => a.localeCompare(b)) : [];
  return (
    <div className="space-y-6" data-testid="console-workspaces-usage">
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Mail sent" description="Messages to outside recipients per day, and how many failed" loading={q.isPending} empty={!hasData(sent)} action={picker}>
          <LazyTrendLine label="Mail sent" series={[{ label: "Sent", rows: sent }, { label: "Failed", rows: failed, tone: "bad" }]} />
        </ChartCard>
        <ChartCard title="Mail received" description="Messages that arrived per day" loading={q.isPending} empty={!hasData(inbound)}>
          <LazyTrendBars label="Mail received" series={[{ label: "Received", rows: inbound }]} />
        </ChartCard>
        <ChartCard title="AI requests" description="AI calls per day" loading={q.isPending} empty={!hasData(ai)} className="lg:col-span-2">
          <LazyTrendBars label="AI requests" series={[{ label: "AI calls", rows: ai }]} />
        </ChartCard>
      </div>
      <Section title="This month" description={d ? `Counters for ${d.month.period}.` : undefined}>
        {q.isPending ? <LoadingBlock rows={2} /> : counters.length
          ? <KvList items={counters.map(([k, v]) => ({ label: counterLabel(k), value: v.toLocaleString() }))} />
          : <p className="text-[13px] text-muted">Nothing counted this month yet.</p>}
      </Section>
    </div>
  );
}
