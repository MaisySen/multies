import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ClipboardList, ExternalLink, Plus, Trash2 } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Logo } from "@/web/components/logo";
import { timeAgo } from "@/web/lib/format";
import { useAssignees, useProjects } from "./data";

type FieldType = "text" | "email" | "textarea" | "phone" | "select" | "number" | "date";
interface FormField { id?: string; label: string; type: FieldType; required?: boolean; options?: string[]; placeholder?: string }
interface Form { id: string; name: string; description: string; slug: string; url: string; target: "task" | "contact"; projectId: string | null; assigneeId: string | null; fields: FormField[]; successMessage: string; enabled: boolean; triage?: boolean; submitCount: number; lastSubmitAt: string | null }
interface Submission { id: string; data: Record<string, string>; entityType: string | null; entityId: string | null; createdAt: string }

const TYPES: Record<FieldType, string> = { text: "Short text", email: "Email", textarea: "Long text", phone: "Phone", select: "Choice", number: "Number", date: "Date" };

export function FormsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["forms"], queryFn: () => api.get<{ forms: Form[]; turnstile: boolean }>("/forms") });
  const [editing, setEditing] = useState<Partial<Form> | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["forms"] });
  const toggle = async (f: Form) => { try { await api.patch(`/forms/${f.id}`, { enabled: !f.enabled }); await refresh(); } catch (e) { showError(e as Error); } };
  return (
    <div>
      <PageHeader title="Forms" description="A public link anyone can fill in. Each answer becomes a task on your board or a contact, with spam checks built in."
        actions={<Button onClick={() => setEditing({ name: "", target: "task" })}><Plus className="h-4 w-4" />New form</Button>} />
      {q.isPending ? <Skeleton className="h-40" /> : !q.data!.forms.length ? (
        <Card><EmptyState icon={<ClipboardList />} title="No forms yet" body="Make an enquiry form for your website, a support request form or a sign-up list." action={<Button onClick={() => setEditing({ name: "Website enquiry", target: "task" })}>Make an enquiry form</Button>} /></Card>
      ) : (
        <Card className="divide-y divide-line">
          {q.data!.forms.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-3 p-4" data-testid="form-row">
              <Switch checked={f.enabled} onChange={() => void toggle(f)} label={`Turn ${f.name} ${f.enabled ? "off" : "on"}`} />
              <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(f)}>
                <div className="text-[14px] font-medium">{f.name}</div>
                <div className="mt-0.5 text-[12.5px] text-muted">Makes a {f.target} · {f.fields.length} fields · {f.submitCount} {f.submitCount === 1 ? "answer" : "answers"}{f.lastSubmitAt && `, last ${timeAgo(f.lastSubmitAt)}`}</div>
              </button>
              <div className="flex items-center gap-2">
                <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-elevated"><ExternalLink className="h-3.5 w-3.5" />Open</a>
                <CopyButton value={f.url} label="Copy link" />
                <Button size="sm" variant="ghost" onClick={() => setViewing(f.id)}>Answers</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {q.data && <p className="mt-3 text-[12px] text-subtle">{q.data.turnstile ? "Spam protection: a human check, a hidden trap field and a limit per sender." : "Spam protection: a hidden trap field, a minimum fill time and a limit per sender."}</p>}
      {editing && <FormEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {viewing && <Answers id={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function FormEditor({ initial, onClose, onSaved }: { initial: Partial<Form>; onClose: () => void; onSaved: () => void }) {
  const projects = useProjects();
  const people = useAssignees();
  const [f, setF] = useState<Partial<Form>>({ ...initial, fields: initial.fields ?? [{ label: "Your name", type: "text", required: true }, { label: "Email", type: "email", required: true }, { label: "What do you need?", type: "text", required: true }, { label: "Details", type: "textarea" }] });
  const [busy, setBusy] = useState(false);
  const fields = f.fields ?? [];
  const setField = (i: number, patch: Partial<FormField>) => setF({ ...f, fields: fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: number) => { const next = [...fields]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setF({ ...f, fields: next }); };
  const save = async () => {
    setBusy(true);
    const body = { name: f.name, description: f.description ?? "", target: f.target, projectId: f.projectId || null, assigneeId: f.assigneeId || null, successMessage: f.successMessage, fields: fields.map((x) => ({ ...x, options: x.type === "select" ? x.options : undefined })), ...(f.target !== "contact" ? { triage: f.triage ?? !f.id } : {}) };
    try { if (f.id) await api.patch(`/forms/${f.id}`, body); else await api.post("/forms", body); onSaved(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const remove = async () => { if (!f.id) return; try { await api.del(`/forms/${f.id}`); onSaved(); } catch (e) { showError(e as Error); } };
  return (
    <Dialog open onClose={onClose} title={f.id ? "Edit form" : "New form"} className="max-w-2xl"
      footer={<>{f.id && <Button variant="ghost" className="mr-auto text-bad" onClick={() => void remove()}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!f.name?.trim()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(fp) => (<Input {...fp} value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Website enquiry" />)}</Field>
        <Field label="Intro" hint="Shown at the top of the form.">{(fp) => (<Textarea {...fp} value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} className="min-h-16" />)}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Each answer makes">{(fp) => (<Select {...fp} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value as "task" | "contact" })}><option value="task">A task</option><option value="contact">A contact</option></Select>)}</Field>
          {f.target === "task" && <Field label="In project">{(fp) => (<Select {...fp} value={f.projectId ?? ""} onChange={(e) => setF({ ...f, projectId: e.target.value || null })}><option value="">Default project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>)}</Field>}
          {f.target === "task" && <Field label="Assign to">{(fp) => (<Select {...fp} value={f.assigneeId ?? ""} onChange={(e) => setF({ ...f, assigneeId: e.target.value || null })}><option value="">Nobody</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.type === "agent" ? " (agent)" : ""}</option>)}</Select>)}</Field>}
        </div>
        <div>
          <div className="mb-1.5 text-[13px] font-medium">Fields</div>
          <ul className="space-y-2">
            {fields.map((x, i) => (
              <li key={i} className="rounded-lg border border-line p-2.5">
                <div className="grid grid-cols-[1fr_130px_auto] items-center gap-2">
                  <Input aria-label={`Field ${i + 1} label`} value={x.label} onChange={(e) => setField(i, { label: e.target.value })} className="h-8 text-[13px]" />
                  <Select aria-label={`Field ${i + 1} type`} value={x.type} onChange={(e) => setField(i, { type: e.target.value as FieldType })} className="h-8 text-[13px]">{(Object.keys(TYPES) as FieldType[]).map((t) => <option key={t} value={t}>{TYPES[t]}</option>)}</Select>
                  <div className="flex items-center gap-1">
                    <label className="flex items-center gap-1 text-[12px] text-muted"><input type="checkbox" checked={!!x.required} onChange={(e) => setField(i, { required: e.target.checked })} />Required</label>
                    <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></button>
                    <button disabled={i === fields.length - 1} onClick={() => move(i, 1)} className="p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></button>
                    <button onClick={() => setF({ ...f, fields: fields.filter((_, j) => j !== i) })} className="p-1 text-subtle hover:text-bad" aria-label="Remove field"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {x.type === "select" && <Input aria-label="Choices" placeholder="Choices, separated by commas" value={(x.options ?? []).join(", ")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })} className="mt-2 h-8 text-[13px]" />}
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setF({ ...f, fields: [...fields, { label: "New question", type: "text" }] })}><Plus className="h-3.5 w-3.5" />Add field</Button>
        </div>
        {f.target !== "contact" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
            <div><div className="text-[13px] font-medium">Send to triage</div><div className="text-[12px] text-muted">New answers wait in Triage until someone accepts them.</div></div>
            <Switch checked={f.triage ?? !f.id} onChange={(v) => setF({ ...f, triage: v })} label="Send to triage" />
          </div>
        )}
        <Field label="Thank-you message">{(fp) => (<Input {...fp} value={f.successMessage ?? "Thanks, we got it. We'll be in touch."} onChange={(e) => setF({ ...f, successMessage: e.target.value })} />)}</Field>
      </div>
    </Dialog>
  );
}

function Answers({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["form", id], queryFn: () => api.get<{ form: Form; submissions: Submission[] }>(`/forms/${id}`) });
  return (
    <Dialog open onClose={onClose} title={q.data ? `Answers to ${q.data.form.name}` : "Answers"} className="max-w-2xl">
      {!q.data ? <Skeleton className="h-32" /> : !q.data.submissions.length ? <p className="text-[13px] text-muted">No answers yet. Share the link: {q.data.form.url}</p> : (
        <ul className="max-h-[60vh] space-y-2 overflow-y-auto">
          {q.data.submissions.map((s) => (
            <li key={s.id} className="rounded-lg border border-line p-3 text-[13px]">
              <div className="mb-1 flex items-center justify-between text-[12px] text-subtle"><span>{timeAgo(s.createdAt)}</span>
                {s.entityType === "task" && s.entityId && <Link className="text-brand-hover hover:underline" to={`/app/tasks?view=list&task=${s.entityId}`}>Open task</Link>}
                {s.entityType === "contact" && s.entityId && <Link className="text-brand-hover hover:underline" to={`/app/contacts/${s.entityId}`}>Open contact</Link>}
              </div>
              <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-0.5">{q.data!.form.fields.map((f) => s.data[f.id!] ? <><dt key={`${f.id}-k`} className="text-subtle">{f.label}</dt><dd key={`${f.id}-v`} className="whitespace-pre-wrap">{s.data[f.id!]}</dd></> : null)}</dl>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

declare global { interface Window { turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; theme?: string }) => string; reset: (id?: string) => void } } }

/** The public form at /f/<slug>. No sign-in. */
export function PublicFormPage() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ["public-form", slug], retry: false, queryFn: async () => (await api.get<{ form: { name: string; description: string; workspace: string; fields: (FormField & { id: string })[]; turnstileSiteKey: string | null } }>(`/public/forms/${slug}`)).form });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [trap, setTrap] = useState("");
  const [token, setToken] = useState<string | undefined>();
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opened = useRef(Date.now());
  const widget = useRef<HTMLDivElement>(null);
  const site = q.data?.turnstileSiteKey;
  useEffect(() => {
    if (!site || !widget.current) return;
    const el = widget.current;
    const mount = () => window.turnstile?.render(el, { sitekey: site, callback: setToken, theme: "dark" });
    if (window.turnstile) { mount(); return; }
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true; s.onload = mount;
    document.head.appendChild(s);
  }, [site]);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/public/forms/${slug}`, { answers, website: trap, turnstileToken: token, elapsedMs: Date.now() - opened.current });
      setDone(r.message);
    } catch (e) { showError(e as Error); window.turnstile?.reset(); } finally { setBusy(false); }
  };
  const f = q.data;
  return (
    <main className="min-h-dvh bg-bg px-4 py-10 text-fg">
      <div className="mx-auto max-w-lg">
        {q.isPending ? <Skeleton className="h-64" /> : !f ? (
          <Card className="p-8 text-center"><h1 className="text-lg font-semibold">This form isn't available</h1><p className="mt-1 text-[13px] text-muted">It may have been turned off.</p></Card>
        ) : done ? (
          <Card className="p-8 text-center" data-testid="form-done"><h1 className="text-lg font-semibold">Sent</h1><p className="mt-2 text-[14px] text-muted">{done}</p></Card>
        ) : (
          <Card className="p-6 sm:p-8">
            <p className="text-[12.5px] text-muted">{f.workspace}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{f.name}</h1>
            {f.description && <p className="mt-2 whitespace-pre-wrap text-[14px] text-muted">{f.description}</p>}
            <form className="mt-6 space-y-4" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="public-form">
              {f.fields.map((x) => {
                const common = { name: x.id, required: x.required, value: answers[x.id] ?? "", placeholder: x.placeholder, onChange: (e: { target: { value: string } }) => setAnswers({ ...answers, [x.id]: e.target.value }) };
                return (
                  <Field key={x.id} label={`${x.label}${x.required ? "" : " (optional)"}`}>{(fp) => (x.type === "textarea" ? <Textarea {...fp} {...common} className="min-h-28" />
                      : x.type === "select" ? <Select {...fp} {...common}><option value="">Choose one</option>{x.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                      : <Input {...fp} {...common} type={x.type === "phone" ? "tel" : x.type === "text" ? "text" : x.type} autoComplete={x.type === "email" ? "email" : /name/i.test(x.label) ? "name" : undefined} />)}</Field>
                );
              })}
              {/* A trap for bots: hidden from people and screen readers. */}
              <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
                <label>Website<input tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} name="website" /></label>
              </div>
              {site && <div ref={widget} />}
              <Button type="submit" className="w-full" loading={busy} disabled={!!site && !token}>Send</Button>
            </form>
          </Card>
        )}
        <div className="mt-6 flex items-center justify-center gap-2 text-[12px] text-subtle">Form by <Logo className="h-4" /></div>
      </div>
    </main>
  );
}
