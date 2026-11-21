/**
 * OPS1 Trends: a small row of chips that picks which view a chart card shows (for cards with more than the two
 * series a chart draws at once). Looks like the RangePicker next to it.
 */
import { cn } from "@/web/lib/cn";

export interface ChipOption<K extends string> { id: K; label: string }

export function ViewChips<K extends string>({ value, onChange, options, label, testId }: {
  value: K; onChange: (v: K) => void; options: readonly ChipOption<K>[]; label: string; testId?: string;
}) {
  if (options.length < 2) return null;
  return (
    <div role="group" aria-label={label} className="inline-flex max-w-full shrink-0 flex-wrap items-center gap-0.5 rounded-lg bg-fill p-0.5" data-testid={testId}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            onClick={() => { if (!on) onChange(o.id); }}
            className={cn(
              "h-7 rounded-md px-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-10 max-sm:px-3",
              on ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
