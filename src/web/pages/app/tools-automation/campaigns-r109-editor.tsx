/**
 * R109: the newsletter editor (blocks, live preview, test send, send or schedule, results) and the journey
 * editor (steps with waits, "only if not opened", send hour). Shared block editor for both.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { useMailboxes } from "@/web/lib/queries";
import { Button } from "@/web/components/ui/button";
import { ConfirmButton } from "@/web/components/ui/confirm";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, Skeleton, StatTile, Switch } from "@/web/components/ui/misc";
import { CAMPAIGN_STATUS_LABEL, rate, type Block, type CampaignStatus, type JourneyStep } from "@/shared/campaigns-r109";
import { AutoPage } from "./shell";
import { B, DailyLimit, ErrorBox, useInfo, useLists, type ListSummary } from "./campaigns-r109";

const FIELDS_HINT = "Use {{first_name}}, {{name}}, {{email}} or any column you imported. Add a fallback with a bar: {{first_name | there}}.";
const NEW_BLOCK: Record<Block["type"], Block> = {
  heading: { type: "heading", text: "" }, text: { type: "text", text: "" }, button: { type: "button", label: "Read more", url: "https://" },
  image: { type: "image", url: "https://", alt: "" }, divider: { type: "divider" },
};
const BLOCK_LABEL: Record<Block["type"], string> = { heading: "Heading", text: "Text", button: "Button", image: "Picture", divider: "Line" };

export function BlockEditor({ blocks, onChange, disabled }: { blocks: Block[]; onChange: (b: Block[]) => void; disabled?: boolean }) {
  const set = (i: number, b: Block) => onChange(blocks.map((x, j) => (j === i ? b : x)));
  const move = (i: number, d: number) => { const n = [...blocks]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); onChange(n); };
  return (
    <div className="space-y-2" data-testid="r109-blocks">
      {blocks.map((b, i) => (
        <div key={i} className="space-y-2 rounded-lg border border-line bg-surface p-3">
          <div className="flex items-center gap-1">
            <span className="mr-auto text-[12px] font-medium uppercase tracking-wide text-muted">{BLOCK_LABEL[b.type]}</span>
            <Button size="sm" variant="ghost" disabled={disabled || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${BLOCK_LABEL[b.type].toLowerCase()} up`}>Up</Button>
            <Button size="sm" variant="ghost" disabled={disabled || i === blocks.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${BLOCK_LABEL[b.type].toLowerCase()} down`}>Down</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(blocks.filter((_, j) => j !== i))} aria-label={`Delete ${BLOCK_LABEL[b.type].toLowerCase()}`}>Delete</Button>
          </div>
          {b.type === "heading" && <Input aria-label="Heading text" value={b.text} disabled={disabled} maxLength={200} onChange={(e) => set(i, { ...b, text: e.target.value })} />}
          {b.type === "text" && <Textarea aria-label="Text" rows={5} value={b.text} disabled={disabled} maxLength={10000} onChange={(e) => set(i, { ...b, text: e.target.value })} />}
          {b.type === "button" && (
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
              <Input aria-label="Button label" value={b.label} disabled={disabled} maxLength={60} onChange={(e) => set(i, { ...b, label: e.target.value })} />
              <Input aria-label="Button link" value={b.url} disabled={disabled} inputMode="url" onChange={(e) => set(i, { ...b, url: e.target.value })} />
            </div>
          )}
          {b.type === "image" && (
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
              <Input aria-label="Picture link" value={b.url} disabled={disabled} inputMode="url" onChange={(e) => set(i, { ...b, url: e.target.value })} />
              <Input aria-label="Picture description" placeholder="Describe it" value={b.alt} disabled={disabled} maxLength={200} onChange={(e) => set(i, { ...b, alt: e.target.value })} />
            </div>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="flex flex-wrap gap-1" role="group" aria-label="Add a block">
          {(Object.keys(NEW_BLOCK) as Block["type"][]).map((t) => <Button key={t} size="sm" variant="outline" onClick={() => onChange([...blocks, NEW_BLOCK[t]])}>Add {BLOCK_LABEL[t].toLowerCase()}</Button>)}
        </div>
      )}
    </div>
  );
}

interface Newsletter {
  id: string; name: string; subject: string; preheader: string; blocks: Block[]; track: boolean; status: CampaignStatus; listId: string; mailboxId: string | null;
  scheduledAt: string | null; sentAt: string | null; error: string | null; canSend: boolean; list: ListSummary;
  stats: { total: number; sent: number; failed: number; skipped: number; opened: number; clicked: number; unsubscribed: number; bounced: number };
}

function useSaveKey(onSave: () => void, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const h = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); onSave(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onSave, on]);
}

export function NewsletterPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ["r109-newsletter", id], queryFn: () => api.get<Newsletter>(`${B}/newsletters/${id}`), refetchInterval: (x) => (x.state.data?.status === "sending" ? 5000 : false) });
  const info = useInfo();
  const lists = useLists();
  const mailboxes = useMailboxes();
  const [d, setD] = useState<Newsletter | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [at, setAt] = useState("");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (q.data) setD(q.data); }, [q.data]);
  const n = q.data;
  const draft = n?.status === "draft";
  const dirty = !!d && !!n && JSON.stringify([d.name, d.subject, d.preheader, d.blocks, d.track, d.listId, d.mailboxId]) !== JSON.stringify([n.name, n.subject, n.preheader, n.blocks, n.track, n.listId, n.mailboxId]);
  const preview = useQuery({ queryKey: ["r109-preview", id, n?.subject, JSON.stringify(n?.blocks), n?.preheader, n?.listId], queryFn: () => api.get<{ html: string; person: { email: string }; eligible: number }>(`${B}/newsletters/${id}/preview`), enabled: !!n });
  const set = (r: Newsletter) => { qc.setQueryData(["r109-newsletter", id], r); qc.invalidateQueries({ queryKey: ["r109-newsletters"] }); };
  const save = useMutation({ mutationFn: () => api.patch<Newsletter>(`${B}/newsletters/${id}`, { name: d!.name, subject: d!.subject, preheader: d!.preheader, blocks: d!.blocks, track: d!.track, listId: d!.listId, mailboxId: d!.mailboxId }), onSuccess: (r) => { set(r); setNote("Saved."); }, onError: (e) => showError(e) });
  const act = useMutation({
    mutationFn: async (a: { path: string; body?: unknown }) => { if (dirty) set(await api.patch<Newsletter>(`${B}/newsletters/${id}`, { name: d!.name, subject: d!.subject, preheader: d!.preheader, blocks: d!.blocks, track: d!.track, listId: d!.listId, mailboxId: d!.mailboxId })); return api.post<Newsletter>(`${B}/newsletters/${id}/${a.path}`, a.body ?? {}); },
    onSuccess: (r, a) => { if (a.path === "test") setNote(`Test sent to ${(r as unknown as { to: string }).to}.`); else if (a.path === "duplicate") nav(`/app/tools/merge/newsletters/${r.id}`); else { set(r); setNote(null); qc.invalidateQueries({ queryKey: ["r109-info"] }); } },
    onError: (e) => showError(e),
  });
  const del = useMutation({ mutationFn: () => api.del(`${B}/newsletters/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["r109-newsletters"] }); nav("/app/tools/merge"); }, onError: (e) => showError(e) });
  useSaveKey(() => { if (dirty && draft) save.mutate(); }, !!draft);
  return (
    <AutoPage entryKey="merge_mail" title={n?.name ?? "Newsletter"} description={n ? `To ${n.list.name}` : ""} usage={false}
      actions={<Link to="/app/tools/merge" className="text-sm text-muted hover:text-fg">Back to newsletters</Link>}>
      {q.isPending || !d ? (q.isError ? <ErrorBox onRetry={() => q.refetch()} /> : <Skeleton className="h-96 w-full" />) : (
        <div className="space-y-4 pb-20 lg:pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={n!.status === "sent" ? "ok" : n!.status === "draft" ? "neutral" : n!.status === "cancelled" ? "bad" : "brand"}>{CAMPAIGN_STATUS_LABEL[n!.status]}</Badge>
            {n!.scheduledAt && n!.status === "scheduled" && <span className="text-sm text-muted">Goes out {new Date(n!.scheduledAt).toLocaleString()}</span>}
            {note && <span role="status" className="text-sm text-muted">{note}</span>}
            <span className="ml-auto" />
            <Button size="sm" variant="ghost" onClick={() => act.mutate({ path: "duplicate" })}>Make a copy</Button>
            {n!.status !== "sending" && <ConfirmButton onConfirm={() => del.mutate()} armedLabel="Delete it?">Delete</ConfirmButton>}
          </div>
          {n!.error && <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">{n!.error}</p>}
          {!draft && <Results n={n!} onAction={(p) => act.mutate({ path: p })} busy={act.isPending} />}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className={`min-w-0 space-y-4 ${showPreview ? "hidden lg:block" : ""}`}>
              <Card className="space-y-3 p-4">
                <Field label="Name" hint="Only you and your team see this.">{(p) => <Input {...p} value={d.name} disabled={!draft} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="List">{(p) => (
                    <Select {...p} value={d.listId} disabled={!draft} onChange={(e) => setD({ ...d, listId: e.target.value })}>
                      {(lists.data?.lists ?? [n!.list]).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </Select>
                  )}</Field>
                  <Field label="Sends from">{(p) => (
                    <Select {...p} value={d.mailboxId ?? ""} disabled={!draft} onChange={(e) => setD({ ...d, mailboxId: e.target.value || null })}>
                      <option value="">Pick a mailbox</option>{(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
                    </Select>
                  )}</Field>
                </div>
                <Field label="Subject" hint={FIELDS_HINT}>{(p) => <Input {...p} value={d.subject} disabled={!draft} maxLength={200} placeholder="News for {{first_name | you}}" onChange={(e) => setD({ ...d, subject: e.target.value })} data-testid="r109-subject" />}</Field>
                <Field label="Preview line" hint="The short line many inboxes show after the subject.">{(p) => <Input {...p} value={d.preheader} disabled={!draft} maxLength={200} onChange={(e) => setD({ ...d, preheader: e.target.value })} />}</Field>
              </Card>
              <BlockEditor blocks={d.blocks} disabled={!draft} onChange={(blocks) => setD({ ...d, blocks })} />
              <Card className="space-y-2 p-4">
                <Switch checked={d.track} disabled={!draft} onChange={(v) => setD({ ...d, track: v })} label="Count opens and clicks" />
                <p className="text-[12px] text-muted">Only the first open and first click per person, with no location or device kept. Turn it off for none at all.</p>
              </Card>
            </div>
            <div className={`min-w-0 space-y-3 ${showPreview ? "" : "hidden lg:block"}`}>
              <Card className="overflow-hidden p-0">
                <p className="border-b border-line px-4 py-2 text-[12.5px] text-muted">{preview.data ? `Preview for ${preview.data.person.email}${dirty ? ", save to update" : ""}` : "Preview"}</p>
                {preview.data ? <iframe title="Email preview" sandbox="" srcDoc={preview.data.html} className="h-[560px] w-full bg-white" data-testid="r109-preview" /> : <Skeleton className="h-[560px] w-full" />}
              </Card>
            </div>
          </div>
          {draft && (
            <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 p-3 backdrop-blur lg:static lg:rounded-lg lg:border lg:p-4">
              <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" className="lg:hidden" onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>{showPreview ? "Edit" : "Preview"}</Button>
                <Button size="sm" variant="secondary" onClick={() => save.mutate()} disabled={!dirty || save.isPending} title="Ctrl Enter">Save</Button>
                <Button size="sm" variant="secondary" onClick={() => act.mutate({ path: "test" })} disabled={act.isPending}>Send me a test</Button>
                <span className="hidden min-w-0 flex-1 text-[12.5px] text-muted sm:inline">{preview.data ? `${preview.data.eligible} ${preview.data.eligible === 1 ? "person" : "people"} can get it` : ""}</span>
                <label className="sr-only" htmlFor="r109-at">Send at</label>
                <Input id="r109-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="w-auto" />
                <Button size="sm" variant="secondary" disabled={!at || !n!.canSend || act.isPending} onClick={() => act.mutate({ path: "schedule", body: { at: new Date(at).toISOString() } })}>Schedule</Button>
                <ConfirmButton variant="primary" disabled={!n!.canSend || act.isPending} onConfirm={() => act.mutate({ path: "schedule", body: { at: null } })} armedLabel={`Send to ${preview.data?.eligible ?? 0} now?`} data-testid="r109-send">Send now</ConfirmButton>
              </div>
              {!n!.canSend && <p className="mx-auto mt-1 max-w-5xl text-[12px] text-muted">Only admins can send to a list shared with the whole workspace. You can write it and send yourself a test.</p>}
              <div className="mx-auto mt-2 hidden max-w-5xl lg:block"><DailyLimit info={info.data} /></div>
            </div>
          )}
        </div>
      )}
    </AutoPage>
  );
}

function Results({ n, onAction, busy }: { n: Newsletter; onAction: (p: string) => void; busy: boolean }) {
  const s = n.stats;
  return (
    <Card className="space-y-3 p-4" data-testid="r109-results">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Sent" value={`${s.sent} of ${s.total}`} />
        <StatTile label="Opened" value={n.track ? rate(s.opened, s.sent) : "Not counted"} hint={n.track ? `${s.opened} people` : undefined} />
        <StatTile label="Clicked" value={n.track ? rate(s.clicked, s.sent) : "Not counted"} hint={n.track ? `${s.clicked} people` : undefined} />
        <StatTile label="Unsubscribed" value={String(s.unsubscribed)} tone={s.unsubscribed ? "warn" : "neutral"} />
      </div>
      <p className="text-[12.5px] text-muted">{s.failed} failed · {s.bounced} bounced · {s.skipped} skipped (unsubscribed or no consent){n.sentAt ? ` · started ${new Date(n.sentAt).toLocaleString()}` : ""}</p>
      <div className="flex flex-wrap gap-2">
        {n.status === "scheduled" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction("unschedule")}>Back to draft</Button>}
        {n.status === "sending" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction("pause")}>Pause</Button>}
        {n.status === "paused" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onAction("resume")}>Resume</Button>}
        {["sending", "paused", "scheduled"].includes(n.status) && <ConfirmButton disabled={busy} onConfirm={() => onAction("stop")} armedLabel="Stop for good?">Stop sending</ConfirmButton>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ journeys

interface Journey { id: string; name: string; status: "draft" | "active" | "paused"; listId: string; listName: string; mailboxId: string | null; steps: JourneyStep[]; sendHour: number; enrolled: number; active: number; tz: string; canSend: boolean; stepStats: { name: string; sent: number; opened: number; clicked: number; unsubscribed: number }[] }

export function JourneyPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient(); const nav = useNavigate();
  const q = useQuery({ queryKey: ["r109-journey", id], queryFn: () => api.get<Journey>(`${B}/journeys/${id}`) });
  const mailboxes = useMailboxes();
  const [d, setD] = useState<Journey | null>(null);
  useEffect(() => { if (q.data) setD(q.data); }, [q.data]);
  const j = q.data;
  const editable = j?.status !== "active";
  const dirty = !!d && !!j && JSON.stringify([d.name, d.steps, d.sendHour, d.mailboxId]) !== JSON.stringify([j.name, j.steps, j.sendHour, j.mailboxId]);
  const set = (r: Journey) => { qc.setQueryData(["r109-journey", id], r); qc.invalidateQueries({ queryKey: ["r109-journeys"] }); };
  const save = useMutation({ mutationFn: () => api.patch<Journey>(`${B}/journeys/${id}`, { name: d!.name, steps: d!.steps, sendHour: d!.sendHour, mailboxId: d!.mailboxId }), onSuccess: set, onError: (e) => showError(e) });
  const status = useMutation({ mutationFn: async (s: "start" | "pause") => { if (dirty && s === "start") set(await api.patch<Journey>(`${B}/journeys/${id}`, { name: d!.name, steps: d!.steps, sendHour: d!.sendHour, mailboxId: d!.mailboxId })); return api.post<Journey>(`${B}/journeys/${id}/${s}`); }, onSuccess: set, onError: (e) => showError(e) });
  const del = useMutation({ mutationFn: () => api.del(`${B}/journeys/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ["r109-journeys"] }); nav("/app/tools/merge?tab=journeys"); }, onError: (e) => showError(e) });
  useSaveKey(() => { if (dirty && editable) save.mutate(); }, !!editable);
  const setStep = (i: number, s: JourneyStep) => d && setD({ ...d, steps: d.steps.map((x, k) => (k === i ? s : x)) });
  return (
    <AutoPage entryKey="merge_mail" title={j?.name ?? "Journey"} description={j ? `For people who join ${j.listName}` : ""} usage={false}
      actions={<Link to="/app/tools/merge?tab=journeys" className="text-sm text-muted hover:text-fg">Back to journeys</Link>}>
      {q.isPending || !d ? (q.isError ? <ErrorBox onRetry={() => q.refetch()} /> : <Skeleton className="h-96 w-full" />) : (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center gap-3 p-4">
            <Badge tone={j!.status === "active" ? "ok" : j!.status === "paused" ? "warn" : "neutral"}>{j!.status === "active" ? "On" : j!.status === "paused" ? "Paused" : "Draft"}</Badge>
            <p className="min-w-0 flex-1 text-sm text-muted">{j!.enrolled} started · {j!.active} on their way. New people who join the list start it; people already on the list don't.</p>
            {j!.status === "active"
              ? <Button size="sm" variant="secondary" onClick={() => status.mutate("pause")} disabled={status.isPending}>Pause</Button>
              : <Button size="sm" onClick={() => status.mutate("start")} disabled={!j!.canSend || status.isPending} data-testid="r109-journey-start">{j!.status === "paused" ? "Resume" : "Turn on"}</Button>}
            {editable && <ConfirmButton onConfirm={() => del.mutate()} armedLabel="Delete it?">Delete</ConfirmButton>}
          </Card>
          {!j!.canSend && <p className="text-[12.5px] text-muted">Only admins can turn on a journey for a list shared with the whole workspace.</p>}
          {j!.status === "active" && <p className="text-[12.5px] text-muted">Pause the journey to change it. While paused nobody gets the next email; on resume it picks up where each person was.</p>}
          <Card className="grid gap-3 p-4 sm:grid-cols-3">
            <Field label="Name">{(p) => <Input {...p} value={d.name} disabled={!editable} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
            <Field label="Sends from">{(p) => (
              <Select {...p} value={d.mailboxId ?? ""} disabled={!editable} onChange={(e) => setD({ ...d, mailboxId: e.target.value || null })}>
                <option value="">Pick a mailbox</option>{(mailboxes.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
              </Select>
            )}</Field>
            <Field label="Send at" hint={`In ${j!.tz.replace(/_/g, " ")}, for emails after a wait.`}>{(p) => (
              <Select {...p} value={d.sendHour} disabled={!editable} onChange={(e) => setD({ ...d, sendHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</option>)}
              </Select>
            )}</Field>
          </Card>
          <ol className="space-y-3" data-testid="r109-steps">
            {d.steps.map((s, i) => {
              const st = j!.stepStats[i];
              return (
                <li key={i}>
                  <Card className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="mr-auto text-sm font-semibold">Email {i + 1}</h3>
                      {st && <span className="text-[12px] text-muted">{st.sent} sent · {rate(st.opened, st.sent)} opened · {rate(st.clicked, st.sent)} clicked</span>}
                      {editable && <Button size="sm" variant="ghost" onClick={() => setD({ ...d, steps: d.steps.filter((_, k) => k !== i) })} aria-label={`Delete email ${i + 1}`}>Delete</Button>}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                      <Field label={i === 0 ? "Wait after joining" : "Wait after the last email"}>{(p) => (
                        <Select {...p} value={s.delayDays} disabled={!editable} onChange={(e) => setStep(i, { ...s, delayDays: Number(e.target.value) })}>
                          {[0, 1, 2, 3, 5, 7, 10, 14, 21, 30, 60, 90].map((n) => <option key={n} value={n}>{n === 0 ? "No wait" : `${n} ${n === 1 ? "day" : "days"}`}</option>)}
                        </Select>
                      )}</Field>
                      <Field label="Subject" hint={FIELDS_HINT}>{(p) => <Input {...p} value={s.subject} disabled={!editable} maxLength={200} onChange={(e) => setStep(i, { ...s, subject: e.target.value })} />}</Field>
                    </div>
                    {i > 0 && <Switch checked={s.onlyIfNotOpened} disabled={!editable} onChange={(v) => setStep(i, { ...s, onlyIfNotOpened: v })} label="Only if they didn't open the last email" />}
                    <BlockEditor blocks={s.blocks} disabled={!editable} onChange={(blocks) => setStep(i, { ...s, blocks })} />
                  </Card>
                </li>
              );
            })}
          </ol>
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={d.steps.length >= 10} onClick={() => setD({ ...d, steps: [...d.steps, { delayDays: d.steps.length ? 3 : 0, subject: "", blocks: [{ type: "text", text: "Hi {{first_name | there}}," }], onlyIfNotOpened: false }] })}>Add an email</Button>
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending} title="Ctrl Enter">Save</Button>
            </div>
          )}
        </div>
      )}
    </AutoPage>
  );
}
