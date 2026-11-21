/**
 * OPS1: the Domains, Suppressions and Held sends tabs of the console's Mail page, each with its one action
 * (Re-check, Remove, Send anyway) behind mail.manage and a reason.
 */
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { Button } from "@/web/components/ui/button";
import { IconClock, IconGlobe, IconShieldCheck } from "@/web/components/ui/icon";
import { num } from "@/web/lib/format";
import { mailApi, plain, StatusBadge, When, WorkspaceLink, type MailDomain, type MailQueuedSend, type MailSuppression, type Tone } from "./mail-shared";

// ---------------------------------------------------------------- domains

const DOMAIN_STATUS: FilterDef = {
  key: "status", label: "State", initial: "pending,failed",
  options: [
    { value: "pending,failed", label: "Needs attention" },
    { value: "failed", label: "Failed" },
    { value: "pending", label: "Waiting for DNS" },
    { value: "verified", label: "Verified" },
    { value: "all", label: "Any" },
  ],
};

const domainTone: Record<MailDomain["status"], Tone> = { verified: "ok", pending: "warn", failed: "bad" };
const domainLabel: Record<MailDomain["status"], string> = { verified: "Verified", pending: "Waiting for DNS", failed: "Failed" };
const sendingTone: Record<NonNullable<MailDomain["sending"]>["status"], Tone> = { verified: "ok", pending: "warn", queued: "warn", error: "bad" };

export function DomainsTab() {
  const canAct = usePermission("mail.manage");
  const recheck = useOperatorAction<MailDomain>({
    title: (d) => `Re-check ${d.name}?`,
    description: "Runs the same live DNS check as the workspace's own Check DNS button and saves the result. The domain's records are not changed.",
    confirmLabel: "Re-check DNS",
    run: (d, reason) => mailApi.recheckDomain(d.id, reason),
    success: (d) => `Checked ${d.name}`,
  });
  return (
    <>
      <DataTable<MailDomain>
        label="Domains" path="/mail/domains" filters={[DOMAIN_STATUS]} search={{ placeholder: "Search domains" }} defaultSort="createdAt:desc"
        rowKey={(d) => d.id}
        empty={{ icon: <IconGlobe />, title: "No domains here", body: "Every domain in this view is verified. Pick Any to see all of them." }}
        columns={[
          { key: "name", header: "Domain", sort: "name", cell: (d) => <span className="font-medium">{d.name}</span> },
          { key: "workspace", header: "Workspace", cell: (d) => <WorkspaceLink id={d.orgId} name={d.orgName} /> },
          { key: "status", header: "State", cell: (d) => <StatusBadge tone={domainTone[d.status]}>{domainLabel[d.status]}</StatusBadge> },
          { key: "sending", header: "Sending", cell: (d) => (d.sending
            ? <span title={d.sending.detail ?? undefined}><StatusBadge tone={sendingTone[d.sending.status]}>{plain(d.sending.status)}</StatusBadge></span>
            : <span className="text-subtle">Not set up</span>) },
          { key: "failing", header: "Failing records", cell: (d) => (d.failingRecords.length
            ? <span className="flex flex-wrap gap-1">{d.failingRecords.map((r) => <span key={r} className="rounded bg-fill px-1.5 py-0.5 font-mono text-[11px] text-bad">{r}</span>)}</span>
            : <span className="text-subtle">None</span>) },
          { key: "checked", header: "Last checked", sort: "lastCheckedAt", cell: (d) => <When at={d.lastCheckedAt} /> },
          { key: "actions", header: "", align: "right", cell: (d) => (canAct
            ? <Button size="sm" variant="ghost" onClick={() => recheck.open(d)} data-testid="console-mail-recheck">Re-check</Button>
            : null) },
        ]}
      />
      {recheck.dialog}
    </>
  );
}

// ---------------------------------------------------------------- suppressions

