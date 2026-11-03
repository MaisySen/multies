import { useRef, useState } from "react";
import { quickRetry } from "@/web/lib/quick-retry-pol1"; // POL1
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LiveKitRoom, VideoConference } from "@livekit/components-react";
import "@livekit/components-styles";
import { IconCalendarClock, IconDownload, IconEdit, IconMail, IconMegaphone, IconRepeat, IconVideo, IconVideoOff } from "@/web/components/ui/icon";
import { LoadFailure } from "@/web/components/load-error-t1g"; // POL1 (MB-312)
import { toast } from "sonner";
import { api } from "@/web/lib/api";
import { isoToZonedInput, tz, zonedDateTime, zonedInputToIso } from "@/web/lib/format";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, Switch } from "@/web/components/ui/misc";
import { Logo } from "@/web/components/logo";
import { MeetingNotes } from "./meeting-notes";
import { MeetingSuggestions } from "./meeting-suggest-td3"; // TD3
import { RecordingLayer, RecordingSection } from "./meeting-recording";
import { RecoverRecording } from "./video-vid2-ui"; // VID2
import { PhoneSaves } from "./video-phone-vid3"; // VID3
import { isPhoneDevice } from "@/web/lib/video-phone-vid3"; // VID3
import { useJoinFromDock } from "./call-r23";
import { CallRoomExtras } from "./call-dock-r23";
import { PreJoin, type JoinPrefs } from "./prejoin-r31";
import { askToJoin, GuestLobby, GuestsWaitSetting, LobbyRequests } from "./lobby-r32";
import { CallSidePanel, CallToolbar, useCallNotesDoc, useCallPanel } from "./call-panel-r31";
import { loadPrefs, roomMedia } from "@/web/lib/prejoin-prefs";
import { useConfig, useMe } from "@/web/lib/queries";
import { ReferencesPanel } from "@/web/components/mentions-td5"; // TD5
import { CallMinutesBanner, CallMinutesUsage } from "./call-minutes-r34"; // R34 (MB-171)
import { NoMeetingsArt } from "@/web/components/illustrations"; // R36
import { startMeetingNow } from "./meeting-start"; // R40 (MB-207)
import { useWebinarOn, WebinarCard } from "./webinar-r114"; // R114
import { AskAboutButton, useAskAboutOn } from "@/web/components/ask-about-td1"; // TD1

