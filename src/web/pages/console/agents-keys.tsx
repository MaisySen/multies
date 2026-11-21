/**
 * OPS1: Agents and AI, the "AI key problems" tab. Workspace AI keys the provider last refused (bad key, out of credit,
 * model gone), newest first. Read only: the key is never shown, and fixing it stays with the workspace.
 */
import { IconKey } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { RelTime, StatusBadge } from "./components/format";
import { PROBLEM_LABELS, PROVIDER_LABELS, WorkspaceCell, type AiKeyProblemRow } from "./agents-shared";

const FILTERS: FilterDef[] = [
  {
    key: "problem", label: "Problem",
    options: [
      { value: "", label: "Any" },
      { value: "key_refused", label: PROBLEM_LABELS.key_refused },
      { value: "no_credit", label: PROBLEM_LABELS.no_credit },
      { value: "model_unavailable", label: PROBLEM_LABELS.model_unavailable },
    ],
  },
];

export function AiKeyProblemsTab() {
  return (
    <DataTable<AiKeyProblemRow>
      label="AI key problems" path="/agents/ai-key-problems"
      filters={FILTERS} search={{ placeholder: "Search workspace" }}
      defaultSort="problemAt:desc"
      rowKey={(k) => k.orgId}
      empty={{ icon: <IconKey />, title: "No AI key problems", body: "When a provider refuses a workspace's own AI key, the workspace shows here until the key works again." }}
      columns={[
        { key: "workspace", header: "Workspace", cell: (k) => <WorkspaceCell row={k} /> },
        { key: "provider", header: "Provider", cell: (k) => PROVIDER_LABELS[k.provider] ?? k.provider },
        { key: "model", header: "Model", secondary: true, cell: (k) => <span className="block max-w-[14rem] truncate font-mono text-xs" title={k.model}>{k.model}</span> },
        { key: "problem", header: "Problem", cell: (k) => <StatusBadge state={k.problem} tone={k.problem === "model_unavailable" ? "warn" : "bad"} label={PROBLEM_LABELS[k.problem] ?? k.problem} /> },
        { key: "since", header: "Since", sort: "problemAt", cell: (k) => <RelTime at={k.problemAt ?? k.updatedAt} className="text-muted" /> },
      ]}
    />
  );
}
