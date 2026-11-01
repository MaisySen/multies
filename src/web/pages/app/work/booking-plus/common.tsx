/** R92: small pieces shared by the Booking plus tabs. */
import type { ReactNode } from "react";
import { cn } from "@/web/lib/cn";

export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const ZONES = (() => {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return fn ? fn("timeZone") : ["UTC", "Australia/Sydney", "Asia/Kathmandu", "Europe/London", "America/New_York"];
})();
export const dayLabel = (s: string | Date) => new Date(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
export const timeLabel = (s: string | Date) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
export const whenLabel = (s: string) => `${dayLabel(s)}, ${timeLabel(s)}`;
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
/** A date input's day plus a time input's HH:MM, read in this browser's zone. */
export const localIso = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();

/** A segmented choice that reads as radios to screen readers. */
export function Segmented<T extends string>({ value, options, onChange, label, className }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn("inline-flex rounded-lg bg-fill p-0.5 text-[13px]", className)}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={cn("min-h-9 rounded-md px-3 font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand max-sm:min-h-11", value === v ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}>{l}</button>
      ))}
    </div>
  );
}

export function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex min-h-9 items-center justify-between gap-2"><h2 className="text-[15px] font-semibold">{title}</h2>{action}</div>
      {children}
    </section>
  );
}
