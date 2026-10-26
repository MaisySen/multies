import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconArrowDown, IconArrowUp, IconClipboardList, IconExternalLink, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Logo } from "@/web/components/logo";
import { timeAgo } from "@/web/lib/format";
import { useAssignees, useProjects, isAgentLike } from "./data";
import { checkAnswers, checkLogic, MULTI_SEPARATOR, visibleFieldIds, type FormFieldType, type FormRoute } from "@/shared/form-logic";
import { FormResults, LogicEditor, RoutingEditor, type BuilderField } from "./form-logic-ui";
import { ApiError } from "@/web/lib/api";

type FieldType = FormFieldType;
type FormField = BuilderField;
interface Form { id: string; name: string; description: string; slug: string; url: string; target: "task" | "contact"; projectId: string | null; assigneeId: string | null; fields: FormField[]; successMessage: string; enabled: boolean; triage?: boolean; routing?: FormRoute[]; submitCount: number; lastSubmitAt: string | null }

const TYPES: Record<FieldType, string> = { text: "Short text", email: "Email", textarea: "Long text", phone: "Phone", select: "Choice", multiselect: "Several choices", number: "Number", date: "Date" };
const withOptions = (t: FieldType) => t === "select" || t === "multiselect";
/** R31: every builder field gets a stable id up front, so "show if" conditions can point at it. */
const idFor = (label: string, taken: Set<string>, i: number) => {
  let id = label.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `field_${i + 1}`;
  while (taken.has(id)) id = `${id}_${i + 1}`;
  taken.add(id);
  return id;
};
const withIds = (fields: FormField[]) => { const taken = new Set(fields.map((x) => x.id).filter(Boolean) as string[]); return fields.map((x, i) => (x.id ? x : { ...x, id: idFor(x.label, taken, i) })); };

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
        actions={<Button onClick={() => setEditing({ name: "", target: "task" })}><IconPlus className="h-4 w-4" />New form</Button>} />
      {q.isPending ? <Skeleton className="h-40" /> : !q.data!.forms.length ? (
        <Card><EmptyState icon={<IconClipboardList />} title="No forms yet" body="Make an enquiry form for your website, a support request form or a sign-up list." action={<Button onClick={() => setEditing({ name: "Website enquiry", target: "task" })}>Make an enquiry form</Button>} /></Card>
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
                <a href={f.url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] hover:bg-elevated"><IconExternalLink className="h-3.5 w-3.5" />Open</a>
                <CopyButton value={f.url} label="Copy link" />
                <Button size="sm" variant="ghost" onClick={() => setViewing(f.id)}>Responses</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {q.data && <p className="mt-3 text-[12px] text-subtle">{q.data.turnstile ? "Spam protection: a human check, a hidden trap field and a limit per sender." : "Spam protection: a hidden trap field, a minimum fill time and a limit per sender."}</p>}
      {editing && <FormEditor initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {viewing && <FormResults id={viewing} name={q.data?.forms.find((x) => x.id === viewing)?.name ?? "form"} onClose={() => setViewing(null)} />}
    </div>
  );
}

function FormEditor({ initial, onClose, onSaved }: { initial: Partial<Form>; onClose: () => void; onSaved: () => void }) {
  const projects = useProjects();
  const people = useAssignees();
  const [f, setF] = useState<Partial<Form>>({ ...initial, fields: withIds(initial.fields ?? [{ label: "Your name", type: "text", required: true }, { label: "Email", type: "email", required: true }, { label: "What do you need?", type: "text", required: true }, { label: "Details", type: "textarea" }]) });
  const [busy, setBusy] = useState(false);
  const fields = f.fields ?? [];
  const setField = (i: number, patch: Partial<FormField>) => setF({ ...f, fields: fields.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: number) => { const next = [...fields]; const [x] = next.splice(i, 1); next.splice(i + d, 0, x); setF({ ...f, fields: next }); };
  // R31: conditions on a removed question go with it; the first logic problem shows above Save.
  const removeField = (i: number) => { const gone = fields[i].id; setF({ ...f, fields: fields.filter((_, j) => j !== i).map((x) => (x.logic && gone ? { ...x, logic: x.logic.conditions.some((c) => c.field === gone) ? (x.logic.conditions.filter((c) => c.field !== gone).length ? { ...x.logic, conditions: x.logic.conditions.filter((c) => c.field !== gone) } : null) : x.logic } : x)) }); };
  const problem = checkLogic(fields.map((x) => ({ ...x, id: x.id ?? "", required: !!x.required })))[0];
  const save = async () => {
    setBusy(true);
    const body = { name: f.name, description: f.description ?? "", target: f.target, projectId: f.projectId || null, assigneeId: f.assigneeId || null, successMessage: f.successMessage, fields: fields.map((x) => ({ ...x, options: withOptions(x.type) ? x.options : undefined, logic: x.logic ?? undefined, rules: x.rules ?? undefined })), ...(f.target !== "contact" ? { triage: f.triage ?? !f.id, routing: (f.routing ?? []).filter((r) => fields.some((x) => x.id === r.when.field)) } : {}) };
    try { if (f.id) await api.patch(`/forms/${f.id}`, body); else await api.post("/forms", body); onSaved(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const remove = async () => { if (!f.id) return; try { await api.del(`/forms/${f.id}`); onSaved(); } catch (e) { showError(e as Error); } };
  return (
    <Dialog open onClose={onClose} title={f.id ? "Edit form" : "New form"} className="max-w-2xl"
      footer={<>{f.id && <Button variant="ghost" className="mr-auto text-bad" onClick={() => void remove()}>Delete</Button>}<Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!f.name?.trim() || !!problem}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name">{(fp) => (<Input {...fp} value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Website enquiry" />)}</Field>
        <Field label="Intro" hint="Shown at the top of the form.">{(fp) => (<Textarea {...fp} value={f.description ?? ""} onChange={(e) => setF({ ...f, description: e.target.value })} className="min-h-16" />)}</Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Each answer makes">{(fp) => (<Select {...fp} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value as "task" | "contact" })}><option value="task">A task</option><option value="contact">A contact</option></Select>)}</Field>
          {f.target === "task" && <Field label="In project">{(fp) => (<Select {...fp} value={f.projectId ?? ""} onChange={(e) => setF({ ...f, projectId: e.target.value || null })}><option value="">Default project</option>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>)}</Field>}
          {f.target === "task" && <Field label="Assign to">{(fp) => (<Select {...fp} value={f.assigneeId ?? ""} onChange={(e) => setF({ ...f, assigneeId: e.target.value || null })}><option value="">Nobody</option>{people.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{isAgentLike(p) ? " (agent)" : ""}</option>)}</Select>)}</Field>}
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
                    <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move up"><IconArrowUp className="h-3.5 w-3.5" /></button>
                    <button disabled={i === fields.length - 1} onClick={() => move(i, 1)} className="p-1 text-subtle hover:text-fg disabled:opacity-30" aria-label="Move down"><IconArrowDown className="h-3.5 w-3.5" /></button>
                    <button onClick={() => removeField(i)} className="p-1 text-subtle hover:text-bad" aria-label="Remove field"><IconTrash className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                {withOptions(x.type) && <Input aria-label="Choices" placeholder="Choices, separated by commas" value={(x.options ?? []).join(", ")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((o) => o.trim()).filter(Boolean) })} className="mt-2 h-8 text-[13px]" />}
                <LogicEditor field={x} index={i} earlier={fields.slice(0, i)} onChange={(patch) => setField(i, patch)} />
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" className="mt-2" onClick={() => setF({ ...f, fields: [...fields, { id: idFor("question", new Set(fields.map((x) => x.id ?? "")), fields.length), label: "New question", type: "text" }] })}><IconPlus className="h-3.5 w-3.5" />Add field</Button>
          {problem && <p role="alert" className="mt-2 text-[12.5px] text-bad" data-testid="logic-problem">{problem.message}</p>}
        </div>
        {f.target === "task" && <RoutingEditor fields={fields} routes={f.routing ?? []} onChange={(routing) => setF({ ...f, routing })} projects={projects.data ?? []} people={(people.data ?? []).map((p) => ({ id: p.id, name: isAgentLike(p) ? `${p.name} (agent)` : p.name }))} />}
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

declare global { interface Window { turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; callback: (t: string) => void; theme?: string }) => string; reset: (id?: string) => void } } }

