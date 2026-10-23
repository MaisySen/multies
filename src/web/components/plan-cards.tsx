import { Check } from "lucide-react";
import { PLAN_ORDER, PLANS, PRICE_LABEL, formatPlanPrice } from "@/shared/plans";
import { ButtonLink } from "@/web/components/ui/button";
import { cn } from "@/web/lib/cn";

export function PlanCards({ ctaTo = "/signup", headingLevel = 3 }: { ctaTo?: string; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const p = PLANS[id];
        return (
          <div key={id} className={cn("relative flex flex-col rounded-2xl border p-6", p.highlighted ? "border-brand/60 bg-surface" : "border-line bg-surface")}>
            {p.highlighted && <span className="absolute -top-2.5 left-6 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold text-brand-fg">Most popular</span>}
            <H className="text-[15px] font-semibold">{p.name}</H>
            <p className="mt-1 text-sm text-muted">{p.tagline}</p>
            <p className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-semibold tracking-tight">{formatPlanPrice(p.priceMonthly)}</span>
              <span className="text-sm text-subtle">{PRICE_LABEL} / month</span>
            </p>
            <ul className="mt-6 flex-1 space-y-2.5 text-sm">
              {p.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-fg/85"><Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-hover" />{f}</li>
              ))}
            </ul>
            <ButtonLink to={ctaTo} variant={p.highlighted ? "primary" : "secondary"} className="mt-8 w-full">
              {p.priceMonthly === 0 ? "Start free" : `Start with ${p.name}`}
            </ButtonLink>
          </div>
        );
      })}
    </div>
  );
}
