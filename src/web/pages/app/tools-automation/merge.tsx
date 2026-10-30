/**
 * Tools P2 (flag merge_mail): one template, a list of people (CSV or contacts), one personal PDF each,
 * sent as one email per person from your mailbox, spread over time. Consent tick required; marketing
 * sends get an unsubscribe line; a daily cap per plan.
 */
import { PagePreview } from "./page-preview";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, Meter, Skeleton } from "@/web/components/ui/misc";
import {
  escapeHtml, isEmail, mergeRowValues, mergeTemplateHtml, parseCsv, personalBody, fillText,
  type TemplateDef, type TemplateField,
} from "@/shared/tools-automation";
import { AutoPage } from "./shell";

interface MergeInfo { cap: number; usedToday: number; maxRows: number; runs: RunRow[]; templates: { id: string; name: string; kind: string; fields: TemplateField[] }[] }
interface RunRow { id: string; status: string; total: number; sent: number; failed: number; subject: string; createdAt: string }
interface Progress extends RunRow { error: string | null; failures: { email: string; error: string | null }[] }
interface Table { columns: string[]; rows: string[][] }

const FIXED = "\u0000fixed";
const STATUS: Record<string, string> = { rendering: "Making the PDFs", sending: "Sending", done: "Finished", cancelled: "Stopped", failed: "Didn't start" };

function guess(columns: string[], key: string): string {
  const k = key.replace(/_/g, " ").toLowerCase();
  return columns.find((c) => c.toLowerCase() === k) ?? columns.find((c) => c.toLowerCase().includes(k.split(" ")[0])) ?? "";
}

