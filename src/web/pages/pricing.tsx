import { PlanCards } from "@/web/components/plan-cards";
import { PLAN_ORDER, PLANS } from "@/shared/plans";
import { Check, Minus } from "lucide-react";

const rows: { label: string; get: (id: (typeof PLAN_ORDER)[number]) => string | boolean }[] = [
  { label: "Custom domains", get: (id) => String(PLANS[id].limits.domains) },
  { label: "Mailboxes", get: (id) => String(PLANS[id].limits.mailboxes) },
  { label: "Aliases & forwards", get: (id) => PLANS[id].limits.aliases.toLocaleString() },
  { label: "Storage per mailbox", get: (id) => `${PLANS[id].limits.storagePerMailboxMb / 1024} GB` },
  { label: "Recipients per day", get: (id) => PLANS[id].limits.dailySends.toLocaleString() },
  { label: "Live DNS verification", get: () => true },
  { label: "Per-domain DKIM keys", get: () => true },
  { label: "Catch-all & plus addressing", get: () => true },
  { label: "Delivery logs & audit trail", get: () => true },
  { label: "Priority support", get: (id) => id === "business" },
];

export function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-5 pb-24 pt-32 sm:pt-40">
      <div className="mx-auto mb-14 max-w-2xl text-center">
        <h1 className="text-fg text-4xl font-semibold tracking-tight sm:text-5xl">Pricing</h1>
        <p className="mt-4 text-[17px] text-muted">Every plan includes verified DNS, webmail and inbound routing. Pay for room to grow, not for features held hostage.</p>
      </div>
      <PlanCards headingLevel={2} />
      <div className="mt-20 overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">Plan comparison</caption>
          <thead>
            <tr className="border-b border-line bg-surface text-left">
              <th scope="col" className="px-5 py-4 font-medium text-muted">Compare plans</th>
              {PLAN_ORDER.map((id) => <th key={id} scope="col" className="px-5 py-4 font-semibold">{PLANS[id].name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-line last:border-0">
                <th scope="row" className="px-5 py-3.5 text-left font-normal text-muted">{r.label}</th>
                {PLAN_ORDER.map((id) => {
                  const v = r.get(id);
                  return (
                    <td key={id} className="px-5 py-3.5">
                      {v === true ? <Check className="h-4 w-4 text-ok" aria-label="Included" /> : v === false ? <Minus className="h-4 w-4 text-subtle" aria-label="Not included" /> : v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
