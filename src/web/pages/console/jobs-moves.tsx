/**
 * OPS1: the Data moves tab of /console/jobs: imports and exports across workspaces (kind, status, workspace, how far
 * they got, last update). Read only. File names, download links and who started a move are never shown.
 */
import { Link } from "react-router";
import { fullDate, timeAgo } from "@/web/lib/format";
import { Badge } from "@/web/components/ui/misc";
import { IconArrowRightLeft } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { MOVE_STATUS_LABEL, MOVE_STATUS_TONE, type ConsoleDataMove, type DataMoveStatus } from "./jobs-api";

const MOVE_STATUSES: DataMoveStatus[] = ["failed", "running", "stopped", "ready", "done", "undone", "expired"];

const FILTERS: FilterDef[] = [
  { key: "kind", label: "Kind", initial: "", options: [{ value: "", label: "Imports and exports" }, { value: "import", label: "Imports" }, { value: "export", label: "Exports" }] },
  { key: "status", label: "Status", initial: "", options: [{ value: "", label: "Any" }, ...MOVE_STATUSES.map((s) => ({ value: s, label: MOVE_STATUS_LABEL[s] }))] },
  { key: "days", label: "Started", initial: "30", options: [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }] },
];

function Step({ m }: { m: ConsoleDataMove }) {
  const pct = m.total > 0 ? Math.min(100, Math.round((m.done / m.total) * 100)) : null;
  return (
    <span className="flex flex-col">
      <span className="tabular-nums">{m.total > 0 ? `${m.done.toLocaleString()} of ${m.total.toLocaleString()}${pct !== null ? ` (${pct}%)` : ""}` : m.done.toLocaleString()}</span>
      {m.lastStepAt && <span className="text-xs text-subtle" title={fullDate(m.lastStepAt)}>Last step {timeAgo(m.lastStepAt)}</span>}
    </span>
  );
}

export function JobsDataMovesTab() {
  return (
    <DataTable<ConsoleDataMove>
      label="Data moves" path="/jobs/data-moves" filters={FILTERS} defaultSort="createdAt:desc"
      rowKey={(m) => m.id}
      empty={{ icon: <IconArrowRightLeft />, title: "No imports or exports", body: "Imports and exports started in this window show here with how far they got." }}
      columns={[
        { key: "kind", header: "Kind", cell: (m) => (
          <span className="flex flex-col">
            <span className="font-medium">{m.kind === "import" ? "Import" : "Export"}</span>
            <span className="text-xs text-subtle">{m.source}</span>
          </span>
        ) },
        { key: "status", header: "Status", cell: (m) => (
          <span className="flex flex-col items-start gap-1">
            <span title={`Status: ${m.status}`}><Badge tone={MOVE_STATUS_TONE[m.status]} dot>{MOVE_STATUS_LABEL[m.status]}</Badge></span>
            {m.error && <span className="line-clamp-2 max-w-xs break-words text-xs text-muted" title={m.error}>{m.error}</span>}
          </span>
        ) },
        { key: "workspace", header: "Workspace", cell: (m) => <Link to={`/console/workspaces/${encodeURIComponent(m.orgId)}`} className="hover:underline">{m.workspaceName ?? m.orgId}</Link> },
        { key: "step", header: "Progress", cell: (m) => <Step m={m} /> },
        { key: "started", header: "Started", sort: "createdAt", cell: (m) => <span className="whitespace-nowrap text-muted" title={fullDate(m.createdAt)}>{timeAgo(m.createdAt)}</span> },
        { key: "updated", header: "Updated", sort: "updatedAt", cell: (m) => <span className="whitespace-nowrap text-muted" title={fullDate(m.updatedAt)}>{timeAgo(m.updatedAt)}</span> },
      ]}
    />
  );
}