export interface Meeting {
  id: string; title: string; room: string; startsAt: string; durationMin: number; endsAt: string; status: "scheduled" | "ended" | "cancelled";
  source: { type: "thread" | "task" | "contact"; id: string } | null; invitees: string[]; invitesSentAt: string | null; joinUrl: string; guestUrl: string; videoEnabled: boolean; guestsWait?: boolean;
  /** A weekly series. In the upcoming list each occurrence is its own entry with the series' id. */
  recurrence: Series | null;
  seriesStartsAt: string | null;
}
type Day = "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";
interface Series { interval: 1 | 2; days: Day[]; until: string | null; count: number | null; rrule: string; timezone: string; summary: string }
const DAYS: [Day, string][] = [["mo", "Mon"], ["tu", "Tue"], ["we", "Wed"], ["th", "Thu"], ["fr", "Fri"], ["sa", "Sat"], ["su", "Sun"]];
const dayOfInput = (local: string): Day => DAYS[(new Date(`${local.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7][0];

/** Repeat settings shared by scheduling and editing a series. Weekly only. */
interface RepeatState { every: "none" | "1" | "2"; days: Day[]; end: "never" | "until" | "count"; until: string; count: string }
const noRepeat = (): RepeatState => ({ every: "none", days: [], end: "never", until: "", count: "10" });
const repeatOf = (s: Series | null): RepeatState => s ? { every: String(s.interval) as "1" | "2", days: s.days, end: s.count ? "count" : s.until ? "until" : "never", until: s.until ?? "", count: String(s.count ?? 10) } : noRepeat();
const repeatBody = (r: RepeatState) => r.every === "none" ? null : {
  interval: Number(r.every), days: r.days, timezone: tz(),
  until: r.end === "until" && r.until ? r.until : null, count: r.end === "count" ? Number(r.count) || 1 : null,
};

function RepeatFields({ value, onChange, startDay }: { value: RepeatState; onChange: (v: RepeatState) => void; startDay: Day }) {
  const set = (p: Partial<RepeatState>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-3">
      <Field label="Repeat">{(fp) => (
        <Select {...fp} value={value.every} onChange={(e) => set({ every: e.target.value as RepeatState["every"] })}>
          <option value="none">Does not repeat</option>
          <option value="1">Every week</option>
          <option value="2">Every 2 weeks</option>
        </Select>
      )}</Field>
      {value.every !== "none" && (
        <>
          <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
            {DAYS.map(([d, label]) => {
              const on = d === startDay || value.days.includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} disabled={d === startDay}
                  onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}
                  className={`h-8 min-w-11 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors ${on ? "border-brand bg-brand text-white" : "border-line text-muted hover:bg-hover"} disabled:cursor-default`}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label="Ends">{(fp) => (
              <Select {...fp} value={value.end} onChange={(e) => set({ end: e.target.value as RepeatState["end"] })}>
                <option value="never">Never</option>
                <option value="until">On a date</option>
                <option value="count">After a number of meetings</option>
              </Select>
            )}</Field>
            {value.end === "until" && <Field label="Last day">{(fp) => (<Input {...fp} type="date" value={value.until} onChange={(e) => set({ until: e.target.value })} />)}</Field>}
            {value.end === "count" && <Field label="Meetings">{(fp) => (<Input {...fp} type="number" min={1} max={520} value={value.count} onChange={(e) => set({ count: e.target.value })} />)}</Field>}
          </div>
        </>
      )}
    </div>
  );
}
interface Join { url: string; token: string; room: string; meeting?: { id: string } }

const when = zonedDateTime;

/**
 * The call, with the Round 31 side panel (Notes, So far). A connect that never succeeded shows a
 * message instead of silently leaving; once connected, a disconnect leaves.
 */
function Room({ join, onLeave, prefs, member, guestToken, title }: { join: Join; onLeave: () => void; prefs?: JoinPrefs; member: boolean; guestToken?: string; title?: string }) {
  const meetingId = join.meeting?.id;
  useCallNotesDoc(meetingId, member);
  const panel = useCallPanel(meetingId, member);
  const connected = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const media = roomMedia(prefs ?? loadPrefs());
  return (
    // R49 mobile: in the app on a phone the call fills the screen between the top bar and the tab bar, so its
    // controls dock right above the tabs like a native call screen (desktop and the guest page are unchanged).
    <div className={cn("space-y-2", member && "max-md:fixed max-md:inset-x-0 max-md:bottom-[var(--tabbar-h,0px)] max-md:top-[calc(3rem+env(safe-area-inset-top))] max-md:z-20 max-md:flex max-md:flex-col max-md:space-y-0 max-md:bg-bg")} data-testid="call-screen">
      <div className={cn("flex items-center justify-end", member && "max-md:min-h-[52px] max-md:justify-between max-md:gap-2 max-md:pl-4 max-md:pr-2")}>
        {member && title && <h2 className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.01em] md:hidden">{title}</h2>}
        <div className="flex min-w-0 items-center gap-2"><span data-rec-slot="" className="contents" /><CallToolbar tab={panel.tab} setTab={panel.setTab} member={member} /></div>
      </div>
      <div className={cn("flex flex-col gap-3 md:flex-row", member && "max-md:relative max-md:min-h-0 max-md:flex-1 max-md:gap-0")}>
        <div data-lk-theme="default" className={cn("relative h-[calc(100dvh-220px)] min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-xl border border-line", member && "max-md:h-auto max-md:min-h-0 max-md:rounded-none max-md:border-x-0 max-md:border-b-0")} data-testid="meeting-room">
          {failed ? (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 bg-[#1c1c1e] p-6 text-center text-[13px] text-white/85" data-testid="meeting-connect-failed">
              <p>Couldn't connect to the call. Check your connection and try again.</p>
              <Button variant="secondary" onClick={onLeave}>Back</Button>
            </div>
          ) : (
            <LiveKitRoom serverUrl={join.url} token={join.token} connect video={media.video} audio={media.audio} options={media.options}
              onConnected={() => { connected.current = true; }}
              onError={(e) => { if (!connected.current) setFailed(e.message); }}
              onDisconnected={() => { if (connected.current) onLeave(); else setFailed("disconnected"); }} style={{ height: "100%" }}>
              <RecordingLayer join={join} title={title} />
              <VideoConference />
              <CallRoomExtras meetingId={meetingId} />
            </LiveKitRoom>
          )}
          {member && <LobbyRequests meetingId={meetingId} className="absolute right-3 top-3 z-30" />}
          {member && <CallMinutesBanner meetingId={meetingId} className="absolute bottom-20 left-3 z-30" />}
        </div>
        {panel.tab && <div className={cn("contents", member && "max-md:absolute max-md:inset-x-2 max-md:bottom-[76px] max-md:top-2 max-md:z-40 max-md:flex max-md:[&>aside]:elev-3")}><CallSidePanel meetingId={meetingId} guestToken={guestToken} member={member} tab={panel.tab} onClose={panel.close} so={panel.so} /></div>}
      </div>
    </div>
  );
}

/** Round 31: the pre-join footnote (recording is always visible to everyone in the call). */
const PREJOIN_NOTE = "Press Enter to join. If the call is recorded, you see a banner while it is on.";

const VIDEO_OFF = "Video calls aren't switched on for this workspace yet. You can still schedule meetings and send invites, and the same links start working once it is.";

export function MeetingsPage() {
  const q = useQuery({ queryKey: ["meetings"], ...quickRetry, queryFn: () => api.get<{ meetings: Meeting[]; videoEnabled: boolean }>("/meetings") });
  // Weekly series come back as one entry per upcoming occurrence (worked out on the server, nothing stored).
  const soon = useQuery({ queryKey: ["meetings", "upcoming"], queryFn: () => api.get<{ meetings: Meeting[] }>("/meetings?upcoming=1") });
  // R79: the shell's Create menu opens Schedule a meeting with ?new=1.
  const [open, setOpen] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1");
  const [starting, setStarting] = useState(false);
  const [asWebinar, setAsWebinar] = useState(false); // POL1 (MB-318): the Webinar button opens Schedule with webinar mode on
  const webinarOn = useWebinarOn();
  const navigate = useNavigate();
  const now = Date.now();
  const upcoming = (soon.data?.meetings ?? q.data?.meetings ?? []).filter((m) => m.status === "scheduled" && new Date(m.endsAt).getTime() > now - 3600_000).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const upcomingIds = new Set(upcoming.map((m) => m.id));
  const past = q.data?.meetings.filter((m) => !upcomingIds.has(m.id) && !(m.recurrence && m.status === "scheduled")) ?? [];
  return (
    <div>
      <PageHeader title="Meetings" description="Video meetings in the browser, started from a thread, task or contact. Guests join with a link, no account needed. Record a call to get a transcript and summary; everyone in the call sees when it is on." actions={<div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={() => { setAsWebinar(false); setOpen(true); }} data-testid="meeting-schedule"><IconCalendarClock className="h-4 w-4" />Schedule</Button>{webinarOn && <Button variant="secondary" onClick={() => { setAsWebinar(true); setOpen(true); }} data-testid="meeting-new-webinar"><IconMegaphone className="h-4 w-4" />Webinar</Button>}<Button onClick={() => { setStarting(true); void startMeetingNow(navigate).finally(() => setStarting(false)); }} loading={starting} data-testid="meeting-start-now"><IconVideo className="h-4 w-4" />Start now</Button></div>} />
      <CallMinutesUsage className="-mt-3 mb-4" />
      {q.data && !q.data.videoEnabled && <Card className="mb-4 flex items-start gap-3 p-4 text-[13px] text-muted" data-testid="meetings-off"><IconVideoOff className="mt-0.5 h-4 w-4 shrink-0" />{VIDEO_OFF}</Card>}
      {q.isPending ? <Skeleton className="h-40" /> : q.error || !q.data ? <Card data-testid="meetings-error"><LoadFailure error={q.error} onRetry={() => q.refetch()} block /></Card> : !q.data.meetings.length ? (
        <Card><EmptyState icon={<IconVideo />} art={<NoMeetingsArt />} title="No meetings yet" body="Start one now and share the guest link, schedule one for later, or start a meeting from any email thread, task or contact." /></Card>
      ) : (
        <div className="space-y-6">
          {[["Upcoming", upcoming], ["Earlier", past]].map(([label, list]) => (list as Meeting[]).length ? (
            <section key={label as string}>
              <h2 className="mb-2 px-1 text-[12px] font-semibold uppercase tracking-wide text-subtle">{label as string}</h2>
              <Card className="divide-y divide-line">
                {(list as Meeting[]).map((m) => (
                  <Link key={`${m.id}:${m.startsAt}`} to={`/app/meetings/${m.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors duration-150 ease-out first:rounded-t-xl last:rounded-b-xl hover:bg-hover focus-visible:bg-hover focus-visible:outline-none max-sm:min-h-14" data-testid="meeting-row">
                    {m.recurrence ? <IconRepeat className="h-4 w-4 shrink-0 text-muted" aria-label="Repeats" /> : <IconCalendarClock className="h-4 w-4 shrink-0 text-muted" />}
                    <div className="min-w-0 flex-1"><div className="truncate text-[14px] font-medium">{m.title}</div><div className="text-[12.5px] text-muted">{when(m.startsAt)} · {m.durationMin} min{m.invitees.length ? ` · ${m.invitees.length} ${m.invitees.length === 1 ? "guest" : "guests"}` : ""}{m.recurrence ? ` · ${m.recurrence.summary}` : ""}</div></div>
                    {m.status !== "scheduled" && <Badge>{m.status === "ended" ? "Ended" : "Cancelled"}</Badge>}
                    {m.invitesSentAt && <Badge tone="ok">Invited</Badge>}
                  </Link>
                ))}
              </Card>
            </section>
          ) : null)}
        </div>
      )}
      <ScheduleDialog key={asWebinar ? "webinar" : "meeting"} open={open} webinar={asWebinar} webinarOn={webinarOn} onClose={() => setOpen(false)} onMade={(id) => navigate(`/app/meetings/${id}`)} />
    </div>
  );
}

