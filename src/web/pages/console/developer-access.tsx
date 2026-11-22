/** OPS1: the Developer platform's access tabs: API keys (Revoke), connected apps (Revoke) and registered apps. */
import { Badge } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { IconKey, IconPlug, IconPlugZap } from "@/web/components/ui/icon";
import { DataTable } from "./components/data-table";
import type { FilterDef } from "./components/filter-bar";
import { useOperatorAction } from "./components/reason-dialog";
import { Day, Empty, EMPTY, PersonLink, RelTime, StatusBadge, formatDateTime } from "./components/format";
import { usePermission } from "./guard";
import { developerApi, hostOf, Mono, Workspace, useWorkspaceScope, type DevApiKey, type DevOAuthClient, type DevOAuthGrant } from "./developer-shared";

/** "full", "read" or a list of per area scopes. */
function scopeLabel(scope: string) {
  if (scope === "full") return <Badge tone="brand" className="whitespace-nowrap">Full access</Badge>;
  if (scope === "read") return <Badge className="whitespace-nowrap">Read only</Badge>;
  const parts = scope.split(/\s+/).filter(Boolean);
  return <span title={parts.join(", ")}><Badge className="whitespace-nowrap">{parts.length === 1 ? parts[0] : `${parts.length} scopes`}</Badge></span>;
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
        search={{ placeholder: "Search API keys" }} minWidth={680}
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
          { key: "workspace", header: "Workspace", cell: (k) => <Workspace id={k.orgId} name={k.orgName} ownerEmail={k.ownerEmail} /> },
          { key: "by", header: "Created by", secondary: true, cell: (k) => <PersonLink id={k.createdByUserId} email={k.createdByEmail} /> },
          { key: "used", header: "Last used", sort: "lastUsedAt", cell: (k) => <RelTime at={k.lastUsedAt} className="text-muted" /> },
          { key: "created", header: "Created", sort: "createdAt", secondary: true, cell: (k) => <Day at={k.createdAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (k) => (canManage
            ? <Button size="sm" variant="danger" onClick={() => revoke.open(k)} data-testid="console-developer-revoke-key">Revoke</Button>
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
  if (g.revokedAt) return <span title={`Revoked ${formatDateTime(g.revokedAt)}`}><StatusBadge state="revoked" label="Revoked" /></span>;
  if (!g.lastUsedAt) return <StatusBadge state="unused" label="Not used yet" tone="neutral" />;
  return <StatusBadge state="connected" label="Connected" />;
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
        rowKey={(g) => g.id} minWidth={680}
        empty={{ icon: <IconPlugZap />, title: "No connected apps match", body: "Apps people connect to a workspace (Claude, ChatGPT, Cursor and others) show here. Without a workspace, the last 90 days are shown." }}
        columns={[
          { key: "app", header: "App", cell: (g) => (g.clientName ? <span className="font-medium">{g.clientName}</span> : <Empty>Removed app</Empty>) },
          { key: "person", header: "Person", cell: (g) => <PersonLink id={g.userId} email={g.userEmail} /> },
          { key: "workspace", header: "Workspace", cell: (g) => <Workspace id={g.orgId} name={g.orgName} ownerEmail={g.ownerEmail} /> },
          { key: "scope", header: "Access", secondary: true, cell: (g) => scopeLabel(g.scope) },
          { key: "state", header: "State", cell: grantState },
          { key: "used", header: "Last used", sort: "lastUsedAt", secondary: true, cell: (g) => <RelTime at={g.lastUsedAt} className="text-muted" /> },
          { key: "created", header: "Connected", sort: "createdAt", secondary: true, cell: (g) => <Day at={g.createdAt} className="text-muted" /> },
          { key: "actions", header: "", align: "right", cell: (g) => (canManage && !g.revokedAt
            ? <Button size="sm" variant="danger" onClick={() => revoke.open(g)} data-testid="console-developer-revoke-grant">Revoke</Button>
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
      search={{ placeholder: "Search apps" }} recentNote="Showing recent registrations only. Apps are not tied to a workspace."
      rowKey={(a) => a.id}
      empty={{ icon: <IconPlug />, title: "No registered apps match", body: "Apps that registered to connect in the last 90 days show here. Search by name to look further back." }}
      columns={[
        { key: "name", header: "App", sort: "name", cell: (a) => <span className="font-medium">{a.name}</span> },
        { key: "site", header: "Website", cell: (a) => (a.clientUri ? <span className="text-muted">{hostOf(a.clientUri)}</span> : <Empty />) },
        { key: "redirects", header: "Returns to", secondary: true, cell: (a) => {
          const hosts = [...new Set(a.redirectUris.map(hostOf))];
          return <span className="line-clamp-2 max-w-xs text-muted" title={a.redirectUris.join("\n")}>{hosts.join(", ") || EMPTY}</span>;
        } },
        { key: "created", header: "Registered", sort: "createdAt", cell: (a) => <Day at={a.createdAt} className="text-muted" /> },
      ]}
    />
  );
}
