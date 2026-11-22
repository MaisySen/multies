/**
 * OPS1: Developer platform in the operator console. Tabs (in the address as ?tab=, failures first):
 *   Webhook failures   deliveries that ran out of retries, last 7 days, a Fields column (names only); Redeliver
 *   Webhook endpoints  on or off, recent failures, why it was switched off; Enable and Disable
 *   API keys           name, prefix, access, workspace, who made it, last used (never the key); Revoke
 *   Connected apps     OAuth connections per person and workspace; Revoke
 *   Registered apps    OAuth clients
 * ?orgId= narrows every tab to one workspace (picked by name with the workspace picker above the tabs). Changes need
 * developer.manage and a reason (server checks again).
 */
import { useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, queryTabSearch, useQueryTab } from "./components/detail-tabs";
import { WorkspacePicker } from "./components/workspace-picker";
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

export function ConsoleDeveloperPage() {
  const scope = useWorkspaceScope();
  const tab: TabId = useQueryTab(TABS);
  const [, setParams] = useSearchParams();
  // A new workspace (or every workspace) keeps only the tab: that tab's search and filters start fresh.
  const setOrg = (id: string) => setParams(() => {
    const next = new URLSearchParams(queryTabSearch(new URLSearchParams(), tab, tab === TABS[0].id));
    if (id) next.set("orgId", id);
    return next;
  }, { replace: true });
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Developer platform"
        description="Webhooks, API keys and connected apps across every workspace. Keys and secrets are never shown; for webhooks only field names are shown, never values." />
      <div className="flex flex-wrap items-center gap-2" data-testid="console-developer-scope">
        <WorkspacePicker value={scope.orgId ?? ""} onChange={setOrg} testIdPrefix="console-developer-workspace" />
      </div>
      {/* Only the tab and the workspace scope carry over; each tab's own search and filters start fresh. */}
      <QueryTabs tabs={TABS} label="Developer platform sections" testIdPrefix="console-developer-tab" keep={["orgId"]} />
      <TabPanel testIdPrefix="console-developer-tab" current={tab}>
      {tab === "failures" && <WebhookFailuresTab />}
      {tab === "endpoints" && <WebhookEndpointsTab />}
      {tab === "keys" && <ApiKeysTab />}
      {tab === "connected" && <ConnectedAppsTab />}
      {tab === "registered" && <RegisteredAppsTab />}
      </TabPanel>
    </div>
  );
}
