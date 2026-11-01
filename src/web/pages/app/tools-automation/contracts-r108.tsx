/**
 * R108 Contracts (flag CONTRACTS_R108), inside Tools > Templates: plain words contract templates, a guided interview
 * that only asks what matters for your answers, a live preview, then a Doc, a PDF, a Word file or a send to sign
 * (the e-sign page). Admins keep the workspace's own versions of templates and a clause library with versions.
 * Every template and generated document carries the "This is a template, not legal advice" note.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { strToU8, zipSync } from "fflate";
import { api, errorMessage } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { jobFile, waitForJobDone } from "@/web/lib/tool-jobs";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { cn } from "@/web/lib/cn";
import type { ToolJob } from "@/shared/tools";
import {
  CONTRACT_NOTE, CONTRACT_NOTE_LONG, buildContract, checkAnswers, plannedReminders, startingAnswers, visibleQuestions,
  type Answers, type BuiltContract, type ClauseText, type ContractTemplateDef, type FillContext, type Question,
} from "@/shared/contracts-r108";

interface TemplateSummary { id: string; name: string; description: string; category: string; questionCount: number; clauseCount: number; builtIn: boolean; retired: boolean; baseId: string }
interface Recent { id: string; title: string; docId: string | null; templateId: string; reminders: number; createdAt: string }
interface ListInfo { templates: TemplateSummary[]; canManage: boolean; note: string; recent: Recent[] }
interface Detail { template: ContractTemplateDef & { builtIn: boolean; retired: boolean; baseId: string }; clauses: (ClauseText & { when: string | null })[]; skipped: string[]; context: FillContext; canManage: boolean }
interface ClauseInfo { key: string; title: string; body: string; version: number; standard: boolean; retired: boolean; edited: boolean; usedBy: string[]; history: { version: number; title: string; body: string; by: string; at: string | null }[] }

const dateText = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
const shortDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** The note every template and generated document carries. */
function LegalNote({ className }: { className?: string }) {
  return (
    <div role="note" data-testid="contract-note" className={cn("rounded-lg border border-line bg-fill/60 px-3 py-2 text-[13px] text-muted", className)}>
      <strong className="text-fg">{CONTRACT_NOTE}</strong> {CONTRACT_NOTE_LONG.slice(CONTRACT_NOTE.length).trim()}
    </div>
  );
}

export function ContractsView() {
  const [open, setOpen] = useState<string | null>(null);
  const [library, setLibrary] = useState(false);
  if (open) return <Interview id={open} onBack={() => setOpen(null)} />;
  if (library) return <ClauseLibrary onBack={() => setLibrary(false)} />;
  return <TemplateGallery onOpen={setOpen} onLibrary={() => setLibrary(true)} />;
}

