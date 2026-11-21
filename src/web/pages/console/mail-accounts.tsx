/**
 * OPS1: the Connected mailboxes tab of the console's Mail page: the outside mailboxes (needing attention first), then
 * an Imports section (failed first). Read only, and never credentials.
 */
import { useState } from "react";
import { ChipSelect } from "@/web/components/ui/chip-select";
import { IconPlug } from "@/web/components/ui/icon";
import { num } from "@/web/lib/format";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Empty, RelTime, StatusBadge, humanize, type StatusTone } from "./components/format";
import { SectionList, Workspace, type MailConnection, type MailImport } from "./mail-shared";

const CONNECTION_STATUS: FilterDef = {
  key: "status", label: "State", initial: "auth_failed,error",
  options: [
    { value: "auth_failed,error", label: "Needs attention" },
    { value: "auth_failed", label: "Sign in failed" },
    { value: "error", label: "Error" },
    { value: "paused", label: "Paused" },
    { value: "active,syncing", label: "Working" },
    { value: "all", label: "Any" },
  ],
};
const connectionTone: Record<MailConnection["status"], StatusTone> = { active: "ok", syncing: "ok", paused: "neutral", auth_failed: "bad", error: "bad" };
const connectionLabel: Record<MailConnection["status"], string> = { active: "Working", syncing: "Syncing", paused: "Paused", auth_failed: "Sign in failed", error: "Error" };

const PROVIDER: Record<string, string> = { gmail: "Gmail", google: "Google", outlook: "Outlook", microsoft: "Microsoft", imap: "IMAP", yahoo: "Yahoo", icloud: "iCloud", fastmail: "Fastmail" };
const providerLabel = (p: string) => PROVIDER[p.toLowerCase()] ?? humanize(p);

function Connections() {
  return (
    <section className="space-y-2" aria-labelledby="mail-connections">
      <h2 id="mail-connections" className="text-[13px] font-semibold">Connected mailboxes</h2>
      <DataTable<MailConnection>
        label="Connected mailboxes" path="/mail/connections" filters={[CONNECTION_STATUS]} search={{ placeholder: "Search mailboxes" }} defaultSort="createdAt:desc"
        rowKey={(m) => m.id}
        empty={{ icon: <IconPlug />, title: "No connected mailboxes here", body: "Mailboxes that can't sign in or keep failing to sync show here. Pick Any to see all of them." }}
        columns={[
          { key: "email", header: "Mailbox", sort: "email", cell: (m) => (
            <span className="flex flex-col"><span className="font-medium">{m.email}</span><span className="text-xs text-subtle">{providerLabel(m.provider)}, {m.authKind === "oauth" ? "signed in with the provider" : "app password"}</span></span>
          ) },
          { key: "workspace", header: "Workspace", cell: (m) => <Workspace id={m.orgId} name={m.orgName} /> },
          { key: "status", header: "State", cell: (m) => <StatusBadge state={m.status} label={connectionLabel[m.status]} tone={connectionTone[m.status]} /> },
          { key: "synced", header: "Last sync", sort: "lastSyncAt", cell: (m) => <RelTime at={m.lastSyncAt} className="text-muted" /> },
          { key: "messages", header: "Messages", align: "right", secondary: true, cell: (m) => <span className="tabular-nums">{num(m.messagesSynced)}</span> },
          { key: "error", header: "Error", secondary: true, cell: (m) => (m.lastError ? <span className="line-clamp-2 max-w-sm text-xs text-muted" title={m.lastError}>{m.lastError}</span> : <Empty />) },
        ]}
      />
    </section>
  );
}

const IMPORT_STATUS = [
  { value: "failed", label: "Failed" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Waiting" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "Any (last 30 days)" },
];
const importTone: Record<MailImport["status"], StatusTone> = { done: "ok", running: "brand", queued: "warn", failed: "bad", cancelled: "neutral" };
const importLabel: Record<MailImport["status"], string> = { done: "Done", running: "Running", queued: "Waiting", failed: "Failed", cancelled: "Cancelled" };

/** Mail imports, failed first; the state filter is the section's own (the address holds the mailboxes list's). */
function Imports() {
  const [status, setStatus] = useState("failed");
  const label = IMPORT_STATUS.find((o) => o.value === status)?.label.toLowerCase() ?? status;
  return (
    <SectionList<MailImport>
      id="mail-imports" title="Imports" path="/mail/imports" query={status === "all" ? {} : { status }} testId="console-mail-imports"
      filter={(
        <ChipSelect label="State:" active={status !== "failed"} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Import state" data-testid="console-mail-imports-state">
          {IMPORT_STATUS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </ChipSelect>
      )}
      rowKey={(j) => j.id}
      empty={status === "all" ? "No mail imports in the last 30 days." : `No ${label} imports. Pick another state to see the rest.`}
      columns={[
        { key: "source", header: "Source", cell: (j) => <span className="flex flex-col"><span className="font-medium">{providerLabel(j.provider)}</span><span className="text-xs text-subtle">{j.sourceHost}</span></span> },
        { key: "workspace", header: "Workspace", cell: (j) => <Workspace id={j.orgId} name={j.orgName} /> },
        { key: "status", header: "State", cell: (j) => <StatusBadge state={j.status} label={importLabel[j.status]} tone={importTone[j.status]} /> },
        { key: "progress", header: "Messages", align: "right", cell: (j) => <span className="whitespace-nowrap tabular-nums">{num(j.messagesDone)}{j.messagesTotal != null ? ` of ${num(j.messagesTotal)}` : ""}</span> },
        { key: "error", header: "Error", secondary: true, cell: (j) => (j.error ? <span className="line-clamp-2 max-w-sm text-xs text-muted" title={j.error}>{j.error}</span> : <Empty />) },
        { key: "started", header: "Started", secondary: true, cell: (j) => <RelTime at={j.createdAt} className="text-muted" /> },
        { key: "finished", header: "Finished", secondary: true, cell: (j) => <RelTime at={j.finishedAt} empty="Not yet" className="text-muted" /> },
      ]}
    />
  );
}

export function ConnectionsTab() {
  return (
    <div className="space-y-8">
      <Connections />
      <Imports />
    </div>
  );
}
