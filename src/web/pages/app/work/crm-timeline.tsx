/**
 * R94 CRM timeline (CRM_TIMELINE): one paged activity stream per contact or company, a composer to log a note, call
 * or meeting, and the pinned next step. Server: /api/crm (routes/crm-r94.ts).
 */
import { useRef, useState } from "react";
import { Link } from "react-router";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCalendarClock, IconCheck, IconClipboardList, IconDue, IconEdit, IconHandshake, IconLock, IconMail, IconMeetings, IconNotes, IconPhone, IconRefresh, IconTasks, IconTimeline, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { mailDate, shortDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { LoadErrorInline } from "@/web/components/load-error-t1g";

/** Whether CRM_TIMELINE is on here (public config, cached with the rest of the app's config). */
export function useCrmTimelineOn() {
  const config = useQuery({ queryKey: ["config"], queryFn: () => api.get<{ crmTimeline?: boolean }>("/config"), staleTime: 300_000 });
  return { on: !!config.data?.crmTimeline, ready: !config.isPending };
}

export type TimelineKind = "mail" | "note" | "call" | "meeting" | "task" | "deal" | "form" | "booking";
export interface Entry { id: string; kind: "note" | "call" | "meeting"; body: string; outcome: string | null; durationMin: number | null; private: boolean; authorName: string | null; mine: boolean; canEdit: boolean; entityType: string; entityId: string }
export interface TimelineItem {
  kind: TimelineKind; id: string; at: string;
  mail?: { threadId: string; subject: string; count: number; lastDirection: "inbound" | "outbound"; snippet: string; messageId: string };
  entry?: Entry;
  meeting?: { id: string; title: string; startsAt: string; durationMin: number; status: string };
  task?: { id: string; ref: string; title: string; statusName: string; done: boolean; due: string | null };
  deal?: { id: string; title: string; stage: string; value: number; event: "created" | "won" | "lost"; reason: string | null };
  form?: { id: string; formId: string; formName: string; fields: { label: string; value: string }[] };
  booking?: { id: string; startsAt: string; durationMin: number; status: string; note: string };
  person?: { id: string; name: string };
}
interface NextStep { id: string; ref: string; title: string; due: string | null }
interface Page { items: TimelineItem[]; nextCursor: string | null; nextStep?: NextStep | null }

const CHIPS: { id: TimelineKind | "all"; label: string }[] = [
  { id: "all", label: "All" }, { id: "mail", label: "Emails" }, { id: "note", label: "Notes" }, { id: "call", label: "Calls" }, { id: "meeting", label: "Meetings" },
  { id: "task", label: "Tasks" }, { id: "deal", label: "Deals" }, { id: "form", label: "Forms" }, { id: "booking", label: "Bookings" },
];
export const OUTCOMES: { id: string; label: string }[] = [
  { id: "connected", label: "Connected" }, { id: "no_answer", label: "No answer" }, { id: "voicemail", label: "Left a voicemail" }, { id: "busy", label: "Busy" }, { id: "wrong_number", label: "Wrong number" },
];
const outcomeLabel = (o: string | null) => OUTCOMES.find((x) => x.id === o)?.label ?? null;
const aud = (n: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

export function CrmTimeline({ type, id }: { type: "contact" | "company"; id: string }) {
  const [kind, setKind] = useState<TimelineKind | "all">("all");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const key = ["crm-timeline", type, id, kind] as const;
  const q = useInfiniteQuery({
    queryKey: key,
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<Page>(`/crm/timeline?type=${type}&id=${encodeURIComponent(id)}${kind === "all" ? "" : `&kinds=${kind}`}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const nextStep = q.data?.pages[0]?.nextStep ?? null;
  return (
    <section aria-label="Timeline" data-testid="crm-timeline">
      <NextStepCard type={type} id={id} step={nextStep} loading={q.isPending} />
      <Composer type={type} id={id} textareaRef={composerRef} />
      <div className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Show">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={kind === c.id} onClick={() => setKind(c.id)}
            className={cn("h-8 shrink-0 rounded-full border px-3 text-[12.5px] transition-colors duration-150", kind === c.id ? "border-brand/40 bg-brand/10 font-medium text-fg" : "border-line text-muted hover:bg-hover hover:text-fg")}>{c.label}</button>
        ))}
      </div>
      {q.isPending ? (
        <div className="space-y-3" aria-label="Loading timeline">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : q.error ? (
        <Card className="p-4"><LoadErrorInline onRetry={() => q.refetch()} /></Card>
      ) : !items.length ? (
        <EmptyState icon={<IconTimeline />} title={kind === "all" ? "Nothing here yet" : "Nothing of this kind yet"} body={kind === "all" ? "Emails, meetings, tasks, deals, forms and bookings show up here on their own. Log a call or a note to start the story." : "Try All to see everything."}
          action={<Button variant="secondary" onClick={() => composerRef.current?.focus()}>Log a note</Button>} className="py-10" />
      ) : (
        <>
          <ol className="relative space-y-3 border-l border-line pl-5" data-testid="crm-timeline-list">
            {items.map((i) => <TimelineRow key={i.id} item={i} type={type} id={id} />)}
          </ol>
          {q.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} data-testid="timeline-older">Show older</Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function refresh(qc: ReturnType<typeof useQueryClient>, type: string, id: string) {
  return qc.invalidateQueries({ queryKey: ["crm-timeline", type, id] });
}

function Composer({ type, id, textareaRef }: { type: "contact" | "company"; id: string; textareaRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"note" | "call" | "meeting">("note");
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState("connected");
  const [minutes, setMinutes] = useState("");
  const [isPrivate, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const canSave = kind === "call" || !!body.trim();
  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    try {
      await api.post("/crm/entries", { entityType: type, entityId: id, kind, body, private: isPrivate, ...(kind === "call" ? { outcome } : {}), ...(kind !== "note" && minutes ? { durationMin: Number(minutes) } : {}) });
      setBody(""); setMinutes(""); setPrivate(false);
      toast(kind === "call" ? "Call logged" : kind === "meeting" ? "Meeting logged" : "Note added");
      await refresh(qc, type, id);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const label = kind === "call" ? "Log call" : kind === "meeting" ? "Log meeting" : "Add note";
  return (
    <Card className="mb-4 p-3" data-testid="crm-composer">
      <div className="mb-2 flex gap-1" role="tablist" aria-label="What to log">
        {([["note", "Note", IconNotes], ["call", "Call", IconPhone], ["meeting", "Meeting", IconMeetings]] as const).map(([k, l, I]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
            className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors duration-150", kind === k ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}><I className="h-4 w-4" aria-hidden />{l}</button>
        ))}
      </div>
      <label htmlFor={`crm-body-${type}`} className="sr-only">{kind === "call" ? "Call summary" : kind === "meeting" ? "Meeting summary" : "Note"}</label>
      <Textarea id={`crm-body-${type}`} ref={textareaRef} value={body} onChange={(e) => setBody(e.target.value)} rows={2} className="min-h-16 text-[13.5px]"
        placeholder={kind === "call" ? "What did you talk about? (optional)" : kind === "meeting" ? "What was agreed?" : "Write a note. Only your team sees it."}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void save(); } }} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {kind === "call" && (
          <label className="flex items-center gap-2 text-[12.5px] text-muted">Outcome
            <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="h-9 w-auto text-[13px]" aria-label="Call outcome">{OUTCOMES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
          </label>
        )}
        {kind !== "note" && (
          <label className="flex items-center gap-2 text-[12.5px] text-muted">Minutes
            <Input value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))} inputMode="numeric" className="h-9 w-20 text-[13px]" aria-label="Minutes" />
          </label>
        )}
        <label className="flex min-h-11 items-center gap-2 text-[12.5px] text-muted sm:min-h-0">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} className="h-4 w-4 accent-[var(--color-brand)]" />
          <IconLock className="h-3.5 w-3.5" aria-hidden />Only me
        </label>
        <Button size="sm" className="ml-auto" loading={busy} disabled={!canSave} onClick={() => void save()} data-testid="crm-save">{label}</Button>
      </div>
    </Card>
  );
}

function NextStepCard({ type, id, step, loading }: { type: "contact" | "company"; id: string; step: NextStep | null; loading: boolean }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (loading) return <Skeleton className="mb-3 h-12 rounded-lg" />;
  const done = async () => {
    if (!step) return;
    setBusy(true);
    try { await api.patch(`/tasks/${step.id}`, { status: "done" }); toast("Next step done"); await refresh(qc, type, id); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const overdue = step?.due ? new Date(step.due).getTime() < Date.now() - 86_400_000 : false;
  return (
    <>
      {step ? (
        <Card className="mb-3 flex flex-wrap items-center gap-3 p-3" data-testid="next-step">
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg border", overdue ? "border-danger/40 text-danger" : "border-line text-muted")}><IconDue className="h-4 w-4" aria-hidden /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-subtle">Next step{step.due ? <> · {overdue ? "overdue, " : ""}due {dayLabel(step.due)}</> : null}</div>
            <Link to={`/app/tasks?view=list&task=${step.id}`} className="block truncate text-[14px] font-medium hover:underline">{step.title}</Link>
          </div>
          <Button size="sm" variant="secondary" loading={busy} onClick={() => void done()}><IconCheck className="h-4 w-4" />Done</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>New step</Button>
        </Card>
      ) : (
        <button type="button" onClick={() => setOpen(true)} data-testid="set-next-step"
          className="mb-3 flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed border-line-strong px-3 py-2.5 text-left text-[13px] text-muted transition-colors duration-150 hover:bg-hover hover:text-fg">
          <IconCalendarClock className="h-4 w-4" aria-hidden />Set a next step so nothing slips
        </button>
      )}
      {open && <NextStepDialog type={type} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

function NextStepDialog({ type, id, onClose }: { type: "contact" | "company"; id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const inThree = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(inThree);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim() || !due) return;
    setBusy(true);
    try { await api.post("/crm/next-step", { entityType: type, entityId: id, title, due }); toast("Next step set. You get a reminder when it is due."); await refresh(qc, type, id); onClose(); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Next step" description="It becomes a task for you, linked here, with a reminder on the day."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!title.trim() || !due} onClick={() => void submit()}>Set next step</Button></>}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="What happens next">{(f) => <Input {...f} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Send the quote" maxLength={200} />}</Field>
        <Field label="Due">{(f) => <Input {...f} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
      </form>
    </Dialog>
  );
}

function Shell({ icon, head, at, children, to, testId }: { icon: React.ReactNode; head: React.ReactNode; at: string; children?: React.ReactNode; to?: string; testId?: string }) {
  const inner = (
    <>
      <div className="flex items-center gap-2 text-[12px] text-subtle">{icon}<span className="min-w-0 truncate">{head}</span><time className="ml-auto shrink-0" dateTime={at}>{mailDate(at)}</time></div>
      {children}
    </>
  );
  const cls = "block rounded-lg border border-line bg-surface p-3 transition-colors duration-150";
  return to ? <Link to={to} className={cn(cls, "hover:border-line-strong")} data-testid={testId}>{inner}</Link> : <div className={cls} data-testid={testId}>{inner}</div>;
}

function TimelineRow({ item: i, type, id }: { item: TimelineItem; type: "contact" | "company"; id: string }) {
  const who = i.person && type === "company" ? <> · <Link to={`/app/contacts/${i.person.id}`} className="hover:text-fg hover:underline">{i.person.name}</Link></> : null;
  const ico = "h-3.5 w-3.5 shrink-0";
  let body: React.ReactNode;
  if (i.mail) {
    body = (
      <Shell icon={<IconMail className={ico} aria-hidden />} at={i.at} to={`/app/mail?m=${i.mail.messageId}`} head={<>{i.mail.count} {i.mail.count === 1 ? "email" : "emails"} · {i.mail.lastDirection === "inbound" ? "they wrote last" : "you wrote last"}</>}>
        <div className="mt-1 line-clamp-2 text-[14px] font-medium">{i.mail.subject || "(no subject)"}</div>
        <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{i.mail.snippet}</p>
      </Shell>
    );
  } else if (i.entry) {
    body = <EntryCard entry={i.entry} at={i.at} who={who} type={type} id={id} />;
  } else if (i.meeting) {
    body = (
      <Shell icon={<IconMeetings className={ico} aria-hidden />} at={i.at} to={`/app/meetings`} head={<>Meeting · {i.meeting.status === "cancelled" ? "cancelled" : `${i.meeting.durationMin} min`}{who}</>}>
        <div className="mt-1 text-[14px] font-medium">{i.meeting.title}</div>
      </Shell>
    );
  } else if (i.task) {
    body = (
      <Shell icon={<IconTasks className={ico} aria-hidden />} at={i.at} to={`/app/tasks?view=list&task=${i.task.id}`} head={<>Task {i.task.ref}{i.task.due ? <> · due {shortDate(i.task.due)}</> : null}</>}>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[14px] font-medium"><span className={cn(i.task.done && "text-muted line-through")}>{i.task.title}</span><Badge>{i.task.statusName}</Badge></div>
      </Shell>
    );
  } else if (i.deal) {
    const ev = i.deal.event === "won" ? "Deal won" : i.deal.event === "lost" ? "Deal lost" : "Deal added";
    body = (
      <Shell icon={<IconHandshake className={ico} aria-hidden />} at={i.at} to="/app/deals" head={<>{ev} · {aud(i.deal.value)}</>}>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[14px] font-medium">{i.deal.title}{i.deal.event !== "created" && <Badge tone={i.deal.event === "won" ? "ok" : "neutral"}>{i.deal.event === "won" ? "Won" : "Lost"}</Badge>}</div>
        {i.deal.reason && <p className="mt-0.5 text-[13px] text-muted">Why: {i.deal.reason}</p>}
      </Shell>
    );
  } else if (i.form) {
    body = (
      <Shell icon={<IconClipboardList className={ico} aria-hidden />} at={i.at} to="/app/forms" head={<>Form sent · {i.form.formName}{who}</>}>
        {i.form.fields.length > 0 && (
          <dl className="mt-1 grid grid-cols-[minmax(0,120px)_1fr] gap-x-3 gap-y-0.5 text-[13px]">
            {i.form.fields.map((f, n) => <div key={n} className="contents"><dt className="truncate text-subtle">{f.label}</dt><dd className="truncate">{f.value}</dd></div>)}
          </dl>
        )}
      </Shell>
    );
  } else if (i.booking) {
    body = (
      <Shell icon={<IconCalendarClock className={ico} aria-hidden />} at={i.at} to="/app/scheduling" head={<>Booking · {i.booking.status === "cancelled" ? "cancelled" : "confirmed"}</>}>
        <div className="mt-1 text-[14px] font-medium">{new Date(i.booking.startsAt).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {i.booking.durationMin} min</div>
        {i.booking.note && <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{i.booking.note}</p>}
      </Shell>
    );
  } else return null;
  return (
    <li className="relative">
      <span className="absolute -left-[27px] top-3 grid h-3.5 w-3.5 place-items-center rounded-full border border-line-strong bg-surface" aria-hidden />
      {body}
    </li>
  );
}

function EntryCard({ entry: e, at, who, type, id }: { entry: Entry; at: string; who: React.ReactNode; type: "contact" | "company"; id: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.body);
  const [busy, setBusy] = useState(false);
  const Ico = e.kind === "call" ? IconPhone : e.kind === "meeting" ? IconMeetings : IconNotes;
  const title = e.kind === "call" ? "Call" : e.kind === "meeting" ? "Meeting" : "Note";
  const bits = [title, e.kind === "call" ? outcomeLabel(e.outcome) : null, e.durationMin ? `${e.durationMin} min` : null, e.authorName].filter(Boolean).join(" · ");
  const save = async () => {
    setBusy(true);
    try { await api.patch(`/crm/entries/${e.id}`, { body: text }); setEditing(false); await refresh(qc, type, id); } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  const remove = async () => {
    try {
      await api.del(`/crm/entries/${e.id}`);
      await refresh(qc, type, id);
      toast(`${title} deleted`, { action: { label: "Undo", onClick: () => { void api.post(`/crm/entries/${e.id}/restore`).then(() => refresh(qc, type, id)).catch((err: Error) => showError(err)); } } });
    } catch (err) { showError(err as Error); }
  };
  return (
    <div className="group rounded-lg border border-line bg-surface p-3" data-testid="crm-entry">
      <div className="flex items-center gap-2 text-[12px] text-subtle">
        <Ico className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="min-w-0 truncate">{bits}{who}</span>
        {e.private && <Badge className="shrink-0"><IconLock className="h-3 w-3" aria-hidden />Only you</Badge>}
        <time className="ml-auto shrink-0" dateTime={at}>{mailDate(at)}</time>
      </div>
      {editing ? (
        <div className="mt-2">
          <label htmlFor={`edit-${e.id}`} className="sr-only">Edit</label>
          <Textarea id={`edit-${e.id}`} value={text} onChange={(x) => setText(x.target.value)} rows={3} className="text-[13.5px]" autoFocus />
          <div className="mt-2 flex justify-end gap-2"><Button size="sm" variant="secondary" onClick={() => { setEditing(false); setText(e.body); }}>Cancel</Button><Button size="sm" loading={busy} disabled={e.kind !== "call" && !text.trim()} onClick={() => void save()}>Save</Button></div>
        </div>
      ) : (
        e.body && <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px]">{e.body}</p>
      )}
      {e.canEdit && !editing && (
        <div className="mt-1 flex justify-end gap-1 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} aria-label={`Edit ${title.toLowerCase()}`}><IconEdit className="h-4 w-4" />Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => void remove()} aria-label={`Delete ${title.toLowerCase()}`}><IconTrash className="h-4 w-4" />Delete</Button>
        </div>
      )}
    </div>
  );
}
