/**
 * OPS1: the "Delivery problems" tab. The workspaces with the worst outbound failure rate first, then every failed
 * delivery in the window, then the held sends (messages a sending limit is holding back). No subjects, bodies or
 * addresses of recipients: what happened, where, and when.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { consoleKeys } from "@/web/lib/console-api";
import { num } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { tableStyles as T } from "@/web/components/ui/misc";
import { Field, Select } from "@/web/components/ui/input";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { IconMailWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { DataTable, consoleTable } from "./components/data-table";
import { useUrlParams, type FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { Empty, EmptyRow, LoadError, RelTime, StatusBadge, humanize, statusTone, type StatusTone } from "./components/format";
import { PermissionGate, usePermission } from "./guard";
import { mailApi, SectionList, Workspace, type MailDelivery, type MailFailureRate, type MailQueuedSend } from "./mail-shared";

const STATUS: FilterDef = {
  key: "status", label: "Status", initial: "",
  options: [
    { value: "", label: "Any failure" },
    { value: "bounced", label: "Bounced" },
    { value: "failed", label: "Failed" },
    { value: "rejected", label: "Refused" },
    { value: "complained", label: "Complaint" },
    { value: "delayed", label: "Delayed" },
    { value: "suppressed", label: "Suppressed" },
  ],
};
const DIRECTION: FilterDef = {
  key: "direction", label: "Direction", initial: "",
  options: [{ value: "", label: "Both" }, { value: "outbound", label: "Sent" }, { value: "inbound", label: "Received" }],
};
const WINDOW: FilterDef = {
  key: "window", label: "When", initial: "7",
  options: [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }],
};
const FILTERS = [STATUS, DIRECTION, WINDOW];

/** A delivery's colour: every failure (bounced, failed, refused, complained) red, held back amber. */
export function deliveryTone(status: string): StatusTone {
  if (["delayed", "suppressed"].includes(status)) return "warn";
  return statusTone(status);
}

/** A delivery's state in plain words: a rejected message reads "Refused" (red, like every failure). */
const deliveryLabel = (status: string) => (status === "rejected" || status === "refused" ? "Refused" : status === "complained" ? "Complaint" : humanize(status));

const pct = (r: number) => `${(r * 100).toFixed(r >= 0.1 ? 0 : 1)}%`;

function useSendingSwitch() {
  const [enabled, setEnabled] = useState(false);
  const action = useOperatorAction<MailFailureRate>({
    title: (w) => `Sending for ${w.orgName ?? w.orgId}`,
    description: "Off stops every message this workspace sends, straight away, with a clear message to its people. Mail still arrives. On puts its plan's daily limit back.",
    confirmLabel: enabled ? "Turn sending on" : "Turn sending off", tone: enabled ? "primary" : "danger",
    fields: (
      <Field label="Sending">
        {(p) => (
          <Select {...p} value={enabled ? "on" : "off"} onChange={(e) => setEnabled(e.target.value === "on")} data-testid="console-mail-sending-choice">
            <option value="off">Turn sending off</option>
            <option value="on">Turn sending back on</option>
          </Select>
        )}
      </Field>
    ),
    run: (w, reason) => mailApi.setSending(w.orgId, enabled, reason),
    success: () => (enabled ? "Sending turned on" : "Sending turned off"),
  });
  return { ...action, open: (w: MailFailureRate) => { setEnabled(false); action.open(w); } };
}

