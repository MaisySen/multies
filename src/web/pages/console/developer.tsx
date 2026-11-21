/**
 * OPS1: Developer platform in the operator console. Tabs (in the address as ?tab=, failures first):
 *   Webhook failures   deliveries that ran out of retries, last 7 days, field names only; Redeliver
 *   Webhook endpoints  on or off, recent failures, why it was switched off; Enable and Disable
 *   API keys           name, prefix, access, workspace, who made it, last used (never the key); Revoke
 *   Connected apps     OAuth connections per person and workspace; Revoke
 *   Registered apps    OAuth clients
 * ?orgId= narrows every tab to one workspace. Changes need developer.manage and a reason (server checks again).
 */
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { WebhookEndpointsTab, WebhookFailuresTab } from "./developer-webhooks";
import { ApiKeysTab, ConnectedAppsTab, RegisteredAppsTab } from "./developer-access";
import { useWorkspaceScope } from "./developer-shared";

const TABS = [
  { id: "failures", label: "Webhook failures" },
  { id: "endpoints", label: "Webhook endpoints" },
  { id: "keys", label: "API keys" },
  { id: "connected", label: "Connected apps" },
  { id: "registered", label: "Registered apps" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** The tab's address: only the tab (and the workspace scope) carry over; each tab's own search and filters start fresh. */
function tabHref(id: TabId, orgId: string | null) {
  const q = new URLSearchParams();
  if (id !== TABS[0].id) q.set("tab", id);
  if (orgId) q.set("orgId", orgId);
  const s = q.toString();
  return { pathname: "/console/developer", search: s ? `?${s}` : "" };
}

export function ConsoleDeveloperPage() {
  const [params] = useSearchParams();
  const scope = useWorkspaceScope();
  const tab: TabId = TABS.find((t) => t.id === params.get("tab"))?.id ?? TABS[0].id;
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Developer platform"
        description="Webhooks, API keys and connected apps across every workspace. Keys, secrets and webhook contents are never shown." />
      {scope.orgId && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="console-developer-scope">
          Showing one workspace only.
          <Link to={tabHref(tab, null)} replace className="font-medium text-fg hover:underline">Show every workspace</Link>
        </p>
      )}
      <nav aria-label="Developer platform sections" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {TABS.map((t) => (
            <li key={t.id}>
              <Link to={tabHref(t.id, scope.orgId)} replace aria-current={tab === t.id ? "page" : undefined} data-testid={`console-developer-tab-${t.id}`}
                className={cn("-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors", tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {tab === "failures" && <WebhookFailuresTab />}
      {tab === "endpoints" && <WebhookEndpointsTab />}
      {tab === "keys" && <ApiKeysTab />}
      {tab === "connected" && <ConnectedAppsTab />}
      {tab === "registered" && <RegisteredAppsTab />}
    </div>
  );
}
