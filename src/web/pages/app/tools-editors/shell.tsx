/**
 * Tools P2, H7: pieces the three editors share: the page frame, the PDF picker (a file or the mail
 * attachment the person came from), the busy line, the error card and the result card.
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { IconCheckCircle, IconDownload, IconFile, IconFileUp, IconMail, IconWrench } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { ToolsFrame } from "@/web/components/tools/tools-frame";
import { middleTruncate } from "@/web/components/tools/tool-directory";
import { cn } from "@/web/lib/cn";
import type { ToolFeature } from "@/shared/tool-features";
import type { EditorJob } from "@/shared/tools-editors";
import { sourceName, useAttachToNewEmail, useToolFeatures, type RunError, type Source } from "./runner";

export const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/** R69: editor feature to its key in the Tools list, so the frame shows the same icon and rail as the tool screens. */
const ENTRY_KEY: Partial<Record<ToolFeature, string>> = { editor: "organize", forms: "form-fill", compare: "compare" };

/** The frame: the shared Tools frame (rail, All tools, icon, runs left), and a plain message while the feature is off. */
export function EditorFrame({ feature, title, description, testId, children }: { feature: ToolFeature; title: string; description: string; testId: string; children: ReactNode }) {
  const f = useToolFeatures();
  return (
    <ToolsFrame entryKey={ENTRY_KEY[feature] ?? feature} title={title} description={description} testId={testId}>
      {!f.ready ? <Skeleton className="h-40 w-full rounded-xl" /> : !f.on(feature) ? (
        <EmptyState icon={<IconWrench />} title="Not available yet" body="This tool is not switched on for your workspace yet." action={<Link to="/app/tools" className="text-sm font-medium text-brand">Back to Tools</Link>} />
      ) : children}
    </ToolsFrame>
  );
}

/** One PDF: dropped, chosen, or already picked from a mail attachment. */
export function PdfPicker({ label, value, onChange, disabled, testId, hint }: { label: string; value: Source | null; onChange: (s: Source | null) => void; disabled?: boolean; testId: string; hint?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const take = (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name)) { setProblem(`${f.name} is not a PDF.`); return; }
    setProblem(null);
    onChange({ kind: "file", file: f });
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); if (!disabled) take(e.dataTransfer.files); };
  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-line bg-elevated px-3 py-2.5" data-testid={`${testId}-chosen`}>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#FF3B30]/10 text-[#FF3B30] [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden>{value.kind === "attachment" ? <IconMail /> : <IconFile />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-muted">{label}</div>
          <div className="truncate text-sm font-medium">{sourceName(value)}</div>
          <div className="text-[12px] text-subtle">{value.kind === "attachment" ? "From your email" : sizeOf(value.file.size)}</div>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>Change</Button>
      </div>
    );
  }
  return (
    <div>
      <div onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={cn("flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-9 text-center transition-colors duration-150 max-sm:py-7",
          dragging ? "border-brand bg-brand/5" : "border-line hover:border-line-strong")}>
        {/* R71 (MB-266): the same drop zone as the tool screens: brand icon, what to add, the limit, one filled button. */}
        <span className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand [&_svg]:h-6 [&_svg]:w-6" aria-hidden><IconFileUp /></span>
        <div className="text-[15px] font-semibold">{label}</div>
        <div className="mt-1 text-[13px] text-muted">{hint ?? "Drop a PDF here, or choose one."}</div>
        <Button type="button" disabled={disabled} onClick={() => input.current?.click()} data-testid={`${testId}-choose`} className="mt-4">Choose a file</Button>
        <input ref={input} type="file" accept=".pdf,application/pdf" className="sr-only" tabIndex={-1} aria-label={label} data-testid={`${testId}-input`}
          onChange={(e) => { take(e.target.files); e.target.value = ""; }} />
      </div>
      {problem && <p className="mt-1.5 text-[13px] text-bad" role="alert">{problem}</p>}
    </div>
  );
}

export function BusyLine({ children, testId = "editor-busy" }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted" role="status" data-testid={testId}>
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-brand motion-reduce:animate-none" aria-hidden />
      {children}
    </div>
  );
}

export function ErrorCard({ error, onRetry }: { error: RunError; onRetry?: () => void }) {
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4" role="alert" data-testid="editor-error">
      <Badge tone={error.limit ? "warn" : "bad"}>{error.limit ? "Plan limit" : "Didn't work"}</Badge>
      <p className="min-w-0 flex-1 text-sm">{error.message}</p>
      {onRetry && <Button type="button" variant="ghost" onClick={onRetry}>Try again</Button>}
    </Card>
  );
}

/** The finished file: one line of facts, Download, Attach to a new email, Start over (R69: same words as the tool screens; stacks on a phone). */
export function ResultCard({ job, facts, onAgain, children }: { job: EditorJob; facts?: string | null; onAgain: () => void; children?: ReactNode }) {
  const attach = useAttachToNewEmail();
  // The result rides to the new email as its token: the server reads it from the engine when the email goes.
  const email = () => { if (job.downloadUrl) attach({ jobs: [{ downloadUrl: job.downloadUrl, name: job.name, bytes: job.bytes }] }); };
  return (
    <Card className="space-y-4 p-4 sm:p-5" data-testid="editor-result">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#34C759] text-white [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconCheckCircle /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" title={job.name} data-testid="editor-result-name">{middleTruncate(job.name, 44)}</div>
          {facts && <div className="text-[13px]" data-testid="editor-facts">{facts}</div>}
          <div className="text-[12.5px] text-muted">{job.bytes ? sizeOf(job.bytes) : "Ready"}. Download within an hour.</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        {job.downloadUrl && <a href={job.downloadUrl} download={job.name} data-testid="editor-download"
          className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-sm font-medium text-brand-fg hover:opacity-90 max-sm:min-h-11"><IconDownload className="h-4 w-4" aria-hidden />Download</a>}
        {job.downloadUrl && <Button type="button" variant="outline" onClick={email} className="max-sm:min-h-11" data-testid="editor-email"><IconMail className="h-4 w-4" aria-hidden />Attach to a new email</Button>}
        <Button type="button" variant="ghost" onClick={onAgain} className="max-sm:min-h-11" data-testid="editor-again">Start over</Button>
      </div>
      {children}
    </Card>
  );
}
