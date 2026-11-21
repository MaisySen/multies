/**
 * OPS1: Agents and AI, the "Runs needing attention" tab. Opens on failed runs plus queued or running ones going for
 * more than 30 minutes, last 7 days. Shows who, where, when and how long; never the run's input, steps or results.
 * Cancel (agents.manage) for queued or running runs, with a reason.
 */
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconAgent } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { agentsApi, formatDuration, When, WorkspaceLink, type AgentRunRow } from "./agents-shared";

const FILTERS: FilterDef[] = [
  {
    key: "status", label: "Status", initial: "attention",
    options: [
      { value: "attention", label: "Needs attention" },
      { value: "failed", label: "Failed" },
      { value: "long_running", label: "Long running" },
      { value: "all", label: "All", send: true },
    ],
  },
  {
    key: "days", label: "Started", initial: "7",
    options: [{ value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }, { value: "90", label: "Last 90 days" }],
  },
];

export function RunStatusBadge({ run }: { run: Pick<AgentRunRow, "status" | "longRunning"> }) {
  if (run.status === "failed") return <Badge tone="bad" dot>Failed</Badge>;
  if (run.longRunning) return <Badge tone="warn" dot>{run.status === "queued" ? "Queued a long time" : "Running a long time"}</Badge>;
  if (run.status === "running") return <Badge tone="brand" dot>Running</Badge>;
  if (run.status === "queued") return <Badge dot>Queued</Badge>;
  if (run.status === "succeeded") return <Badge tone="ok" dot>Finished</Badge>;
  return <Badge dot>Cancelled</Badge>;
}

export function AgentRunsTab() {
  const cancel = useOperatorAction<AgentRunRow>({
    title: (r) => `Cancel this run of ${r.agentName ?? "the agent"}?`,
    description: (r) => `The run stops and is marked cancelled in ${r.workspaceName ?? "the workspace"}. The workspace's activity log shows that an operator cancelled it.`,
    confirmLabel: "Cancel run", tone: "danger",
    run: (r, reason) => agentsApi.cancelRun(r.id, reason),
    success: "Run cancelled",
  });
  return (
    <>
      <DataTable<AgentRunRow>
        label="Agent runs" path="/agents/runs"
        filters={FILTERS} search={{ placeholder: "Search workspace or agent" }}
        defaultSort="createdAt:desc"
        rowKey={(r) => r.id}
        empty={{ icon: <IconAgent />, title: "No runs need a look", body: "Failed runs and runs going for more than 30 minutes show here. Pick All to see every run in the window." }}
        columns={[
          { key: "status", header: "Status", cell: (r) => <span data-testid="console-agents-run-status"><RunStatusBadge run={r} /></span> },
          { key: "workspace", header: "Workspace", cell: (r) => <WorkspaceLink id={r.orgId} name={r.workspaceName} /> },
          { key: "agent", header: "Agent", cell: (r) => r.agentName ?? <span className="text-subtle">Removed agent</span> },
          { key: "started", header: "Started", sort: "createdAt", cell: (r) => <When at={r.startedAt ?? r.createdAt} /> },
          { key: "duration", header: "Duration", align: "right", cell: (r) => <span className="tabular-nums">{formatDuration(r.durationMs) || <span className="text-subtle">Not started</span>}</span> },
          { key: "steps", header: "Steps", align: "right", cell: (r) => <span className="tabular-nums">{r.stepCount}</span> },
          {
            key: "actions", header: "", align: "right",
            cell: (r) => (r.status === "queued" || r.status === "running") ? (
              <PermissionGate permission="agents.manage">
                <Button size="sm" variant="secondary" onClick={() => cancel.open(r)} data-testid="console-agents-run-cancel">Cancel</Button>
              </PermissionGate>
            ) : null,
          },
        ]}
      />
      {cancel.dialog}
    </>
  );
}
