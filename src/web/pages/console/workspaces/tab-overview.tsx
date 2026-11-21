/**
 * OPS1: the Overview tab of a workspace: its state, its limits (with the sending switch), usage against the plan's
 * limits, and today's write budget.
 */
import { Badge, Card, Meter, Switch } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { formatBytes } from "@/web/lib/format";
import { KvList } from "../components/kv-list";
import { usePermission } from "../guard";
import { PLAN_LABEL, Section, When, capText, useLimitActions, type WorkspaceOverview } from "./tab-shared";

const BUDGET: Record<string, { tone: "ok" | "warn" | "bad" | "neutral"; label: string }> = {
  ok: { tone: "ok", label: "Normal" }, near: { tone: "warn", label: "Near the budget" }, over: { tone: "bad", label: "Over the budget" }, off: { tone: "neutral", label: "Not enforced" },
};

function UsageMeter({ label, used, max, format = (n: number) => n.toLocaleString() }: { label: string; used: number; max: number | null; format?: (n: number) => string }) {
  const unlimited = max === null || !Number.isFinite(max) || max <= 0;
  return (
    <div className="min-w-0 space-y-1.5 rounded-xl border border-line bg-surface p-3" data-testid="console-workspaces-meter">
      <div className="flex items-baseline justify-between gap-2 text-[13px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">{format(used)}{!unlimited && <span className="text-subtle"> of {format(max)}</span>}</span>
      </div>
      {unlimited ? <p className="text-xs text-subtle">No limit</p> : <Meter value={used} max={max} label={`${label}: ${format(used)} of ${format(max)}`} />}
    </div>
  );
}

