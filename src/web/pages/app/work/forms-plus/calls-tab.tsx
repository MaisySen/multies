/**
 * R93: calls for submissions (forms whose answers are kept for review) and the reviewer's own queue.
 * Admins set the rubric, assign reviewers, shortlist or decline. Reviewers score only what is assigned to them;
 * with blind review the server has already removed names, emails and phones.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { IconClipboardList, IconPlus, IconTrash, IconUserCheck } from "@/web/components/ui/icon";
import { useAssignees, isAgentLike } from "../data";
import type { RubricCriterion, ReviewSetup } from "@/shared/forms-plus";

interface Review { id: string; reviewerId: string; reviewer: string; status: "pending" | "done"; total: number | null; comment: string }
interface Entry { id: string; title: string; answers: Record<string, string>; state: "new" | "shortlisted" | "declined"; createdAt: string; average: number | null; reviews: Review[] }
interface EntriesData { form: { id: string; name: string; fields: { id: string; label: string }[] }; setup: ReviewSetup; entries: Entry[]; counts: Record<string, number> }
const STATE_LABEL = { new: "New", shortlisted: "Shortlisted", declined: "Declined" } as const;

export const DEFAULT_CALL_FIELDS = [
  { id: "full_name", label: "Your name", type: "text", required: true }, { id: "email", label: "Email", type: "email", required: true },
  { id: "title", label: "Title of your entry", type: "text", required: true }, { id: "summary", label: "Summary", type: "textarea", required: true },
];
export const DEFAULT_RUBRIC = [{ label: "Relevance", max: 5, weight: 2 }, { label: "Quality", max: 5, weight: 1 }];

function ScoreRow({ c, value, onChange }: { c: RubricCriterion; value: number | undefined; onChange: (n: number) => void }) {
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-medium">{c.label}{c.weight > 1 && <span className="font-normal text-muted"> (counts {c.weight} times)</span>}</legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={c.label}>
        {Array.from({ length: c.max }, (_, i) => i + 1).map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)}
            className={`h-10 w-10 rounded-lg border text-[14px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand max-sm:h-11 max-sm:w-11 ${value === n ? "border-brand bg-brand text-brand-fg" : "border-line hover:bg-hover"}`}>{n}</button>
        ))}
      </div>
    </fieldset>
  );
}

function SetupEditor({ formId, setup, onSaved }: { formId: string; setup: ReviewSetup; onSaved: () => void }) {
  const [s, setS] = useState<ReviewSetup>(setup);
  const [busy, setBusy] = useState(false);
  const setC = (i: number, p: Partial<RubricCriterion>) => setS({ ...s, rubric: s.rubric.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const save = async () => {
    setBusy(true);
    try { await api.put(`/forms-plus/forms/${formId}/settings`, { plus: { review: { ...s, rubric: s.rubric.filter((c) => c.label.trim()) } } }); toast.success("Saved"); onSaved(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <h3 className="text-[13px] font-semibold">Scoring</h3>
      <ul className="space-y-2">
        {s.rubric.map((c, i) => (
          <li key={i} className="grid grid-cols-[1fr_88px_88px_auto] items-end gap-2">
            <Field label={i ? "" : "Criterion"}>{(fp) => <Input {...fp} aria-label={`Criterion ${i + 1}`} value={c.label} onChange={(e) => setC(i, { label: e.target.value })} />}</Field>
            <Field label={i ? "" : "Top score"}>{(fp) => <Input {...fp} aria-label={`Top score for criterion ${i + 1}`} type="number" min={2} max={10} value={c.max} onChange={(e) => setC(i, { max: Number(e.target.value) })} />}</Field>
            <Field label={i ? "" : "Weight"}>{(fp) => <Input {...fp} aria-label={`Weight for criterion ${i + 1}`} type="number" min={1} max={5} value={c.weight} onChange={(e) => setC(i, { weight: Number(e.target.value) })} />}</Field>
            <Button variant="ghost" size="icon" aria-label={`Remove criterion ${i + 1}`} onClick={() => setS({ ...s, rubric: s.rubric.filter((_, j) => j !== i) })}><IconTrash className="h-4 w-4" /></Button>
          </li>
        ))}
      </ul>
      {s.rubric.length < 10 && <Button size="sm" variant="ghost" onClick={() => setS({ ...s, rubric: [...s.rubric, { id: "", label: "", max: 5, weight: 1 }] })}><IconPlus className="h-3.5 w-3.5" />Add criterion</Button>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reviewers per entry">{(fp) => <Input {...fp} type="number" min={1} max={5} value={s.perEntry} onChange={(e) => setS({ ...s, perEntry: Number(e.target.value) })} />}</Field>
        <Field label="Reviews close on" hint="Optional.">{(fp) => <Input {...fp} type="date" value={s.deadline ?? ""} onChange={(e) => setS({ ...s, deadline: e.target.value || null })} />}</Field>
      </div>
      <div className="flex items-center justify-between gap-3 rounded-lg bg-fill px-3 py-2.5">
        <div><div className="text-[13px] font-medium">Blind review</div><div className="text-[12px] text-muted">Reviewers don't see names, emails, phones or questions you mark to hide.</div></div>
        <Switch checked={s.blind} onChange={(v) => setS({ ...s, blind: v })} label="Blind review" />
      </div>
      <div className="flex justify-end"><Button size="sm" onClick={() => void save()} loading={busy} data-testid="rubric-save">Save scoring</Button></div>
    </div>
  );
}

export function CallDialog({ form, onClose }: { form: { id: string; name: string }; onClose: () => void }) {
  const qc = useQueryClient();
  const [state, setState] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const people = useAssignees();
  const humans = (people.data ?? []).filter((p) => !isAgentLike(p));
  const key = ["fp-entries", form.id, state];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<EntriesData>(`/forms-plus/forms/${form.id}/entries${state ? `?state=${state}` : ""}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["fp-entries", form.id] });
  const run = async (fn: () => Promise<unknown>, done?: string) => { try { await fn(); if (done) toast.success(done); refresh(); } catch (e) { showError(e as Error); } };
  const d = q.data;
  return (
    <Dialog open onClose={onClose} title={`${form.name}: entries`} className="max-w-3xl" footer={<><a href={`/api/forms-plus/forms/${form.id}/entries.csv`} className="mr-auto inline-flex h-9 items-center rounded-lg px-3 text-[13px] text-muted hover:bg-hover hover:text-fg">Download CSV</a><Button variant="ghost" onClick={onClose}>Close</Button></>}>
      {q.isPending ? <Skeleton className="h-64" /> : q.isError ? <Card className="p-6 text-center text-[13px]">Couldn't load the entries. <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>Try again</Button></Card> : (
        <div className="space-y-4">
          <SetupEditor formId={form.id} setup={d!.setup} onSaved={refresh} />
          <div className="space-y-2 rounded-lg border border-line p-3">
            <h3 className="text-[13px] font-semibold">Reviewers</h3>
            <div className="flex flex-wrap gap-2">
              {humans.map((p) => {
                const id = p.id.replace(/^member:/, "");
                const on = picked.includes(id);
                return <label key={p.id} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-2.5 text-[13px] max-sm:min-h-11 ${on ? "border-brand bg-brand/10" : "border-line"}`}><input type="checkbox" className="accent-brand" checked={on} onChange={(e) => setPicked(e.target.checked ? [...picked, id] : picked.filter((x) => x !== id))} />{p.name}</label>;
              })}
            </div>
            <Button size="sm" disabled={!picked.length || !d!.setup.rubric.length} onClick={() => void run(async () => { const r = await api.post<{ assigned: number }>(`/forms-plus/forms/${form.id}/assign`, { reviewerIds: picked }); toast.success(r.assigned ? `${r.assigned} reviews assigned` : "Every entry already has its reviewers"); })} data-testid="assign"><IconUserCheck className="h-4 w-4" />Assign entries</Button>
            {!d!.setup.rubric.length && <p className="text-[12px] text-muted">Add a scoring criterion first.</p>}
          </div>
          <div role="tablist" aria-label="Entries" className="flex flex-wrap gap-1">
            {(["", "new", "shortlisted", "declined"] as const).map((s) => <button key={s} role="tab" type="button" aria-selected={state === s} onClick={() => setState(s)} className={`h-8 rounded-lg px-3 text-[13px] max-sm:min-h-11 ${state === s ? "bg-fill font-medium text-fg" : "text-muted hover:text-fg"}`}>{s ? `${STATE_LABEL[s]} ${d!.counts[s] ?? 0}` : "All"}</button>)}
          </div>
          {!d!.entries.length ? <EmptyState icon={<IconClipboardList />} title={state ? "Nothing here" : "No entries yet"} body={state ? "Pick another filter." : "Share the form link. Entries show up here for review."} /> : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {d!.entries.map((e) => (
                <li key={e.id} className="p-3" data-testid="entry">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="min-w-0 flex-1 text-left" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <div className="break-words text-[14px] font-medium">{e.title}</div>
                      <div className="text-[12px] text-muted">{e.average === null ? "No score yet" : `Score ${e.average}`} · {e.reviews.filter((r) => r.status === "done").length} of {e.reviews.length} reviews</div>
                    </button>
                    <Badge tone={e.state === "shortlisted" ? "ok" : e.state === "declined" ? "bad" : "neutral"}>{STATE_LABEL[e.state]}</Badge>
                    <Button size="sm" variant={e.state === "shortlisted" ? "outline" : "primary"} onClick={() => void run(() => api.post(`/forms-plus/forms/${form.id}/entries/${e.id}/state`, { state: e.state === "shortlisted" ? "new" : "shortlisted" }))} data-testid="shortlist">{e.state === "shortlisted" ? "Undo shortlist" : "Shortlist"}</Button>
                    {e.state !== "declined" && <Button size="sm" variant="ghost" onClick={() => void run(() => api.post(`/forms-plus/forms/${form.id}/entries/${e.id}/state`, { state: "declined" }))}>Decline</Button>}
                  </div>
                  {open === e.id && (
                    <div className="mt-2 space-y-2 rounded-lg bg-fill p-3 text-[13px]">
                      {d!.form.fields.filter((f) => e.answers[f.id]).map((f) => <div key={f.id}><div className="text-[12px] text-muted">{f.label}</div><div className="whitespace-pre-wrap break-words">{e.answers[f.id]}</div></div>)}
                      {e.reviews.map((r) => <div key={r.id} className="border-t border-line pt-2"><span className="font-medium">{r.reviewer}</span>: {r.status === "done" ? `${r.total} out of 100` : "not scored yet"}{r.comment && <p className="text-muted">{r.comment}</p>}</div>)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

interface MyReview { id: string; call: string; entry: { title: string; fields: { id: string; label: string }[]; answers: Record<string, string> }; blind: boolean; rubric: RubricCriterion[]; deadline: string | null; status: "pending" | "done"; scores: Record<string, number>; comment: string; total: number | null }

function ScoreDialog({ r, onClose }: { r: MyReview; onClose: () => void }) {
  const qc = useQueryClient();
  const [scores, setScores] = useState<Record<string, number>>(r.scores);
  const [comment, setComment] = useState(r.comment);
  const [busy, setBusy] = useState(false);
  const ready = r.rubric.every((c) => scores[c.id]);
  const save = async () => {
    setBusy(true);
    try { await api.put(`/forms-plus/reviews/${r.id}`, { scores, comment }); toast.success("Review saved"); await qc.invalidateQueries({ queryKey: ["fp-reviews"] }); onClose(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={r.entry.title} description={r.blind ? "Blind review: the person's name and contact details are hidden." : undefined} className="max-w-2xl"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy} disabled={!ready} data-testid="review-save">Save review</Button></>}>
      <div className="space-y-4">
        <div className="space-y-2 rounded-lg bg-fill p-3 text-[13.5px]">
          {r.entry.fields.map((f) => <div key={f.id}><div className="text-[12px] text-muted">{f.label}</div><div className="whitespace-pre-wrap break-words">{r.entry.answers[f.id]}</div></div>)}
        </div>
        {r.rubric.map((c) => <ScoreRow key={c.id} c={c} value={scores[c.id]} onChange={(n) => setScores({ ...scores, [c.id]: n })} />)}
        <Field label="Comment" hint="Optional. Admins see it with your scores.">{(fp) => <Textarea {...fp} value={comment} onChange={(e) => setComment(e.target.value)} className="min-h-20" />}</Field>
      </div>
    </Dialog>
  );
}

export function ReviewQueueTab() {
  const q = useQuery({ queryKey: ["fp-reviews"], queryFn: () => api.get<{ reviews: MyReview[] }>("/forms-plus/reviews") });
  const [open, setOpen] = useState<MyReview | null>(null);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError) return <Card className="p-6 text-center text-[13px]">Couldn't load your reviews. <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>Try again</Button></Card>;
  const list = q.data!.reviews;
  if (!list.length) return <Card><EmptyState icon={<IconUserCheck />} title="Nothing to review" body="When an admin assigns you entries from a call for submissions, they show up here." /></Card>;
  return (
    <>
      <Card className="divide-y divide-line">
        {list.map((r) => (
          <button key={r.id} type="button" onClick={() => setOpen(r)} className="flex w-full items-center gap-3 p-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand" data-testid="review-row">
            <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{r.entry.title}</div><div className="text-[12.5px] text-muted">{r.call}{r.deadline ? ` · closes ${r.deadline}` : ""}</div></div>
            <Badge tone={r.status === "done" ? "ok" : "warn"}>{r.status === "done" ? `Scored ${r.total}` : "To score"}</Badge>
          </button>
        ))}
      </Card>
      {open && <ScoreDialog r={open} onClose={() => setOpen(null)} />}
    </>
  );
}
