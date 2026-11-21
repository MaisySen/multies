/**
 * OPS1: the Connected mailboxes and Imports tabs of the console's Mail page. Read only, and never credentials.
 */
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { IconDownload, IconPlug } from "@/web/components/ui/icon";
import { num } from "@/web/lib/format";
import { plain, StatusBadge, When, WorkspaceLink, type MailConnection, type MailImport, type Tone } from "./mail-shared";

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
const connectionTone: Record<MailConnection["status"], Tone> = { active: "ok", syncing: "ok", paused: "neutral", auth_failed: "bad", error: "bad" };
const connectionLabel: Record<MailConnection["status"], string> = { active: "Working", syncing: "Syncing", paused: "Paused", auth_failed: "Sign in failed", error: "Error" };

export function ConnectionsTab() {
  return (
    <DataTable<MailConnection>
      label="Connected mailboxes" path="/mail/connections" filters={[CONNECTION_STATUS]} search={{ placeholder: "Search by mailbox address" }} defaultSort="createdAt:desc"
      rowKey={(m) => m.id}
      empty={{ icon: <IconPlug />, title: "No connected mailboxes here", body: "Mailboxes that can't sign in or keep failing to sync show here. Pick Any to see all of them." }}
      columns={[
        { key: "email", header: "Mailbox", sort: "email", cell: (m) => (
          <span className="flex flex-col"><span className="font-medium">{m.email}</span><span className="text-xs text-subtle">{plain(m.provider)}, {m.authKind === "oauth" ? "signed in with the provider" : "app password"}</span></span>
        ) },
        { key: "workspace", header: "Workspace", cell: (m) => <WorkspaceLink id={m.orgId} name={m.orgName} /> },
        { key: "status", header: "State", cell: (m) => <StatusBadge tone={connectionTone[m.status]}>{connectionLabel[m.status]}</StatusBadge> },
        { key: "synced", header: "Last sync", sort: "lastSyncAt", cell: (m) => <When at={m.lastSyncAt} /> },
        { key: "messages", header: "Messages", align: "right", cell: (m) => <span className="tabular-nums">{num(m.messagesSynced)}</span> },
        { key: "error", header: "Error", cell: (m) => (m.lastError ? <span className="line-clamp-2 max-w-sm text-xs text-muted" title={m.lastError}>{m.lastError}</span> : <span className="text-subtle">None</span>) },
      ]}
    />
  );
}

const IMPORT_STATUS: FilterDef = {
  key: "status", label: "State", initial: "failed",
  options: [
    { value: "failed", label: "Failed" },
    { value: "running", label: "Running" },
    { value: "queued", label: "Waiting" },
    { value: "done", label: "Done" },
    { value: "cancelled", label: "Cancelled" },
    { value: "all", label: "Any (last 30 days)" },
  ],
};
const importTone: Record<MailImport["status"], Tone> = { done: "ok", running: "neutral", queued: "neutral", failed: "bad", cancelled: "neutral" };
const importLabel: Record<MailImport["status"], string> = { done: "Done", running: "Running", queued: "Waiting", failed: "Failed", cancelled: "Cancelled" };

export function ImportsTab() {
  return (
    <DataTable<MailImport>
      label="Imports" path="/mail/imports" filters={[IMPORT_STATUS]} defaultSort="createdAt:desc"
      rowKey={(j) => j.id}
      empty={{ icon: <IconDownload />, title: "No imports here", body: "Mail imports in this state show here. Pick another state to see the rest." }}
      columns={[
        { key: "source", header: "Source", cell: (j) => <span className="flex flex-col"><span className="font-medium">{plain(j.provider)}</span><span className="text-xs text-subtle">{j.sourceHost}</span></span> },
        { key: "workspace", header: "Workspace", cell: (j) => <WorkspaceLink id={j.orgId} name={j.orgName} /> },
        { key: "status", header: "State", cell: (j) => <StatusBadge tone={importTone[j.status]}>{importLabel[j.status]}</StatusBadge> },
        { key: "progress", header: "Messages", align: "right", cell: (j) => <span className="tabular-nums">{num(j.messagesDone)}{j.messagesTotal != null ? ` of ${num(j.messagesTotal)}` : ""}</span> },
        { key: "error", header: "Error", cell: (j) => (j.error ? <span className="line-clamp-2 max-w-sm text-xs text-muted" title={j.error}>{j.error}</span> : <span className="text-subtle">None</span>) },
        { key: "started", header: "Started", sort: "createdAt", cell: (j) => <When at={j.createdAt} /> },
        { key: "finished", header: "Finished", cell: (j) => <When at={j.finishedAt} empty="Not yet" /> },
      ]}
    />
  );
}
