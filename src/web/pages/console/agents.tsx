/**
 * OPS1: Agents and AI in the operator console. Five tabs, the most useful first:
 *   Runs needing attention (default)  failed and long-running agent runs; Cancel
 *   Triggers                          schedules and webhooks; Pause and Resume
 *   Waiting approvals                 agent emails waiting for a person (read only)
 *   AI usage                          account totals and the heaviest workspaces (read only)
 *   AI key problems                   workspace AI keys the provider refused (read only)
 * The tab lives in the address (?tab=), next to each list's own search, filters and sort, so links can be shared.
 * Switching tabs starts the new list from its defaults.
 */
import type { ReactNode } from "react";
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, useQueryTab, type DetailTab } from "./components/detail-tabs";
import { AgentRunsTab } from "./agents-runs";
import { AgentTriggersTab } from "./agents-triggers";
import { AgentApprovalsTab } from "./agents-approvals";
import { AiUsageTab } from "./agents-usage";
import { AiKeyProblemsTab } from "./agents-keys";

const TABS: (DetailTab & { render: () => ReactNode })[] = [
  { id: "runs", label: "Runs needing attention", render: () => <AgentRunsTab /> },
  { id: "triggers", label: "Triggers", render: () => <AgentTriggersTab /> },
  { id: "approvals", label: "Waiting approvals", render: () => <AgentApprovalsTab /> },
  { id: "usage", label: "AI usage", render: () => <AiUsageTab /> },
  { id: "keys", label: "AI key problems", render: () => <AiKeyProblemsTab /> },
];

export function ConsoleAgentsPage() {
  const tab = useQueryTab(TABS);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Agents and AI" description="Agent runs that need a look, triggers, emails waiting for approval, AI use and AI key problems across every workspace." />
      <QueryTabs tabs={TABS} label="Agents and AI sections" testIdPrefix="console-agents-tab" />
      <TabPanel testIdPrefix="console-agents-tab" current={current.id} testId={`console-agents-panel-${current.id}`}>{current.render()}</TabPanel>
    </div>
  );
}
