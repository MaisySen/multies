/** OPS1: the Members tab of a workspace: people and agent members, each linking to the person's console page. */
import { Link } from "react-router";
import { Badge } from "@/web/components/ui/misc";
import { IconTeam } from "@/web/components/ui/icon";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { When } from "./tab-shared";

interface Member {
  id: string; userId: string; email: string; name: string; role: "owner" | "admin" | "member"; kind: "human" | "agent";
  title: string | null; emailVerified: boolean; twoFactorEnabled: boolean; banned: boolean; lastLoginMethod: string | null;
  disabledAt: string | null; joinedAt: string;
}

const FILTERS: FilterDef[] = [
  { key: "kind", label: "Kind", initial: "", options: [{ value: "", label: "Everyone" }, { value: "human", label: "People" }, { value: "agent", label: "Agent members" }] },
];

const ROLE: Record<Member["role"], string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function WorkspaceMembersTab({ orgId }: { orgId: string }) {
  return (
    <div data-testid="console-workspaces-members">
      <DataTable<Member>
        label="Members" path={`/workspaces/${encodeURIComponent(orgId)}/members`}
        search={{ placeholder: "Search name or email" }} filters={FILTERS} defaultSort="createdAt:asc"
        rowKey={(m) => m.id} rowHref={(m) => (m.kind === "human" ? `/console/users/${encodeURIComponent(m.userId)}` : "")}
        empty={{ icon: <IconTeam />, title: "No members match", body: "Try another search or show everyone." }}
        columns={[
          {
            key: "name", header: "Name", sort: "name",
            cell: (m) => (
              <span className="flex min-w-0 flex-col">
                {m.kind === "human"
                  ? <Link to={`/console/users/${encodeURIComponent(m.userId)}`} className="font-medium hover:underline">{m.name || m.email}</Link>
                  : <span className="font-medium">{m.name}</span>}
                {m.kind === "human" && <span className="text-xs text-subtle [overflow-wrap:anywhere]">{m.email}</span>}
                {m.title && <span className="text-xs text-subtle">{m.title}</span>}
              </span>
            ),
          },
          { key: "role", header: "Role", cell: (m) => (m.kind === "agent" ? <Badge>Agent member</Badge> : <span>{ROLE[m.role]}</span>) },
          {
            key: "state", header: "State",
            cell: (m) => (
              <span className="inline-flex flex-wrap gap-1">
                {m.banned && <Badge tone="bad" dot>Banned</Badge>}
                {m.disabledAt && <Badge tone="warn" dot>Paused</Badge>}
                {m.kind === "human" && !m.emailVerified && <Badge tone="warn">Email not confirmed</Badge>}
                {m.kind === "human" && m.twoFactorEnabled && <Badge tone="ok">Two-step on</Badge>}
                {!m.banned && !m.disabledAt && (m.kind === "agent" || (m.emailVerified && !m.twoFactorEnabled)) && <span className="text-subtle">Normal</span>}
              </span>
            ),
          },
          { key: "joined", header: "Joined", sort: "createdAt", align: "right", cell: (m) => <When at={m.joinedAt} /> },
        ]}
      />
    </div>
  );
}
