/**
 * OPS1: Workspaces in the operator console. Search by name, id, owner email or domain; filter by plan and state;
 * click a row to open the workspace. The owner's email sits under the name so two workspaces with the same name can
 * be told apart; Owner, People and Domains are hidden on phones.
 */
import { Link } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { IconBuilding } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { Empty, PersonLink, RelTime, planLabel } from "../components/format";
import { StateBadges, workspacePlanLabel, wsPath, type WorkspaceRow } from "./tab-shared";
import { LOCALE } from "@/shared/locale";

const FILTERS: FilterDef[] = [
  {
    key: "plan", label: "Plan", initial: "",
    options: [{ value: "", label: "Any" }, ...(["starter", "pro", "business"] as const).map((p) => ({ value: p, label: planLabel(p) }))],
  },
  {
    key: "state", label: "State", initial: "",
    options: [
      { value: "", label: "Any" }, { value: "suspended", label: "Suspended" }, { value: "pastDue", label: "Past due" },
      { value: "comp", label: "Free Business plan" }, { value: "demo", label: "Demo" }, { value: "active", label: "In good standing" },
    ],
  },
];

export function ConsoleWorkspacesPage() {
  return (
    <div className="space-y-4" data-testid="console-workspaces-list">
      <PageHeader eyebrow="Customers" title="Workspaces" description="Every workspace on Multies. Open one to see its people, limits, usage and history." />
      <DataTable<WorkspaceRow>
        label="Workspaces" path="/workspaces"
        search={{ placeholder: "Search workspaces" }}
        filters={FILTERS} defaultSort="createdAt:desc" minWidth={0}
        rowKey={(w) => w.id} rowHref={(w) => wsPath(w.id)}
        empty={{ icon: <IconBuilding />, title: "No workspaces match", body: "Try another search or clear the filters." }}
        columns={[
          {
            key: "name", header: "Name", sort: "name",
            cell: (w) => (
              <span className="flex min-w-0 flex-col">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link to={wsPath(w.id)} title={w.id} className="font-medium hover:underline" data-testid="console-workspaces-row-link">{w.name}</Link>
                  <StateBadges w={w} />
                </span>
                {/* On phones the Owner column is hidden: the email here tells same-named workspaces apart. */}
                {w.ownerEmail && <span className="truncate text-xs text-subtle sm:hidden">{w.ownerEmail}</span>}
              </span>
            ),
          },
          { key: "plan", header: "Plan", sort: "plan", cell: (w) => <span className="whitespace-nowrap" title={w.plan}>{workspacePlanLabel(w)}</span> },
          {
            key: "owner", header: "Owner", secondary: true,
            cell: (w) => (w.ownerEmail ? <PersonLink id={w.ownerUserId ?? null} email={w.ownerEmail} className="max-w-[16rem]" /> : <Empty>No owner</Empty>),
          },
          { key: "people", header: "People", align: "right", secondary: true, cell: (w) => <span className="tabular-nums">{w.members.toLocaleString(LOCALE)}</span> },
          { key: "domains", header: "Domains", align: "right", secondary: true, cell: (w) => <span className="tabular-nums">{w.domains.toLocaleString(LOCALE)}</span> },
          { key: "created", header: "Created", sort: "createdAt", align: "right", cell: (w) => <RelTime at={w.createdAt} className="text-muted" /> },
        ]}
      />
    </div>
  );
}
