/** Tools P2 automation pages: shared bits (header with the way back to Tools, the result box). */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { IconDownload } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Card, PageHeader } from "@/web/components/ui/misc";
import { useAttachToNewEmail } from "@/web/lib/compose-files";
import type { ToolJob } from "@/shared/tools";
import { saveFile } from "@/web/lib/tool-jobs";

export function AutoPage({ title, description, children, actions }: { title: string; description: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
      <Link to="/app/tools" className="text-[13px] text-muted hover:text-fg">Tools</Link>
      <PageHeader title={title} description={description} actions={actions} />
      {children}
    </div>
  );
}

/** A finished file: download it or attach it to a new email (an engine result goes by its token, nothing uploaded again). */
export function ResultBox({ file, job, subject, note }: { file: File; job?: Pick<ToolJob, "downloadUrl" | "name">; subject?: string; note?: ReactNode }) {
  const attach = useAttachToNewEmail();
  return (
    <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="auto-result">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{file.name}</p>
        <p className="text-[12px] text-muted">{(file.size / 1024).toFixed(0)} KB{note ? <> · {note}</> : null}</p>
      </div>
      <Button variant="secondary" onClick={() => saveFile(file, file.name)}><IconDownload className="h-4 w-4" />Download</Button>
      <Button onClick={() => attach(job?.downloadUrl ? { jobs: [{ downloadUrl: job.downloadUrl, name: file.name, bytes: file.size }] } : { files: [file] }, { subject: subject ?? "" })}>Attach to a new email</Button>
    </Card>
  );
}

/** A small "busy, then done or failed" state for one run. */
export type RunState = { kind: "idle" } | { kind: "working"; label: string } | { kind: "done"; file: File; job?: ToolJob } | { kind: "failed"; message: string };
export function useRunState() { return useState<RunState>({ kind: "idle" }); }

/** Tools P2: cards for the automation pages, for the Tools page (shows only what is switched on). */
export function AutomationLinks({ features }: { features: readonly string[] }) {
  const items = [
    { f: "workflows", to: "/app/tools/workflows", title: "Workflows", body: "Chain tools, for example scan, make searchable, compress." },
    { f: "templates", to: "/app/tools/templates", title: "Templates", body: "Invoices, quotes and letters from a form, as a PDF." },
    { f: "merge_mail", to: "/app/tools/merge", title: "Mail merge", body: "One template, a personal PDF and email for each person." },
    { f: "rules", to: "/app/settings#send-rules", title: "Before sending", body: "Compress big PDFs and turn Word files into PDFs as you attach them." },
  ].filter((x) => features.includes(x.f));
  if (!items.length) return null;
  return (
    <section className="space-y-2" data-testid="automation-links">
      <h2 className="text-sm font-semibold">Automate</h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((x) => (
          <Link key={x.to} to={x.to} className="rounded-xl border border-line p-4 hover:bg-hover">
            <p className="text-sm font-semibold">{x.title}</p>
            <p className="mt-1 text-[13px] text-muted">{x.body}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
