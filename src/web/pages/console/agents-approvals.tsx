/**
 * OPS1: Agents and AI, the "Waiting approvals" tab. Agent emails waiting for a person in the workspace to approve them,
 * oldest first. Read only: the message itself is never shown here, and approving stays with the workspace.
 */
import { Badge } from "@/web/components/ui/misc";
import { IconHourglass } from "@/web/components/ui/icon";
import { fullDate } from "@/web/lib/format";
import { DataTable } from "./components/data-table";
import { formatDuration, When, WorkspaceLink, type PendingApprovalRow } from "./agents-shared";

export function AgentApprovalsTab() {
  return (
    <DataTable<PendingApprovalRow>
      label="Waiting approvals" path="/agents/approvals"
      search={{ placeholder: "Search workspace or agent" }}
      defaultSort="createdAt:asc"
      rowKey={(a) => a.id}
      empty={{ icon: <IconHourglass />, title: "Nothing is waiting", body: "Agent emails that wait for a person to approve them show here, oldest first." }}
      columns={[
        { key: "workspace", header: "Workspace", cell: (a) => <WorkspaceLink id={a.orgId} name={a.workspaceName} /> },
        { key: "agent", header: "Agent", cell: (a) => a.agentName ?? <span className="text-subtle">Removed agent</span> },
        { key: "waiting", header: "Waiting", sort: "createdAt", cell: (a) => <span className="tabular-nums" title={`Asked ${fullDate(a.createdAt)}`}>{formatDuration(a.ageMs)}</span> },
        {
          key: "expires", header: "Expires", sort: "expiresAt",
          cell: (a) => (a.overdue
            ? <span data-testid="console-agents-approval-overdue"><Badge tone="bad" dot>Overdue</Badge></span>
            : <When at={a.expiresAt} />),
        },
      ]}
    />
  );
}
