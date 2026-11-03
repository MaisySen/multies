/**
 * Tools P2 (flag workflows): chain 2 to 6 tools, save them for the workspace, and run them on uploads or
 * on a mail attachment (?attachment=<id>&name=<file>). The engine runs the whole chain as one job.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { jobFile, uploadJobTo, waitForJobDone } from "@/web/lib/tool-jobs";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { IconArrowDown, IconArrowUp, IconClose } from "@/web/components/ui/icon";
import type { ToolJob } from "@/shared/tools";
import {
  WORKFLOW_MAX_STEPS, WORKFLOW_OPS, WORKFLOW_OP_LABELS, checkWorkflow, needsRunPassword,
  type WorkflowDef, type WorkflowFinish, type WorkflowOp, type WorkflowStep,
} from "@/shared/tools-automation";
import { AutoPage, ResultBox, useRunState } from "./shell";
import { OCR_SLOW_NOTE } from "@/shared/tools";

interface Saved extends WorkflowDef { id: string }
interface Starter extends Saved { blurb: string }

/** The few options a step can carry in a saved workflow (the rest take the tool's defaults). */
const STEP_OPTIONS: Partial<Record<WorkflowOp, { name: string; label: string; choices?: [string, string][]; placeholder?: string }[]>> = {
  ocr: [{ name: "language", label: "Language", choices: [["eng", "English"], ["eng+nep", "English and Nepali"], ["eng+hin", "English and Hindi"]] }],
  "scan-clean": [{ name: "mode", label: "Colour", choices: [["color", "Colour"], ["gray", "Grey"], ["bw", "Black and white"]] }],
  watermark: [{ name: "text", label: "Text", placeholder: "DRAFT" }],
  stamp: [{ name: "stamp", label: "Stamp", choices: [["none", "None"], ["approved", "Approved"], ["paid", "Paid"], ["draft", "Draft"], ["confidential", "Confidential"], ["copy", "Copy"]] }, { name: "page_numbers", label: "Page numbers", choices: [["none", "None"], ["n", "1, 2, 3"], ["page n of N", "Page 1 of 3"]] }],
  protect: [{ name: "allow_print", label: "Allow printing", choices: [["yes", "Yes"], ["no", "No"]] }, { name: "allow_copy", label: "Allow copying text", choices: [["no", "No"], ["yes", "Yes"]] }],
  rotate: [{ name: "angle", label: "Turn", choices: [["90", "Right"], ["270", "Left"], ["180", "Upside down"]] }],
  "pdf-to": [{ name: "target", label: "Into", choices: [["txt", "Text"], ["md", "Markdown"], ["csv", "CSV tables"], ["xlsx", "Excel tables"], ["png", "Images"]] }],
};