function WorstWorkspaces({ days, onPick }: { days: string; onPick: (orgId: string) => void }) {
  const q = useQuery({ queryKey: consoleKeys.list("/mail/failure-rates", { window: days }), queryFn: () => mailApi.failureRates(days) });
  const sending = useSendingSwitch();
  return (
    <section className="space-y-2" aria-labelledby="mail-worst">
      <h2 id="mail-worst" className="text-[13px] font-semibold">Workspaces with the most failures</h2>
      {q.isPending ? <SkeletonRows rows={3} label="Loading failure rates" /> : q.error ? (
        <LoadError error={q.error} what="failure rates" retry={() => void q.refetch()} />
      ) : !q.data.items.length ? (
        <EmptyRow>No workspace stands out. Workspaces with at least 10 sent messages and any failures in this window show here, worst first.</EmptyRow>
      ) : (
        <div className={T.wrap} tabIndex={0} role="region" aria-label="Workspaces with the most failures" data-testid="console-mail-worst">
          <table className={consoleTable.table}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>Workspace</th>
                <th className={cn(T.th, "text-right")}>Failure rate</th>
                <th className={cn(T.th, "text-right")}>Failed of sent</th>
                <th className={cn(T.th, "text-right", consoleTable.secondary)}>Bounced</th>
                <th className={cn(T.th, "text-right", consoleTable.secondary)}>Complaints</th>
                <th className={T.th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={T.body}>
              {q.data.items.map((w) => (
                <tr key={w.orgId} className={T.row}>
                  <td className={T.td}><Workspace id={w.orgId} name={w.orgName} /></td>
                  <td className={cn(T.td, "text-right")}><StatusBadge state="rate" label={pct(w.failureRate)} tone={w.failureRate >= 0.05 ? "bad" : w.failureRate >= 0.02 ? "warn" : "neutral"} /></td>
                  <td className={cn(T.td, "whitespace-nowrap text-right tabular-nums")}>{num(w.failed)} of {num(w.total)}</td>
                  <td className={cn(T.td, "text-right tabular-nums", consoleTable.secondary)}>{num(w.bounced)}</td>
                  <td className={cn(T.td, "text-right tabular-nums", consoleTable.secondary)}>{num(w.complained)}</td>
                  <td className={cn(T.td, "text-right")}>
                    <span className="inline-flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => onPick(w.orgId)}>Show failures</Button>
                      <PermissionGate permission="workspaces.limits">
                        <Button size="sm" variant="secondary" onClick={() => sending.open(w)} data-testid="console-mail-sending">Change sending</Button>
                      </PermissionGate>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sending.dialog}
    </section>
  );
}

/** Held sends: messages a sending limit holds until tomorrow, each with Send anyway. */
function HeldSends({ orgId }: { orgId: string }) {
  const canAct = usePermission("mail.manage");
  const force = useOperatorAction<MailQueuedSend>({
    title: "Send this message now?",
    description: (s) => `It goes out on the next run, past ${s.orgName ?? "the workspace"}'s daily sending limit. It never goes out while the workspace's sending is turned off.`,
    confirmLabel: "Send anyway",
    run: (s, reason) => mailApi.forceSend(s.id, reason),
    success: "Message will go out on the next run",
  });
  return (
    <>
      <SectionList<MailQueuedSend>
        id="mail-held" title="Held sends" path="/mail/queued-sends" query={{ sort: "dueAt:asc", ...(orgId ? { orgId } : {}) }} testId="console-mail-held"
        rowKey={(s) => s.id}
        empty="No held sends. Messages a sending limit holds until tomorrow show here."
        columns={[
          { key: "reason", header: "Why it was held", cell: (s) => <span className="line-clamp-2 max-w-sm">{s.reason || "A sending limit"}</span> },
          { key: "workspace", header: "Workspace", cell: (s) => <Workspace id={s.orgId} name={s.orgName} /> },
          { key: "from", header: "From", secondary: true, cell: (s) => (s.mailboxAddress ? <span className="text-muted">{s.mailboxAddress}</span> : <Empty>A removed mailbox</Empty>) },
          { key: "recipients", header: "Recipients", align: "right", secondary: true, cell: (s) => <span className="tabular-nums">{num(s.recipients)}</span> },
          { key: "due", header: "Due", cell: (s) => (s.forced ? <StatusBadge state="sending" label="Sending now" tone="ok" /> : <RelTime at={s.dueAt} />) },
          { key: "actions", header: "", align: "right", cell: (s) => (canAct && !s.forced
            ? <Button size="sm" variant="secondary" onClick={() => force.open(s)} data-testid="console-mail-force-send">Send anyway</Button>
            : null) },
        ]}
      />
      {force.dialog}
    </>
  );
}

export function DeliveryTab() {
  const url = useUrlParams(FILTERS, { sort: "createdAt:desc" });
  const [params, setParams] = useSearchParams();
  const orgId = params.get("orgId") ?? "";
  const setOrg = (id: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (id) next.set("orgId", id); else next.delete("orgId");
    return next;
  }, { replace: true });
  const days = url.values.window || "7";
  return (
    <div className="space-y-8">
      {!orgId && <WorstWorkspaces days={days} onPick={setOrg} />}
      <section className="space-y-2" aria-labelledby="mail-failed">
        <h2 id="mail-failed" className="text-[13px] font-semibold">Failed deliveries</h2>
        <DataTable<MailDelivery>
          label="Failed deliveries" path="/mail/deliveries" filters={FILTERS} defaultSort="createdAt:desc"
          params={orgId ? { orgId } : undefined}
          actions={orgId ? <Button size="sm" variant="secondary" onClick={() => setOrg("")} data-testid="console-mail-all-workspaces">Show every workspace</Button> : undefined}
          rowKey={(d) => d.id}
          empty={{ icon: <IconMailWarning />, title: "No failed deliveries", body: "Nothing bounced, failed or was refused in this window. Try a longer window or another status." }}
          columns={[
            { key: "when", header: "When", sort: "createdAt", cell: (d) => <RelTime at={d.createdAt} className="text-muted" /> },
            { key: "status", header: "Status", cell: (d) => <StatusBadge state={d.status} label={deliveryLabel(d.status)} tone={deliveryTone(d.status)} /> },
            { key: "direction", header: "Direction", secondary: true, cell: (d) => <span className="text-muted">{d.direction === "outbound" ? "Sent" : "Received"}</span> },
            { key: "workspace", header: "Workspace", cell: (d) => <Workspace id={d.orgId} name={d.orgName} /> },
            { key: "detail", header: "Error", cell: (d) => (d.detail ? <span className="line-clamp-2 max-w-md text-xs text-muted" title={d.detail}>{d.detail}</span> : <Empty>None given</Empty>) },
          ]}
        />
      </section>
      <HeldSends orgId={orgId} />
    </div>
  );
}
