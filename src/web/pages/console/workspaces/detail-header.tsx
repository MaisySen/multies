/**
 * OPS1: the header of a console detail page (a workspace, a person), so both read the same way:
 *
 *   <DetailHeader back={{ to: "/console/workspaces", label: "All workspaces" }} title={org.name}
 *     meta={<>...plan badge, owner link, id with <CopyIdButton value={org.id} label="Copy workspace id" />...</>}
 *     note={suspended reason} actions={<Buttons />} />
 *
 * Back link above the title, no eyebrow, one wrapping line of facts under the title, the actions on the right (under
 * the title on phones).
 */
import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { BackLink } from "../components/format";

/** A small copy icon button with an accessible label (the label is also its tooltip). */
export function CopyIdButton({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      data-testid={testId}
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:h-9 max-sm:w-9"
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-ok" aria-hidden /> : <IconCopy className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

/** A dot between facts in the header's meta line. */
export function MetaDot() {
  return <span aria-hidden className="text-subtle max-sm:hidden">·</span>;
}

export function DetailHeader({ back, title, meta, note, actions, className, testId }: {
  back: { to: string; label: string };
  title: ReactNode;
  meta?: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <header className={cn("mb-4 space-y-3", className)} data-testid={testId}>
      <BackLink to={back.to}>{back.label}</BackLink>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <h1 className="large-title [overflow-wrap:anywhere]">{title}</h1>
          {meta && <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-muted">{meta}</div>}
          {note}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