// --------------------------------------------------------------------------------------------- gallery
function TemplateGallery({ onOpen, onLibrary }: { onOpen: (id: string) => void; onLibrary: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["contracts"], queryFn: () => api.get<ListInfo>("/contracts") });
  const [editing, setEditing] = useState<{ id?: string; baseId: string; name: string; description: string } | null>(null);
  const { confirm, dialogs } = useDialogs();
  const retire = useMutation({
    mutationFn: ({ id, back }: { id: string; back: boolean }) => api.post(`/contracts/templates/${id}/${back ? "restore" : "retire"}`, {}),
    onSuccess: (_, v) => { toast.success(v.back ? "Template is back for everyone" : "Template retired. Members no longer see it."); void qc.invalidateQueries({ queryKey: ["contracts"] }); },
    onError: (e) => showError(e),
  });
  if (q.isPending) return <div className="space-y-3"><Skeleton className="h-12 w-full" /><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-36" />)}</div></div>;
  if (q.isError) return <EmptyState title="Contracts didn't load" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>} />;
  const d = q.data!;
  const ours = d.templates.filter((t) => !t.builtIn);
  const standard = d.templates.filter((t) => t.builtIn);
  const card = (t: TemplateSummary) => (
    <Card key={t.id} data-testid={`contract-template-${t.id}`} className={cn("flex flex-col gap-2 p-4", t.retired && "opacity-70")}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-[15px] font-semibold leading-snug">{t.name}</h3>
        <div className="flex shrink-0 gap-1">{t.retired ? <Badge tone="warn">Retired</Badge> : !t.builtIn ? <Badge tone="brand">Your version</Badge> : <Badge>{t.category}</Badge>}</div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">{t.description || "No description yet."}</p>
      <p className="text-xs text-subtle">{t.questionCount} questions, {t.clauseCount} clauses</p>
      <div className="mt-auto flex flex-wrap gap-2 pt-1">
        {!t.retired && <Button size="sm" onClick={() => onOpen(t.id)} aria-label={`Start ${t.name}`}>Start</Button>}
        {d.canManage && t.builtIn && <Button size="sm" variant="ghost" onClick={() => setEditing({ baseId: t.id, name: `${t.name} (ours)`, description: t.description })}>Make our version</Button>}
        {d.canManage && !t.builtIn && !t.retired && <Button size="sm" variant="ghost" onClick={() => setEditing({ id: t.id, baseId: t.baseId, name: t.name, description: t.description })}>Edit</Button>}
        {d.canManage && !t.builtIn && (
          <Button size="sm" variant="ghost" onClick={async () => { if (t.retired || (await confirm({ title: `Retire ${t.name}?`, description: "Members won't see it any more. Contracts already made stay as they are. You can bring it back later.", confirmLabel: "Retire", tone: "danger" }))) retire.mutate({ id: t.id, back: t.retired }); }}>{t.retired ? "Bring back" : "Retire"}</Button>
        )}
      </div>
    </Card>
  );
  return (
    <div className="space-y-5">
      <LegalNote />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">Pick a template, answer a few questions and get a contract as a Doc, a PDF or a Word file. Send it to sign when it's ready.</p>
        <Button variant="secondary" size="sm" onClick={onLibrary}>Clause library</Button>
      </div>
      {ours.length > 0 && (
        <section aria-labelledby="ours-h" className="space-y-2">
          <h2 id="ours-h" className="text-[13px] font-semibold text-muted">Your workspace</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{ours.map(card)}</div>
        </section>
      )}
      <section aria-labelledby="std-h" className="space-y-2">
        <h2 id="std-h" className="text-[13px] font-semibold text-muted">Standard templates</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{standard.map(card)}</div>
      </section>
      <section aria-labelledby="recent-h" className="space-y-2">
        <h2 id="recent-h" className="text-[13px] font-semibold text-muted">Your recent contracts</h2>
        {d.recent.length === 0 ? <p className="text-[13px] text-subtle">Contracts you make show up here, with a link to the Doc.</p> : (
          <Card className="divide-y divide-line">
            {d.recent.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-[13px]">
                {r.docId ? <Link to={`/app/docs/${r.docId}`} className="min-w-0 truncate font-medium text-fg hover:underline">{r.title}</Link> : <span className="min-w-0 truncate">{r.title}</span>}
                <span className="text-xs text-subtle">{dateText(r.createdAt)}{r.reminders ? `, ${r.reminders} reminder${r.reminders === 1 ? "" : "s"}` : ""}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
      {editing && <TemplateEditor start={editing} onDone={() => setEditing(null)} />}
      {dialogs}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- template editor (admins)
function TemplateEditor({ start, onDone }: { start: { id?: string; baseId: string; name: string; description: string }; onDone: () => void }) {
  const qc = useQueryClient();
  const base = useQuery({ queryKey: ["contracts", "template", start.id ?? start.baseId], queryFn: () => api.get<Detail>(`/contracts/templates/${start.id ?? start.baseId}`) });
  const all = useQuery({ queryKey: ["contracts", "clauses"], queryFn: () => api.get<{ clauses: ClauseInfo[] }>("/contracts/clauses") });
  const [name, setName] = useState(start.name);
  const [description, setDescription] = useState(start.description);
  const [keys, setKeys] = useState<string[] | null>(null);
  useEffect(() => { if (base.data && keys === null) setKeys(base.data.template.clauses.map((c) => c.key).filter((k) => !base.data.skipped.includes(k))); }, [base.data, keys]);
  const save = useMutation({
    mutationFn: () => (start.id ? api.put<{ id: string; warnings: string[] }>(`/contracts/templates/${start.id}`, { name, description, clauseKeys: keys ?? [] }) : api.post<{ id: string; warnings: string[] }>("/contracts/templates", { baseId: start.baseId, name, description, clauseKeys: keys ?? [] })),
    onSuccess: (r) => {
      toast.success(start.id ? "Template saved" : "Template added for your workspace");
      if (r.warnings.length) toast.message(`These words have no question, so they print as a blank line: ${r.warnings.join(", ")}`);
      void qc.invalidateQueries({ queryKey: ["contracts"] });
      onDone();
    },
    onError: (e) => showError(e),
  });
  const choices = (all.data?.clauses ?? []).filter((c) => !c.retired);
  const chosen = keys ?? [];
  const move = (i: number, by: number) => setKeys((k) => { const a = [...(k ?? [])]; const j = i + by; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const title = (k: string) => choices.find((c) => c.key === k)?.title ?? k;
  return (
    <Dialog open onClose={onDone} title={start.id ? "Edit template" : "Make your workspace's version"} description="Questions come from the standard template. Choose and order the clauses your workspace uses."
      footer={<><Button variant="ghost" onClick={onDone}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || chosen.length === 0}>Save template</Button></>}>
      <div className="space-y-4">
        <Field label="Name">{(fp) => <Input {...fp} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description" hint="One line so people know when to use it.">{(fp) => <Input {...fp} value={description} maxLength={240} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="space-y-2">
          <p className="text-[13px] font-medium">Clauses in order</p>
          {!keys ? <Skeleton className="h-40 w-full" /> : (
            <ol className="space-y-1" aria-label="Clauses in this template">
              {chosen.map((k, i) => (
                <li key={k} className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 text-[13px]">
                  <span className="w-5 text-right text-subtle">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{title(k)}</span>
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${title(k)} up`}>Up</Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === chosen.length - 1} aria-label={`Move ${title(k)} down`}>Down</Button>
                  <Button size="sm" variant="ghost" onClick={() => setKeys(chosen.filter((x) => x !== k))} aria-label={`Remove ${title(k)}`}>Remove</Button>
                </li>
              ))}
            </ol>
          )}
          {keys && (
            <Field label="Add a clause">{(fp) => (
              <Select {...fp} value="" onChange={(e) => { if (e.target.value) setKeys([...chosen, e.target.value]); }}>
                <option value="">Choose a clause</option>
                {choices.filter((c) => !chosen.includes(c.key)).map((c) => <option key={c.key} value={c.key}>{c.title}{c.standard ? "" : " (your clause)"}</option>)}
              </Select>
            )}</Field>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------------------------------------- interview
function QuestionInput({ q, value, error, onChange }: { q: Question; value: string; error?: string; onChange: (v: string) => void }) {
  if (q.type === "yesno" || (q.type === "choice" && (q.options?.length ?? 0) <= 3)) {
    return (
      <fieldset className="space-y-1.5" aria-describedby={error || q.help ? `${q.key}-hint` : undefined}>
        <legend className="mb-1 text-[13px] font-medium text-fg/90">{q.label}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={q.label}>
          {(q.options ?? []).map((o) => (
            <label key={o.value} className={cn("flex min-h-[40px] cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px]", value === o.value ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:text-fg")}>
              <input type="radio" name={q.key} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="accent-[var(--color-brand,#0071E3)]" />
              {o.label}
            </label>
          ))}
        </div>
        {(error || q.help) && <p id={`${q.key}-hint`} role={error ? "alert" : undefined} className={cn("text-xs", error ? "text-bad" : "text-subtle")}>{error ?? q.help}</p>}
      </fieldset>
    );
  }
  return (
    <Field label={q.required ? q.label : `${q.label} (optional)`} hint={q.help} error={error}>
      {(fp) => q.type === "textarea" ? <Textarea {...fp} rows={4} value={value} placeholder={q.placeholder} onChange={(e) => onChange(e.target.value)} />
        : q.type === "choice" ? <Select {...fp} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose</option>{(q.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
        : <Input {...fp} value={value} placeholder={q.placeholder} inputMode={q.type === "number" || q.type === "abn" ? "numeric" : q.type === "money" ? "decimal" : undefined}
            type={q.type === "date" ? "date" : q.type === "email" ? "email" : "text"} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  );
}

function Preview({ built }: { built: BuiltContract }) {
  return (
    <article data-testid="contract-preview" aria-label="Contract preview" className="space-y-3 rounded-xl border border-line bg-surface p-5 text-[13px] leading-relaxed shadow-sm">
      <h2 className="text-lg font-semibold leading-snug">{built.title}</h2>
      <p className="text-muted">{built.partiesLine}</p>
      <LegalNote />
      {built.clauses.map((c) => (
        <section key={c.key} className="space-y-1.5">
          <h3 className="pt-1 text-[14px] font-semibold">{c.heading}</h3>
          {c.paragraphs.map((p, i) => {
            const lines = p.split("\n");
            return lines.every((l) => /^\d+\.\s/.test(l))
              ? <ol key={i} className="list-decimal space-y-0.5 pl-5">{lines.map((l, j) => <li key={j}>{l.replace(/^\d+\.\s/, "")}</li>)}</ol>
              : <p key={i} className="whitespace-pre-line">{p}</p>;
          })}
        </section>
      ))}
    </article>
  );
}

const REVIEW = "Review";
function Interview({ id, onBack }: { id: string; onBack: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["contracts", "template", id], queryFn: () => api.get<Detail>(`/contracts/templates/${id}`) });
  const [answers, setAnswers] = useState<Answers | null>(null);
  const [step, setStep] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [pane, setPane] = useState<"questions" | "preview">("questions");
  const [reminders, setReminders] = useState(true);
  const [made, setMade] = useState<{ doc: { id: string; title: string }; tasks: { id: string; title: string; due: string }[] } | null>(null);
  const [busy, setBusy] = useState<null | "doc" | "pdf" | "sign" | "word">(null);
  const [pdf, setPdf] = useState<{ token: string; url: string; name: string } | null>(null);
  useEffect(() => { if (q.data && !answers) setAnswers(startingAnswers(q.data.template, q.data.context)); }, [q.data, answers]);
  const def = q.data?.template;
  const clauseMap = useMemo(() => new Map((q.data?.clauses ?? []).map((c) => [c.key, c])), [q.data]);
  const visible = useMemo(() => (def && answers ? visibleQuestions(def, answers) : []), [def, answers]);
  const sections = useMemo(() => [...new Set(visible.map((x) => x.section)), REVIEW], [visible]);
  const errors = useMemo(() => (def && answers ? checkAnswers(def, answers) : {}), [def, answers]);
  const built = useMemo(() => (def && answers && q.data ? buildContract(def, clauseMap, answers, q.data.context) : null), [def, answers, clauseMap, q.data]);
  const planned = useMemo(() => (def && answers && q.data && built ? plannedReminders(def, answers, q.data.context, built.title) : []), [def, answers, q.data, built]);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);
  if (q.isPending || !answers) return <div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>;
  if (q.isError || !def || !built) return <EmptyState title="This template didn't open" body={errorMessage(q.error)} action={<Button variant="secondary" onClick={onBack}>Back to templates</Button>} />;
  const cur = Math.min(step, sections.length - 1);
  const section = sections[cur];
  const inSection = visible.filter((x) => x.section === section);
  const sectionErrors = inSection.filter((x) => errors[x.key]);
  const allOk = Object.keys(errors).length === 0;
  const set = (k: string, v: string) => { setAnswers((a) => ({ ...(a ?? {}), [k]: v })); setPdf(null); setMade(null); };
  const next = () => { if (sectionErrors.length) { setShowErrors(true); toast.error("Some answers need another look."); return; } setShowErrors(false); setStep(cur + 1); };
  const body = { templateId: id, answers };
  const fail = (e: unknown) => {
    const details = (e as { details?: { errors?: Record<string, string> } }).details;
    if (details?.errors) { setShowErrors(true); const k = Object.keys(details.errors)[0]; const s = visible.find((x) => x.key === k)?.section; if (s) setStep(sections.indexOf(s)); }
    showError(e as Error);
  };
  const createDoc = async () => {
    setBusy("doc");
    try {
      const r = await api.post<{ doc: { id: string; title: string }; tasks: { id: string; title: string; due: string }[] }>("/contracts/generate", { ...body, reminders });
      setMade(r);
      toast.success("Contract saved as a Doc");
      void qc.invalidateQueries({ queryKey: ["contracts"] });
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const makePdf = async (then: "download" | "sign") => {
    setBusy(then === "sign" ? "sign" : "pdf");
    try {
      let p = pdf;
      if (!p) {
        const job = await api.post<ToolJob>("/contracts/pdf", body);
        const done = await waitForJobDone(job.token);
        const file = await jobFile(done);
        p = { token: job.token, url: URL.createObjectURL(file), name: file.name };
        setPdf(p);
      }
      if (then === "sign") navigate(`/app/tools/sign?result=${encodeURIComponent(p.token)}&mode=request`);
      else { const a = document.createElement("a"); a.href = p.url; a.download = p.name; a.click(); }
    } catch (e) { fail(e); } finally { setBusy(null); }
  };
  const makeWord = () => {
    setBusy("word");
    try {
      const blob = contractDocx(built);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `${built.title.replace(/[^\w ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "contract"}.docx`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally { setBusy(null); }
  };
  const answerText = (x: Question) => { const v = answers[x.key] ?? ""; return x.options?.find((o) => o.value === v)?.label ?? (x.type === "date" && v ? shortDate(v) : v) ?? ""; };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Button variant="ghost" size="sm" onClick={onBack}>Back to templates</Button>
          <h2 className="mt-1 text-lg font-semibold">{def.name}</h2>
        </div>
        <div className="flex rounded-lg border border-line p-0.5 lg:hidden" role="tablist" aria-label="Questions or preview">
          {(["questions", "preview"] as const).map((p) => <button key={p} role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={cn("min-h-[36px] rounded-md px-3 text-[13px]", pane === p ? "bg-fill font-medium text-fg" : "text-muted")}>{p === "questions" ? "Questions" : "Preview"}</button>)}
        </div>
      </div>
      {q.data!.skipped.length > 0 && <p className="text-xs text-subtle">{q.data!.skipped.length} retired clause{q.data!.skipped.length === 1 ? " is" : "s are"} left out.</p>}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <Card className={cn("space-y-4 p-4", pane !== "questions" && "hidden lg:block")}>
          <nav aria-label="Interview steps">
            <ol className="flex flex-wrap gap-1.5">
              {sections.map((s, i) => (
                <li key={s}><button onClick={() => (i <= cur || allOk ? setStep(i) : undefined)} aria-current={i === cur ? "step" : undefined} disabled={i > cur && !allOk}
                  className={cn("rounded-full border px-3 py-1 text-[12px]", i === cur ? "border-brand bg-brand/10 font-medium text-fg" : i < cur ? "border-line text-fg" : "border-line text-subtle")}>{i + 1}. {s}</button></li>
              ))}
            </ol>
          </nav>
          <p className="text-xs text-subtle" aria-live="polite">Step {cur + 1} of {sections.length}</p>
          {section !== REVIEW ? (
            <div className="space-y-4" data-testid="contract-step">
              {inSection.map((x) => <QuestionInput key={x.key} q={x} value={answers[x.key] ?? ""} error={showErrors ? errors[x.key] : undefined} onChange={(v) => set(x.key, v)} />)}
              <div className="flex gap-2 pt-1">
                {cur > 0 && <Button variant="secondary" onClick={() => setStep(cur - 1)}>Back</Button>}
                <Button onClick={next}>Next</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4" data-testid="contract-review">
              <dl className="divide-y divide-line rounded-lg border border-line text-[13px]">
                {visible.map((x) => (
                  <div key={x.key} className="flex items-start justify-between gap-3 px-3 py-2">
                    <dt className="text-muted">{x.label}</dt>
                    <dd className="flex min-w-0 items-start gap-2 text-right"><span className={cn("min-w-0 whitespace-pre-line break-words", errors[x.key] && "text-bad")}>{answerText(x) || "Not answered"}</span>
                      <button className="shrink-0 text-xs text-brand underline-offset-2 hover:underline" onClick={() => setStep(sections.indexOf(x.section))} aria-label={`Change ${x.label}`}>Change</button></dd>
                  </div>
                ))}
              </dl>
              <div className="space-y-2 rounded-lg border border-line p-3">
                <Switch checked={reminders && planned.some((r) => !r.past)} onChange={setReminders} disabled={!planned.some((r) => !r.past)} label="Add reminder tasks for renewal and end dates" />
                {planned.length === 0 ? <p className="text-xs text-subtle">No dates to remind you about in this contract.</p> : (
                  <ul className="space-y-0.5 text-xs text-muted">{planned.map((r) => <li key={r.due + r.title}>{shortDate(r.due)}: {r.title}{r.past ? " (already past, skipped)" : ""}</li>)}</ul>
                )}
              </div>
              {!allOk && <p role="alert" className="text-[13px] text-bad">Some answers need another look before you can make the contract.</p>}
              {made ? (
                <div data-testid="contract-made" className="space-y-2 rounded-lg border border-ok/40 bg-ok/5 p-3 text-[13px]">
                  <p className="font-medium">Saved as a Doc: {made.doc.title}</p>
                  {made.tasks.length > 0 && <p className="text-muted">{made.tasks.length} reminder task{made.tasks.length === 1 ? "" : "s"} added for you.</p>}
                  <Link to={`/app/docs/${made.doc.id}`} className="inline-flex font-medium text-brand hover:underline">Open the Doc</Link>
                </div>
              ) : <Button onClick={createDoc} loading={busy === "doc"} disabled={!allOk || busy !== null}>Create Doc</Button>}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void makePdf("download")} loading={busy === "pdf"} disabled={!allOk || busy !== null}>Download PDF</Button>
                <Button variant="secondary" onClick={makeWord} disabled={!allOk || busy !== null}>Download Word</Button>
                <Button variant="secondary" onClick={() => void makePdf("sign")} loading={busy === "sign"} disabled={!allOk || busy !== null}>Send to sign</Button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setStep(cur - 1)}>Back</Button>
            </div>
          )}
        </Card>
        <div className={cn("min-w-0", pane !== "preview" && "hidden lg:block")}><Preview built={built} /></div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------------------------- clause library
function ClauseLibrary({ onBack }: { onBack: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["contracts", "clauses"], queryFn: () => api.get<{ clauses: ClauseInfo[] }>("/contracts/clauses") });
  const info = useQuery({ queryKey: ["contracts"], queryFn: () => api.get<ListInfo>("/contracts") });
  const canManage = !!info.data?.canManage;
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ key?: string; title: string; body: string } | null>(null);
  const [filter, setFilter] = useState("");
  const { confirm, dialogs } = useDialogs();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["contracts"] });
  const save = useMutation({
    mutationFn: (d: { key?: string; title: string; body: string }) => (d.key ? api.put<{ key: string; version: number }>(`/contracts/clauses/${d.key}`, { title: d.title, body: d.body }) : api.post<{ key: string; version: number }>("/contracts/clauses", { title: d.title, body: d.body })),
    onSuccess: (r) => { toast.success(`Saved as version ${r.version}`); setDraft(null); setSel(r.key); refresh(); },
    onError: (e) => showError(e),
  });
  const retire = useMutation({
    mutationFn: ({ key, back }: { key: string; back: boolean }) => api.post(`/contracts/clauses/${key}/${back ? "restore" : "retire"}`, {}),
    onSuccess: (_, v) => { toast.success(v.back ? "Clause is back in use" : "Clause retired. Templates leave it out."); refresh(); },
    onError: (e) => showError(e),
  });
  const clauses = (list.data?.clauses ?? []).filter((c) => !filter.trim() || `${c.title} ${c.body}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const current = list.data?.clauses.find((c) => c.key === sel) ?? null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><Button variant="ghost" size="sm" onClick={onBack}>Back to templates</Button><h2 className="mt-1 text-lg font-semibold">Clause library</h2></div>
        {canManage && <Button size="sm" onClick={() => { setSel(null); setDraft({ title: "", body: "" }); }}>New clause</Button>}
      </div>
      <p className="text-[13px] text-muted">Every template is built from these clauses. {canManage ? "Editing a clause saves a new version; contracts already made keep the version they used." : "Only workspace admins can change clauses."}</p>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className="space-y-2 p-3">
          <Field label="Find a clause">{(fp) => <Input {...fp} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="GST, privacy, ending" />}</Field>
          {list.isPending ? <Skeleton className="h-64" /> : clauses.length === 0 ? <p className="p-2 text-[13px] text-subtle">No clauses match.</p> : (
            <ul className="max-h-[560px] space-y-1 overflow-y-auto" aria-label="Clauses">
              {clauses.map((c) => (
                <li key={c.key}>
                  <button onClick={() => { setSel(c.key); setDraft(null); }} aria-current={sel === c.key ? "true" : undefined}
                    className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px]", sel === c.key ? "bg-brand/10 text-fg" : "hover:bg-hover")}>
                    <span className={cn("min-w-0 truncate", c.retired && "text-subtle line-through")}>{c.title}</span>
                    <span className="shrink-0">{c.retired ? <Badge tone="warn">Retired</Badge> : c.edited ? <Badge tone="brand">Version {c.version}</Badge> : <Badge>Standard</Badge>}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="space-y-3 p-4" aria-live="polite">
          {draft ? (
            <div className="space-y-3" data-testid="clause-editor">
              <Field label="Title">{(fp) => <Input {...fp} value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}</Field>
              <Field label="Clause text" hint="Leave a blank line between paragraphs. {{client_name}} puts in an answer. A line [[if has_end]] up to [[end]] only shows when the answer is yes.">{(fp) => <Textarea {...fp} rows={12} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}</Field>
              <div className="flex flex-wrap gap-2"><Button onClick={() => save.mutate(draft)} loading={save.isPending} disabled={!draft.title.trim() || !draft.body.trim()}>{draft.key ? "Save new version" : "Add clause"}</Button><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button></div>
            </div>
          ) : !current ? <EmptyState title="Pick a clause" body="See its words, where it's used and its earlier versions." /> : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div><h3 className="text-[15px] font-semibold">{current.title}</h3><p className="text-xs text-subtle">{current.usedBy.length ? `Used in ${current.usedBy.join(", ")}` : "Your own clause"}</p></div>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {!current.retired && <Button size="sm" variant="secondary" onClick={() => setDraft({ key: current.key, title: current.title, body: current.body })}>Edit</Button>}
                    <Button size="sm" variant="ghost" onClick={async () => { if (current.retired || (await confirm({ title: `Retire ${current.title}?`, description: "Templates will leave this clause out of new contracts. You can bring it back later.", confirmLabel: "Retire", tone: "danger" }))) retire.mutate({ key: current.key, back: current.retired }); }}>{current.retired ? "Bring back" : "Retire"}</Button>
                  </div>
                )}
              </div>
              <div className="whitespace-pre-line rounded-lg border border-line bg-fill/40 p-3 text-[13px] leading-relaxed">{current.body}</div>
              <section aria-label="Versions" className="space-y-1.5">
                <h4 className="text-[13px] font-semibold text-muted">Versions</h4>
                <ul className="space-y-1">
                  {current.history.map((h) => (
                    <li key={h.version} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-[12px]">
                      <span>{h.version === 0 ? "Standard wording" : `Version ${h.version}`}{h.at ? `, ${dateText(h.at)}` : ""}{h.by ? ` by ${h.by}` : ""}{h.version === current.version ? " (in use)" : ""}</span>
                      {canManage && h.version !== current.version && !current.retired && <Button size="sm" variant="ghost" onClick={() => setDraft({ key: current.key, title: h.title, body: h.body })}>Use this version</Button>}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}
        </Card>
      </div>
      {dialogs}
    </div>
  );
}

// --------------------------------------------------------------------------------------------- Word file
const x = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
const run = (t: string, opts: { bold?: boolean; size?: number } = {}) => `<w:r><w:rPr>${opts.bold ? "<w:b/>" : ""}${opts.size ? `<w:sz w:val="${opts.size}"/>` : ""}</w:rPr><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
const para = (inner: string, style?: string) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inner}</w:p>`;
/** A plain Word file (headings and paragraphs) made in the browser; no service involved. */
export function contractDocx(b: BuiltContract): Blob {
  const body: string[] = [para(run(b.title, { bold: true, size: 36 }), "Title"), para(run(b.partiesLine)), para(run(CONTRACT_NOTE, { bold: true }) + run(` ${b.note.slice(CONTRACT_NOTE.length).trim()}`, { size: 18 }))];
  for (const c of b.clauses) {
    body.push(para(run(c.heading, { bold: true, size: 24 }), "Heading2"));
    for (const p of c.paragraphs) for (const line of p.split("\n")) body.push(para(run(line)));
  }
  body.push(para(run(CONTRACT_NOTE, { size: 16 })));
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1247" w:right="1134" w:bottom="1247" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(doc),
  };
  return new Blob([zipSync(files) as BlobPart], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
