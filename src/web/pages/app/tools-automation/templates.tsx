/**
 * Tools P2 (flag templates): invoices, quotes and letters (and the workspace's own templates) filled from a
 * form, previewed live, made into a PDF by the engine, then downloaded or attached to a new email.
 */
import { PagePreview } from "./page-preview";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { jobFile, waitForJobDone } from "@/web/lib/tool-jobs";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Card, Skeleton } from "@/web/components/ui/misc";
import { IconClose } from "@/web/components/ui/icon";
import { cn } from "@/web/lib/cn";
import type { ToolJob } from "@/shared/tools";
import {
  TEMPLATE_FIELD_TYPES, fillTemplate, invoiceTotals, missingRequired, money, nextDocNumber, parseLines, templateDefaults,
  type LineItem, type TemplateDef, type TemplateField, type TemplateFieldType,
} from "@/shared/tools-automation";
import { AutoPage, ResultBox, useRunState } from "./shell";
import { warmEngine } from "@/web/components/tools/tool-directory";

/** R67: the last invoice and quote number made in this browser, per workspace, so the next one is suggested. */
const NUMBER_KEYS = { invoice_number: "invoice", quote_number: "quote" } as const;
const lastNumberKey = (ws: string, key: string) => `mm-last-doc-number:${ws}:${key}`;
function suggestedNumbers(ws: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, kind] of Object.entries(NUMBER_KEYS)) {
    let last: string | null = null;
    try { last = localStorage.getItem(lastNumberKey(ws, key)); } catch { /* storage off */ }
    out[key] = nextDocNumber(last, kind);
  }
  return out;
}
function rememberNumbers(ws: string, values: Record<string, string>) {
  for (const key of Object.keys(NUMBER_KEYS)) {
    const v = values[key]?.trim();
    if (v) try { localStorage.setItem(lastNumberKey(ws, key), v); } catch { /* storage off */ }
  }
}

interface Info { templates: TemplateDef[]; workspaceName: string; logo: string | null; today: string }

