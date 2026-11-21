/**
 * OPS1: Workspaces in the operator console. Search by name, id, owner email or domain; filter by plan and state;
 * click a row to open the workspace.
 */
import { Link } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { IconBuilding } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { PLAN_LABEL, StateBadges, When, wsPath, type WorkspaceRow } from "./tab-shared";

const FILTERS: FilterDef[] = [
  {
    key: "plan", label: "Plan", initial: "",
    options: [{ value: "", label: "Any" }, { value: "starter", label: "Starter" }, { value: "pro", label: "Pro" }, { value: "business", label: "Business" }],
  },
  {
    key: "state", label: "State", initial: "",
    options: [
      { value: "", label: "Any" }, { value: "suspended", label: "Suspended" }, { value: "pastDue", label: "Past due" },
      { value: "comp", label: "Comp" }, { value: "demo", label: "Demo" }, { value: "active", label: "In good standing" },
    ],
  },
];

export function ConsoleWorkspacesPage() {
  return (
    <div className="space-y-4" data-testid="console-workspaces-list">
      <PageHeader eyebrow="Customers" title="Workspaces" description="Every workspace on Multies. Open one to see its people, limits, usage and history." />
      <DataTable<WorkspaceRow>
        label="Workspaces" path="/workspaces"
        search={{ placeholder: "Search name, id, owner email or domain" }}
        filters={FILTERS} defaultSort="createdAt:desc"
        rowKey={(w) => w.id} rowHref={(w) => wsPath(w.id)}
        empty={{ icon: <IconBuilding />, title: "No workspaces match", body: "Try another search or clear the filters." }}
        columns={[
          {
            key: "name", header: "Name", sort: "name",
            cell: (w) => (
              <span className="flex min-w-0 flex-col gap-1">
                <Link to={wsPath(w.id)} className="font-medium hover:underline" data-testid="console-workspaces-row-link">{w.name}</Link>
                <StateBadges w={w} />
              </span>
            ),
          },
          { key: "plan", header: "Plan", sort: "plan", cell: (w) => <span>{PLAN_LABEL[w.plan] ?? w.plan}{w.effectivePlan !== w.plan && <span className="text-subtle"> (runs as {PLAN_LABEL[w.effectivePlan]})</span>}</span> },
          { key: "owner", header: "Owner", cell: (w) => (w.ownerEmail ? <span className="[overflow-wrap:anywhere]">{w.ownerEmail}</span> : <span className="text-subtle">No owner</span>) },
          { key: "people", header: "People", align: "right", cell: (w) => <span className="tabular-nums">{w.members.toLocaleString()}</span> },
          { key: "domains", header: "Domains", align: "right", cell: (w) => <span className="tabular-nums">{w.domains.toLocaleString()}</span> },
          { key: "created", header: "Created", sort: "createdAt", align: "right", cell: (w) => <When at={w.createdAt} /> },
        ]}
      />
    </div>
  );
}
