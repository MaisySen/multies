import { useState, type ReactNode } from "react";
import { IconCheck, IconCopy } from "./icon";
import { cn } from "@/web/lib/cn";
import { useMarkSkeleton } from "@/web/lib/load-errors-t1g"; // T1G (T1-8)
import { toast } from "sonner";

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-line bg-surface shadow-card", className)} {...rest}>{children}</div>;
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "brand";
const tones: Record<Tone, string> = {
  neutral: "bg-fill text-muted border-line",
  ok: "bg-ok-soft text-ok border-ok/20",
  warn: "bg-warn-soft text-warn border-warn/20",
  bad: "bg-bad-soft text-bad border-bad/20",
  brand: "bg-brand-soft text-brand-hover border-brand/25",
};
export function Badge({ tone = "neutral", children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4", tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  useMarkSkeleton(); // T1G: the app frame offers Retry when a failed read leaves this on screen
  return <div className={cn("skeleton h-4", className)} style={style} aria-hidden />;
}

export function EmptyState({ icon, art, title, body, action, className }: { icon?: ReactNode; art?: ReactNode; title: string; body: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {/* R35: an illustration (components/illustrations.tsx) when the list has one, else the round icon. */}
      {art ? <div className="mb-4" aria-hidden>{art}</div> : <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-fill text-muted [&_svg]:h-5 [&_svg]:w-5" aria-hidden>{icon}</div>}
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** R39: `toastText` also shows a toast naming what was copied (one tap copy on the domain records). */
export function CopyButton({ value, label = "Copy", className, toastText }: { value: string; label?: string; className?: string; toastText?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
        if (toastText) toast.success(toastText);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-fill px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg max-sm:min-h-11 max-sm:px-3", className)}
      aria-label={done ? "Copied" : `${label} to clipboard`}
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-ok" /> : <IconCopy className="h-3.5 w-3.5" />}
      <span>{done ? "Copied" : label}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  // R36: native looking key cap (.keycap in index.css).
  return <kbd className="keycap">{children}</kbd>;
}

/** `drawn`: the letters are drawn by CSS instead of a text node. R54: use it inside a button with its own aria-label,
 *  where axe counts the hidden letters as the button's visible words (label-content-name-mismatch). */
export function Avatar({ label, className, drawn }: { label: string; className?: string; drawn?: boolean }) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-fg", drawn && "before:content-[attr(data-label)]", className)}
      style={{ background: `hsl(${h} var(--avatar-s) var(--avatar-l))` }}
      aria-hidden
      data-label={drawn ? label : undefined}
    >
      {drawn ? null : label}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition-colors duration-200 ease-out disabled:opacity-40 max-sm:h-[31px] max-sm:w-[51px]", checked ? "bg-brand" : "bg-line-strong")}
    >
      <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.2)] transition-transform duration-200 [transition-timing-function:var(--ease-spring)] max-sm:h-[27px] max-sm:w-[27px]", checked ? "translate-x-4 max-sm:translate-x-5" : "translate-x-0")} />
    </button>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: string; description?: ReactNode; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-0.5 text-[13px] font-semibold text-brand-hover">{eyebrow}</p>}
        <h1 className="large-title">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * R33: one headline number. Label on top, a large tabular figure, an optional hint underneath and an icon chip,
 * the way Linear and Vercel dashboards set a stat. Tone colours the chip only, never the number.
 */
export function StatTile({ label, value, hint, icon, tone = "neutral", className }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone; className?: string }) {
  const chip: Record<Tone, string> = { neutral: "bg-fill text-muted", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", brand: "bg-brand-soft text-brand-hover" };
  return (
    <Card className={cn("flex min-w-0 flex-col gap-3 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[12.5px] font-medium leading-tight text-muted [overflow-wrap:anywhere]">{label}</span>
        {icon && <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5", chip[tone])} aria-hidden>{icon}</span>}
      </div>
      <div className="text-[26px] font-semibold leading-none tracking-tight tabular-nums">{value}</div>
      {hint && <div className="-mt-1 text-xs text-subtle">{hint}</div>}
    </Card>
  );
}

/** R33: the shared look for admin data tables: a quiet header band, roomy rows, a hover tint. */
export const tableStyles = {
  wrap: "overflow-x-auto rounded-xl border border-line",
  table: "w-full text-sm",
  head: "bg-fill/60 text-left text-[12px] font-medium text-muted",
  th: "px-4 py-2.5 font-medium whitespace-nowrap",
  body: "divide-y divide-line",
  row: "transition-colors hover:bg-hover/50",
  td: "px-4 py-3 align-middle",
};

export function Meter({ value, max, className, label }: { value: number; max: number; className?: string; label?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-fill", className)} role="progressbar" aria-label={label ?? `${value} of ${max} used`} aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", pct > 90 ? "bg-bad" : pct > 70 ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} />
    </div>
  );
}