function ScheduleDialog({ open, onClose, onMade, webinar: startAsWebinar = false, webinarOn = false }: { open: boolean; onClose: () => void; onMade: (id: string) => void; webinar?: boolean; webinarOn?: boolean }) {
  const [title, setTitle] = useState("");
  const [webinar, setWebinar] = useState(startAsWebinar); // POL1 (MB-318)
  const [at, setAt] = useState(() => { const d = new Date(Date.now() + 3600_000); d.setUTCMinutes(0, 0, 0); return isoToZonedInput(d); });
  const [duration, setDuration] = useState("30");
  const [guests, setGuests] = useState("");
  const [repeat, setRepeat] = useState<RepeatState>(noRepeat);
  const [busy, setBusy] = useState(false);
  const save = async (send: boolean) => {
    setBusy(true);
    try {
      const invitees = guests.split(/[\s,;]+/).map((g) => g.trim()).filter(Boolean);
      const r = await api.post<{ meeting: Meeting; invites: { status: string } | null }>("/meetings", { title: title || undefined, startsAt: zonedInputToIso(at), durationMin: Number(duration), invitees, sendInvites: send && invitees.length > 0, ...(repeat.every !== "none" ? { recurrence: repeatBody(repeat) } : {}) });
      if (r.invites?.status === "sent") toast.success("Invites sent");
      // POL1 (MB-318): webinar mode in the same step; if it can't be turned on, the meeting still stands and the page has the switch.
      if (webinar && webinarOn) {
        try { await api.patch(`/webinars/${r.meeting.id}`, { enabled: true }); toast.success("Webinar scheduled. Share the registration link from its page."); }
        catch (e) { showError(e as Error); }
      }
      onClose(); onMade(r.meeting.id);
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={webinar && webinarOn ? "Schedule a webinar" : "Schedule a meeting"} footer={<><Button variant="ghost" onClick={() => void save(false)} loading={busy}>Save without inviting</Button><Button onClick={() => void save(true)} loading={busy}>Save and send invites</Button></>}>
      <div className="space-y-3">
        <Field label="Title">{(fp) => (<Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={webinar && webinarOn ? "Webinar" : "Meeting"} />)}</Field>
        {webinarOn && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-line p-3" data-testid="schedule-webinar">
            <div className="min-w-0 text-[13px]"><div className="font-medium text-fg">Make it a webinar</div><div className="text-muted">Hosts and panelists are on stage. Everyone else registers with a link, watches, asks questions and votes in polls.</div></div>
            <Switch checked={webinar} onChange={setWebinar} label="Make it a webinar" />
          </div>
        )}
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={`Starts (${tz()})`}>{(fp) => (<Input {...fp} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />)}</Field>
          <Field label="Minutes">{(fp) => (<Input {...fp} type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} />)}</Field>
        </div>
        <RepeatFields value={repeat} onChange={setRepeat} startDay={dayOfInput(at)} />
        <Field label="Guests" hint="Email addresses, separated by commas. Each gets a calendar invite with the join link.">{(fp) => (<Input {...fp} value={guests} onChange={(e) => setGuests(e.target.value)} placeholder="maria@blueharbor.co" />)}</Field>
      </div>
    </Dialog>
  );
}

