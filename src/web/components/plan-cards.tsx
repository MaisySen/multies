import { Check } from "lucide-react";
import { PLAN_ORDER, PLANS } from "@/shared/plans";
import { ButtonLink } from "@/web/components/ui/button";
import { cn } from "@/web/lib/cn";

export function PlanCards({ ctaTo = "/signup" }: { ctaTo?: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {PLAN_ORDER.map((id) => {
        const p = PLANS[id];
        return (
          <div key={id} className={cn("relative flex flex-col rounded-2xl border p-6", p.highlighted ? "border-brand/50 bg-gradient-to-b from-brand/[0.12] to-surface shadow-[0_0_60px_-20px_rgb(110_107_255/0.6)]" : "border-line bg-surface")}>
            {p.highlighted && <span className="absolute -top-2.5 left-6 rounded-full bg-brand px-2.5 py-0.5 text-[11px] font-semibold text-white">Most popular</span>}
            <h3 className="text-[15px] font-semibold">{p.name}</h3>
            <p className="mt-1 text-sm text-muted">{p.tagline}</p>
            <p className="mt-6 flex items-baseline gap-1">
              <span className="text-4xl font-semibold tracking-tight">${p.priceMonthly}</span>
              <span className="text-sm text-subtle">/ month</span>
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