function StepsEditor({ steps, onChange }: { steps: WorkflowStep[]; onChange: (s: WorkflowStep[]) => void }) {
  const set = (i: number, s: WorkflowStep) => onChange(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, by: number) => { const n = [...steps]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x); onChange(n); };
  return (
    <ol className="space-y-2" data-testid="workflow-steps">
      {steps.map((s, i) => (
        <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-brand/10 text-[12px] font-semibold text-brand-hover">{i + 1}</span>
          <Select value={s.op} onChange={(e) => set(i, { op: e.target.value as WorkflowOp, options: {} })} aria-label={`Step ${i + 1}`} className="w-56">
            {WORKFLOW_OPS.map((op) => <option key={op} value={op}>{WORKFLOW_OP_LABELS[op]}</option>)}
          </Select>
          {(STEP_OPTIONS[s.op] ?? []).map((o) => o.choices
            ? <Select key={o.name} value={s.options[o.name] ?? o.choices[0][0]} onChange={(e) => set(i, { ...s, options: { ...s.options, [o.name]: e.target.value } })} aria-label={o.label} className="w-40">{o.choices.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            : <Input key={o.name} value={s.options[o.name] ?? ""} placeholder={o.placeholder} onChange={(e) => set(i, { ...s, options: { ...s.options, [o.name]: e.target.value.slice(0, 60) } })} aria-label={o.label} className="w-40" />)}
          {s.op === "protect" && <span className="text-[12px] text-muted">The password is asked each time it runs</span>}
          {s.op === "ocr" && (s.options.language ?? "eng") !== "eng" && <span className="text-[12px] text-muted">{OCR_SLOW_NOTE}</span>}
          <div className="ml-auto flex items-center">
            <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="rounded p-1.5 text-muted hover:bg-hover disabled:opacity-30"><IconArrowUp className="h-4 w-4" /></button>
            <button type="button" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="rounded p-1.5 text-muted hover:bg-hover disabled:opacity-30"><IconArrowDown className="h-4 w-4" /></button>
            <button type="button" onClick={() => onChange(steps.filter((_, j) => j !== i))} aria-label="Remove step" className="rounded p-1.5 text-muted hover:bg-hover hover:text-bad"><IconClose className="h-4 w-4" /></button>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Runner({ wf, attachment, onClose }: { wf: Saved; attachment: { id: string; name: string } | null; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [password, setPassword] = useState("");
  const [run, setRun] = useRunState();
  const pw = needsRunPassword(wf.steps);
  const start = async () => {
    setRun({ kind: "working", label: "Sending the files" });
    try {
      const base: Record<string, string> = { workflowId: wf.id };
      const job: ToolJob = attachment
        ? await api.post<ToolJob>("/tools/workflows/run", { ...base, attachmentIds: [attachment.id], ...(pw ? { password } : {}) })
        : await uploadJobTo("/api/tools/workflows/run", files, { ...base, ...(pw ? { password } : {}) });
      setRun({ kind: "working", label: `Running ${wf.steps.length} steps` });
      const done = await waitForJobDone(job.token, { timeoutMs: 10 * 60_000 });
      setRun({ kind: "done", file: await jobFile(done), job: done });
    } catch (e) { setRun({ kind: "failed", message: errorMessage(e) }); }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="workflow-runner">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">Run {wf.name}</h3><button onClick={onClose} aria-label="Close" className="rounded p-1 text-muted hover:bg-hover"><IconClose className="h-4 w-4" /></button></div>
      {attachment ? <p className="text-sm">On <strong>{attachment.name}</strong> from your mail.</p> : (
        <Field label="Files">{() => <><input type="file" multiple accept={wf.steps[0]?.op === "scan-clean" ? "image/*" : undefined} capture={wf.steps[0]?.op === "scan-clean" ? "environment" : undefined} onChange={(e) => setFiles([...(e.target.files ?? [])])} data-testid="workflow-files" className="text-sm" /></>}</Field>
      )}
      {pw && <Field label="Password for this run" hint="4 to 128 characters. It isn't saved.">{(fp) => <Input {...fp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />}</Field>}
      <div className="flex items-center gap-3">
        <Button onClick={start} disabled={run.kind === "working" || (!attachment && !files.length) || (pw && password.length < 4)}>Run</Button>
        {run.kind === "working" && <span role="status" className="text-sm text-muted">{run.label}</span>}
        {run.kind === "failed" && <span role="alert" className="text-sm text-bad">{run.message}</span>}
      </div>
      {run.kind === "done" && <ResultBox file={run.file} job={run.job} subject={wf.finish === "email" ? run.file.name.replace(/\.[^.]+$/, "") : undefined} note={`${wf.steps.length} steps done`} />}
    </Card>
  );
}

export function WorkflowsPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const attachment = params.get("attachment") ? { id: params.get("attachment")!, name: params.get("name") ?? "Attachment" } : null;
  const q = useQuery({ queryKey: ["tools-workflows"], queryFn: () => api.get<{ starters: Starter[]; workflows: Saved[] }>("/tools/workflows") });
  const [edit, setEdit] = useState<(WorkflowDef & { id?: string }) | null>(null);
  const [running, setRunning] = useState<Saved | null>(null);
  const problem = useMemo(() => (edit ? checkWorkflow(edit.steps) : null), [edit]);
  const save = useMutation({
    mutationFn: (w: WorkflowDef & { id?: string }) => (w.id ? api.put<Saved>(`/tools/workflows/${w.id}`, w) : api.post<Saved>("/tools/workflows", w)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["tools-workflows"] }); setEdit(null); toast.success("Workflow saved"); },
    onError: (e) => showError(e),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/tools/workflows/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ["tools-workflows"] }), onError: (e) => showError(e) });
  const card = (w: Saved, starter: boolean, blurb?: string) => (
    <Card key={w.id} className="flex flex-col gap-3 p-4" data-testid="workflow-card">
      <div className="flex items-start justify-between gap-2">
        <div><h3 className="text-sm font-semibold">{w.name}</h3>{blurb && <p className="mt-0.5 text-[13px] text-muted">{blurb}</p>}</div>
        {starter && <Badge>Starter</Badge>}
      </div>
      <div className="flex flex-wrap gap-1">{w.steps.map((s, i) => <span key={i} className="rounded-full bg-hover px-2 py-0.5 text-[12px]">{i + 1}. {WORKFLOW_OP_LABELS[s.op] ?? s.op}</span>)}</div>
      <div className="mt-auto flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setRunning(w)}>Run</Button>
        <Button size="sm" variant="secondary" onClick={() => setEdit({ id: starter ? undefined : w.id, name: starter ? `${w.name} (copy)` : w.name, steps: w.steps.map((s) => ({ ...s, options: { ...s.options } })), finish: w.finish })}>{starter ? "Copy and edit" : "Edit"}</Button>
        {!starter && <Button size="sm" variant="ghost" onClick={() => del.mutate(w.id)}>Delete</Button>}
      </div>
    </Card>
  );
  return (
    <AutoPage entryKey="workflows" title="Workflows" description="Chain tools into one step, for example clean up a scan, make it searchable, then compress it. Everyone in the workspace can use saved workflows."
      actions={<Button onClick={() => setEdit({ name: "", steps: [{ op: "ocr", options: {} }, { op: "compress", options: {} }], finish: "download" })}>New workflow</Button>}>
      {attachment && <p className="rounded-lg bg-brand/[0.06] px-3 py-2 text-sm">Pick a workflow to run on {attachment.name}.</p>}
      {running && <Runner wf={running} attachment={attachment} onClose={() => setRunning(null)} />}
      {edit && (
        <Card className="space-y-4 p-4" data-testid="workflow-builder">
          <Field label="Name">{(fp) => <Input {...fp} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Shrink scans for clients" maxLength={80} />}</Field>
          <StepsEditor steps={edit.steps} onChange={(steps) => setEdit({ ...edit, steps })} />
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" disabled={edit.steps.length >= WORKFLOW_MAX_STEPS} onClick={() => setEdit({ ...edit, steps: [...edit.steps, { op: "compress", options: {} }] })}>Add a step</Button>
            <label className="flex items-center gap-2 text-sm">When it's done
              <Select value={edit.finish} onChange={(e) => setEdit({ ...edit, finish: e.target.value as WorkflowFinish })} className="w-52"><option value="download">Offer the download</option><option value="email">Start a new email with it</option></Select>
            </label>
          </div>
          {problem && <p role="alert" className="text-sm text-bad">{problem}</p>}
          <div className="flex gap-2"><Button disabled={!!problem || !edit.name.trim() || save.isPending} onClick={() => save.mutate(edit)}>Save workflow</Button><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button></div>
        </Card>
      )}
      {q.isPending ? <Skeleton className="h-40 w-full" /> : q.data && (
        <>
          <section className="space-y-2"><h2 className="text-sm font-semibold">Starters</h2><div className="grid gap-3 sm:grid-cols-3">{q.data.starters.map((w) => card(w, true, w.blurb))}</div></section>
          <section className="space-y-2"><h2 className="text-sm font-semibold">Saved in this workspace</h2>
            {q.data.workflows.length ? <div className="grid gap-3 sm:grid-cols-3">{q.data.workflows.map((w) => card(w, false))}</div> : <p className="text-sm text-muted">None yet. Copy a starter or make a new one.</p>}
          </section>
        </>
      )}
    </AutoPage>
  );
}
