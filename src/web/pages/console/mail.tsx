/**
 * OPS1: Mail and deliverability in the operator console. Tabs (kept in ?tab=): Delivery problems (default), Domains,
 * Suppressions, Held sends, Connected mailboxes, Imports. Each opens on what needs attention. No subjects, bodies or
 * credentials anywhere: content access is only through audited impersonation.
 */
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, useQueryTab, type DetailTab } from "./components/detail-tabs";
import { DeliveryTab } from "./mail-delivery";
import { DomainsTab, HeldSendsTab, SuppressionsTab } from "./mail-domains";
import { ConnectionsTab, ImportsTab } from "./mail-accounts";

const TABS: DetailTab[] = [
  { id: "delivery", label: "Delivery problems" },
  { id: "domains", label: "Domains" },
  { id: "suppressions", label: "Suppressions" },
  { id: "held", label: "Held sends" },
  { id: "connections", label: "Connected mailboxes" },
  { id: "imports", label: "Imports" },
];

export function ConsoleMailPage() {
  const tab = useQueryTab(TABS);
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Product" title="Mail and deliverability" description="Where mail is failing, and the domains, addresses and mailboxes behind it." />
      <QueryTabs tabs={TABS} label="Mail sections" testIdPrefix="console-mail-tab" className="mb-5" />
      <TabPanel testIdPrefix="console-mail-tab" current={tab}>
        {tab === "delivery" && <DeliveryTab />}
        {tab === "domains" && <DomainsTab />}
        {tab === "suppressions" && <SuppressionsTab />}
        {tab === "held" && <HeldSendsTab />}
        {tab === "connections" && <ConnectionsTab />}
        {tab === "imports" && <ImportsTab />}
      </TabPanel>
    </div>
  );
}
