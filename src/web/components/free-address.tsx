import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, AtSign, Check } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Card } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";

export type FreeAddressInfo =
  | { enabled: false }
  | { enabled: true; domain: string; dailySends: number; available: boolean; suggestion: string; addresses: { id: string; address: string; displayName: string }[] };

export const freeAddressKey = ["free-address"] as const;

export function useFreeAddress() {
  return useQuery({ queryKey: freeAddressKey, queryFn: () => api.get<FreeAddressInfo>("/free-address"), staleTime: 60_000 });
}

/**
 * Take a free address on the shared Multies domain: one field, prefilled, one button.
 * Shows the address once taken, with a link straight to the inbox.
 */
export function FreeAddressCard({ className, compact = false, onDone }: { className?: string; compact?: boolean; onDone?: (address: string) => void }) {
  const info = useFreeAddress();
  const qc = useQueryClient();
  const [local, setLocal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claim = useMutation({
    mutationFn: (localPart: string) => api.post<{ mailbox: { id: string; address: string } }>("/free-address", { localPart }),
    onSuccess: (r) => {
      for (const k of [freeAddressKey, qk.mailboxes, qk.org, qk.dashboard, qk.overview]) qc.invalidateQueries({ queryKey: k });
      toast.success(`${r.mailbox.address} is yours`);
      onDone?.(r.mailbox.address);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "That didn't work. Try again."),
  });
  const d = info.data;
  if (!d || !d.enabled) return null;
  const mine = d.addresses[0];
  if (mine) {
    return (
      <Card className={cn("flex flex-wrap items-center gap-3 p-4", className)} data-testid="free-address-done">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ok-soft text-ok"><Check className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-muted">Your free address</div>
          <div className="truncate font-medium" data-testid="free-address-value">{mine.address}</div>
        </div>
        <ButtonLink size="sm" variant="secondary" to={`/app/mail?mailbox=${mine.id}`}>Open inbox <ArrowRight className="h-4 w-4" /></ButtonLink>
      </Card>
    );
  }
  if (!d.available) return null;
  const value = local ?? d.suggestion;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const v = value.trim().toLowerCase();
    if (v.length < 3) { setError("Use at least 3 letters or numbers."); return; }
    claim.mutate(v);
  };
  return (
    <Card className={cn("p-4 sm:p-5", className)} data-testid="free-address">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand"><AtSign className="h-4 w-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Get a free address</h2>
          {!compact && <p className="mt-0.5 text-sm text-muted">No domain needed. Send and receive straight away. You can add your own domain any time.</p>}
        </div>
      </div>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start" noValidate>
        <div className="min-w-0 flex-1">
          <label htmlFor="free-local" className="sr-only">Address</label>
          <div className={cn("flex items-center rounded-lg border bg-surface focus-within:ring-2 focus-within:ring-brand/40", error ? "border-bad" : "border-line")}>
            <input id="free-local" value={value} onChange={(e) => { setLocal(e.target.value.replace(/\s+/g, "").toLowerCase()); setError(null); }}
              autoComplete="off" spellCheck={false} maxLength={40} aria-invalid={!!error} aria-describedby={error ? "free-local-error" : undefined}
              className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[15px] outline-none" />
            <span className="shrink-0 pr-3 text-[15px] text-subtle">@{d.domain}</span>
          </div>
          {error && <p id="free-local-error" role="alert" className="mt-1.5 text-[13px] text-bad">{error}</p>}
        </div>
        <Button type="submit" loading={claim.isPending}>Get my address</Button>
      </form>
      {!compact && <p className="mt-3 text-[12px] text-subtle">Free addresses can send to {d.dailySends} people a day. Your own domain lifts that.</p>}
    </Card>
  );
}