export function MeetingPage() {
  const askOn = useAskAboutOn(); // TD1
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["meeting", id], queryFn: async () => (await api.get<{ meeting: Meeting }>(`/meetings/${id}`)).meeting });
  const [join, setJoin] = useState<Join | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const cfg = useConfig().data;
  // VID3: on a phone, videos recorded in the call wait here for a Save tap after hanging up.
  const phonePage = !!(cfg?.videoRecVid2 && cfg?.videoPhoneVid3) && typeof navigator !== "undefined" && isPhoneDevice({ ua: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints });
  const meetTd3 = !!cfg?.meetTd3; // TD3: meetings to tasks
  // Round 31: Join now opens the pre-join screen; its choices carry into the call.
  // R40 (MB-207): Start now opens the meeting with ?join=1, straight to the camera and name check.
  const [prejoin, setPrejoin] = useState(() => new URLSearchParams(window.location.search).get("join") === "1");
  const [prefs, setPrefs] = useState<JoinPrefs | undefined>();
  const me = useMe();
  const webinarOn = useWebinarOn();
  const m = q.data;
  const inCall = useQuery({
    queryKey: ["call-status", id], enabled: prejoin && !!id, refetchInterval: prejoin ? 15_000 : false,
    queryFn: () => api.get<{ participants: { name: string }[] }>(`/chat/calls/${id}`),
  });
  const enter = async (p?: JoinPrefs) => {
    setBusy(true);
    try { setJoin(await api.post<Join>(`/meetings/${id}/join`, p?.name ? { name: p.name } : {})); setPrefs(p); setPrejoin(false); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  useJoinFromDock(!!m?.videoEnabled && m.status === "scheduled" && !join, () => void enter()); // Round 23 (the dock already passed pre-join)
  const invite = async () => {
    try { const r = await api.post<{ status: string }>(`/meetings/${id}/invite`, {}); toast.success(r.status === "sent" ? "Invites sent" : "Invites are waiting for approval"); void qc.invalidateQueries({ queryKey: ["meeting", id] }); } catch (e) { showError(e as Error); }
  };
  const setStatus = async (status: "ended" | "cancelled") => { try { await api.patch(`/meetings/${id}`, { status }); void qc.invalidateQueries({ queryKey: ["meeting", id] }); } catch (e) { showError(e as Error); } };
  if (!m) return q.error ? <Card data-testid="meeting-error"><LoadFailure error={q.error} onRetry={() => q.refetch()} block /></Card> : <Skeleton className="h-40" />; // POL1
  if (join) return <div><PageHeader title={m.title} actions={<Button variant="secondary" onClick={() => setJoin(null)}>Leave</Button>} /><Room join={join} prefs={prefs} member title={m.title} onLeave={() => setJoin(null)} /></div>;
  if (prejoin) return <div className="py-2"><PreJoin title={m.title} who={{ mode: "member", name: me.data?.user?.name || me.data?.user?.email || "you" }} inCall={inCall.data?.participants.map((p) => p.name)} busy={busy} footnote={PREJOIN_NOTE} onJoin={(p) => void enter(p)} onCancel={() => setPrejoin(false)} /></div>;
  const source = m.source ? (m.source.type === "task" ? { to: `/app/tasks?task=${m.source.id}`, label: "the task" } : m.source.type === "contact" ? { to: `/app/contacts/${m.source.id}`, label: "the contact" } : { to: `/app/mail`, label: "the thread" }) : null;
  return (
    <div data-testid="meeting-page">
      <PageHeader title={m.title} description={<>{when(m.startsAt)} · {m.durationMin} minutes{source && <> · started from <Link className="text-brand-hover hover:underline" to={source.to}>{source.label}</Link></>}</>}
        actions={askOn ? <div className="flex flex-wrap items-center gap-2"><AskAboutButton kind="meetings" id={m.id} title={m.title} />{m.status === "scheduled" ? <Button onClick={() => setPrejoin(true)} loading={busy} disabled={!m.videoEnabled} data-testid="join-meeting"><IconVideo className="h-4 w-4" />Join now</Button> : <Badge>{m.status === "ended" ? "Ended" : "Cancelled"}</Badge>}</div> : m.status === "scheduled" ? <Button onClick={() => setPrejoin(true)} loading={busy} disabled={!m.videoEnabled} data-testid="join-meeting"><IconVideo className="h-4 w-4" />Join now</Button> : <Badge>{m.status === "ended" ? "Ended" : "Cancelled"}</Badge>} />
      {!m.videoEnabled && <Card className="mb-4 flex items-start gap-3 p-4 text-[13px] text-muted" data-testid="meetings-off"><IconVideoOff className="mt-0.5 h-4 w-4 shrink-0" />{VIDEO_OFF}</Card>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Guest link</h2>
          <p className="mt-1 text-[13px] text-muted">Anyone with this link can join from a browser. No account or app needed.</p>
          <div className="mt-3 flex items-center gap-2"><Input readOnly value={m.guestUrl} aria-label="Guest link" className="font-mono text-[12.5px]" /><CopyButton value={m.guestUrl} /></div>
          <GuestsWaitSetting meetingId={m.id} value={m.guestsWait !== false} />
        </Card>
        <Card className="p-5">
          <h2 className="text-[13px] font-semibold">Guests</h2>
          {m.invitees.length ? <ul className="mt-2 space-y-1 text-[13px]">{m.invitees.map((g) => <li key={g} className="flex items-center gap-2"><IconMail className="h-3.5 w-3.5 text-muted" />{g}</li>)}</ul> : <p className="mt-1 text-[13px] text-muted">No guests yet. Share the link, or schedule with guest emails.</p>}
          {m.invitees.length > 0 && m.status === "scheduled" && <div className="mt-3 flex items-center gap-3"><Button size="sm" variant="secondary" onClick={() => void invite()}>{m.invitesSentAt ? "Send invites again" : "Send calendar invites"}</Button>{m.invitesSentAt && <span className="text-[12px] text-subtle">Sent {when(m.invitesSentAt)}</span>}</div>}
        </Card>
      </div>
      {webinarOn && <WebinarCard meetingId={m.id} status={m.status} />}
      {m.recurrence && (
        <Card className="mt-4 flex items-start gap-3 p-5" data-testid="meeting-series">
          <IconRepeat className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold">{m.recurrence.summary}</h2>
            <p className="mt-1 text-[13px] text-muted">First meeting {when(m.startsAt)}. Changes apply to every meeting in the series, and the same guest link works each time.</p>
          </div>
        </Card>
      )}
      {cfg?.videoRecVid2 && (me.data?.organization?.role === "owner" || me.data?.organization?.role === "admin") && <RecoverRecording meetingId={m.id} className="mb-4" phone={phonePage} />}
      {phonePage && <PhoneSaves className="mb-4" />}
      <RecordingSection meetingId={m.id} title={m.title} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}><IconEdit className="h-4 w-4" />{m.recurrence ? "Edit series" : "Edit"}</Button>
        <a href={`/api/meetings/${m.id}/ics`} download className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted hover:bg-hover hover:text-fg"><IconDownload className="h-4 w-4" />Calendar file</a>
        {m.status === "scheduled" && <><Button size="sm" variant="ghost" onClick={() => void setStatus("ended")}>Mark as ended</Button><Button size="sm" variant="ghost" onClick={() => void setStatus("cancelled")}>{m.recurrence ? "Cancel series" : "Cancel meeting"}</Button></>}
      </div>
      <MeetingNotes meetingId={m.id} />
      {meetTd3 && <MeetingSuggestions meetingId={m.id} />}
      <ReferencesPanel type="meeting" id={m.id} />
      {editing && <EditMeetingDialog m={m} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void qc.invalidateQueries({ queryKey: ["meeting", id] }); void qc.invalidateQueries({ queryKey: ["meetings"] }); }} />}
    </div>
  );
}

