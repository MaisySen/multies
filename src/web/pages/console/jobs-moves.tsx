/**
 * OPS1: the Data moves tab of /console/jobs: imports and exports across workspaces (kind, status, workspace, how far
 * they got, last update). Read only. File names, download links and who started a move are never shown.
 */
import { IconArrowRightLeft } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { humanize, RelTime, StatusBadge, WorkspaceLink, workspaceHint } from "./components/format";
import { MOVE_STATUS_LABEL, MOVE_STATUS_TONE, type ConsoleDataMove, type DataMoveStatus } from "./jobs-api";
import { LOCALE } from "@/shared/locale";

const MOVE_STATUSES: DataMoveStatus[] = ["failed", "running", "stopped", "ready", "done", "undone", "expired"];

const FILTERS: FilterDef[] = [
  { key: "kind", label: "Kind", initial: "", options: [{ value: "", label: "Imports and exports" }, { value: "import", label: "Imports" }, { value: "export", label: "Exports" }] },
  { key: "status", label: "Status", initial: "", options: [{ value: "", label: "Any" }, ...MOVE_STATUSES.map((s) => ({ value: s, label: MOVE_STATUS_LABEL[s] }))] },
  { key: "days", label: "Started", initial: "30", options: [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }] },
];

/** CSV and other source names as people say them. */
const SOURCE: Record<string, string> = { csv: "CSV file", json: "JSON file", zip: "Zip file", mbox: "Mailbox file", imap: "Mailbox" };

function Step({ m }: { m: ConsoleDataMove }) {
  const pct = m.total > 0 ? Math.min(100, Math.round((m.done / m.total) * 100)) : null;
  return (
    <span className="flex flex-col">
      <span className="whitespace-nowrap tabular-nums">{m.total > 0 ? `${m.done.toLocaleString(LOCALE)} of ${m.total.toLocaleString(LOCALE)}${pct !== null ? ` (${pct}%)` : ""}` : m.done.toLocaleString(LOCALE)}</span>
      {m.lastStepAt && <span className="whitespace-nowrap text-xs text-subtle">Last step <RelTime at={m.lastStepAt} /></span>}
    </span>
  );
}

export function JobsDataMovesTab() {
  return (
    <DataTable<ConsoleDataMove>
      label="Data moves" path="/jobs/data-moves" filters={FILTERS} defaultSort="createdAt:desc"
      rowKey={(m) => m.id} minWidth={720}
      empty={{ icon: <IconArrowRightLeft />, title: "No imports or exports", body: "Imports and exports started in this window show here with how far they got." }}
      columns={[
        { key: "workspace", header: "Workspace", cell: (m) => <WorkspaceLink id={m.orgId} name={m.workspaceName} hint={workspaceHint(m.orgId, m.ownerEmail)} /> },
        { key: "kind", header: "Kind", cell: (m) => (
          <span className="flex flex-col">
            <span className="font-medium">{m.kind === "import" ? "Import" : "Export"}</span>
            <span className="text-xs text-subtle" title={m.source}>{SOURCE[m.source] ?? humanize(m.source)}</span>
          </span>
        ) },
        { key: "status", header: "Status", cell: (m) => (
          <span className="flex flex-col items-start gap-1">
            <StatusBadge state={m.status} label={MOVE_STATUS_LABEL[m.status]} tone={MOVE_STATUS_TONE[m.status]} />
            {m.error && <span className="line-clamp-2 max-w-xs break-words text-xs text-muted" title={m.error}>{m.error}</span>}
          </span>
        ) },
        { key: "step", header: "Progress", cell: (m) => <Step m={m} /> },
        { key: "started", header: "Started", sort: "createdAt", secondary: true, cell: (m) => <RelTime at={m.createdAt} className="text-muted" /> },
        { key: "updated", header: "Updated", sort: "updatedAt", cell: (m) => <RelTime at={m.updatedAt} className="text-muted" /> },
      ]}
    />
  );
}
