import { Check } from "lucide-react";
import { ADDON_ORDER, ADDONS, PLANS, YEARLY_BELOW_MONTHLY, formatPlanPrice } from "@/shared/plans";
import { ButtonLink } from "@/web/components/ui/button";

/** Free forever on the left, the add-ons on the right: the whole price list in one glance. */
export function PlanCards({ ctaTo = "/signup", headingLevel = 3 }: { ctaTo?: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  const free = PLANS.starter;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.15fr]">
      <div className="flex flex-col rounded-2xl border border-brand/60 bg-surface p-6">
        <H className="text-[15px] font-semibold">Free</H>
        <p className="mt-1 text-sm text-muted">{free.tagline}</p>
        <p className="mt-6 flex items-baseline gap-1">
          <span className="text-4xl font-semibold tracking-tight">A$0</span>
          <span className="text-sm text-subtle">for your whole business</span>
        </p>
        <ul className="mt-6 flex-1 space-y-2.5 text-sm">
          {free.features.map((f) => (
            <li key={f} className="flex items-start gap-2.5 text-fg/85"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-hover" />{f}</li>
          ))}
        </ul>
        <ButtonLink to={ctaTo} className="mt-8 w-full">Start free</ButtonLink>
      </div>
      <div className="flex flex-col rounded-2xl border border-line bg-surface p-6">
        <H className="text-[15px] font-semibold">Add only what you need</H>
        <p className="mt-1 text-sm text-muted">Priced per business, never per person. One invoice for everything.</p>
        <ul className="mt-5 flex-1 divide-y divide-line text-sm">
          {ADDON_ORDER.map((id) => {
            const a = ADDONS[id];
            return (
              <li key={id} className="flex items-baseline justify-between gap-4 py-3">
                <span><span className="font-medium text-fg">{a.name}</span><span className="block text-xs text-subtle">{a.description}</span></span>
                <span className="shrink-0 text-right tabular-nums"><span className="font-semibold">{formatPlanPrice(a.priceMonthly)}</span><span className="text-xs text-subtle"> / mo{a.maxQuantity === 1 ? "" : ` per ${a.unit}`}</span></span>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs text-subtle">Prices in AUD, excluding GST. Under A${YEARLY_BELOW_MONTHLY} a month in total bills once a year, so one extra domain is A$12 a year.</p>
      </div>
    </div>
  );
}