function LinesEditor({ value, onChange, gst }: { value: string; onChange: (v: string) => void; gst: string }) {
  const lines = (() => { try { return JSON.parse(value) as LineItem[]; } catch { return []; } })();
  const set = (n: LineItem[]) => onChange(JSON.stringify(n));
  const t = invoiceTotals(parseLines(value), { gst: gst !== "no", gstIncluded: gst === "included" });
  return (
    <div className="space-y-2" data-testid="lines-editor">
      {/* R67: column names once on wide screens; on a phone each box carries its own small label. */}
      {lines.length > 0 && <div aria-hidden className="hidden grid-cols-[1fr_4.5rem_6.5rem_2rem] gap-2 text-[12px] text-muted sm:grid"><span>Description</span><span>Quantity</span><span>Unit price</span><span /></div>}
      {lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[4.5rem_1fr_auto] items-end gap-2 sm:grid-cols-[1fr_4.5rem_6.5rem_2rem] sm:items-center">
          <Input className="col-span-3 sm:col-span-1" value={l.description} placeholder="Description" onChange={(e) => set(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label={`Item ${i + 1}`} />
          <label className="block min-w-0"><span className="mb-1 block text-[12px] text-muted sm:hidden">Quantity</span>
            <Input type="number" inputMode="decimal" min={0} step="any" value={String(l.quantity)} onChange={(e) => set(lines.map((x, j) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} aria-label="Quantity" /></label>
          <label className="block min-w-0"><span className="mb-1 block text-[12px] text-muted sm:hidden">Unit price</span>
            <Input type="number" inputMode="decimal" min={0} step="0.01" value={String(l.unitPrice)} onChange={(e) => set(lines.map((x, j) => (j === i ? { ...x, unitPrice: Number(e.target.value) } : x)))} aria-label="Unit price" /></label>
          <button type="button" onClick={() => set(lines.filter((_, j) => j !== i))} aria-label="Remove item" className="grid h-10 w-10 place-items-center rounded text-muted hover:bg-hover max-sm:h-11 max-sm:w-11"><IconClose className="h-4 w-4" /></button>
        </div>
      ))}
      <Button type="button" size="sm" variant="secondary" onClick={() => set([...lines, { description: "", quantity: 1, unitPrice: 0 }])}>Add an item</Button>
      <dl className="ml-auto grid w-60 grid-cols-2 gap-y-1 text-sm" data-testid="lines-totals">
        <dt className="text-muted">Subtotal</dt><dd className="text-right">{money(t.subtotal)}</dd>
        <dt className="text-muted">GST (10%)</dt><dd className="text-right">{money(t.gst)}</dd>
        <dt className="font-semibold">Total</dt><dd className="text-right font-semibold">{money(t.total)}</dd>
      </dl>
    </div>
  );
}

function FormField({ f, value, onChange, gst }: { f: TemplateField; value: string; onChange: (v: string) => void; gst: string }) {
  const label = `${f.label}${f.required ? " *" : ""}`;
  if (f.type === "lines") return <Field label={label}>{() => <><LinesEditor value={value || "[]"} onChange={onChange} gst={gst} /></>}</Field>;
  if (f.type === "textarea") return <Field label={label}>{(fp) => <Textarea {...fp} rows={f.key === "body" ? 8 : 3} value={value} onChange={(e) => onChange(e.target.value)} />}</Field>;
  const type = f.type === "date" ? "date" : f.type === "number" || f.type === "money" ? "number" : f.type === "email" ? "email" : "text";
  return <Field label={label}>{(fp) => <Input {...fp} type={type} step={f.type === "money" ? "0.01" : undefined} value={value} onChange={(e) => onChange(e.target.value)} />}</Field>;
}

function CustomEditor({ start, onDone }: { start: Partial<TemplateDef>; onDone: () => void }) {
  const qc = useQueryClient();
  const [t, setT] = useState({ name: start.name ?? "", kind: start.kind ?? "custom", html: start.html ?? "<h1>{{title}}</h1>\n<p>{{body}}</p>\n<p>{{workspace_name}}</p>", fields: start.fields ?? [{ key: "title", label: "Title", type: "text" as TemplateFieldType }, { key: "body", label: "Text", type: "textarea" as TemplateFieldType }] });
  const save = useMutation({
    mutationFn: () => (start.id && !start.builtIn ? api.put(`/tools/templates/${start.id}`, t) : api.post("/tools/templates", t)),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["tools-templates"] }); toast.success("Template saved"); onDone(); },
    onError: (e) => showError(e),
  });
  const setField = (i: number, p: Partial<TemplateField>) => setT({ ...t, fields: t.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  return (
    <Card className="space-y-3 p-4" data-testid="template-editor">
      <Field label="Name">{(fp) => <Input {...fp} value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} maxLength={80} />}</Field>
      <Field label="Template (HTML)" hint="Put {{field_name}} where a value goes. {{workspace_name}}, {{logo}} and {{today}} fill in for you. No scripts or files from other websites.">{() => <>
        <Textarea rows={10} value={t.html} onChange={(e) => setT({ ...t, html: e.target.value })} className="font-mono text-[12.5px]" />
      </>}</Field>
      <div className="space-y-2">
        <h3 className="text-[13px] font-semibold">Fields</h3>
        {t.fields.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input value={f.key} onChange={(e) => setField(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })} aria-label="Field name" className="w-36 font-mono" />
            <Input value={f.label} onChange={(e) => setField(i, { label: e.target.value })} aria-label="Label" placeholder="Label" className="w-44" />
            <Select value={f.type} onChange={(e) => setField(i, { type: e.target.value as TemplateFieldType })} aria-label="Type" className="w-32">{TEMPLATE_FIELD_TYPES.map((x) => <option key={x} value={x}>{x === "lines" ? "items" : x}</option>)}</Select>
            <label className="flex items-center gap-1 text-[13px]"><input type="checkbox" checked={!!f.required} onChange={(e) => setField(i, { required: e.target.checked })} />Required</label>
            <button type="button" onClick={() => setT({ ...t, fields: t.fields.filter((_, j) => j !== i) })} aria-label="Remove field" className="rounded p-1 text-muted hover:bg-hover"><IconClose className="h-4 w-4" /></button>
          </div>
        ))}
        <Button size="sm" variant="secondary" onClick={() => setT({ ...t, fields: [...t.fields, { key: `field_${t.fields.length + 1}`, label: "", type: "text" }] })}>Add a field</Button>
      </div>
      <div className="flex gap-2"><Button onClick={() => save.mutate()} disabled={save.isPending || !t.name.trim()}>Save template</Button><Button variant="ghost" onClick={onDone}>Cancel</Button></div>
    </Card>
  );
}

