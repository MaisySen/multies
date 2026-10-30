/**
 * R39 premium pass 4: shared pieces for billing, notifications and domain detail. A drawn usage ring, a tinted
 * kind tile with an avatar badge, a setup stepper and a record status pill. Motion is 180 ms and stops under
 * prefers-reduced-motion; every colour is a theme token so dark mode follows.
 */
import type { ReactNode } from "react";
import { IconApprovals, IconAssign, IconChat, IconChatText, IconCheck, IconCircleDot, IconClose, IconDue, IconMail, IconMention, IconWarning } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import { initials, RECORD_PILL_LABELS, usageRing, type RecordPill, type SetupStep } from "@/web/lib/premium4-r39";

const RING_TONE = { brand: "text-brand", warn: "text-warn", bad: "text-bad" } as const;

/** A drawn ring with the figure in the middle; reads out as a progress bar. */
export function UsageRing({ used, max, label, show, size = 48 }: { used: number; max: number; label: string; show?: (n: number) => string; size?: number }) {
  const { pct, tone } = usageRing(used, max);
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const fmt = show ?? ((n: number) => n.toLocaleString());
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="usage-ring">
      <div className="relative shrink-0" style={{ width: size, height: size }}
        role="progressbar" aria-label={`${label}: ${fmt(used)} of ${fmt(max)} used`} aria-valuenow={used} aria-valuemin={0} aria-valuemax={max}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={5} style={{ stroke: "var(--color-fill)" }} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={5} strokeLinecap="round" stroke="currentColor"
            className={cn(RING_TONE[tone], "transition-[stroke-dashoffset] duration-200 ease-out motion-reduce:transition-none")}
            strokeDasharray={c} strokeDashoffset={c - (c * Math.max(pct, used > 0 ? 3 : 0)) / 100} />
        </svg>
        <span className="absolute inset-0 grid place-items-center text-[10px] font-semibold tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-muted" title={label}>{label}</div>
        <div className="whitespace-nowrap text-[14px] font-semibold tabular-nums">{fmt(used)} / {fmt(max)}</div>
      </div>
    </div>
  );
}

type KindTone = "brand" | "ok" | "warn" | "bad" | "neutral";
const KIND: Record<string, { icon: ReactNode; tone: KindTone }> = {
  mention: { icon: <IconMention />, tone: "brand" }, assignment: { icon: <IconAssign />, tone: "ok" }, comment: { icon: <IconChatText />, tone: "neutral" },
  approval: { icon: <IconApprovals />, tone: "warn" }, due_soon: { icon: <IconDue />, tone: "bad" }, chat: { icon: <IconChat />, tone: "brand" },
  email: { icon: <IconMail />, tone: "neutral" }, status: { icon: <IconCircleDot />, tone: "ok" },
};
const TILE: Record<KindTone, string> = { brand: "bg-brand-soft text-brand-hover", ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", neutral: "bg-fill text-muted" };

/** A notification kind as a tinted rounded tile; the actor's initials sit on its corner as a small avatar. */
export function KindTile({ kind, actor, size = "md" }: { kind: string; actor?: string | null; size?: "sm" | "md" }) {
  const k = KIND[kind] ?? { icon: <IconCircleDot />, tone: "neutral" as const };
  let h = 0;
  for (const ch of actor ?? "") h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="relative inline-flex shrink-0" aria-hidden data-testid="kind-tile" data-kind={kind}>
      <span className={cn("grid place-items-center rounded-[10px]", size === "sm" ? "h-7 w-7 [&_svg]:h-3.5 [&_svg]:w-3.5" : "h-9 w-9 [&_svg]:h-[18px] [&_svg]:w-[18px]", TILE[k.tone])}>{k.icon}</span>
      {actor && size === "md" && (
        <span className="absolute -bottom-1 -right-1 grid h-[18px] w-[18px] place-items-center rounded-full text-[8.5px] font-semibold text-fg ring-2 ring-surface"
          style={{ background: `hsl(${h} var(--avatar-s) var(--avatar-l))` }}>{initials(actor)}</span>
      )}
    </span>
  );
}

/** A horizontal stepper: done steps show a check, the current one a ring in the accent, later ones a quiet dot. */
export function Stepper({ steps, current, label }: { steps: SetupStep[]; current: number; label: string }) {
  return (
    <ol className="flex items-start gap-1" aria-label={label} data-testid="setup-stepper">
      {steps.map((s, i) => {
        const now = i === current;
        return (
          <li key={s.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center" aria-current={now ? "step" : undefined}>
            <div className="flex w-full items-center">
              <span className={cn("h-0.5 flex-1 rounded-full", i === 0 ? "bg-transparent" : steps[i - 1]!.done ? "bg-ok" : "bg-line")} />
              <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold transition-colors duration-200 motion-reduce:transition-none",
                s.done ? "bg-ok text-white" : now ? "bg-brand-soft text-brand-hover ring-2 ring-brand" : "bg-fill text-subtle")}>
                {s.done ? <IconCheck className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn("h-0.5 flex-1 rounded-full", i === steps.length - 1 ? "bg-transparent" : s.done ? "bg-ok" : "bg-line")} />
            </div>
            <span className={cn("px-1 text-[12px] leading-tight", now ? "font-semibold text-fg" : s.done ? "text-muted" : "text-subtle")}>
              {s.label}<span className="sr-only">{s.done ? ", done" : now ? ", next" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const PILL: Record<RecordPill, { cls: string; icon: ReactNode }> = {
  verified: { cls: "bg-ok-soft text-ok border-ok/20", icon: <IconCheck className="h-3 w-3" /> },
  pending: { cls: "bg-fill text-muted border-line", icon: <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" /> },
  wrong: { cls: "bg-bad-soft text-bad border-bad/20", icon: <IconClose className="h-3 w-3" /> },
  warning: { cls: "bg-warn-soft text-warn border-warn/20", icon: <IconWarning className="h-3 w-3" /> },
};

/** A record's status pill in plain words: Verified, Pending, Wrong value or Check this. */
export function RecordStatusPill({ pill }: { pill: RecordPill }) {
  const p = PILL[pill];
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-medium", p.cls)} data-testid="record-pill" data-pill={pill}>
      {p.icon}{RECORD_PILL_LABELS[pill]}
    </span>
  );
}
