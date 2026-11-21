/**
 * OPS1: the Usage tab of a workspace (the old Usage and Trends tabs in one). First its use against the plan's limits
 * (from the workspace read the page already has), then the trend charts from GET /api/console/metrics/workspaces/:id
 * with one range picker (7, 30 or 90 days, kept in ?range=) in the section header: mail (outbound sent and failed, or
 * inbound received), AI (calls or units; AI history only goes back a couple of days, and the chart says so), and the
 * workspace's daily usage counters that exist (rows written, chat messages received and so on). No actions.
 */
import { useState } from "react";
import { Meter } from "@/web/components/ui/misc";
import { formatBytes } from "@/web/lib/format";
import { ChartCard, hasData, LazyTrendBars, LazyTrendLine, RangePicker } from "../components/kpi";
import { formatDay as formatCalendarDay } from "../components/format";
import { usePermission } from "../guard";
import { ViewChips } from "../trends-chips";
import { orderCounters, pointsOf, useTrendRange, useWorkspaceTrends } from "../trends-data";
import { Section, type WorkspaceOverview } from "./tab-shared";

type MailView = "outbound" | "inbound";
type AiView = "calls" | "units";

function UsageMeter({ label, used, max, format = (n: number) => n.toLocaleString() }: { label: string; used: number | undefined; max: number | null | undefined; format?: (n: number) => string }) {
  const n = used ?? 0;
  const unlimited = max === null || max === undefined || !Number.isFinite(max) || max <= 0;
  return (
    <div className="min-w-0 space-y-1.5 rounded-xl border border-line bg-surface p-3" data-testid="console-workspaces-meter">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="min-w-0 truncate text-muted">{label}</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">{format(n)}{!unlimited && <span className="text-subtle"> of {format(max)}</span>}</span>
      </div>
      {unlimited ? <p className="text-xs text-subtle">No limit</p> : <Meter value={n} max={max} label={`${label}: ${format(n)} of ${format(max)}`} />}
    </div>
  );
}

function LimitMeters({ w }: { w: WorkspaceOverview }) {
  const u = w.usage ?? ({} as Partial<WorkspaceOverview["usage"]>);
  const l = w.limits ?? ({} as Partial<WorkspaceOverview["limits"]>);
  const dailyCap = w.org.sendCapDaily ?? l.dailySends;
  return (
    <Section title="Against the plan's limits" description="What this workspace uses now, and this month for monthly limits." testId="console-workspaces-usage-limits">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <UsageMeter label="People" used={u.seats} max={l.seats} />
        <UsageMeter label="Domains" used={u.domains} max={l.domains} />
        <UsageMeter label="Mailboxes" used={u.mailboxes} max={l.mailboxes} />
        <UsageMeter label="Aliases" used={u.aliases} max={l.aliases} />
        <UsageMeter label="Agent inboxes" used={u.agentInboxes} max={l.agentInboxes} />
        <UsageMeter label="Agent messages this month" used={u.agentMessages} max={l.agentMessagesMonthly} />
        <UsageMeter label="Storage" used={u.storageMb} max={l.storageMb} format={(n) => formatBytes(n * 1024 * 1024)} />
        <UsageMeter label="Sent today" used={w.counts.sendsToday} max={dailyCap} />
        <UsageMeter label="Call minutes this month" used={w.counts.meetingMinutesThisMonth} max={w.org.meetingMinutesCap} />
      </div>
    </Section>
  );
}

function Trends({ orgId }: { orgId: string }) {
  const [days, setDays] = useTrendRange();
  const [mailView, setMailView] = useState<MailView>("outbound");
  const [aiView, setAiView] = useState<AiView>("calls");
  const [counterPick, setCounterPick] = useState<string | null>(null);
  const q = useWorkspaceTrends(orgId, days);
  const data = q.data;
  const common = { loading: q.isPending, error: q.error ?? undefined, onRetry: () => void q.refetch() };

  const mail = mailView === "outbound"
    ? [{ label: "Sent", rows: pointsOf(data, "deliveries_sent") }, { label: "Failed or bounced", rows: pointsOf(data, "deliveries_failed"), tone: "bad" as const }]
    : [{ label: "Received", rows: pointsOf(data, "deliveries_received") }];
  const aiRows = pointsOf(data, aiView === "calls" ? "ai_calls" : "ai_units");
  const aiNote = data?.ai.partial && data.ai.from
    ? ` AI history is only kept for the last ${data.ai.historyDays} days, so days before ${formatCalendarDay(data.ai.from, { timeZone: "UTC" })} show no data.`
    : "";

  const counters = orderCounters(Object.keys(data?.series ?? {}).filter((k) => hasData(pointsOf(data, k))));
  const counter = counters.find((c) => c.id === counterPick) ?? counters[0];
  const counterRows = counter ? pointsOf(data, counter.id) : [];

  return (
    <section aria-labelledby="console-ws-trends-h" className="space-y-3" data-testid="console-workspace-trends">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <h2 id="console-ws-trends-h" className="text-[15px] font-semibold">Trends</h2>
          <p className="text-[13px] text-muted">This workspace per day, in UTC. Today so far is included.</p>
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

export function WorkspaceUsageTab({ w }: { w: WorkspaceOverview }) {
  const canTrends = usePermission("metrics.read");
  return (
    <div className="space-y-6" data-testid="console-workspaces-usage">
      <LimitMeters w={w} />
      {canTrends && <Trends orgId={w.org.id} />}
    </div>
  );
}
