/**
 * Tools P2, H7: pieces the three editors share: the page frame, the PDF picker (a file or the mail
 * attachment the person came from), the busy line, the error card and the result card.
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { IconArrowLeft, IconDownload, IconFile, IconFileUp, IconMail, IconWrench } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import type { ToolFeature } from "@/shared/tool-features";
import type { EditorJob } from "@/shared/tools-editors";
import { sourceName, useAttachToNewEmail, useToolFeatures, type RunError, type Source } from "./runner";

export const sizeOf = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/** The frame: a back link to Tools, the title, and a plain 404 style message while the feature is off. */
export function EditorFrame({ feature, title, description, testId, children }: { feature: ToolFeature; title: string; description: string; testId: string; children: ReactNode }) {
  const f = useToolFeatures();
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6" data-testid={testId}>
      <Link to="/app/tools" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-fg"><IconArrowLeft className="h-3.5 w-3.5" aria-hidden />Tools</Link>
      <PageHeader title={title} description={description} />
      {!f.ready ? <Skeleton className="h-40 w-full rounded-xl" /> : !f.on(feature) ? (
        <EmptyState icon={<IconWrench />} title="Not available yet" body="This tool is not switched on for your workspace yet." action={<Link to="/app/tools" className="text-sm font-medium text-brand">Back to Tools</Link>} />
      ) : children}
    </div>
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
        className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors duration-150",
          dragging ? "border-brand bg-brand/5" : "border-line hover:border-line-strong")}>
        <span className="grid h-10 w-10 place-items-center rounded-full bg-fill text-muted [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconFileUp /></span>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-[13px] text-muted">{hint ?? "Drop a PDF here, or"}</div>
        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => input.current?.click()} data-testid={`${testId}-choose`}>Choose a PDF</Button>
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

/** The finished file: one line of facts, Download, Email it, Start again. */
export function ResultCard({ job, facts, onAgain, children }: { job: EditorJob; facts?: string | null; onAgain: () => void; children?: ReactNode }) {
  const attach = useAttachToNewEmail();
  // The result rides to the new email as its token: the server reads it from the engine when the email goes.
  const email = () => { if (job.downloadUrl) attach({ jobs: [{ downloadUrl: job.downloadUrl, name: job.name, bytes: job.bytes }] }); };
  return (
    <Card className="space-y-3 p-4" data-testid="editor-result">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#34C759] text-white [&_svg]:h-[18px] [&_svg]:w-[18px]" aria-hidden><IconFile /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold" data-testid="editor-result-name">{job.name}</div>
          {facts && <div className="text-[13px]" data-testid="editor-facts">{facts}</div>}
          <div className="text-[12.5px] text-muted">{job.bytes ? sizeOf(job.bytes) : "Ready"}. Download within an hour.</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.downloadUrl && <a href={job.downloadUrl} download={job.name} data-testid="editor-download"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg hover:opacity-90 max-sm:min-h-11"><IconDownload className="h-4 w-4" aria-hidden />Download</a>}
          {job.downloadUrl && <Button type="button" variant="outline" onClick={email} data-testid="editor-email"><IconMail className="h-4 w-4" aria-hidden />Email it</Button>}
          <Button type="button" variant="ghost" onClick={onAgain}>Start again</Button>
        </div>
      </div>
      {children}
    </Card>
  );
}