/** Edits the meeting, or the whole series when it repeats. */
function EditMeetingDialog({ m, onClose, onSaved }: { m: Meeting; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(m.title);
  const [at, setAt] = useState(() => isoToZonedInput(new Date(m.startsAt)));
  const [duration, setDuration] = useState(String(m.durationMin));
  const [repeat, setRepeat] = useState<RepeatState>(() => repeatOf(m.recurrence));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const startsAt = zonedInputToIso(at);
      await api.patch(`/meetings/${m.id}`, { title, durationMin: Number(duration), ...(startsAt !== m.startsAt ? { startsAt } : {}), recurrence: repeatBody(repeat) });
      toast.success(m.recurrence || repeat.every !== "none" ? "Series saved" : "Meeting saved");
      onSaved();
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={m.recurrence ? "Edit series" : "Edit meeting"} description={m.recurrence ? "Changes apply to every meeting in the series." : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()} loading={busy}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Title">{(fp) => (<Input {...fp} value={title} onChange={(e) => setTitle(e.target.value)} />)}</Field>
        <div className="grid grid-cols-[1fr_110px] gap-3">
          <Field label={`${m.recurrence ? "First meeting" : "Starts"} (${tz()})`}>{(fp) => (<Input {...fp} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />)}</Field>
          <Field label="Minutes">{(fp) => (<Input {...fp} type="number" min={5} max={480} value={duration} onChange={(e) => setDuration(e.target.value)} />)}</Field>
        </div>
        <RepeatFields value={repeat} onChange={setRepeat} startDay={dayOfInput(at)} />
      </div>
    </Dialog>
  );
}

