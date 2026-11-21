/**
 * OPS1: Mail and deliverability in the operator console. Tabs (kept in ?tab=): Delivery problems (default, with a
 * Held sends section under the failures), Domains, Suppressions, Connected mailboxes (with an Imports section). Each
 * opens on what needs attention. No subjects, bodies or credentials anywhere: content access is only through audited
 * impersonation. Old addresses ?tab=held and ?tab=imports open the tab that now holds that section, scrolled to it.
 */
import { Navigate, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, queryTabSearch, useQueryTab, type DetailTab } from "./components/detail-tabs";
import { DeliveryTab } from "./mail-delivery";
import { DomainsTab, SuppressionsTab } from "./mail-domains";
import { ConnectionsTab } from "./mail-accounts";

const TABS: DetailTab[] = [
  { id: "delivery", label: "Delivery problems" },
  { id: "domains", label: "Domains" },
  { id: "suppressions", label: "Suppressions" },
  { id: "connections", label: "Connected mailboxes" },
];

/** Tabs that became sections: the old ?tab= value, the tab that holds it now, and the section's id. */
const MOVED: Record<string, { tab: string; section: string }> = {
  held: { tab: "delivery", section: "mail-held" },
  imports: { tab: "connections", section: "mail-imports" },
};

export function ConsoleMailPage() {
  const [params] = useSearchParams();
  const tab = useQueryTab(TABS);
  const moved = MOVED[params.get("tab") ?? ""];
  if (moved) {
    return <Navigate replace to={{ search: queryTabSearch(params, moved.tab, moved.tab === TABS[0]!.id, ["orgId"]), hash: moved.section }} />;
  }
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Mail and deliverability" description="Where mail is failing, and the domains, addresses and mailboxes behind it." />
      <QueryTabs tabs={TABS} label="Mail sections" testIdPrefix="console-mail-tab" className="mb-5" />
      <TabPanel testIdPrefix="console-mail-tab" current={tab}>
        {tab === "delivery" && <DeliveryTab />}
        {tab === "domains" && <DomainsTab />}
        {tab === "suppressions" && <SuppressionsTab />}
        {tab === "connections" && <ConnectionsTab />}
      </TabPanel>
    </div>
  );
}
