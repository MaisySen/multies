/**
 * OPS1: Users in the operator console. Find any account by email, name or id; filter by banned, unverified, operators
 * and two-step sign in. Each row opens the person's detail page, where the actions are. The email sits under the name
 * so two people with the same name can be told apart; Workspaces and Sign in are hidden on phones.
 */
import { Link } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { IconUser } from "@/web/components/ui/icon";
import { num } from "@/web/lib/format";
import { DataTable } from "../components/data-table";
import type { FilterDef } from "../components/filter-bar";
import { RelTime, personHref } from "../components/format";
import { signInMethodLabel, type ConsoleUserRow } from "./users-api";
import { UserStateBadges } from "./users-badges";

const yesNo = (key: string, label: string, yes: string, no: string): FilterDef => ({
  key, label, initial: "",
  options: [{ value: "", label: "Any" }, { value: "true", label: yes }, { value: "false", label: no }],
});

export const USER_FILTERS: FilterDef[] = [
  yesNo("banned", "Banned", "Banned", "Not banned"),
  yesNo("unverified", "Email", "Not confirmed", "Confirmed"),
  yesNo("operator", "Operators", "Operators only", "Customers only"),
  { key: "twoFactor", label: "Two-step", initial: "", options: [{ value: "", label: "Any" }, { value: "false", label: "Off" }, { value: "true", label: "On" }] },
];

export function ConsoleUsersPage() {
  return (
    <div className="space-y-4" data-testid="console-users">
      <PageHeader eyebrow="Customers" title="Users" description="Every account on Multies. Open one to see its workspaces, sessions and sign in, and to help or act." />
      <DataTable<ConsoleUserRow>
        label="Users" path="/users" defaultSort="createdAt:desc"
        search={{ placeholder: "Search users" }}
        filters={USER_FILTERS} minWidth={0}
        rowKey={(u) => u.id} rowHref={(u) => personHref(u.id)}
        empty={{ icon: <IconUser />, title: "No accounts match", body: "Try another search, or clear the filters to see everyone." }}
        columns={[
          { key: "name", header: "Name", sort: "name", cell: (u) => (
            <span className="flex min-w-0 flex-col">
              <Link to={personHref(u.id)} title={u.id} className="truncate font-medium hover:underline" data-testid="console-users-row">{u.name || "No name"}</Link>
              <span className="truncate text-xs text-subtle">{u.email}</span>
            </span>
          ) },
          { key: "state", header: "State", cell: (u) => <UserStateBadges u={u} /> },
          { key: "workspaces", header: "Workspaces", align: "right", secondary: true, cell: (u) => <span className="tabular-nums">{num(u.workspaces)}</span> },
          { key: "signin", header: "Sign in", secondary: true, cell: (u) => <span className="whitespace-nowrap text-muted">{u.kind === "agent" ? "None (AI agent)" : signInMethodLabel(u.lastLoginMethod)}{u.twoFactorEnabled ? ", two-step" : ""}</span> },
          { key: "created", header: "Created", sort: "createdAt", align: "right", cell: (u) => <RelTime at={u.createdAt} className="text-muted" /> },
        ]}
      />
    </div>
  );
}
