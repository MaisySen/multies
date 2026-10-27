/**
 * R45 (MB-137): "Archive older mail". A sheet with four cuts (1 week, 1 month, 3 months, 1 year), the count of Inbox
 * mail dated before the cut (POST /api/mail/bulk-jobs/preview, scoped like the job, so only mailboxes the person can
 * open), then ONE server job with progress and one Undo in the bulk toast (mail/bulk-ops-r33.ts).
 */
import { useEffect, useId, useState } from "react";
import { Dialog } from "@/web/components/ui/dialog";
import { Button } from "@/web/components/ui/button";
import { Spinner } from "@/web/components/ui/spinner";
import { IconArchive } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { olderCountWords } from "./archive-older-offer"; // R46

export type OlderPreset = "week" | "month" | "quarter" | "year";
export const OLDER_PRESETS: { id: OlderPreset; label: string; hint: string }[] = [
  { id: "week", label: "1 week", hint: "Keeps this week" },
  { id: "month", label: "1 month", hint: "Keeps the last month" },
  { id: "quarter", label: "3 months", hint: "Keeps the last 3 months" },
  { id: "year", label: "1 year", hint: "Keeps the last year" },
];

/** The cut for a preset: mail dated before this moves. */
export function olderCut(preset: OlderPreset, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  if (preset === "week") d.setDate(d.getDate() - 7);
  else if (preset === "month") d.setMonth(d.getMonth() - 1);
  else if (preset === "quarter") d.setMonth(d.getMonth() - 3);
  else d.setFullYear(d.getFullYear() - 1);
  return d.toISOString();
}

export function ArchiveOlderSheet({ open, onClose, mailboxId, asOf, onRun, everyTab = false }: {
  open: boolean; onClose: () => void; mailboxId: string; asOf: string;
  /** R46: split tabs are on; the job and the count cover every tab, and the words say so. */
  everyTab?: boolean;
  onRun: (before: string, count: number) => void;
}) {
  const [preset, setPreset] = useState<OlderPreset>("month");
  const [count, setCount] = useState<{ before: string; total: number; max: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const name = useId();
  const base = new Date(asOf || Date.now());
  const before = olderCut(preset, Number.isNaN(base.getTime()) ? new Date() : base);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setCount(null);
    setFailed(false);
    api.post<{ total: number; max: number }>("/mail/bulk-jobs/preview", { scope: { mailboxId, folder: "inbox", before }, max_received_at: asOf })
      .then((r) => { if (live) setCount({ before, ...r }); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [open, mailboxId, before, asOf]);
  const ready = count && count.before === before ? count : null;
  const n = ready ? Math.min(ready.total, ready.max) : 0;
  const words = failed ? "Couldn't count that mail. Try again in a moment."
    : !ready ? "Counting…"
      : olderCountWords(ready.total, ready.max, everyTab);
  return (
    <Dialog open={open} onClose={onClose} title="Archive older mail"
      description={everyTab ? "Inbox mail dated before the cut moves to Archive, from every Inbox tab, not only this one. New mail stays where it is, and you can undo it." : "Inbox mail dated before the cut moves to Archive. New mail stays where it is, and you can undo it."}
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button data-testid="archive-older-run" disabled={!ready || n === 0} onClick={() => { onRun(before, n); onClose(); }}>
          <IconArchive className="h-4 w-4" />{n > 0 ? `Archive ${n.toLocaleString()}` : "Archive"}
        </Button>
      </>}>
      <fieldset>
        <legend className="mb-2 text-[13px] font-medium text-muted">Older than</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Older than">
          {OLDER_PRESETS.map((p) => (
            <label key={p.id} className={cn(
              "relative flex min-h-11 cursor-pointer flex-col justify-center rounded-xl border px-3 py-2 transition-[border-color,background-color,box-shadow] duration-150 ease-out",
              "focus-within:ring-2 focus-within:ring-brand/40",
              preset === p.id ? "border-brand bg-brand/8 text-fg" : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
            )}>
              <input type="radio" name={name} value={p.id} checked={preset === p.id} onChange={() => setPreset(p.id)} className="sr-only" data-testid={`archive-older-${p.id}`} />
              <span className="text-sm font-semibold">{p.label}</span>
              <span className="text-[11px] text-subtle">{p.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-4 flex min-h-6 items-center gap-2 text-sm" aria-live="polite" data-testid="archive-older-count">
        {!ready && !failed && <Spinner className="h-4 w-4" />}
        <span className={cn(failed ? "text-bad" : ready && ready.total > 0 ? "text-fg" : "text-muted")}>{words}</span>
      </p>
    </Dialog>
  );
}
