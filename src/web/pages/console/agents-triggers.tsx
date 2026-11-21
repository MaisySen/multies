/**
 * OPS1: Agents and AI, the Triggers tab. Every agent trigger (schedules and webhooks) across workspaces, with how often
 * it fired and when it runs next. Never the trigger's instructions. Pause and Resume (agents.manage), with a reason.
 */
import { Button } from "@/web/components/ui/button";
import { IconCalendarClock } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { Empty, RelTime, StatusBadge } from "./components/format";
import { useOperatorAction } from "./components/reason-dialog";
import { PermissionGate } from "./guard";
import { agentsApi, WorkspaceCell, type AgentTriggerRow } from "./agents-shared";

const FILTERS: FilterDef[] = [
  { key: "enabled", label: "State", options: [{ value: "", label: "Any" }, { value: "true", label: "On" }, { value: "false", label: "Paused" }] },
  { key: "kind", label: "Kind", options: [{ value: "", label: "Any" }, { value: "schedule", label: "Schedule" }, { value: "webhook", label: "Webhook" }] },
];

export function AgentTriggersTab() {
  const pause = useOperatorAction<AgentTriggerRow>({
    title: (t) => `Pause ${t.name}?`,
    description: (t) => `${t.kind === "schedule" ? "It stops running on its schedule" : "Calls to its webhook stop starting runs"} until someone resumes it. ${t.workspaceName ?? "The workspace"} sees that an operator paused it.`,
    confirmLabel: "Pause trigger", tone: "danger",
    run: (t, reason) => agentsApi.pauseTrigger(t.id, reason),
    success: "Trigger paused",
  });
  const resume = useOperatorAction<AgentTriggerRow>({
    title: (t) => `Resume ${t.name}?`,
    description: (t) => (t.kind === "schedule" ? "It runs again on its schedule, starting from the next due time." : "Calls to its webhook start runs again."),
    confirmLabel: "Resume trigger",
    run: (t, reason) => agentsApi.resumeTrigger(t.id, reason),
    success: "Trigger resumed",
  });
  return (
    <>
      <DataTable<AgentTriggerRow>
        label="Agent triggers" path="/agents/triggers"
        filters={FILTERS} search={{ placeholder: "Search trigger, workspace or agent" }}
        defaultSort="createdAt:desc"
        rowKey={(t) => t.id} minWidth={820}
        empty={{ icon: <IconCalendarClock />, title: "No triggers match", body: "Agent schedules and webhooks that workspaces set up show here." }}
        columns={[
          { key: "workspace", header: "Workspace", cell: (t) => <WorkspaceCell row={t} /> },
          { key: "name", header: "Trigger", cell: (t) => <span className="font-medium">{t.name}</span> },
          { key: "state", header: "State", cell: (t) => (t.enabled ? <StatusBadge state="on" label="On" /> : <StatusBadge state="paused" label="Paused" tone="neutral" />) },
          { key: "kind", header: "Kind", secondary: true, cell: (t) => (t.kind === "schedule" ? "Schedule" : "Webhook") },
          { key: "agent", header: "Agent", secondary: true, cell: (t) => t.agentName ?? <Empty>Removed agent</Empty> },
          { key: "fires", header: "Fired", sort: "fireCount", align: "right", cell: (t) => <span className="tabular-nums">{t.fireCount}</span> },
          { key: "last", header: "Last fired", cell: (t) => <RelTime at={t.lastFiredAt} className="text-muted" /> },
          { key: "next", header: "Next run", cell: (t) => (t.kind === "webhook" && !t.nextRunAt ? <Empty>When called</Empty> : <RelTime at={t.nextRunAt} className="text-muted" />) },
          {
            key: "actions", header: "", align: "right",
            cell: (t) => (
              <PermissionGate permission="agents.manage">
                {t.enabled
                  ? <Button size="sm" variant="secondary" onClick={() => pause.open(t)} data-testid="console-agents-trigger-pause">Pause</Button>
                  : <Button size="sm" variant="secondary" onClick={() => resume.open(t)} data-testid="console-agents-trigger-resume">Resume</Button>}
              </PermissionGate>
            ),
          },
        ]}
      />
      {pause.dialog}
      {resume.dialog}
    </>
  );
}
