/**
 * R93: a form's Forms plus settings (admins or the maker): chat style, hidden fields, the website bubble, the signed
 * webhook with its last deliveries, and the NPS or CSAT score.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { timeAgo } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { Badge, CopyButton, Skeleton } from "@/web/components/ui/misc";
import type { FormPlus, NpsResult, CsatResult } from "@/shared/forms-plus";

interface Settings { mode: "classic" | "chat"; plus: FormPlus; webhook: { url: string | null; hasSecret: boolean; failures: number; paused: boolean } }
interface Delivery { id: string; ok: boolean; status: number | null; error: string | null; ms: number; at: string; test: boolean }

export function ScoreCard({ formId }: { formId: string }) {
  const q = useQuery({ queryKey: ["form-score", formId], queryFn: () => api.get<{ score: NpsResult | CsatResult | null; question?: string }>(`/forms-plus/forms/${formId}/score`) });
  const s = q.data?.score;
  if (q.isPending) return <Skeleton className="h-20" />;
  if (!s) return null;
  const parts = s.kind === "nps" ? [{ n: s.promoters, label: "Promoters", cls: "bg-ok" }, { n: s.passives, label: "Passives", cls: "bg-warn" }, { n: s.detractors, label: "Detractors", cls: "bg-bad" }] : [{ n: s.satisfied, label: "Satisfied", cls: "bg-ok" }, { n: s.n - s.satisfied, label: "Not satisfied", cls: "bg-line-strong" }];
  return (
    <div className="rounded-lg border border-line p-3" data-testid="score-card">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] font-medium">{s.kind === "nps" ? "Net promoter score" : "Customer satisfaction"}</div>
        <div className="text-2xl font-semibold tabular-nums">{s.score === null ? "No answers yet" : s.kind === "nps" ? s.score : `${s.score}%`}</div>
      </div>
      {s.n > 0 && (
        <>
          <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-fill" aria-hidden="true">{parts.map((p) => <div key={p.label} className={p.cls} style={{ width: `${(p.n / s.n) * 100}%` }} />)}</div>
          <p className="mt-1.5 text-[12px] text-muted">{parts.map((p) => `${p.label} ${p.n}`).join(" · ")} · {s.n} {s.n === 1 ? "answer" : "answers"}</p>
        </>
      )}
    </div>
  );
}

export function FormPlusDialog({ form, onClose }: { form: { id: string; name: string; slug: string; url: string; target: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["form-plus", form.id], queryFn: () => api.get<Settings>(`/forms-plus/forms/${form.id}/settings`) });
  const log = useQuery({ queryKey: ["form-plus-log", form.id], queryFn: () => api.get<{ deliveries: Delivery[] }>(`/forms-plus/forms/${form.id}/webhook/log`) });
  const [mode, setMode] = useState<"classic" | "chat" | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const s = q.data;
  const curMode = mode ?? s?.mode ?? "classic";
  const curHidden = hidden ?? s?.plus.hiddenFields.join(", ") ?? "";
  const curLabel = label ?? s?.plus.bubbleLabel ?? "Chat with us";
  const curUrl = url ?? s?.webhook.url ?? "";
  const origin = new URL(form.url, window.location.origin).origin;
  const snippet = `<script src="${origin}/forms-embed.js" data-form="${form.slug}" data-label="${curLabel.replace(/"/g, "")}" async></script>`;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["form-plus", form.id] }); void qc.invalidateQueries({ queryKey: ["form-plus-log", form.id] }); void qc.invalidateQueries({ queryKey: ["forms"] }); };
  const save = async () => {
    setBusy("save");
    try {
      const r = await api.put<Settings & { secret?: string }>(`/forms-plus/forms/${form.id}/settings`, {
        mode: curMode, plus: { hiddenFields: curHidden.split(/[,\s]+/).filter(Boolean), bubbleLabel: curLabel }, ...(curUrl !== (s?.webhook.url ?? "") ? { webhookUrl: curUrl.trim() || null } : {}),
      });
      if (r.secret) setSecret(r.secret);
      toast.success("Saved");
      refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  const act = async (what: "test" | "secret" | "resume") => {
    setBusy(what);
    try {
      if (what === "test") { const r = await api.post<Delivery>(`/forms-plus/forms/${form.id}/webhook/test`); if (r.ok) toast.success("Test sent"); else toast.error(r.error ?? "The test didn't go through."); }
      if (what === "secret") setSecret((await api.post<{ secret: string }>(`/forms-plus/forms/${form.id}/webhook/secret`)).secret);
      if (what === "resume") await api.put(`/forms-plus/forms/${form.id}/settings`, { resumeWebhook: true });
      refresh();
    } catch (e) { showError(e as Error); } finally { setBusy(null); }
  };
  return (
    <Dialog open onClose={onClose} title={`${form.name}: more settings`} className="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button onClick={() => void save()} loading={busy === "save"} disabled={!s} data-testid="plus-save">Save</Button></>}>
      {!s ? <Skeleton className="h-64" /> : (
        <div className="space-y-5">
          <ScoreCard formId={form.id} />
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">Style</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {([["classic", "Classic", "Every question on one page."], ["chat", "Chat", "One question at a time, like a conversation."]] as const).map(([v, t, d]) => (
                <label key={v} className={`flex min-h-11 cursor-pointer gap-2.5 rounded-lg border p-3 ${curMode === v ? "border-brand bg-brand/5" : "border-line hover:bg-hover"}`}>
                  <input type="radio" name="mode" className="mt-0.5 accent-brand" checked={curMode === v} onChange={() => setMode(v)} />
                  <span><span className="block text-[14px] font-medium">{t}</span><span className="block text-[12.5px] text-muted">{d}</span></span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-muted">Branches use each question's Show if rules. Put {"{{question_id}}"} in a question or the thank you message to repeat an earlier answer.</p>
          </fieldset>
          <Field label="Hidden fields" hint={`Names read from the link and saved with each answer, for example ${form.url}?ref=newsletter`}>{(fp) => <Input {...fp} value={curHidden} onChange={(e) => setHidden(e.target.value)} placeholder="ref, plan" data-testid="plus-hidden" />}</Field>
          <section className="space-y-2">
            <h3 className="text-[13px] font-medium">Chat bubble for your website</h3>
            <Field label="Button text">{(fp) => <Input {...fp} value={curLabel} maxLength={40} onChange={(e) => setLabel(e.target.value)} />}</Field>
            <div className="flex items-start gap-2 rounded-lg bg-fill p-2.5">
              <code className="min-w-0 flex-1 break-all text-[12px]" data-testid="embed-snippet">{snippet}</code>
              <CopyButton value={snippet} label="Copy code" />
            </div>
            <p className="text-[12px] text-muted">Paste it before the closing body tag. It opens this form in chat style in the corner of your page.</p>
          </section>
          <section className="space-y-2">
            <div className="flex items-center gap-2"><h3 className="text-[13px] font-medium">Webhook</h3>{s.webhook.paused && <Badge tone="warn">Paused</Badge>}</div>
            <Field label="Address" hint="We send each answer here as JSON, signed with your secret (x-multies-signature). One try, 5 second limit.">{(fp) => <Input {...fp} type="url" value={curUrl} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/forms" data-testid="plus-webhook" />}</Field>
            {secret && (
              <div className="rounded-lg border border-warn/40 bg-warn/10 p-2.5 text-[12.5px]" role="status">
                <p className="font-medium">Your signing secret. Copy it now, it won't be shown again.</p>
                <div className="mt-1.5 flex items-center gap-2"><code className="min-w-0 flex-1 break-all" data-testid="plus-secret">{secret}</code><CopyButton value={secret} label="Copy" /></div>
              </div>
            )}
            {s.webhook.paused && <div className="flex items-center gap-2 rounded-lg bg-warn/10 p-2.5 text-[12.5px]"><span className="flex-1">Paused after {s.webhook.failures} failed tries in a row. Check the address, then resume.</span><Button size="sm" variant="outline" loading={busy === "resume"} onClick={() => void act("resume")}>Resume</Button></div>}
            {s.webhook.url && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" loading={busy === "test"} onClick={() => void act("test")} data-testid="plus-test">Send a test</Button>
                <Button size="sm" variant="ghost" loading={busy === "secret"} onClick={() => void act("secret")}>New secret</Button>
              </div>
            )}
            {!!log.data?.deliveries.length && (
              <ul className="divide-y divide-line rounded-lg border border-line text-[12.5px]" aria-label="Last deliveries" data-testid="plus-log">
                {log.data.deliveries.slice(0, 8).map((d) => (
                  <li key={d.id} className="flex items-center gap-2 px-3 py-2">
                    <Badge tone={d.ok ? "ok" : "bad"}>{d.ok ? "Sent" : "Failed"}</Badge>
                    <span className="min-w-0 flex-1 truncate text-muted">{d.test ? "Test" : "Answer"}{d.error ? `: ${d.error}` : d.status ? `: ${d.status}` : ""}</span>
                    <span className="shrink-0 text-subtle">{timeAgo(d.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