/** The guest page at /m/<token>: a name, then the call. */
export function GuestMeetingPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["guest-meeting", token], queryFn: async () => (await api.get<{ meeting: { title: string; startsAt: string; durationMin: number; status: string; host: string; videoEnabled: boolean; guestsWait?: boolean } }>(`/public/meetings/${token}`)).meeting, retry: false });
  // Round 32: who is already in ("Maya and 2 others are here"), and the waiting room.
  const here = useQuery({
    queryKey: ["guest-here", token], enabled: !!q.data && q.data.status === "scheduled" && q.data.videoEnabled, refetchInterval: 15_000, retry: false,
    queryFn: () => api.get<{ names: string[]; count: number }>(`/public/meeting-lobby/${token}/here`),
  });
  const [lobby, setLobby] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [join, setJoin] = useState<Join | null>(null);
  const [left, setLeft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prefs, setPrefs] = useState<JoinPrefs | undefined>();
  const go = async (p?: JoinPrefs, lobbyId?: string) => {
    setBusy(true);
    try { setJoin(await api.post<Join>(`/public/meetings/${token}/join`, { name: p?.name ?? name, ...(lobbyId ? { lobbyId } : {}) })); setPrefs(p); setLeft(false); setLobby(null); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  /** With the waiting room on, ask first and wait; otherwise join straight away. */
  const ask = async (p: JoinPrefs) => {
    if (!q.data?.guestsWait) return go(p);
    setBusy(true);
    try {
      const r = await askToJoin(token!, p.name ?? name);
      setPrefs(p);
      if (r.lobbyId) setLobby({ id: r.lobbyId, name: p.name ?? name }); else { setBusy(false); return go(p); }
    } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const m = q.data;
  return (
    <main className="min-h-dvh bg-bg px-4 py-6 text-fg">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between"><Logo /><span className="text-[12px] text-subtle">Video meeting</span></div>
        {q.isPending ? <Skeleton className="h-40" /> : !m ? <Card className="p-8 text-center"><h1 className="text-lg font-semibold">This meeting link doesn't work</h1><p className="mt-1 text-[13px] text-muted">Ask whoever invited you for a new link.</p></Card>
          : join ? <Room join={join} prefs={prefs} member={false} guestToken={token} onLeave={() => { setJoin(null); setLeft(true); }} />
          : lobby ? <Card className="mx-auto max-w-3xl p-6"><GuestLobby token={token!} lobbyId={lobby.id} name={lobby.name} prefs={prefs} title={m.title} onAdmitted={() => void go(prefs, lobby.id)} onLeave={() => setLobby(null)} onAskAgain={() => { if (prefs) void ask(prefs); }} /></Card>
          : (
            <Card className={m.status === "scheduled" && m.videoEnabled ? "mx-auto max-w-3xl p-6" : "mx-auto max-w-md p-6"} data-testid="guest-meeting">
              <p className="text-[12.5px] text-muted">{m.host} invited you to</p>
              <h1 className="mt-1 text-xl font-semibold">{m.title}</h1>
              <p className="mt-1 text-[13px] text-muted">{when(m.startsAt)} · {m.durationMin} minutes</p>
              {left && <p className="mt-3 text-[13px] text-muted">You left the meeting. Join again below.</p>}
              {m.status !== "scheduled" ? <p className="mt-4 text-[13px]">{m.status === "cancelled" ? "This meeting was cancelled." : "This meeting has ended."}</p>
                : !m.videoEnabled ? <p className="mt-4 text-[13px] text-muted">The video service isn't switched on yet. Try again at the meeting time, or reply to the invite.</p>
                : (
                  <div className="mt-5"><PreJoin bare title={m.title} who={{ mode: "guest" }} inCall={here.data?.names} inCallCount={here.data?.count} busy={busy} joinLabel={m.guestsWait ? "Ask to join" : "Join meeting"} footnote={PREJOIN_NOTE} onJoin={(p) => { setName(p.name ?? ""); void ask(p); }} /></div>
                )}
            </Card>
          )}
      </div>
    </main>
  );
}