export function WorkspaceOverviewTab({ w }: { w: WorkspaceOverview }) {
  const o = w.org;
  const canLimits = usePermission("workspaces.limits");
  const limits = useLimitActions();
  const sendingOn = o.sendCapDaily !== 0;
  const target = { id: o.id, name: o.name };
  const dailyCap = o.sendCapDaily ?? w.limits.dailySends;
  const b = w.writeBudget;
  return (
    <div className="space-y-6" data-testid="console-workspaces-overview">
      <Section title="State">
        <KvList items={[
          { label: "Plan", value: <span>{PLAN_LABEL[o.plan] ?? o.plan}{o.compPlan && <span className="text-subtle"> (comp, runs as {PLAN_LABEL[o.effectivePlan]})</span>}</span> },
          { label: "Subscription", value: o.subscriptionStatus ? <span>{o.subscriptionStatus.replace(/_/g, " ")}{o.billingInterval && <span className="text-subtle">, billed every {o.billingInterval}</span>}</span> : null },
          { label: "Renews", value: o.currentPeriodEnd ? <span><When at={o.currentPeriodEnd} />{o.cancelAtPeriodEnd && <Badge tone="warn" className="ml-2">Cancels at period end</Badge>}</span> : null },
          { label: "Past due since", value: o.pastDueSince ? <When at={o.pastDueSince} /> : null, hint: o.graceEndsAt ? <>Grace ends <When at={o.graceEndsAt} /></> : undefined },
          { label: "Suspended", value: o.suspendedAt ? <span><When at={o.suspendedAt} />{o.suspendedReason && <span className="text-muted">: {o.suspendedReason}</span>}</span> : "No" },
          { label: "Single sign on required", value: o.requireSso ? "Yes" : "No" },
          { label: "Time zone", value: o.timezone },
          { label: "Country", value: o.country },
          { label: "Created", value: <When at={o.createdAt} /> },
        ]} />
      </Section>

      <Section title="Limits" description="Operator limits on top of the plan. Changes are kept in the audit log with your reason.">
        <Card className="divide-y divide-line p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Sending</p>
              <p className="text-[13px] text-muted">{sendingOn ? "On. Sends follow the daily cap below." : "Off. Every send is refused until it is turned back on."}</p>
            </div>
            {canLimits
              ? <Switch checked={sendingOn} label="Sending" testId="admin-sending-toggle" onChange={(v) => limits.openSending({ ...target, enabled: v })} />
              : <Badge tone={sendingOn ? "ok" : "bad"} dot>{sendingOn ? "On" : "Off"}</Badge>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Daily send cap</p>
              <p className="text-[13px] text-muted">{capText(o.sendCapDaily, "a day")}. Plan allows {w.limits.dailySends.toLocaleString()} a day. Sent today: {w.counts.sendsToday.toLocaleString()}.</p>
            </div>
            {canLimits && <Button size="sm" variant="secondary" onClick={() => limits.openSendCap({ ...target, current: o.sendCapDaily })} data-testid="console-workspaces-send-cap">Change</Button>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Call minutes cap</p>
              <p className="text-[13px] text-muted">{capText(o.meetingMinutesCap, "minutes a month")}. Used this month: {w.counts.meetingMinutesThisMonth.toLocaleString()}.</p>
            </div>
            {canLimits && <Button size="sm" variant="secondary" onClick={() => limits.openMeetingCap({ ...target, current: o.meetingMinutesCap })} data-testid="console-workspaces-meeting-cap">Change</Button>}
          </div>
        </Card>
      </Section>

      <Section title="Usage against limits">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <UsageMeter label="People" used={w.usage.seats} max={w.limits.seats} />
          <UsageMeter label="Domains" used={w.usage.domains} max={w.limits.domains} />
          <UsageMeter label="Mailboxes" used={w.usage.mailboxes} max={w.limits.mailboxes} />
          <UsageMeter label="Aliases" used={w.usage.aliases} max={w.limits.aliases} />
          <UsageMeter label="Agent inboxes" used={w.usage.agentInboxes} max={w.limits.agentInboxes} />
          <UsageMeter label="Agent messages this month" used={w.usage.agentMessages} max={w.limits.agentMessagesMonthly} />
          <UsageMeter label="Storage" used={w.usage.storageMb} max={w.limits.storageMb} format={(n) => formatBytes(n * 1024 * 1024)} />
          <UsageMeter label="Sent today" used={w.counts.sendsToday} max={dailyCap} />
          <UsageMeter label="Call minutes this month" used={w.counts.meetingMinutesThisMonth} max={o.meetingMinutesCap} />
        </div>
      </Section>

      <Section title="Write budget today" description="Rows this workspace wrote today against its daily budget. It resets at midnight UTC.">
        <Card className="space-y-2 p-4" data-testid="console-workspaces-write-budget">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="tabular-nums">{b.used.toLocaleString()} of {b.budget.toLocaleString()} rows</span>
            <span className="flex items-center gap-2">
              <Badge tone={BUDGET[b.level]?.tone ?? "neutral"} dot>{BUDGET[b.level]?.label ?? b.level}</Badge>
              <span className="text-subtle">Resets <When at={b.resetAt} /></span>
            </span>
          </div>
          <Meter value={b.used} max={b.budget} label={`Write budget: ${b.used} of ${b.budget} rows`} />
        </Card>
      </Section>

      <Section title="Counts">
        <KvList items={[
          { label: "People", value: w.counts.members.toLocaleString() },
          { label: "Agent members", value: w.counts.agentMembers.toLocaleString() },
          { label: "Pending invites", value: w.counts.pendingInvites.toLocaleString() },
          { label: "Agent inboxes", value: w.counts.agents.toLocaleString() },
          { label: "API keys", value: w.counts.apiKeys.toLocaleString() },
          { label: "Webhook endpoints", value: `${w.counts.webhookEndpoints.toLocaleString()}${w.counts.webhookEndpointsDisabled ? ` (${w.counts.webhookEndpointsDisabled} turned off)` : ""}` },
          { label: "Connected apps", value: w.counts.activeOauthGrants.toLocaleString() },
        ]} />
      </Section>
      {limits.dialogs}
    </div>
  );
}
