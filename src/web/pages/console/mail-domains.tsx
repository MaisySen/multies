/**
 * OPS1: the Domains and Suppressions tabs of the console's Mail page, each with its one action (Re-check, Remove)
 * behind mail.manage and a reason. Held sends are a section of the Delivery problems tab (mail-delivery.tsx).
 */
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { Empty, RelTime, StatusBadge, dnsFailingText, humanize, type StatusTone } from "./components/format";
import { usePermission } from "./guard";
import { Button } from "@/web/components/ui/button";
import { IconGlobe, IconShieldCheck } from "@/web/components/ui/icon";
import { mailApi, Workspace, type MailDomain, type MailSuppression } from "./mail-shared";

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

const domainLabel: Record<MailDomain["status"], string> = { verified: "Verified", pending: "Waiting for DNS", failed: "Failed" };
const sendingLabel: Record<NonNullable<MailDomain["sending"]>["status"], string> = { verified: "Verified", pending: "Waiting", queued: "Waiting", error: "Error" };

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
          { key: "workspace", header: "Workspace", cell: (d) => <Workspace id={d.orgId} name={d.orgName} ownerEmail={d.ownerEmail} /> },
          { key: "status", header: "State", cell: (d) => <StatusBadge state={d.status} label={domainLabel[d.status]} /> },
          { key: "sending", header: "Sending", secondary: true, cell: (d) => (d.sending
            ? <span title={d.sending.detail ?? undefined}><StatusBadge state={d.sending.status} label={sendingLabel[d.sending.status] ?? humanize(d.sending.status)} /></span>
            : <Empty className="whitespace-nowrap">Not set up</Empty>) },
          { key: "failing", header: "Failing records", cell: (d) => (d.failingRecords.length
            ? <span className="text-bad" title={d.failingRecords.join(", ")}>{dnsFailingText(d.failingRecords)}</span>
            : <Empty />) },
          { key: "checked", header: "Last checked", sort: "lastCheckedAt", secondary: true, cell: (d) => <RelTime at={d.lastCheckedAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (d) => (canAct
            ? <Button size="sm" variant="secondary" onClick={() => recheck.open(d)} data-testid="console-mail-recheck">Re-check</Button>
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
const reasonTone: Record<MailSuppression["reason"], StatusTone> = { hard_bounce: "bad", complaint: "warn", manual: "neutral" };
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
        label="Suppressed addresses" path="/mail/suppressions" filters={[REASON]} search={{ placeholder: "Search addresses" }} defaultSort="createdAt:desc"
        rowKey={(s) => s.id}
        empty={{ icon: <IconShieldCheck />, title: "No suppressed addresses", body: "Addresses that bounced or complained in the last 30 days show here." }}
        columns={[
          { key: "address", header: "Address", sort: "address", cell: (s) => <span className="font-medium">{s.address}</span> },
          { key: "reason", header: "Reason", cell: (s) => <StatusBadge state={s.reason} label={reasonLabel[s.reason]} tone={reasonTone[s.reason]} /> },
          { key: "workspace", header: "Workspace", cell: (s) => <Workspace id={s.orgId} name={s.orgName} ownerEmail={s.ownerEmail} /> },
          { key: "detail", header: "Detail", secondary: true, cell: (s) => (s.detail ? <span className="line-clamp-2 max-w-xs text-xs text-muted" title={s.detail}>{s.detail}</span> : <Empty />) },
          { key: "added", header: "Added", sort: "createdAt", secondary: true, cell: (s) => <RelTime at={s.createdAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (s) => (canAct
            ? <Button size="sm" variant="danger" onClick={() => remove.open(s)} data-testid="console-mail-unsuppress">Remove</Button>
            : null) },
        ]}
      />
      {remove.dialog}
    </>
  );
}
