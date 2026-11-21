/**
 * OPS1 Trends: the Trends tab of a workspace's console page. A range picker (7, 30 or 90 days, kept in ?range=) and
 * three charts from GET /api/console/metrics/workspaces/:id: mail (outbound sent and failed, or inbound received),
 * AI (calls or units; AI history only goes back a couple of days, and the chart says so), and the workspace's daily
 * usage counters that exist (rows written, chat messages received and so on). No actions.
 */
import { useState } from "react";
import { ChartCard, formatDay, hasData, LazyTrendBars, LazyTrendLine, RangePicker } from "../components/kpi";
import { ViewChips } from "../trends-chips";
import { counterLabel, pointsOf, useTrendRange, useWorkspaceTrends } from "../trends-data";

type MailView = "outbound" | "inbound";
type AiView = "calls" | "units";

export function WorkspaceTrendsTab({ orgId }: { orgId: string }) {
  const [days, setDays] = useTrendRange();
  const [mailView, setMailView] = useState<MailView>("outbound");
  const [aiView, setAiView] = useState<AiView>("calls");
  const [counterPick, setCounterPick] = useState<string | null>(null);
  const q = useWorkspaceTrends(orgId, days);
  const data = q.data;
  const common = { loading: q.isPending, error: q.error ?? undefined, onRetry: () => void q.refetch() };

  const mail = mailView === "outbound"
    ? [{ label: "Sent", rows: pointsOf(data, "deliveries_sent") }, { label: "Failed", rows: pointsOf(data, "deliveries_failed"), tone: "bad" as const }]
    : [{ label: "Received", rows: pointsOf(data, "deliveries_received") }];
  const aiRows = pointsOf(data, aiView === "calls" ? "ai_calls" : "ai_units");
  const aiNote = data?.ai.partial && data.ai.from
    ? ` AI history is only kept for the last ${data.ai.historyDays} days, so days before ${formatDay(data.ai.from, "medium")} show no data.`
    : "";

  const counters = Object.keys(data?.series ?? {})
    .filter((k) => k.startsWith("usage:") && hasData(pointsOf(data, k)))
    .sort()
    .map((k) => ({ id: k, label: counterLabel(k.slice("usage:".length)) }));
  const counter = counters.find((c) => c.id === counterPick) ?? counters[0];
  const counterRows = counter ? pointsOf(data, counter.id) : [];

  return (
    <section aria-labelledby="console-ws-trends-h" className="space-y-3" data-testid="console-workspace-trends">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h2 id="console-ws-trends-h" className="text-[15px] font-semibold">Trends</h2>
          <p className="text-[12.5px] text-muted">This workspace per day, in UTC. Today so far is included.</p>
        </div>
        <RangePicker value={days} onChange={setDays} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <ChartCard {...common} title="Mail" description={mailView === "outbound" ? "Outbound mail sent and failed." : "Inbound mail received."}
          empty={!hasData(mail)}
          action={<ViewChips label="Mail direction" value={mailView} onChange={setMailView} testId="console-workspace-trends-mail-view"
            options={[{ id: "outbound", label: "Outbound" }, { id: "inbound", label: "Inbound" }]} />}
          testId="console-workspace-trends-mail">
          <LazyTrendLine label="Mail" series={mail} />
        </ChartCard>
        <ChartCard {...common} title="AI" description={`${aiView === "calls" ? "AI requests" : "AI units spent"} per day.${aiNote}`}
          empty={!hasData(aiRows)} emptyText={aiNote ? aiNote.trim() : "No AI use in this range."}
          action={<ViewChips label="AI measure" value={aiView} onChange={setAiView} testId="console-workspace-trends-ai-view"
            options={[{ id: "calls", label: "Calls" }, { id: "units", label: "Units" }]} />}
          testId="console-workspace-trends-ai">
          <LazyTrendBars label={aiView === "calls" ? "AI calls" : "AI units"} series={[{ label: aiView === "calls" ? "Calls" : "Units", rows: aiRows }]} />
        </ChartCard>
        <ChartCard {...common} className="lg:col-span-2" title="Daily usage" description={counter ? `${counter.label} per day.` : "Daily usage counters this workspace keeps."}
          empty={!counter} emptyText="This workspace has no daily usage counters in this range."
          action={counter && <ViewChips label="Usage counter" value={counter.id} onChange={setCounterPick} options={counters} testId="console-workspace-trends-usage-view" />}
          testId="console-workspace-trends-usage">
          {counter && <LazyTrendBars label={counter.label} series={[{ label: counter.label, rows: counterRows }]} />}
        </ChartCard>
      </div>
    </section>
  );
}
