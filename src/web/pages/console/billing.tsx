/**
 * OPS1: Billing in the operator console. Tabs (kept in ?tab=): Past due (default), Subscriptions, Stripe events,
 * Free plans (comps) and Referrals. Billing actions live on each workspace's Billing tab, which every row opens.
 * One notice at the top says when Stripe is not connected on this deployment.
 */
import { PageHeader } from "@/web/components/ui/misc";
import { QueryTabs, TabPanel, useQueryTab } from "./components/detail-tabs";
import { BillingNotConnected } from "./billing-api";
import { CompsList, EventsList, PastDueList, ReferralsList, SubscriptionsList } from "./billing-lists";

const TABS = [
  { id: "past-due", label: "Past due" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "events", label: "Stripe events" },
  { id: "comps", label: "Free plans" },
  { id: "referrals", label: "Referrals" },
] as const;

export function ConsoleBillingPage() {
  const tab = useQueryTab(TABS);
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Customers" title="Billing" description="Who is behind on payment, every subscription, what Stripe told us, free plans and referrals. Open a workspace to change its billing." />
      <BillingNotConnected />
      <QueryTabs tabs={TABS} label="Billing lists" testIdPrefix="console-billing-tab" />
      <TabPanel testIdPrefix="console-billing-tab" current={tab}>
        {tab === "past-due" && <PastDueList />}
        {tab === "subscriptions" && <SubscriptionsList />}
        {tab === "events" && <EventsList />}
        {tab === "comps" && <CompsList />}
        {tab === "referrals" && <ReferralsList />}
      </TabPanel>
    </div>
  );
}
