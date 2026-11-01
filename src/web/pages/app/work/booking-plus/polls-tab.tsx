/** R92: Time polls tab. Propose times, share the link, watch answers come in, pick the winner (makes a meeting). */
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IconCalendarPlus, IconCheckCircle, IconPlus, IconTrash } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { useDialogs } from "@/web/components/ui/confirm";
import { DateInput, Field, Input, Select, TimeInput } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, Skeleton, Switch } from "@/web/components/ui/misc";
import { POLL_ANSWER_LABEL, type PollAnswer } from "@/shared/booking-plus";
import { dayLabel, localIso, timeLabel, ymd, zone } from "./common";

interface PollRow { id: string; title: string; status: "open" | "closed"; votes: number; options: number; createdAt: string; mine: boolean; url: string }
interface PollFull {
  id: string; title: string; description: string; location: string; durationMin: number; status: "open" | "closed"; winnerOptionId: string | null; meetingId: string | null; url: string;
  options: { id: string; startsAt: string }[]; votes: { id: string; name: string; email?: string; answers: Record<string, PollAnswer> }[];
  totals: { optionId: string; yes: number; maybe: number; no: number; score: number }[]; best: string | null;
}
const CELL: Record<PollAnswer, string> = { yes: "bg-ok-soft text-fg", maybe: "bg-warn-soft text-fg", no: "text-subtle" };

