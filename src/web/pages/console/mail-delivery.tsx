/**
 * OPS1: the "Delivery problems" tab. The workspaces with the worst outbound failure rate first, then every failed
 * delivery in the window. No subjects, bodies or addresses: what happened, where, and when.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { consoleKeys } from "@/web/lib/console-api";
import { errorMessage } from "@/web/lib/api";
import { num } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Card, EmptyState, tableStyles as T } from "@/web/components/ui/misc";
import { Field, Select } from "@/web/components/ui/input";
import { SkeletonRows } from "@/web/components/ui/skeleton-rows";
import { IconMailCheck, IconMailWarning, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { DataTable } from "./components/data-table";
import { useUrlParams, type FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { mailApi, plain, StatusBadge, When, WorkspaceLink, type MailDelivery, type MailFailureRate, type Tone } from "./mail-shared";

const STATUS: FilterDef = {
  key: "status", label: "Status", initial: "",
  options: [
    { value: "", label: "Any failure" },
    { value: "bounced", label: "Bounced" },
    { value: "failed", label: "Failed" },
    { value: "rejected", label: "Rejected" },
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

export function deliveryTone(status: string): Tone {
  if (["bounced", "failed", "rejected", "complained"].includes(status)) return "bad";
  if (["delayed", "queued", "suppressed"].includes(status)) return "warn";
  if (["delivered", "sent", "received", "forwarded"].includes(status)) return "ok";
  return "neutral";
}

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
        <Card className="p-0"><EmptyState icon={<IconWarning />} title="Couldn't load failure rates" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} /></Card>
      ) : !q.data.items.length ? (
        <Card className="p-0"><EmptyState icon={<IconMailCheck />} title="No workspace stands out" body="Workspaces with at least 10 sent messages and any failures in this window show here, worst first." /></Card>
      ) : (
        <div className={T.wrap} tabIndex={0} role="region" aria-label="Workspaces with the most failures" data-testid="console-mail-worst">
          <table className={T.table}>
            <thead className={T.head}>
              <tr>
                <th className={T.th}>Workspace</th>
                <th className={cn(T.th, "text-right")}>Failure rate</th>
                <th className={cn(T.th, "text-right")}>Failed of sent</th>
                <th className={cn(T.th, "text-right")}>Bounced</th>
                <th className={cn(T.th, "text-right")}>Complaints</th>
                <th className={T.th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className={T.body}>
              {q.data.items.map((w) => (
                <tr key={w.orgId} className={T.row}>
                  <td className={T.td}><WorkspaceLink id={w.orgId} name={w.orgName} /></td>
                  <td className={cn(T.td, "text-right")}><StatusBadge tone={w.failureRate >= 0.05 ? "bad" : w.failureRate >= 0.02 ? "warn" : "neutral"}>{pct(w.failureRate)}</StatusBadge></td>
                  <td className={cn(T.td, "text-right tabular-nums")}>{num(w.failed)} of {num(w.total)}</td>
                  <td className={cn(T.td, "text-right tabular-nums")}>{num(w.bounced)}</td>
                  <td className={cn(T.td, "text-right tabular-nums")}>{num(w.complained)}</td>
                  <td className={cn(T.td, "text-right")}>
                    <span className="inline-flex gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => onPick(w.orgId)}>Show failures</Button>
                      <PermissionGate permission="workspaces.limits">
                        <Button size="sm" variant="ghost" onClick={() => sending.open(w)} data-testid="console-mail-sending">Change sending</Button>
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
    <div className="space-y-6">
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
            { key: "when", header: "When", sort: "createdAt", cell: (d) => <When at={d.createdAt} /> },
            { key: "status", header: "Status", cell: (d) => <StatusBadge tone={deliveryTone(d.status)}>{plain(d.status)}</StatusBadge> },
            { key: "direction", header: "Direction", cell: (d) => <span className="text-muted">{d.direction === "outbound" ? "Sent" : "Received"}</span> },
            { key: "workspace", header: "Workspace", cell: (d) => <WorkspaceLink id={d.orgId} name={d.orgName} /> },
            { key: "detail", header: "Error", cell: (d) => (d.detail ? <span className="line-clamp-2 max-w-md text-xs text-muted" title={d.detail}>{d.detail}</span> : <span className="text-subtle">None given</span>) },
          ]}
        />
      </section>
    </div>
  );
}
