/**
 * R39 premium pass 5: shared pieces for mailboxes, team, deliverability and connections, in pass 4's language.
 * A plain word status pill, a mailbox kind pill, a small storage ring and a headline number tile. Motion is 180 ms
 * and stops under prefers-reduced-motion; every colour is a theme token so dark mode follows.
 */
import type { ReactNode } from "react";
import { IconAgent, IconCheck, IconCircleDot, IconTeam, IconUser, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { MAILBOX_KIND_LABELS, PLAIN_STATUS_LABELS, type MailboxKind, type PlainStatus } from "@/web/lib/premium5-r39";

const STATUS: Record<PlainStatus, { cls: string; icon: ReactNode }> = {
  good: { cls: "bg-ok-soft text-ok border-ok/20", icon: <IconCheck className="h-3 w-3" /> },
  check: { cls: "bg-warn-soft text-warn border-warn/20", icon: <IconWarning className="h-3 w-3" /> },
  unset: { cls: "bg-fill text-muted border-line", icon: <IconCircleDot className="h-3 w-3" /> },
};

/** A status pill in plain words: Good, Check this or Not set up. */
export function PlainStatusPill({ status, className }: { status: PlainStatus; className?: string }) {
  const s = STATUS[status];
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium", s.cls, className)} data-testid="plain-status" data-status={status}>
      {s.icon}{PLAIN_STATUS_LABELS[status]}
    </span>
  );
}

const KIND: Record<MailboxKind, { cls: string; icon: ReactNode }> = {
  personal: { cls: "bg-fill text-muted", icon: <IconUser className="h-3 w-3" /> },
  shared: { cls: "bg-brand-soft text-brand-hover", icon: <IconTeam className="h-3 w-3" /> },
  agent: { cls: "bg-ok-soft text-ok", icon: <IconAgent className="h-3 w-3" /> },
};

/** Personal, Shared or Agent, as a small tinted pill. */
export function MailboxKindPill({ kind }: { kind: MailboxKind }) {
  const k = KIND[kind];
  return <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium", k.cls)} data-testid="mailbox-kind" data-kind={kind}>{k.icon}{MAILBOX_KIND_LABELS[kind]}</span>;
}

/** A small drawn ring for storage, the figure beside it; reads out as a progress bar. */
export function StorageRing({ used, max, label, show }: { used: number; max: number; label: string; show: (n: number) => string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0;
  const size = 32; const r = 13; const c = 2 * Math.PI * r;
  const tone = pct > 90 ? "text-bad" : pct > 70 ? "text-warn" : "text-brand";
  return (
    <div className="flex items-center gap-2.5" data-testid="storage-ring">
      <span role="progressbar" aria-label={`${label}: ${show(used)} of ${show(max)} used`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className="shrink-0">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle cx={16} cy={16} r={r} fill="none" strokeWidth={4} style={{ stroke: "var(--color-fill)" }} />
          <circle cx={16} cy={16} r={r} fill="none" strokeWidth={4} strokeLinecap="round" stroke="currentColor"
            className={cn(tone, "transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none")}
            strokeDasharray={c} strokeDashoffset={c - (c * Math.max(pct, used > 0 ? 4 : 0)) / 100} />
        </svg>
      </span>
      <div className="min-w-0 text-right leading-tight" data-ring-text>
        <div className="whitespace-nowrap text-[13px] font-semibold tabular-nums">{show(used)}</div>
        <div className="whitespace-nowrap text-[11px] text-subtle tabular-nums">of {show(max)}</div>
      </div>
    </div>
  );
}

/** One headline number in a tile: an icon chip, the figure and a label. */
export function HeadlineTile({ icon, value, label, tone = "brand", testId }: { icon: ReactNode; value: number | string; label: string; tone?: "brand" | "ok" | "warn" | "neutral"; testId?: string }) {
  const chip = { brand: "bg-brand-soft text-brand-hover", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", neutral: "bg-fill text-muted" }[tone];
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[14px] border border-line bg-surface p-3.5 shadow-[var(--shadow-e1)]" data-testid={testId}>
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]", chip)} aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className="text-[20px] font-semibold leading-none tabular-nums">{value}</div>
        <div className="mt-1 text-[12px] leading-tight text-muted [overflow-wrap:anywhere]">{label}</div>
      </div>
    </div>
  );
}

/** A tinted rounded tile with the initials of a mailbox or a person; the hue follows the name so it stays stable. */
export function AvatarTile({ label, name, size = 40 }: { label: string; name: string; size?: number }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-[12px] text-[14px] font-semibold text-fg"
      style={{ width: size, height: size, background: `hsl(${h} var(--avatar-s) var(--avatar-l))` }}>{label}</span>
  );
}
