import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import "@livekit/components-styles";
import { CalendarClock, Mail, Plus, Video, VideoOff } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Logo } from "@/web/components/logo";

export interface Meeting {
  id: string; title: string; room: string; startsAt: string; durationMin: number; endsAt: string; status: "scheduled" | "ended" | "cancelled";
  source: { type: "thread" | "task" | "contact"; id: string } | null; invitees: string[]; invitesSentAt: string | null; joinUrl: string; guestUrl: string; videoEnabled: boolean;
}
interface Join { url: string; token: string; room: string }

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function Room({ join, onLeave }: { join: Join; onLeave: () => void }) {
  return (
    <div data-lk-theme="default" className="h-[calc(100dvh-180px)] min-h-[420px] overflow-hidden rounded-xl border border-line" data-testid="meeting-room">
      <LiveKitRoom serverUrl={join.url} token={join.token} connect video audio onDisconnected={onLeave} style={{ height: "100%" }}>
        <VideoConference />
      </LiveKitRoom>
    </div>
  );
}

const VIDEO_OFF = "Video isn't switched on for this MyMail yet. You can still schedule meetings and send invites, and the same links start working once it is.";

export function MeetingsPage() {
  const q = useQuery({ queryKey: ["meetings"], queryFn: () => api.get<{ meetings: Meeting[]; videoEnabled: boolean }>("/meetings") });
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const now = Date.now();
  const upcoming = q.data?.meetings.filter((m) => m.status === "scheduled" && new Date(m.endsAt).getTime() > now - 3600_000).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) ?? [];
  const past = q.data?.meetings.filter((m) => !upcoming.includes(m)) ?? [];
  return (
    <div>
      <PageHeader title="Meetings" description="Video meetings in the browser, started from a thread, task or contact. Guests join with a link, no account needed. No recordings or transcripts." actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Schedule</Button>} />
      {q.data && !q.data.videoEnabled && <Card className="mb-4 flex items-start gap-3 p-4 text-[13px] text-muted" data-testid="meetings-off"><VideoOff className="mt-0.5 h-4 w-4 shrink-0" />{VIDEO_OFF}</Card>}
      {q.isPending ? <Skeleton className="h-40" /> : !q.data!.meetings.length ? (
        <Card><EmptyState icon={<Video />} title="No meetings yet" body="Schedule one here, or use Start a meeting on any email thread, task or contact." /></Card>
      ) : (
        <div className="space-y-6">
          {[["Upcoming", upcoming], ["Earlier", past]].map(([label, list]) => (list as Meeting[]).length ? (
            <section key={label as string}>
              <h2 className="mb-2 text-[13px] font-semibold">{label as string}</h2>
              <Card className="divide-y divide-line">
                {(list as Meeting[]).map((m) => (
                  <Link key={m.id} to={`/app/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]">
                    <CalendarClock className="h-4 w-4 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{m.title}</div><div className="text-[12.5px] text-muted">{when(m.startsAt)} · {m.durationMin} min{m.invitees.length ? ` · ${m.invitees.length} ${m.invitees.length === 1 ? "guest" : "guests"}` : ""}</div></div>
                    {m.status !== "scheduled" && <Badge>{m.status === "ended" ? "Ended" : "Cancelled"}</Badge>}
                    {m.invitesSentAt && <Badge tone="ok">Invited</Badge>}
                  </Link>
                ))}
              </Card>
            </section>
          ) : null)}
        </div>
      )}
      <ScheduleDialog open={open} onClose={() => setOpen(false)} onMade={(id) => navigate(`/app/meetings/${id}`)} />
    </div>
  );
}

function ScheduleDialog({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [at, setAt] = useState(() => { const d = new Date(Date.now() + 3600_000); d.setMinutes(0, 0, 0); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  const [duration, setDuration] = useState("30");
  const [guests, setGuests] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (send: boolean) => {
    setBusy(true);
    try {
      const invitees = guests.split(/[\s,;]+/).map((g) => g.trim()).filter(Boolean);
      const r = await api.post<{ meeting: Meeting; invites: { status: string } | null }>("/meetings", { title: title || undefined, startsAt: new Date(at).toISOString(), durationMin: Number(duration), invitees, sendInvites: send && invitees.length > 0 });
      if (r.invites?.status === "sent") toast.success("Invites sent");
      onClose(); onMade(r.meeting.id);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Schedule a meeting" footer={<><Button variant="ghost" onClick={() => void save(false)} loading={busy}>Save without inviting</Button><Button onClick={() => void save(true)} loading={busy}>Save and send invites</Button></>}>
      <div className="space-y-3">
        <Field label="Title">{(fp) => (<Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Meeting" />)}</Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label="Starts">{(fp) => (<Input {...fp} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />)}</Field>
          <Field label="Minutes">{(fp) => (<Input {...fp} type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} />)}</Field>
        </div>
        <Field label="Guests" hint="Email addresses, separated by commas. Each gets a calendar invite with the join link.">{(fp) => (<Input {...fp} value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="maria@blueharbor.co" />)}</Field>
      </div>
    </Dialog>
  );
}

export function MeetingPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["meeting", id], queryFn: async () => (await api.get<{ meeting: Meeting }>(`/meetings/${id}`)).meeting });
  const [join, setJoin] = useState<Join | null>(null);
  const [busy, setBusy] = useState(false);
  const m = q.data;
  const enter = async () => {
    setBusy(true);
    try { setJoin(await api.post<Join>(`/meetings/${id}/join`, {})); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const invite = async () => {
    try { const r = await api.post<{ status: string }>(`/meetings/${id}/invite`, {}); toast.success(r.status === "sent" ? "Invites sent" : "Invites are waiting for approval"); void qc.invalidateQueries({ queryKey: ["meeting", id] }); } catch (e) { showError(e as Error); }
  };
  const setStatus = async (status: "ended" | "cancelled") => { try { await api.patch(`/meetings/${id}`, { status }); void qc.invalidateQueries({ queryKey: ["meeting", id] }); } catch (e) { showError(e as Error); } };
  if (!m) return q.error ? <p className="text-sm text-muted">{(q.error as Error).message}</p> : <Skeleton className="h-40" />;
  if (join) return <div><PageHeader title={m.title} actions={<Button variant="secondary" onClick={() => setJoin(null)}>Leave</Button>} /><Room join={join} onLeave={() => setJoin(null)} /></div>;
  const source = m.source ? (m.source.type === "task" ? { to: `/app/tasks?task=${m.source.id}`, label: "the task" } : m.source.type === "contact" ? { to: `/app/contacts/${m.source.id}`, label: "the contact" } : { to: `/app/mail`, label: "the thread" }) : null;
  return (
    <div data-testid="meeting-page">
      <PageHeader title={m.title} description={<>{when(m.startsAt)} · {m.durationMin} minutes{source && <> · started from <Link className="text-brand-hover hover:underline" to={source.to}>{source.label}</Link></>}</>}
        actions={m.status === "scheduled" ? <Button onClick={() => void enter()} loading={busy} disabled={!m.videoEnabled} data-testid="join-meeting"><Video className="h-4 w-4" />Join now</Button> : <Badge>{m.status === "ended" ? "Ended" : "Cancelled"}</Badge>} />
      {!m.videoEnabled && <Card className="mb-4 flex items-start gap-3 p-4 text-[13px] text-muted" data-testid="meetings-off"><VideoOff className="mt-0.5 h-4 w-4 shrink-0" />{VIDEO_OFF}</Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Guest link</h2>
          <p className="mt-1 text-[13px] text-muted">Anyone with this link can join from a browser. No account or app needed.</p>
          <div className="mt-3 flex items-center gap-2"><Input readOnly value={m.guestUrl} aria-label="Guest link" className="font-mono text-[12.5px]" /><CopyButton value={m.guestUrl} /></div>
        </Card>
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Guests</h2>
          {m.invitees.length ? <ul className="mt-2 space-y-1 text-[13px]">{m.invitees.map((g) => <li key={g} className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-muted" />{g}</li>)}</ul> : <p className="mt-1 text-[13px] text-muted">No guests yet. Share the link, or schedule with guest emails.</p>}
          {m.invitees.length > 0 && m.status === "scheduled" && <div className="mt-3 flex items-center gap-3"><Button size="sm" variant="secondary" onClick={() => void invite()}>{m.invitesSentAt ? "Send invites again" : "Send calendar invites"}</Button>{m.invitesSentAt && <span className="text-[12px] text-subtle">Sent {when(m.invitesSentAt)}</span>}</div>}
        </Card>
      </div>
      {m.status === "scheduled" && <div className="mt-4 flex gap-2"><Button size="sm" variant="ghost" onClick={() => void setStatus("ended")}>Mark as ended</Button><Button size="sm" variant="ghost" onClick={() => void setStatus("cancelled")}>Cancel meeting</Button></div>}
    </div>
  );
}

/** The guest page at /m/<token>: a name, then the call. */
export function GuestMeetingPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["guest-meeting", token], queryFn: async () => (await api.get<{ meeting: { title: string; startsAt: string; durationMin: number; status: string; host: string; videoEnabled: boolean } }>(`/public/meetings/${token}`)).meeting, retry: false });
  const [name, setName] = useState("");
  const [join, setJoin] = useState<Join | null>(null);
  const [left, setLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { setJoin(await api.post<Join>(`/public/meetings/${token}/join`, { name })); setLeft(false); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const m = q.data;
  return (
    <main className="min-h-dvh bg-bg px-4 py-6 text-fg">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between"><Logo /><span className="text-[12px] text-subtle">Video meeting</span></div>
        {q.isPending ? <Skeleton className="h-40" /> : !m ? <Card className="p-8 text-center"><h1 className="text-lg font-semibold">This meeting link doesn't work</h1><p className="mt-1 text-[13px] text-muted">Ask whoever invited you for a new link.</p></Card>
          : join ? <Room join={join} onLeave={() => { setJoin(null); setLeft(true); }} />
          : (
            <Card className="mx-auto max-w-md p-6" data-testid="guest-meeting">
              <p className="text-[12.5px] text-muted">{m.host} invited you to</p>
              <h1 className="mt-1 text-xl font-semibold">{m.title}</h1>
              <p className="mt-1 text-[13px] text-muted">{when(m.startsAt)} · {m.durationMin} minutes</p>
              {left && <p className="mt-3 text-[13px] text-muted">You left the meeting. Join again below.</p>}
              {m.status !== "scheduled" ? <p className="mt-4 text-[13px]">{m.status === "cancelled" ? "This meeting was cancelled." : "This meeting has ended."}</p>
                : !m.videoEnabled ? <p className="mt-4 text-[13px] text-muted">The video service isn't switched on yet. Try again at the meeting time, or reply to the invite.</p>
                : (
                  <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); void go(); }}>
                    <Field label="Your name">{(fp) => (<Input {...fp} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={60} />)}</Field>
                    <Button type="submit" className="w-full" loading={busy} disabled={!name.trim()}><Video className="h-4 w-4" />Join meeting</Button>
                    <p className="text-[12px] text-subtle">Your browser will ask to use your camera and microphone. Nothing is recorded.</p>
                  </form>
                )}
            </Card>
          )}
      </div>
    </main>
  );
}
