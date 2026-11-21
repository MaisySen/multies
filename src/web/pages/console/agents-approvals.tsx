/**
 * OPS1: Agents and AI, the "Waiting approvals" tab. Agent emails waiting for a person in the workspace to approve them,
 * oldest first. Read only: the message itself is never shown here, and approving stays with the workspace.
 */
import { IconHourglass } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import { Empty, formatDateTime, RelTime, StatusBadge } from "./components/format";
import { formatDuration, WorkspaceCell, type PendingApprovalRow } from "./agents-shared";

export function AgentApprovalsTab() {
  return (
    <DataTable<PendingApprovalRow>
      label="Waiting approvals" path="/agents/approvals"
      search={{ placeholder: "Search workspace or agent" }}
      defaultSort="createdAt:asc"
      rowKey={(a) => a.id}
      empty={{ icon: <IconHourglass />, title: "Nothing is waiting", body: "Agent emails that wait for a person to approve them show here, oldest first." }}
      columns={[
        { key: "workspace", header: "Workspace", cell: (a) => <WorkspaceCell row={a} /> },
        { key: "agent", header: "Agent", cell: (a) => a.agentName ?? <Empty>Removed agent</Empty> },
        { key: "waiting", header: "Waiting", sort: "createdAt", sortFirst: "asc", cell: (a) => <span className="whitespace-nowrap tabular-nums" title={`Asked ${formatDateTime(a.createdAt)}`}>{formatDuration(a.ageMs)}</span> },
        {
          key: "expires", header: "Expires", sort: "expiresAt", sortFirst: "asc",
          cell: (a) => (a.overdue
            ? <span data-testid="console-agents-approval-overdue"><StatusBadge state="overdue" label="Overdue" tone="bad" /></span>
            : <RelTime at={a.expiresAt} className="text-muted" />),
        },
      ]}
    />
  );
}
