/**
 * R31: "Since your last visit" at the top of a chat channel, a task panel and a doc. Opening the item reads the digest
 * since the last visit and records this one (the server writes at most once a minute per item). No card when nothing
 * changed. The card says "Digest": it is counted from the workspace's own records, not written by a model. With the
 * workspace's own AI key, "Write a summary" asks that key for a short summary.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconClose, IconHistory } from "@/web/components/ui/icon";
import { api, errorMessage } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { catchupHeadline, type CatchupDigest, type CatchupType } from "@/web/lib/catchup";

export function CatchupCard({ type, id, className }: { type: CatchupType; id: string; className?: string }) {
  const [hidden, setHidden] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null); // QUAL1 (audit row 12): the reason stays on the card
  const q = useQuery({
    queryKey: ["catchup", type, id], staleTime: Infinity, gcTime: 60_000, refetchOnWindowFocus: false, retry: false,
    queryFn: async () => (await api.get<{ catchup: CatchupDigest }>(`/catchup?type=${type}&id=${encodeURIComponent(id)}&visit=1`)).catchup,
  });
  const d = q.data;
  if (hidden || !d?.hasNew) return null;
  const caughtUp = async () => {
    setHidden(true);
    try { await api.post("/catchup/visit", { type, id }); } catch (e) { showError(e as Error); }
  };
  const summarise = async () => {
    setBusy(true); setFailed(null);
    try { setSummary((await api.post<{ summary: string }>("/catchup/summary", { type, id })).summary); } catch (e) { setFailed(errorMessage(e)); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Since your last visit" data-testid="catchup-card"
      className={cn("mx-2 my-2 rounded-xl border border-line bg-elevated px-3.5 py-3 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200", className)}>
      <div className="flex items-start gap-2">
        <IconHistory className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            Since your last visit{d.since ? <span className="font-normal text-subtle"> {timeAgo(d.since)}</span> : null}
            <span className="ml-2 rounded bg-fill px-1.5 py-0.5 align-middle text-[10.5px] font-medium uppercase tracking-wide text-subtle">Digest</span>
          </p>
          <p className="mt-0.5 text-muted" data-testid="catchup-headline">{catchupHeadline(d)}</p>
          {d.decisions.length > 0 && (
            <ul className="mt-2 space-y-1" aria-label="Latest decisions">
              {d.decisions.map((x, i) => <li key={i} className="truncate"><span className="text-subtle">{x.actor ? `${x.actor}: ` : ""}</span>{x.text}</li>)}
            </ul>
          )}
          {!d.decisions.length && d.latest.length > 0 && (
            <ul className="mt-2 space-y-1" aria-label="Newest">
              {d.latest.map((x) => <li key={x.id} className="truncate"><span className="text-subtle">{x.actor ? `${x.actor}: ` : ""}</span>{x.text}</li>)}
            </ul>
          )}
          {summary && <p className="mt-2 rounded-lg bg-bg px-2.5 py-2 text-fg" data-testid="catchup-summary">{summary}</p>}
          {failed && <p role="alert" className="mt-2 rounded-lg bg-bad-soft px-2.5 py-2 text-bad" data-testid="catchup-summary-error">{failed}</p>}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button onClick={() => void caughtUp()} className="rounded-md bg-brand px-2.5 py-1 text-[12.5px] font-medium text-white hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2">Mark as caught up</button>
            {d.canSummarise && !summary && (
              <button onClick={() => void summarise()} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-[12.5px] hover:bg-fill disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{busy ? "Writing..." : failed ? "Try again" : "Write a summary"}</button>
            )}
          </div>
        </div>
        <button onClick={() => setHidden(true)} aria-label="Hide" className="grid h-6 w-6 place-items-center rounded text-subtle hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"><IconClose className="h-3.5 w-3.5" /></button>
      </div>
    </section>
  );
}
