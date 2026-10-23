import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/web/lib/cn";

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-line bg-surface", className)} {...rest}>{children}</div>;
}

type Tone = "neutral" | "ok" | "warn" | "bad" | "brand";
const tones: Record<Tone, string> = {
  neutral: "bg-white/[0.06] text-muted border-line",
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

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} aria-hidden />;
}

export function EmptyState({ icon, title, body, action, className }: { icon: ReactNode; title: string; body: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      <div className="relative mb-5">
        <div className="absolute inset-0 -m-3 rounded-full bg-brand/10 blur-xl" aria-hidden />
        <div className="relative grid h-12 w-12 place-items-center rounded-xl border border-line-strong bg-elevated text-muted [&_svg]:h-5 [&_svg]:w-5">{icon}</div>
      </div>
      <h2 className="text-[15px] font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-elevated px-2 text-xs text-muted transition-colors hover:border-line-strong hover:text-fg", className)}
      aria-label={done ? "Copied" : `${label} to clipboard`}
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{done ? "Copied" : label}</span>
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line-strong bg-elevated px-1 font-sans text-[10.5px] text-muted">{children}</kbd>;
}

export function Avatar({ label, className }: { label: string; className?: string }) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-fg", className)}
      style={{ background: `hsl(${h} 22% 24%)` }}
      aria-hidden
    >
      {label}
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50", checked ? "border-brand bg-brand" : "border-line-strong bg-elevated")}
    >
      <span className={cn("absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight sm:text-[22px]">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Meter({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]", className)} role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-valuemin={0}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", pct > 90 ? "bg-bad" : pct > 70 ? "bg-warn" : "bg-brand")} style={{ width: `${Math.max(pct, value > 0 ? 3 : 0)}%` }} />
    </div>
  );
}