const REASON: FilterDef = {
  key: "reason", label: "Reason", initial: "",
  options: [{ value: "", label: "Any" }, { value: "hard_bounce", label: "Hard bounce" }, { value: "complaint", label: "Complaint" }, { value: "manual", label: "Added by hand" }],
};
const reasonTone: Record<MailSuppression["reason"], Tone> = { hard_bounce: "bad", complaint: "warn", manual: "neutral" };
const reasonLabel: Record<MailSuppression["reason"], string> = { hard_bounce: "Hard bounce", complaint: "Complaint", manual: "Added by hand" };

export function SuppressionsTab() {
  const canAct = usePermission("mail.manage");
  const remove = useOperatorAction<MailSuppression>({
    title: (s) => `Let mail go to ${s.address} again?`,
    description: (s) => `${s.orgName ?? "The workspace"} can send to this address again. If it still bounces or complains, it is suppressed again on its own.`,
    confirmLabel: "Remove suppression", tone: "danger",
    run: (s, reason) => mailApi.removeSuppression(s.id, reason),
    success: (s) => `${s.address} can get mail again`,
  });
  return (
    <>
      <DataTable<MailSuppression>
        label="Suppressed addresses" path="/mail/suppressions" filters={[REASON]} search={{ placeholder: "Search by address" }} defaultSort="createdAt:desc"
        rowKey={(s) => s.id}
        empty={{ icon: <IconShieldCheck />, title: "No suppressed addresses", body: "Addresses that bounced or complained in the last 30 days show here." }}
        columns={[
          { key: "address", header: "Address", sort: "address", cell: (s) => <span className="font-medium">{s.address}</span> },
          { key: "reason", header: "Reason", cell: (s) => <StatusBadge tone={reasonTone[s.reason]}>{reasonLabel[s.reason]}</StatusBadge> },
          { key: "workspace", header: "Workspace", cell: (s) => <WorkspaceLink id={s.orgId} name={s.orgName} /> },
          { key: "detail", header: "Detail", cell: (s) => (s.detail ? <span className="line-clamp-2 max-w-xs text-xs text-muted" title={s.detail}>{s.detail}</span> : <span className="text-subtle">None</span>) },
          { key: "added", header: "Added", sort: "createdAt", cell: (s) => <When at={s.createdAt} /> },
          { key: "actions", header: "", align: "right", cell: (s) => (canAct
            ? <Button size="sm" variant="ghost" onClick={() => remove.open(s)} data-testid="console-mail-unsuppress">Remove</Button>
            : null) },
        ]}
      />
      {remove.dialog}
    </>
  );
}

// ---------------------------------------------------------------- held sends

export function HeldSendsTab() {
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
      <DataTable<MailQueuedSend>
        label="Held sends" path="/mail/queued-sends" defaultSort="dueAt:asc"
        rowKey={(s) => s.id}
        empty={{ icon: <IconClock />, title: "No held messages", body: "Messages a sending limit holds until tomorrow show here." }}
        columns={[
          { key: "reason", header: "Why it was held", cell: (s) => <span className="line-clamp-2 max-w-sm">{s.reason || "A sending limit"}</span> },
          { key: "workspace", header: "Workspace", cell: (s) => <WorkspaceLink id={s.orgId} name={s.orgName} /> },
          { key: "from", header: "From", cell: (s) => <span className="text-muted">{s.mailboxAddress ?? "A removed mailbox"}</span> },
          { key: "recipients", header: "Recipients", align: "right", cell: (s) => <span className="tabular-nums">{num(s.recipients)}</span> },
          { key: "due", header: "Due", sort: "dueAt", cell: (s) => (s.forced ? <StatusBadge tone="ok">Sending now</StatusBadge> : <When at={s.dueAt} />) },
          { key: "actions", header: "", align: "right", cell: (s) => (canAct && !s.forced
            ? <Button size="sm" variant="ghost" onClick={() => force.open(s)} data-testid="console-mail-force-send">Send anyway</Button>
            : null) },
        ]}
      />
      {force.dialog}
    </>
  );
}
