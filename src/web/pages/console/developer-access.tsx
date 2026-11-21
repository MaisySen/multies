/** OPS1: the Developer platform's access tabs: API keys (Revoke), connected apps (Revoke) and registered apps. */
import { Badge } from "@/web/components/ui/misc";
import { fullDate } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { IconKey, IconPlug, IconPlugZap } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { usePermission } from "./guard";
import { developerApi, hostOf, Mono, PersonLink, When, WorkspaceLink, useWorkspaceScope, type DevApiKey, type DevOAuthClient, type DevOAuthGrant } from "./developer-shared";

/** "full", "read" or a list of per area scopes. */
function scopeLabel(scope: string) {
  if (scope === "full") return <Badge tone="brand">Full access</Badge>;
  if (scope === "read") return <Badge>Read only</Badge>;
  const parts = scope.split(/\s+/).filter(Boolean);
  return <span title={parts.join(", ")}><Badge>{parts.length === 1 ? parts[0] : `${parts.length} scopes`}</Badge></span>;
}

export function ApiKeysTab() {
  const canManage = usePermission("developer.manage");
  const scope = useWorkspaceScope();
  const revoke = useOperatorAction<DevApiKey>({
    title: (k) => `Revoke the API key "${k.name}"?`,
    description: (k) => `This deletes the key straight away and can't be undone. Anything using it is refused from its next request, and ${k.orgName ?? "the workspace"} will need to create a new key and put it where this one was used.`,
    confirmLabel: "Revoke key", tone: "danger",
    run: (k, reason) => developerApi.revokeApiKey(k.id, reason),
    success: "API key revoked",
  });
  return (
    <>
      <DataTable<DevApiKey>
        label="API keys" path="/developer/api-keys" defaultSort="createdAt:desc" params={scope.params}
        search={{ placeholder: "Search by key name or prefix" }}
        rowKey={(k) => k.id}
        empty={{ icon: <IconKey />, title: "No API keys match", body: "Keys workspaces create in their developer settings show here. The key itself is never shown." }}
        columns={[
          { key: "name", header: "Name", sort: "name", cell: (k) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">{k.name}</span>
              <Mono className="text-muted">{k.prefix}</Mono>
            </span>
          ) },
          { key: "scope", header: "Access", cell: (k) => <span className="flex flex-wrap gap-1">{scopeLabel(k.scope)}{k.agentId && <Badge>Agent</Badge>}</span> },
          { key: "workspace", header: "Workspace", cell: (k) => <WorkspaceLink id={k.orgId} name={k.orgName} /> },
          { key: "by", header: "Created by", cell: (k) => <PersonLink id={k.createdByUserId} email={k.createdByEmail} /> },
          { key: "used", header: "Last used", sort: "lastUsedAt", cell: (k) => <When at={k.lastUsedAt} /> },
          { key: "created", header: "Created", sort: "createdAt", cell: (k) => <When at={k.createdAt} /> },
          { key: "actions", header: "", align: "right", cell: (k) => (canManage
            ? <Button size="sm" variant="ghost" onClick={() => revoke.open(k)} data-testid="console-developer-revoke-key">Revoke</Button>
            : null) },
        ]}
      />
      {revoke.dialog}
    </>
  );
}

const GRANT_FILTERS: FilterDef[] = [
  { key: "state", label: "State", initial: "active", options: [
    { value: "active", label: "Connected" },
    { value: "revoked", label: "Revoked" },
    { value: "all", label: "Any" },
  ] },
];

function grantState(g: DevOAuthGrant) {
  if (g.revokedAt) return <span title={`Revoked ${fullDate(g.revokedAt)}`}><Badge tone="bad" dot>Revoked</Badge></span>;
  if (!g.lastUsedAt) return <Badge dot>Not used yet</Badge>;
  return <Badge tone="ok" dot>Connected</Badge>;
}

export function ConnectedAppsTab() {
  const canManage = usePermission("developer.manage");
  const scope = useWorkspaceScope();
  const revoke = useOperatorAction<DevOAuthGrant>({
    title: (g) => `Disconnect ${g.clientName ?? "this app"} for ${g.userEmail ?? "this person"}?`,
    description: (g) => `Its access and refresh tokens stop working straight away. This can't be undone: to use ${g.clientName ?? "the app"} with ${g.orgName ?? "the workspace"} again, they will need to reconnect it.`,
    confirmLabel: "Revoke access", tone: "danger",
    run: (g, reason) => developerApi.revokeGrant(g.id, reason),
    success: "App disconnected",
  });
  return (
    <>
      <DataTable<DevOAuthGrant>
        label="Connected apps" path="/developer/oauth-grants" filters={GRANT_FILTERS} defaultSort="createdAt:desc" params={scope.params}
        rowKey={(g) => g.id}
        empty={{ icon: <IconPlugZap />, title: "No connected apps match", body: "Apps people connect to a workspace (Claude, ChatGPT, Cursor and others) show here. Without a workspace, the last 90 days are shown." }}
        columns={[
          { key: "app", header: "App", cell: (g) => <span className="font-medium">{g.clientName ?? "Removed app"}</span> },
          { key: "person", header: "Person", cell: (g) => <PersonLink id={g.userId} email={g.userEmail} /> },
          { key: "workspace", header: "Workspace", cell: (g) => <WorkspaceLink id={g.orgId} name={g.orgName} /> },
          { key: "scope", header: "Access", cell: (g) => (g.scope === "full" ? <Badge tone="brand">Full access</Badge> : <Badge>Read only</Badge>) },
          { key: "state", header: "State", cell: grantState },
          { key: "used", header: "Last used", sort: "lastUsedAt", cell: (g) => <When at={g.lastUsedAt} /> },
          { key: "created", header: "Connected", sort: "createdAt", cell: (g) => <When at={g.createdAt} /> },
          { key: "actions", header: "", align: "right", cell: (g) => (canManage && !g.revokedAt
            ? <Button size="sm" variant="ghost" onClick={() => revoke.open(g)} data-testid="console-developer-revoke-grant">Revoke</Button>
            : null) },
        ]}
      />
      {revoke.dialog}
    </>
  );
}

export function RegisteredAppsTab() {
  return (
    <DataTable<DevOAuthClient>
      label="Registered apps" path="/developer/oauth-clients" defaultSort="createdAt:desc"
      search={{ placeholder: "Search by app name or website" }}
      rowKey={(a) => a.id}
      empty={{ icon: <IconPlug />, title: "No registered apps match", body: "Apps that registered to connect in the last 90 days show here. Search by name to find older ones." }}
      columns={[
        { key: "name", header: "App", sort: "name", cell: (a) => <span className="font-medium">{a.name}</span> },
        { key: "site", header: "Website", cell: (a) => (a.clientUri ? <span className="text-muted">{hostOf(a.clientUri)}</span> : <span className="text-subtle">None</span>) },
        { key: "redirects", header: "Returns to", cell: (a) => {
          const hosts = [...new Set(a.redirectUris.map(hostOf))];
          return <span className="line-clamp-2 max-w-xs text-muted" title={a.redirectUris.join("\n")}>{hosts.join(", ") || "None"}</span>;
        } },
        { key: "created", header: "Registered", sort: "createdAt", cell: (a) => <When at={a.createdAt} /> },
      ]}
    />
  );
}
