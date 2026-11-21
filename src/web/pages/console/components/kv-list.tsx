/**
 * OPS1: a label and value list for detail pages.
 * Usage: <KvList items={[{ label: "Plan", value: <Badge>Pro</Badge> }, { label: "Id", value: org.id, mono: true, copy: true }]} />
 * Empty values (null, undefined, "") show a quiet "None" (EMPTY in ./format).
 */
import type { ReactNode } from "react";
import { CopyButton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import { EMPTY } from "./format";

export interface KvItem { label: string; value: ReactNode; mono?: boolean; copy?: boolean; hint?: ReactNode }

export function KvList({ items, className }: { items: KvItem[]; className?: string }) {
  return (
    <dl className={cn("divide-y divide-line rounded-xl border border-line bg-surface text-sm", className)}>
      {items.map((it) => {
        const empty = it.value === null || it.value === undefined || it.value === "";
        return (
          <div key={it.label} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,180px)_1fr] sm:gap-4">
            <dt className="text-muted">{it.label}</dt>
            <dd className={cn("min-w-0 [overflow-wrap:anywhere]", it.mono && "font-mono text-[13px]")}>
              {empty ? <span className="text-subtle">{EMPTY}</span> : (
                <span className="inline-flex max-w-full items-center gap-1.5">
                  <span className="min-w-0">{it.value}</span>
                  {it.copy && typeof it.value === "string" && <CopyButton value={it.value} label={`Copy ${it.label.toLowerCase()}`} />}
                </span>
              )}
              {it.hint && <span className="mt-0.5 block text-xs text-subtle">{it.hint}</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