/** The public form at /f/<slug>. No sign-in. */
export function PublicFormPage() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ["public-form", slug], retry: false, queryFn: async () => (await api.get<{ form: { name: string; description: string; workspace: string; fields: (FormField & { id: string })[]; turnstileSiteKey: string | null } }>(`/public/forms/${slug}`)).form });
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
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
  const f = q.data;
  // R31: the same rules as the server (src/shared/form-logic.ts): hidden questions are skipped and never required.
  const logicFields = (f?.fields ?? []).map((x) => ({ ...x, required: !!x.required }));
  const shown = visibleFieldIds(logicFields, answers);
  const focusFirst = (errs: Record<string, string>) => { const first = logicFields.find((x) => errs[x.id]); if (first) document.querySelector<HTMLElement>(`[name="${first.id}"]`)?.focus(); };
  const submit = async () => {
    const checked = checkAnswers(logicFields, answers);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) { focusFirst(checked.errors); return; }
    setBusy(true);
    try {
      const sendable = Object.fromEntries(Object.entries(answers).filter(([k]) => shown.has(k)));
      const r = await api.post<{ ok: boolean; message: string }>(`/public/forms/${slug}`, { answers: sendable, website: trap, turnstileToken: token, elapsedMs: Date.now() - opened.current });
      setDone(r.message);
    } catch (e) {
      if (e instanceof ApiError && e.fields && Object.keys(e.fields).length) { setErrors(e.fields); focusFirst(e.fields); } else showError(e as Error);
      window.turnstile?.reset();
    } finally { setBusy(false); }
  };
  const setAnswer = (id: string, v: string | string[]) => { setAnswers((a) => ({ ...a, [id]: v })); if (errors[id]) setErrors((er) => { const n = { ...er }; delete n[id]; return n; }); };
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
            <form className="mt-6 space-y-4" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="public-form">
              {f.fields.filter((x) => shown.has(x.id)).map((x) => {
                const value = answers[x.id];
                const text = Array.isArray(value) ? value.join(MULTI_SEPARATOR) : (value ?? "");
                const common = { name: x.id, "aria-required": x.required || undefined, value: text, placeholder: x.placeholder, onChange: (e: { target: { value: string } }) => setAnswer(x.id, e.target.value) };
                const label = `${x.label}${x.required ? "" : " (optional)"}`;
                const animate = x.logic?.conditions.length ? "animate-pop-in motion-reduce:animate-none" : undefined;
                if (x.type === "multiselect") {
                  const picked = Array.isArray(value) ? value : [];
                  return (
                    <fieldset key={x.id} className={animate} aria-invalid={errors[x.id] ? true : undefined} aria-describedby={errors[x.id] ? `${x.id}-err` : undefined}>
                      <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
                      <div className="space-y-1.5">
                        {x.options?.map((o, oi) => (
                          <label key={o} className="flex items-center gap-2 text-[14px]">
                            <input type="checkbox" name={oi === 0 ? x.id : undefined} className="h-4 w-4 rounded border-line accent-brand focus-visible:ring-2 focus-visible:ring-brand" checked={picked.includes(o)}
                              onChange={(e) => setAnswer(x.id, e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))} />{o}
                          </label>
                        ))}
                      </div>
                      {errors[x.id] && <p id={`${x.id}-err`} role="alert" className="mt-1 text-xs text-bad">{errors[x.id]}</p>}
                    </fieldset>
                  );
                }
                return (
                  <div key={x.id} className={animate} data-testid={`q-${x.id}`}>
                    <Field label={label} error={errors[x.id]}>{(fp) => (x.type === "textarea" ? <Textarea {...fp} {...common} className="min-h-28" />
                      : x.type === "select" ? <Select {...fp} {...common}><option value="">Choose one</option>{x.options?.map((o) => <option key={o} value={o}>{o}</option>)}</Select>
                      : <Input {...fp} {...common} type={x.type === "phone" ? "tel" : x.type === "text" ? "text" : x.type} inputMode={x.type === "number" ? "decimal" : undefined} autoComplete={x.type === "email" ? "email" : /name/i.test(x.label) ? "name" : undefined} />)}</Field>
                  </div>
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
