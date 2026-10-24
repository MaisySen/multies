import { CircleAlert, CircleCheck, CircleX, Inbox } from "lucide-react";
import type { CheckStatus, DomainCheckItem, DomainMailCheck } from "@/shared/mail-check";
import { cn } from "@/web/lib/cn";

const icon: Record<CheckStatus, typeof CircleCheck> = { pass: CircleCheck, warn: CircleAlert, fail: CircleX };
const tone: Record<CheckStatus, string> = { pass: "text-ok", warn: "text-warn", fail: "text-bad" };
const word: Record<CheckStatus, string> = { pass: "Set", warn: "Needs attention", fail: "Missing or broken" };

/** One SPF or DMARC row: status, plain words and the record as published. */
function CheckRow({ title, item }: { title: string; item: DomainCheckItem }) {
  const Icon = icon[item.status];
  return (
    <li className="flex gap-3 py-4">
      <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", tone[item.status])} aria-hidden />
      <div className="min-w-0">
        <p className="font-medium">{title} <span className="sr-only">: {word[item.status]}</span></p>
        <p className="mt-0.5 text-[14px] text-muted">{item.message}</p>
        {item.records.map((r) => <p key={r} className="mt-1.5 break-all rounded-md bg-fill px-2 py-1 font-mono text-[12px] text-muted">{r}</p>)}
      </div>
    </li>
  );
}

/** Who hosts the domain's mail today, with its MX hosts. */
export function ProviderSummary({ check }: { check: DomainMailCheck }) {
  return (
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand-hover"><Inbox className="h-5 w-5" aria-hidden /></span>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-subtle">Mail for {check.domain} goes to</p>
        <p className="text-lg font-semibold">{check.provider.name}</p>
        {check.mx.length > 0 && <p className="mt-0.5 break-all text-[13px] text-subtle">{check.mx.map((m) => m.host).join(", ")}</p>}
      </div>
    </div>
  );
}

export function SenderChecks({ check }: { check: DomainMailCheck }) {
  return (
    <ul className="divide-y divide-line">
      <CheckRow title="Sender policy (SPF)" item={check.spf} />
      <CheckRow title="Forgery policy (DMARC)" item={check.dmarc} />
    </ul>
  );
}

/** The numbered switch plan. */
export function SwitchPlan({ check, className }: { check: DomainMailCheck; className?: string }) {
  return (
    <ol className={cn("space-y-4", className)}>
      {check.steps.map((s, i) => (
        <li key={s.id} className="flex gap-3">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-fill text-[12px] font-semibold text-muted" aria-hidden>{i + 1}</span>
          <div className="min-w-0">
            <p className="font-medium">{s.title}</p>
            <p className="mt-0.5 text-[14px] text-muted">{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Fetches the public check. Throws the server's message so pages can show it. */
export async function fetchMailCheck(domain: string): Promise<DomainMailCheck> {
  const res = await fetch(`/api/check/domain?domain=${encodeURIComponent(domain)}`, { headers: { accept: "application/json" } });
  const body = (await res.json().catch(() => null)) as { check?: DomainMailCheck; error?: { message?: string } } | null;
  if (!res.ok || !body?.check) throw new Error(body?.error?.message ?? "The check didn't finish. Try again.");
  return body.check;
}