export function PollsTab() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["booking", "polls"], queryFn: async () => (await api.get<{ polls: PollRow[] }>("/booking/polls")).polls });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-4" data-testid="polls-tab">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-muted">Suggest a few times, send the link, and people vote without an account.</p>
        <Button onClick={() => setCreating(true)}><IconPlus className="h-4 w-4" />New poll</Button>
      </div>
      {list.isPending ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : list.isError ? <Card><EmptyState title="Polls did not load" body="Check your connection and try again." action={<Button variant="secondary" onClick={() => list.refetch()}>Try again</Button>} /></Card>
          : !list.data.length ? <Card><EmptyState icon={<IconCalendarPlus />} title="No polls yet" body="Find a time that suits a group. People answer Yes, If need be or No for each time." action={<Button onClick={() => setCreating(true)}>New poll</Button>} /></Card>
            : (
              <Card className="divide-y divide-line p-0">
                {list.data.map((p) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <button type="button" onClick={() => setOpenId(p.id)} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-brand">
                      <span className="block truncate text-[15px] font-medium" title={p.title}>{p.title}</span>
                      <span className="text-[13px] text-subtle">{p.options} {p.options === 1 ? "time" : "times"} · {p.votes} {p.votes === 1 ? "answer" : "answers"}</span>
                    </button>
                    <Badge tone={p.status === "open" ? "ok" : "neutral"}>{p.status === "open" ? "Open" : "Closed"}</Badge>
                    <CopyButton value={p.url} label="Copy link" toastText="Poll link copied" />
                  </div>
                ))}
              </Card>
            )}
      <NewPollDialog open={creating} onClose={() => setCreating(false)} onMade={(id) => { setCreating(false); setOpenId(id); void qc.invalidateQueries({ queryKey: ["booking", "polls"] }); }} />
      {openId && <PollDialog id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function NewPollDialog({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (id: string) => void }) {
  const tomorrow = ymd(new Date(Date.now() + 86400_000));
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [duration, setDuration] = useState(30);
  const [video, setVideo] = useState(true);
  const [times, setTimes] = useState<{ date: string; time: string }[]>([{ date: tomorrow, time: "10:00" }, { date: tomorrow, time: "14:00" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTime = () => {
    const last = times[times.length - 1];
    const next = last ? new Date(`${last.date}T00:00:00`) : new Date();
    next.setDate(next.getDate() + 1);
    setTimes([...times, { date: ymd(next), time: last?.time ?? "10:00" }]);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) return setError("Give the poll a title.");
    if (!times.length) return setError("Add at least one time.");
    setBusy(true);
    try {
      const r = await api.post<{ poll: PollFull }>("/booking/polls", { title, location, durationMin: duration, video, timezone: zone(), options: times.map((t) => localIso(t.date, t.time)) });
      toast.success("Poll ready. Copy the link and send it.");
      setTitle(""); setLocation("");
      onMade(r.poll.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New time poll" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" form="new-poll" disabled={busy}>{busy ? "Making" : "Make poll"}</Button></>}>
      <form id="new-poll" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Title">{(f) => <Input {...f} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project kickoff" maxLength={120} data-autofocus />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Length">{(f) => <Select {...f} value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</Select>}</Field>
          <Field label="Place (optional)">{(f) => <Input {...f} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={200} />}</Field>
        </div>
        <Switch checked={video} onChange={setVideo} label="Add a video call link when a time is picked" />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium text-muted">Times to suggest ({zone()})</legend>
          {times.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <DateInput aria-label={`Day ${i + 1}`} value={t.date} onChange={(e) => setTimes(times.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} className="min-w-0 flex-1" />
              <TimeInput aria-label={`Time ${i + 1}`} value={t.time} onChange={(e) => setTimes(times.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} className="w-32" />
              <Button type="button" variant="ghost" size="icon" aria-label={`Remove time ${i + 1}`} onClick={() => setTimes(times.filter((_, j) => j !== i))}><IconTrash className="h-4 w-4" /></Button>
            </div>
          ))}
          <Button type="button" variant="secondary" size="sm" onClick={addTime} disabled={times.length >= 30}><IconPlus className="h-4 w-4" />Add a time</Button>
        </fieldset>
        {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
      </form>
    </Dialog>
  );
}

function PollDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { confirm, dialogs } = useDialogs();
  const q = useQuery({ queryKey: ["booking", "poll", id], queryFn: async () => (await api.get<{ poll: PollFull }>(`/booking/polls/${id}`)).poll });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["booking", "poll", id] }); void qc.invalidateQueries({ queryKey: ["booking", "polls"] }); };
  const p = q.data;
  const pick = async (optionId: string, startsAt: string) => {
    if (!(await confirm({ title: "Pick this time?", description: `${dayLabel(startsAt)}, ${timeLabel(startsAt)}. We make the meeting, close the poll and email everyone who left an email.`, confirmLabel: "Pick this time" }))) return;
    try {
      const r = await api.post<{ mailed: number }>(`/booking/polls/${id}/pick`, { optionId });
      toast.success(r.mailed ? `Meeting made. ${r.mailed} ${r.mailed === 1 ? "person was" : "people were"} emailed.` : "Meeting made.");
      refresh();
    } catch (e) { showError(e as Error); }
  };
  const toggle = async () => { try { await api.patch(`/booking/polls/${id}`, { open: p?.status !== "open" }); refresh(); } catch (e) { showError(e as Error); } };
  const remove = async () => {
    if (!(await confirm({ title: "Delete this poll?", description: "The link stops working and the answers are deleted.", confirmLabel: "Delete poll", tone: "danger" }))) return;
    try { await api.del(`/booking/polls/${id}`); refresh(); onClose(); } catch (e) { showError(e as Error); }
  };
  const totals = Object.fromEntries((p?.totals ?? []).map((t) => [t.optionId, t]));
  return (
    <Dialog open onClose={onClose} title={p?.title ?? "Poll"} className="sm:max-w-3xl"
      footer={p && <div className="flex w-full flex-wrap items-center gap-2"><Button variant="ghost" onClick={remove}><IconTrash className="h-4 w-4" />Delete</Button>{!p.meetingId && <Button variant="secondary" onClick={toggle}>{p.status === "open" ? "Close poll" : "Reopen poll"}</Button>}<span className="flex-1" /><CopyButton value={p.url} label="Copy link" toastText="Poll link copied" /></div>}>
      {dialogs}
      {!p ? <Skeleton className="h-48" /> : (
        <div className="space-y-4" data-testid="poll-detail">
          {p.votes.length === 0 && <p className="rounded-lg bg-fill px-3 py-2 text-[14px] text-muted">No answers yet. Copy the link and send it to people.</p>}
          {/* At 1280: people as rows and times as columns. On phones the table scrolls inside its card. */}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[480px] border-collapse text-[13px]">
              <thead>
                <tr className="bg-fill/60">
                  <th scope="col" className="sticky left-0 z-10 bg-fill px-3 py-2 text-left font-medium text-muted">Time</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium text-muted">Answers</th>
                  {p.votes.map((v) => <th key={v.id} scope="col" className="max-w-[120px] truncate px-2 py-2 text-left font-medium" title={v.email || v.name}>{v.name}</th>)}
                  <th scope="col" className="px-3 py-2"><span className="sr-only">Pick</span></th>
                </tr>
              </thead>
              <tbody>
                {p.options.map((o) => {
                  const t = totals[o.id];
                  const won = p.winnerOptionId === o.id;
                  return (
                    <tr key={o.id} className={cn("border-t border-line", won && "bg-ok-soft")}>
                      <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-surface px-3 py-2 text-left font-medium">{dayLabel(o.startsAt)} <span className="text-muted">{timeLabel(o.startsAt)}</span>{p.best === o.id && !p.winnerOptionId && <Badge tone="ok" className="ml-2">Best</Badge>}{won && <Badge tone="ok" className="ml-2">Picked</Badge>}</th>
                      <td className="whitespace-nowrap px-3 py-2 text-muted">{t?.yes ?? 0} yes{t?.maybe ? `, ${t.maybe} maybe` : ""}</td>
                      {p.votes.map((v) => {
                        const a = v.answers[o.id];
                        return <td key={v.id} className={cn("px-2 py-2", a && CELL[a])}>{a ? POLL_ANSWER_LABEL[a] : <span className="text-subtle">No answer</span>}</td>;
                      })}
                      <td className="px-3 py-2 text-right">{!p.meetingId && <Button size="sm" variant={p.best === o.id ? "primary" : "secondary"} onClick={() => pick(o.id, o.startsAt)}>Pick</Button>}{won && <IconCheckCircle className="ml-auto h-5 w-5 text-ok" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {p.meetingId && <p className="text-[14px] text-muted">The meeting is in Meetings. Everyone who left an email got the time.</p>}
        </div>
      )}
    </Dialog>
  );
}