export function TemplatesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["tools-templates"], queryFn: () => api.get<Info>("/tools/templates") });
  const [id, setId] = useState("builtin-invoice");
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Partial<TemplateDef> | null>(null);
  const [run, setRun] = useRunState();
  const t = q.data?.templates.find((x) => x.id === id) ?? q.data?.templates[0];
  const ctx = useMemo(() => ({ workspaceName: q.data?.workspaceName ?? "", logoDataUri: q.data?.logo, today: q.data?.today ?? "" }), [q.data]);
  const ws = q.data?.workspaceName ?? "";
  // R67: the next invoice or quote number is suggested from the last one made here.
  useEffect(() => { if (t) { const next = suggestedNumbers(ws); setValues({ ...templateDefaults(t, ctx), ...Object.fromEntries(t.fields.filter((f) => f.key in next).map((f) => [f.key, next[f.key]])) }); setRun({ kind: "idle" }); } }, [t?.id, ctx]); // eslint-disable-line react-hooks/exhaustive-deps
  // R67: wake the document engine as the page opens, so Make PDF does not wait for a cold start.
  useEffect(() => { void warmEngine(); }, []);
  const gst = values.gst ?? "yes";
  const preview = useMemo(() => (t ? fillTemplate(t, values, ctx) : ""), [t, values, ctx]);
  const missing = t ? missingRequired(t, values) : [];
  const del = useMutation({ mutationFn: (x: string) => api.del(`/tools/templates/${x}`), onSuccess: () => { setId("builtin-invoice"); void qc.invalidateQueries({ queryKey: ["tools-templates"] }); }, onError: (e) => showError(e) });
  const make = async () => {
    if (!t) return;
    setRun({ kind: "working", label: "Making the PDF" });
    try {
      const body = { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, t.fields.find((f) => f.key === k)?.type === "lines" ? parseLines(v) : v])) };
      const job = await api.post<ToolJob>(`/tools/templates/${t.id}/render`, body);
      const doneJob = await waitForJobDone(job.token);
      setRun({ kind: "done", file: await jobFile(doneJob), job: doneJob });
      rememberNumbers(ws, values);
    } catch (e) { setRun({ kind: "failed", message: errorMessage(e) }); }
  };
  const subject = t ? `${t.name}${values.invoice_number ? ` ${values.invoice_number}` : values.quote_number ? ` ${values.quote_number}` : values.subject ? `: ${values.subject}` : ""}` : "";
  return (
    <AutoPage title="Document templates" description="Fill in an invoice, quote or letter, check the preview, and get a PDF to send. Invoices work out line totals, GST and the total for you."
      actions={<Button variant="secondary" onClick={() => setEditing({})}>New template</Button>}>
      {editing && <CustomEditor start={editing} onDone={() => setEditing(null)} />}
      {q.isPending ? <Skeleton className="h-96 w-full" /> : t && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card className="space-y-4 p-4">
            <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Document templates">
              {q.data!.templates.map((x) => (
                <button key={x.id} role="tab" aria-selected={x.id === t.id} onClick={() => setId(x.id)}
                  className={cn("rounded-full border px-3 py-1 text-[13px]", x.id === t.id ? "border-[#0071E3] bg-[#0071E3]/10 text-[#0071E3]" : "border-line text-muted hover:text-fg")}>{x.name}</button>
              ))}
            </div>
            {t.kind !== "letter" && t.fields.some((f) => f.type === "lines") && (
              <Field label="GST">{(fp) => <Select {...fp} value={gst} onChange={(e) => setValues({ ...values, gst: e.target.value })}><option value="yes">Add 10% GST</option><option value="included">Prices include GST</option><option value="no">No GST</option></Select>}</Field>
            )}
            {t.fields.map((f) => <FormField key={f.key} f={f} gst={gst} value={values[f.key] ?? ""} onChange={(v) => setValues((x) => ({ ...x, [f.key]: v }))} />)}
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={make} disabled={run.kind === "working" || missing.length > 0}>Make PDF</Button>
              {!t.builtIn && <><Button variant="secondary" onClick={() => setEditing(t)}>Edit template</Button><Button variant="ghost" onClick={() => del.mutate(t.id)}>Delete</Button></>}
              {t.builtIn && <Button variant="ghost" onClick={() => setEditing({ ...t, id: undefined, name: `${t.name} (my copy)`, builtIn: false, kind: "custom" })}>Copy and edit</Button>}
              {missing.length > 0 && <span className="text-[12px] text-muted">Fill in {missing.join(", ")}</span>}
              {run.kind === "working" && <span role="status" className="text-sm text-muted">{run.label}</span>}
              {run.kind === "failed" && <span role="alert" className="text-sm text-bad">{run.message}</span>}
            </div>
            {run.kind === "done" && <ResultBox file={run.file} job={run.job} subject={subject} />}
          </Card>
          <Card className="overflow-hidden p-0 lg:sticky lg:top-4 lg:self-start">
            <p className="border-b border-line px-4 py-2 text-[12px] text-muted">Preview</p>
            <PagePreview title="Preview" html={preview} testId="template-preview" />
          </Card>
        </div>
      )}
    </AutoPage>
  );
}
