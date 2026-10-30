/**
 * Tools P2, H7: compare two PDFs (Tools item 8). Two files, older first (uploads, or two versions in a
 * mail thread); the engine compares the words page by page. Multies shows the summary, the change list
 * (added in green, removed in red, by page) and the engine's report PDF.
 */
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { IconArrowRightLeft, IconMinus, IconPlus } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Card, StatTile } from "@/web/components/ui/misc";
import { api } from "@/web/lib/api";
import { readCompareChanges, type CompareChanges, type EditorJob } from "@/shared/tools-editors";
import { readJson, startCompare, waitFor, RunError, sourceName, type Source, carriedPdfs, useTakeCarried } from "./runner";
import { BusyLine, EditorFrame, ErrorCard, PdfPicker, ResultCard, sizeOf } from "./shell";
import { useKeptSource } from "./keep-source"; // R74
import { useLeaveGuard } from "@/web/components/tools/leave-guard"; // R74

type Phase = { kind: "pick" } | { kind: "working"; pct: number | null } | { kind: "done"; report: EditorJob; changes: CompareChanges } | { kind: "failed"; error: RunError };

interface ThreadPdf { id: string; filename: string; sizeBytes: number; date: string }

/** The other PDFs in the thread the person started from, offered as the second version. */
function ThreadPdfs({ attachmentId, chosen, onPick, disabled }: { attachmentId: string; chosen: Source[]; onPick: (s: Source) => void; disabled: boolean }) {
  const q = useQuery({ queryKey: ["tools-editors-thread-pdfs", attachmentId], queryFn: () => api.get<{ attachments: ThreadPdf[] }>(`/tools/editors/attachments/${encodeURIComponent(attachmentId)}/pdfs`), staleTime: 60_000 });
  const others = (q.data?.attachments ?? []).filter((a) => !chosen.some((c) => c.kind === "attachment" && c.id === a.id));
  if (!others.length) return null;
  return (
    <div className="space-y-1.5" data-testid="compare-thread-pdfs">
      <div className="text-[12.5px] text-muted">Or pick another version from this email thread:</div>
      <div className="flex flex-wrap gap-2">
        {others.map((a) => (
          <button key={a.id} type="button" disabled={disabled} onClick={() => onPick({ kind: "attachment", id: a.id, name: a.filename })}
            className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-elevated px-3 py-1.5 text-[13px] hover:border-line-strong max-sm:min-h-11">
            <span className="truncate font-medium">{a.filename}</span><span className="shrink-0 text-subtle">{sizeOf(a.sizeBytes)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChangeList({ changes }: { changes: CompareChanges }) {
  if (!changes.pages.length) return <p className="text-sm text-muted" data-testid="compare-same">No word changes found. The two versions have the same text.</p>;
  return (
    <ol className="space-y-4" data-testid="compare-changes">
      {changes.pages.map((p) => (
        <li key={p.page} className="space-y-2" data-testid="compare-page">
          <h3 className="text-[13px] font-semibold">Page {p.page}</h3>
          <ul className="space-y-1.5">
            {p.removed.map((r, i) => (
              <li key={`r${i}`} className="flex items-start gap-2 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad" data-testid="compare-removed">
                <IconMinus className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span className="sr-only">Removed: </span><del className="decoration-bad/60">{r}</del>
              </li>
            ))}
            {p.added.map((a, i) => (
              <li key={`a${i}`} className="flex items-start gap-2 rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok" data-testid="compare-added">
                <IconPlus className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /><span className="sr-only">Added: </span><ins className="no-underline">{a}</ins>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

export function ComparePage() {
  const [params] = useSearchParams();
  const fromMail = params.get("attachment");
  const [older, setOlder] = useState<Source | null>(() => carriedPdfs()[0] ?? null);
  const [newer, setNewer] = useState<Source | null>(() => (fromMail ? { kind: "attachment", id: fromMail, name: params.get("name") ?? "Attachment.pdf" } : carriedPdfs()[1] ?? null));
  useTakeCarried();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const stop = useRef({ stopped: false });
  useEffect(() => () => { stop.current.stopped = true; }, []);
  const busy = phase.kind === "working";
  const anchor = fromMail ?? (older?.kind === "attachment" ? older.id : newer?.kind === "attachment" ? newer.id : null);

  const run = async () => {
    if (!older || !newer) return;
    const signal = { stopped: false };
    stop.current = signal;
    const hasFile = older.kind === "file" || newer.kind === "file";
    setPhase({ kind: "working", pct: hasFile ? 0 : null });
    try {
      const both = await startCompare(older, newer, (pct) => setPhase({ kind: "working", pct }));
      const [report, list] = await Promise.all([waitFor(both.report, () => undefined, signal), waitFor(both.changes, () => undefined, signal)]);
      const changes = readCompareChanges(await readJson(list));
      if (!signal.stopped) setPhase({ kind: "done", report, changes });
    } catch (err) {
      if (!signal.stopped) setPhase({ kind: "failed", error: err instanceof RunError ? err : new RunError("That didn't work. Try again.") });
    }
  };
  const again = () => { setOlder(null); setNewer(null); setPhase({ kind: "pick" }); };
  const swap = () => { const o = older; setOlder(newer); setNewer(o); };
  // R74: both picked PDFs survive a reload of this tab, and leaving before Compare asks first.
  useKeptSource("compare-older", older, setOlder, phase.kind === "done");
  useKeptSource("compare-newer", newer, setNewer, phase.kind === "done");
  const leaveGuard = useLeaveGuard(!!(older || newer) && phase.kind !== "done", "your files");

  return (
    <EditorFrame feature="compare" title="Compare PDFs" description="See what changed between two versions of a document, page by page." testId="compare-tool">
      {phase.kind !== "done" && (
        <Card className="space-y-4 p-4">
          <div className="grid items-start gap-3 md:grid-cols-[1fr_auto_1fr]">
            <PdfPicker label="Older version" value={older} onChange={setOlder} disabled={busy} testId="compare-older" />
            <Button type="button" variant="ghost" size="icon" className="self-center justify-self-center max-md:rotate-90" onClick={swap} disabled={busy || (!older && !newer)} aria-label="Swap older and newer" title="Swap"><IconArrowRightLeft className="h-4 w-4" aria-hidden /></Button>
            <PdfPicker label="Newer version" value={newer} onChange={setNewer} disabled={busy} testId="compare-newer" />
          </div>
          {anchor && (!older || !newer) && <ThreadPdfs attachmentId={anchor} chosen={[older, newer].filter((s): s is Source => !!s)} disabled={busy} onPick={(s) => (older ? setNewer(s) : setOlder(s))} />}
          <p className="text-[12.5px] text-muted">Compares the words on each page. Changes in pictures or layout alone are not listed.</p>
          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button type="button" onClick={run} disabled={busy || !older || !newer} loading={busy} data-testid="compare-run">Compare</Button>
            {phase.kind === "working" && <BusyLine>{phase.pct !== null && phase.pct < 100 ? `Uploading ${phase.pct}%` : "Comparing"}</BusyLine>}
          </div>
        </Card>
      )}
      {leaveGuard}
      {phase.kind === "failed" && <ErrorCard error={phase.error} onRetry={() => setPhase({ kind: "pick" })} />}
      {phase.kind === "done" && (
        <>
          <div className="text-[13px] text-muted" data-testid="compare-names">{older && newer ? <>{sourceName(older)} <span aria-hidden>→</span><span className="sr-only">compared with</span> {sourceName(newer)}</> : null}</div>
          <div className="grid grid-cols-3 gap-3" data-testid="compare-summary">
            <StatTile label="Pages changed" value={phase.report.result?.pages_changed ?? phase.changes.pages.length} />
            <StatTile label="Words added" value={phase.report.result?.words_added ?? phase.changes.wordsAdded} tone="ok" />
            <StatTile label="Words removed" value={phase.report.result?.words_removed ?? phase.changes.wordsRemoved} tone="bad" />
          </div>
          <Card className="space-y-3 p-4">
            <h2 className="text-[15px] font-semibold">Changes</h2>
            <ChangeList changes={phase.changes} />
          </Card>
          <ResultCard job={phase.report} facts="The report: a summary page, then each changed page side by side." onAgain={again}>
            {phase.report.downloadUrl && (
              <iframe title="Compare report" src={`${phase.report.downloadUrl}?inline=1`} className="hidden h-[640px] w-full rounded-lg border border-line bg-white md:block" data-testid="compare-report" />
            )}
          </ResultCard>
        </>
      )}
    </EditorFrame>
  );
}
