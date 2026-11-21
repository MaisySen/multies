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
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { AgentRunsTab } from "./agents-runs";
import { AgentTriggersTab } from "./agents-triggers";
import { AgentApprovalsTab } from "./agents-approvals";
import { AiUsageTab } from "./agents-usage";
import { AiKeyProblemsTab } from "./agents-keys";

const TABS: { id: string; label: string; render: () => ReactNode }[] = [
  { id: "runs", label: "Runs needing attention", render: () => <AgentRunsTab /> },
  { id: "triggers", label: "Triggers", render: () => <AgentTriggersTab /> },
  { id: "approvals", label: "Waiting approvals", render: () => <AgentApprovalsTab /> },
  { id: "usage", label: "AI usage", render: () => <AiUsageTab /> },
  { id: "keys", label: "AI key problems", render: () => <AiKeyProblemsTab /> },
];

export function ConsoleAgentsPage() {
  const [params] = useSearchParams();
  const current = TABS.find((t) => t.id === params.get("tab")) ?? TABS[0];
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Agents and AI" description="Agent runs that need a look, triggers, emails waiting for approval, AI use and AI key problems across every workspace." />
      <nav aria-label="Agents and AI sections" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {TABS.map((t, i) => {
            const on = t.id === current.id;
            return (
              <li key={t.id}>
                <Link
                  to={{ search: i === 0 ? "" : `?tab=${t.id}` }} replace
                  aria-current={on ? "page" : undefined} data-testid={`console-agents-tab-${t.id}`}
                  className={cn("-mb-px inline-flex h-10 items-center whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors", on ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}
                >
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div key={current.id} data-testid={`console-agents-panel-${current.id}`}>{current.render()}</div>
    </div>
  );
}
