/**
 * OPS1: the Members tab of a workspace: people and agent members, each person linking to their console page. The
 * link carries ?org= so "View as" on that page opens this workspace.
 */
import { Link } from "react-router";
import { Badge } from "@/web/components/ui/misc";
import { IconTeam } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { Empty, RelTime, StatusBadge, TwoStepBadge, personHref } from "../components/format";

interface Member {
  id: string; userId: string; email: string; name: string; role: "owner" | "admin" | "member"; kind: "human" | "agent";
  title: string | null; emailVerified: boolean; twoFactorEnabled: boolean; banned: boolean; lastLoginMethod: string | null;
  disabledAt: string | null; joinedAt: string;
}

const FILTERS: FilterDef[] = [
  { key: "kind", label: "Kind", initial: "", options: [{ value: "", label: "Everyone" }, { value: "human", label: "People" }, { value: "agent", label: "Agent members" }] },
];

const ROLE: Record<Member["role"], string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** A person's console page, opened from this workspace. */
const memberHref = (m: Member, orgId: string) => `${personHref(m.userId)}?org=${encodeURIComponent(orgId)}`;

export function WorkspaceMembersTab({ orgId }: { orgId: string }) {
  return (
    <div data-testid="console-workspaces-members">
      <DataTable<Member>
        label="Members" path={`/workspaces/${encodeURIComponent(orgId)}/members`}
        search={{ placeholder: "Search name or email" }} filters={FILTERS} defaultSort="createdAt:asc"
        rowKey={(m) => m.id} rowHref={(m) => (m.kind === "human" ? memberHref(m, orgId) : "")}
        empty={{ icon: <IconTeam />, title: "No members match", body: "Try another search or show everyone." }}
        columns={[
          {
            key: "name", header: "Name", sort: "name",
            cell: (m) => (
              <span className="flex min-w-0 flex-col">
                {m.kind === "human"
                  ? <Link to={memberHref(m, orgId)} title={m.userId} className="truncate font-medium hover:underline">{m.name || m.email}</Link>
                  : <span className="truncate font-medium">{m.name}</span>}
                {m.kind === "human" && m.name && <span className="truncate text-xs text-subtle">{m.email}</span>}
                {m.title && <span className="truncate text-xs text-subtle">{m.title}</span>}
              </span>
            ),
          },
          { key: "role", header: "Role", cell: (m) => (m.kind === "agent" ? <Badge className="whitespace-nowrap">Agent member</Badge> : <span>{ROLE[m.role]}</span>) },
          {
            key: "state", header: "State", secondary: true,
            cell: (m) => {
              const badges = [
                m.banned && <StatusBadge key="b" state="banned" label="Banned" />,
                m.disabledAt && <StatusBadge key="p" state="paused" label="Paused" />,
                m.kind === "human" && !m.emailVerified && <StatusBadge key="e" state="pending" label="Email not confirmed" />,
                m.kind === "human" && m.twoFactorEnabled && <TwoStepBadge key="t" on long />,
              ].filter(Boolean);
              return badges.length ? <span className="inline-flex flex-wrap gap-1">{badges}</span> : <Empty>Normal</Empty>;
            },
          },
          { key: "joined", header: "Joined", sort: "createdAt", align: "right", cell: (m) => <RelTime at={m.joinedAt} className="text-muted" /> },
        ]}
      />
    </div>
  );
}