function RunProgress({ id, onDone }: { id: string; onDone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["merge-run", id], queryFn: () => api.get<Progress>(`/tools/merge/${id}`), refetchInterval: (x) => (x.state.data && ["done", "cancelled", "failed"].includes(x.state.data.status) ? false : 3000) });
  const cancel = useMutation({ mutationFn: () => api.post<Progress>(`/tools/merge/${id}/cancel`), onSuccess: (r) => qc.setQueryData(["merge-run", id], r), onError: (e) => showError(e) });
  const r = q.data;
  useEffect(() => { if (r && ["done", "cancelled", "failed"].includes(r.status)) onDone(); }, [r?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <Skeleton className="h-24 w-full" />;
  return (
    <Card className="space-y-3 p-4" data-testid="merge-progress">
      <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{r.subject}</h3><Badge tone={r.status === "done" ? "ok" : r.status === "failed" ? "bad" : "neutral"}>{STATUS[r.status] ?? r.status}</Badge></div>
      <Meter value={r.sent + r.failed} max={r.total} label={`${r.sent} sent, ${r.failed} failed of ${r.total}`} />
      <p className="text-sm"><strong>{r.sent}</strong> sent · <strong>{r.failed}</strong> failed · {r.total - r.sent - r.failed} to go</p>
      {r.error && <p role="alert" className="text-sm text-bad">{r.error}</p>}
      {r.failures.length > 0 && <ul className="space-y-0.5 text-[13px] text-muted">{r.failures.map((f) => <li key={f.email}>{f.email}: {f.error}</li>)}</ul>}
      {(r.status === "sending" || r.status === "rendering") && <Button size="sm" variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Stop sending</Button>}
    </Card>
  );
}

export function MergePage() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ["tools-merge"], queryFn: () => api.get<MergeInfo>("/tools/merge") });
  const tpls = useQuery({ queryKey: ["tools-templates"], queryFn: () => api.get<{ templates: TemplateDef[]; workspaceName: string; logo: string | null; today: string }>("/tools/templates") });
  const mailboxes = useMailboxes();
  const [templateId, setTemplateId] = useState("builtin-invoice");
  const [table, setTable] = useState<Table | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  /** Values that are the same for everyone (a field with no column), e.g. the date or your name. */
  const [fixed, setFixed] = useState<Record<string, string>>({});
  const [mailboxId, setMailboxId] = useState("");
  const [subject, setSubject] = useState("Your document from {{workspace}}");
  const [body, setBody] = useState("Hi {{first_name}},\n\nYour document is attached.\n\nThanks");
  const [marketing, setMarketing] = useState(false);
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const t = info.data?.templates.find((x) => x.id === templateId);
  const fullT = tpls.data?.templates.find((x) => x.id === templateId);
  const fields = useMemo(() => [{ key: "email", label: "Email", type: "email" as const, required: true }, { key: "name", label: "Name", type: "text" as const, required: true }, ...(t?.fields ?? [])], [t]);
  useEffect(() => { if (!mailboxId && mailboxes.data?.[0]) setMailboxId(mailboxes.data[0].id); }, [mailboxes.data, mailboxId]);
  useEffect(() => {
    if (!table) return;
    const ws = tpls.data?.workspaceName ?? "";
    const iso = new Date().toISOString().slice(0, 10);
    const defaults: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === "date") defaults[f.key] = iso;
      else if (f.key === "business_name" || f.key === "sender_name") defaults[f.key] = ws;
    }
    const m: Record<string, string> = {};
    for (const f of fields) m[f.key] = guess(table.columns, f.key) || (defaults[f.key] !== undefined ? FIXED : "");
    if (!m.recipient_name && m.name) m.recipient_name = m.name;
    if (!m.client_name && m.name) m.client_name = m.name;
    setMap(m);
    setFixed(defaults);
  }, [table, fields]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCsv = async (file: File) => {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) { showError(new Error("That file has no rows under the header.")); return; }
    setTable({ columns: rows[0].map((c, i) => c.trim() || `Column ${i + 1}`), rows: rows.slice(1) });
  };
  const loadContacts = async () => {
    try {
      const r = await api.get<{ contacts?: { name?: string; email?: string; company?: string }[]; items?: { name?: string; email?: string; company?: string }[] }>("/contacts?limit=500");
      const list = (r.contacts ?? r.items ?? []).filter((c) => c.email);
      if (!list.length) { showError(new Error("None of your contacts has an email address yet.")); return; }
      setTable({ columns: ["Name", "Email", "Company"], rows: list.map((c) => [c.name ?? "", c.email ?? "", c.company ?? ""]) });
    } catch (e) { showError(e as Error); }
  };
  const people = useMemo(() => {
    if (!table) return [];
    const col = (k: string) => table.columns.indexOf(map[k] ?? "");
    return table.rows.map((r) => {
      const data: Record<string, string> = {};
      for (const f of t?.fields ?? []) { if (map[f.key] === FIXED) { data[f.key] = fixed[f.key] ?? ""; continue; } const i = col(f.key); if (i >= 0) data[f.key] = r[i] ?? ""; }
      return { email: (r[col("email")] ?? "").trim(), name: (r[col("name")] ?? "").trim(), data };
    });
  }, [table, map, fixed, t]);
  const valid = people.filter((p) => isEmail(p.email));
  const unfilled = (t?.fields ?? []).filter((f) => f.required && !map[f.key]).map((f) => f.label);
  const left = info.data ? Math.max(0, info.data.cap - info.data.usedToday) : 0;
  const ctx = { workspaceName: tpls.data?.workspaceName ?? "", logoDataUri: tpls.data?.logo, today: tpls.data?.today ?? "" };
  const previewHtml = (p: (typeof people)[number]) => {
    if (!fullT) return "";
    const v = mergeRowValues(fullT, { name: p.name, email: p.email, ...p.data }, ctx);
    return mergeTemplateHtml(fullT.html).replace(/\{\{\s*logo\s*\}\}/g, "").replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k: string) => escapeHtml(v[k] ?? ""));
  };
  const textFor = (s: string) => s.replace(/\{\{\s*workspace\s*\}\}/g, ctx.workspaceName);
  const start = useMutation({
    mutationFn: () => api.post<{ id: string; total: number; skippedUnsubscribed: number }>("/tools/merge", { templateId, mailboxId, subject: textFor(subject), body: textFor(body), people: valid, consent, marketing }),
    onSuccess: (r) => { setRunning(r.id); void qc.invalidateQueries({ queryKey: ["tools-merge"] }); },
    onError: (e) => showError(e),
  });
  return (
    <AutoPage entryKey="merge_mail" title="Mail merge" description="Send each person their own PDF, made from one template, in their own email from your mailbox.">
      {info.isPending ? <Skeleton className="h-64 w-full" /> : info.data && (
        <>
          <p className="text-sm text-muted" data-testid="merge-cap">Today: {info.data.usedToday} of {info.data.cap} people on your plan. Your normal daily sending limit applies too.</p>
          {running && <RunProgress id={running} onDone={() => void qc.invalidateQueries({ queryKey: ["tools-merge"] })} />}
          <Card className="space-y-4 p-4">
            <h2 className="text-sm font-semibold">1. Template</h2>
            <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template" className="max-w-sm">{info.data.templates.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
            <h2 className="text-sm font-semibold">2. People</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-2 text-sm hover:bg-hover">Upload a CSV<input type="file" accept=".csv,text/csv" hidden data-testid="merge-csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadCsv(f); e.target.value = ""; }} /></label>
              <Button variant="secondary" onClick={loadContacts}>Use my contacts</Button>
              {table && <span className="text-sm text-muted">{table.rows.length} rows, {valid.length} with a valid email</span>}
            </div>
            {table && (
              <>
                <h2 className="text-sm font-semibold">3. Match the columns</h2>
                <div className="grid gap-2 sm:grid-cols-2" data-testid="merge-map">
                  {fields.map((f) => (
                    <div key={f.key} className="flex flex-wrap items-center gap-2 text-sm"><span className="w-40 shrink-0">{f.label}{f.key === "email" || f.key === "name" ? " *" : ""}</span>
                      <Select value={map[f.key] ?? ""} onChange={(e) => setMap({ ...map, [f.key]: e.target.value })} aria-label={f.label} className="w-48"><option value="">Leave empty</option>{f.key !== "email" && f.key !== "name" && <option value={FIXED}>Same for everyone</option>}{table.columns.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
                      {map[f.key] === FIXED && <Input type={f.type === "date" ? "date" : "text"} value={fixed[f.key] ?? ""} onChange={(e) => setFixed({ ...fixed, [f.key]: e.target.value })} aria-label={`${f.label} for everyone`} className="w-48" />}
                    </div>
                  ))}
                </div>
                <h2 className="text-sm font-semibold">4. The email</h2>
                <Field label="Send from">{(fp) => <Select {...fp} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>{(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.displayName} &lt;{m.address}&gt;</option>)}</Select>}</Field>
                <Field label="Subject" hint="{{first_name}}, {{name}} and any matched field fill in per person.">{(fp) => <Input {...fp} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />}</Field>
                <Field label="Message">{(fp) => <Textarea {...fp} rows={6} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
                <h2 className="text-sm font-semibold">5. Preview</h2>
                <div className="grid gap-3 lg:grid-cols-3" data-testid="merge-preview">
                  {valid.slice(0, 3).map((p) => (
                    <Card key={p.email} className="overflow-hidden p-0">
                      <div className="space-y-1 border-b border-line p-3 text-[13px]"><p><strong>To:</strong> {p.email}</p><p><strong>Subject:</strong> {fillText(textFor(subject), p)}</p><p className="whitespace-pre-line text-muted">{personalBody(textFor(body), p).slice(0, 220)}</p></div>
                      <PagePreview title={`Preview for ${p.name || p.email}`} html={previewHtml(p)} maxHeight={420} />
                    </Card>
                  ))}
                </div>
                <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
                  <label className="flex items-start gap-2"><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-1" /><span>This is marketing (offers, news, promotions). An unsubscribe line is added and people who unsubscribed are skipped.</span></label>
                  <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="merge-consent" className="mt-1" /><span><strong>These people agreed to get this email.</strong> Australian law requires consent for commercial email.</span></label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={() => start.mutate()} disabled={!consent || !valid.length || !mailboxId || start.isPending || valid.length > left} data-testid="merge-send">Send {valid.length} emails</Button>
                  {valid.length > left && <span className="text-sm text-bad">Only {left} left today on your plan.</span>}
                  {!consent && <span className="text-[12px] text-muted">Tick the consent box to send.</span>}
                  {unfilled.length > 0 && <span className="text-[12px] text-muted">Empty in every PDF: {unfilled.join(", ")}</span>}
                </div>
              </>
            )}
          </Card>
          {info.data.runs.length > 0 && (
            <section className="space-y-2"><h2 className="text-sm font-semibold">Recent merges</h2>
              <ul className="divide-y divide-line rounded-lg border border-line text-sm">
                {info.data.runs.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 px-3 py-2"><button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setRunning(r.id)}>{r.subject}</button><span className="text-muted">{r.sent} of {r.total} sent{r.failed ? `, ${r.failed} failed` : ""}</span><Badge>{STATUS[r.status] ?? r.status}</Badge></li>)}
              </ul>
            </section>
          )}
        </>
      )}
    </AutoPage>
  );
}
