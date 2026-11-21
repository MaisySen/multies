/**
 * OPS1: Billing in the operator console. Tabs (kept in ?tab=): Past due (default), Subscriptions, Stripe events,
 * Free plans (comps) and Referrals. Billing actions live on each workspace's Billing tab, which every row opens.
 * A notice at the top says when Stripe is not connected on this deployment.
 */
import { Link, useSearchParams } from "react-router";
import { PageHeader } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { BillingNotConnected } from "./billing-api";
import { CompsList, EventsList, PastDueList, ReferralsList, SubscriptionsList } from "./billing-lists";

const TABS = [
  { id: "past-due", label: "Past due" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "events", label: "Stripe events" },
  { id: "comps", label: "Free plans" },
  { id: "referrals", label: "Referrals" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function ConsoleBillingPage() {
  const [params] = useSearchParams();
  const raw = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === raw) ? (raw as TabId) : "past-due";
  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Customers" title="Billing" description="Who is behind on payment, every subscription, what Stripe told us, free plans and referrals. Open a workspace to change its billing." />
      <BillingNotConnected />
      <nav aria-label="Billing lists" className="overflow-x-auto border-b border-line">
        <ul className="flex min-w-max gap-1">
          {TABS.map((t) => (
            <li key={t.id}>
              <Link to={t.id === "past-due" ? "/console/billing" : `/console/billing?tab=${t.id}`} replace aria-current={tab === t.id ? "page" : undefined}
                data-testid={`console-billing-tab-${t.id}`}
                className={cn("-mb-px inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors", tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div key={tab}>
        {tab === "past-due" && <PastDueList />}
        {tab === "subscriptions" && <SubscriptionsList />}
        {tab === "events" && <EventsList />}
        {tab === "comps" && <CompsList />}
        {tab === "referrals" && <ReferralsList />}
      </div>
    </div>
  );
}
