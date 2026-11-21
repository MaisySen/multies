/**
 * OPS1: the Overview tab of a workspace: its state, its limits (with the sending switch) and today's write budget.
 * Usage against the plan's limits lives on the Usage tab; counts of keys, endpoints and the like on their own tabs.
 */
import { Link } from "react-router";
import { Badge, Card, Meter, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { KvList } from "../components/kv-list";
import { Day, RelTime, StatusBadge, humanize, type StatusTone } from "../components/format";
import { usePermission } from "../guard";
import { Section, capText, useLimitActions, workspacePlanLabel, wsPath, type WorkspaceOverview } from "./tab-shared";

const BUDGET: Record<string, { label: string; tone: StatusTone }> = {
  ok: { label: "Normal", tone: "ok" }, near: { label: "Near the budget", tone: "warn" }, over: { label: "Over the budget", tone: "bad" }, off: { label: "Not enforced", tone: "neutral" },
};

/** The country's name in the operator's language ("AU" -> "Australia"), the code when the browser has no name. */
function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  try { return new Intl.DisplayNames(undefined, { type: "region" }).of(code.toUpperCase()) ?? code; } catch { return code; }
}

export function WorkspaceOverviewTab({ w }: { w: WorkspaceOverview }) {
  const o = w.org;
  const canLimits = usePermission("workspaces.limits");
  const limits = useLimitActions();
  const suspended = !!o.suspendedAt;
  const sendingOn = o.sendCapDaily !== 0;
  const target = { id: o.id, name: o.name };
  const b = w.writeBudget;
  const budget = BUDGET[b.level];
  const sendingText = suspended
    ? "Stopped while suspended. Restore the workspace to send again."
    : sendingOn ? "On. Sends follow the daily cap below." : "Off. Every send is refused until it is turned back on.";
  return (
    <div className="space-y-6" data-testid="console-workspaces-overview">
      <Section title="State">
        <KvList items={[
          { label: "Plan", value: workspacePlanLabel(o) },
          { label: "Subscription", value: o.subscriptionStatus ? <span>{humanize(o.subscriptionStatus)}{o.billingInterval && <span className="text-subtle">, billed every {o.billingInterval}</span>}</span> : null },
          { label: "Renews", value: o.currentPeriodEnd ? <span className="inline-flex flex-wrap items-center gap-2"><Day at={o.currentPeriodEnd} />{o.cancelAtPeriodEnd && <Badge tone="warn" className="whitespace-nowrap">Cancels at period end</Badge>}</span> : null },
          { label: "Past due since", value: o.pastDueSince ? <Day at={o.pastDueSince} /> : null, hint: o.graceEndsAt ? <>Grace ends <Day at={o.graceEndsAt} /></> : undefined },
          { label: "Suspended", value: o.suspendedAt ? <span><RelTime at={o.suspendedAt} />{o.suspendedReason && <span className="text-muted">: {o.suspendedReason}</span>}</span> : "No" },
          { label: "Single sign on required", value: o.requireSso ? "Yes" : "No" },
          { label: "Time zone", value: o.timezone },
          { label: "Country", value: countryName(o.country) },
          { label: "Created", value: <Day at={o.createdAt} /> },
        ]} />
      </Section>

      <Section title="Limits" description={<>Operator limits on top of the plan. Changes are kept in the audit log with your reason. Usage against the plan is on the <Link to={`${wsPath(o.id)}/usage`} className="text-brand hover:underline">Usage tab</Link>.</>}>
        <Card className="divide-y divide-line p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Sending</p>
              <p className="text-[13px] text-muted" data-testid="console-workspaces-sending-state">{sendingText}</p>
            </div>
            {canLimits
              ? <Switch checked={sendingOn && !suspended} disabled={suspended} label={suspended ? "Sending, stopped while suspended" : "Sending"} testId="admin-sending-toggle" onChange={(v) => limits.openSending({ ...target, enabled: v })} />
              : suspended
                ? <StatusBadge state="suspended" label="Stopped while suspended" />
                : <StatusBadge state={sendingOn ? "on" : "off"} label={sendingOn ? "On" : "Off"} tone={sendingOn ? "ok" : "bad"} />}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Daily send cap</p>
              <p className="text-[13px] text-muted">{capText(o.sendCapDaily, "a day")}. Plan allows {(w.limits.dailySends ?? 0).toLocaleString()} a day. Sent today: {w.counts.sendsToday.toLocaleString()}.</p>
            </div>
            {canLimits && <Button size="sm" variant="secondary" onClick={() => limits.openSendCap({ ...target, current: o.sendCapDaily })} data-testid="console-workspaces-send-cap">Change</Button>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Call minutes cap</p>
              <p className="text-[13px] text-muted">{capText(o.meetingMinutesCap, "minutes a month")}. Used this month: {w.counts.meetingMinutesThisMonth.toLocaleString()}.</p>
            </div>
            {canLimits && <Button size="sm" variant="secondary" onClick={() => limits.openMeetingCap({ ...target, current: o.meetingMinutesCap })} data-testid="console-workspaces-meeting-cap">Change</Button>}
          </div>
        </Card>
      </Section>

      <Section title="Write budget today" description="Rows this workspace wrote today against its daily budget. It resets at midnight UTC.">
        <Card className="space-y-2 p-4" data-testid="console-workspaces-write-budget">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="tabular-nums">{b.used.toLocaleString()} of {b.budget.toLocaleString()} rows</span>
            <span className="flex items-center gap-2">
              <StatusBadge state={b.level} label={budget?.label} tone={budget?.tone} />
              <span className="text-subtle">Resets <RelTime at={b.resetAt} /></span>
            </span>
          </div>
          <Meter value={b.used} max={b.budget} label={`Write budget: ${b.used} of ${b.budget} rows`} />
        </Card>
      </Section>
      {limits.dialogs}
    </div>
  );
}
