/**
 * R79: a light toolbar control that shows its current setting as words ("Assignee: Anyone"), not a boxed dropdown.
 * Underneath it is the shared Select (native select on a computer, the bottom sheet on a phone), so keyboard and
 * screen readers keep working as before.
 */
import type { ReactNode, SelectHTMLAttributes } from "react";
import { cn } from "@/web/lib/cn";
import { Select } from "./input";

export function ChipSelect({ label, active, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; active?: boolean; children: ReactNode }) {
  return (
    <label className={cn("relative inline-flex h-8 cursor-pointer items-center gap-1 rounded-lg pl-2.5 pr-6 text-[13px] transition-colors duration-100 focus-within:ring-2 focus-within:ring-brand/40 motion-reduce:transition-none",
      active ? "bg-brand-soft text-brand-hover" : "text-muted hover:bg-hover hover:text-fg", className)}>
      <span className="whitespace-nowrap">{label}</span>
      <Select bare {...rest} className="max-w-[12rem] cursor-pointer appearance-none truncate bg-transparent font-medium text-fg outline-none [&>option]:bg-surface [&>option]:text-fg"
        phoneClassName="max-w-[10rem] truncate text-left font-medium text-fg">
        {children}
      </Select>
      <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 opacity-60"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </label>
  );
}
