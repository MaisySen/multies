import { useState } from "react";
import { IconClose, IconSliders } from "@/web/components/ui/icon";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { cn } from "@/web/lib/cn";
import { tr } from "@/web/i18n"; // POL4 (HQ MB-356)

/**
 * R40 (MB-209): filters on a phone. One Filter button with the count of active filters, a chip per active filter
 * (tap the x to clear it), and a bottom sheet with each filter as a list of pill choices, instead of a row of browser
 * selects. Shown below the sm breakpoint only; larger screens keep their inline selects.
 */
export interface FilterGroup {
  key: string;
  label: string;
  value: string;
  /** The first option is the "any" choice (value ""). */
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

export function PhoneFilters({ groups, className }: { groups: FilterGroup[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const active = groups.filter((g) => g.value);
  const labelOf = (g: FilterGroup) => g.options.find((o) => o.value === g.value)?.label ?? g.value;
  return (
    <div className={cn("flex items-center gap-2 sm:hidden", className)} data-testid="phone-filters">
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="phone-filter-button"
        className={cn("inline-flex h-11 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors duration-150 motion-reduce:transition-none",
          active.length ? "border-brand/40 bg-brand-soft text-brand-hover" : "border-line bg-elevated text-fg")}>
        <IconSliders className="h-3.5 w-3.5" aria-hidden />{tr("tasks.filter")}{active.length ? <span className="grid h-4 min-w-4 place-items-center rounded-full bg-brand px-1 text-[10.5px] font-semibold text-white">{active.length}</span> : null}
      </button>
      {active.map((g) => (
        <span key={g.key} className="inline-flex h-11 items-center gap-1 rounded-full border border-line bg-elevated pl-2.5 pr-1 text-[12.5px]" data-testid="filter-chip">
          {labelOf(g)}
          <button type="button" onClick={() => g.onChange("")} aria-label={tr("tasks.clear_filter", { name: g.label.toLowerCase() })} className="grid h-9 w-9 place-items-center rounded-full text-subtle hover:bg-hover hover:text-fg"><IconClose className="h-3 w-3" /></button>
        </span>
      ))}
      <Dialog open={open} onClose={() => setOpen(false)} title={tr("tasks.filter")}
        footer={<>{active.length ? <Button variant="ghost" onClick={() => active.forEach((g) => g.onChange(""))}>{tr("tasks.clear_all")}</Button> : null}<Button onClick={() => setOpen(false)}>{tr("common.done")}</Button></>}>
        <div className="space-y-5">
          {groups.map((g) => (
            <fieldset key={g.key}>
              <legend className="mb-2 text-[13px] font-semibold">{g.label}</legend>
              <div role="radiogroup" aria-label={g.label} className="flex flex-wrap gap-2">
                {g.options.map((o) => (
                  <button key={o.value || "any"} type="button" role="radio" aria-checked={g.value === o.value} onClick={() => g.onChange(o.value)}
                    className={cn("min-h-10 rounded-full border px-3.5 text-[13.5px] transition-colors duration-150 motion-reduce:transition-none",
                      g.value === o.value ? "border-brand bg-brand text-white" : "border-line bg-surface text-fg hover:border-line-strong")}>{o.label}</button>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </Dialog>
    </div>
  );
}
