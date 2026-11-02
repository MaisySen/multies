/**
 * R114: webinar mode for meetings (flag WEBINAR_R114). The Webinar card on a meeting, the host page
 * (/app/meetings/:id/webinar: live questions, chat, polls and stage; registrations and report; replay; settings),
 * and the public pages: registration (/w/:slug), the attendee page from a personal link (/w/a/:token) and the replay.
 * Attendees watch only. Real video needs the meeting video service; everything else works without it.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GridLayout, LiveKitRoom, ParticipantTile, RoomAudioRenderer, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import "@livekit/components-styles";
import { toast } from "sonner";
import { api, ApiError } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { Field, Input, Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, CopyButton, EmptyState, PageHeader, Skeleton, StatTile, Switch, tableStyles } from "@/web/components/ui/misc";
import { IconDownload, IconVideo } from "@/web/components/ui/icon";
import { LoadFailure } from "@/web/components/load-error-t1g"; // POL1
import { usePageTitle } from "@/web/lib/page-title-pol1"; // POL1
import { Logo } from "@/web/components/logo";
import { useConfig, useTeam } from "@/web/lib/queries";

type ChatMode = "everyone" | "hosts" | "off";
type Panelist = { kind: "member" | "registrant"; id: string; name: string };
type Phase = "upcoming" | "open" | "ended" | "cancelled";
export type WebinarSettings = {
  meetingId: string; enabled: boolean; canManage: boolean; registrationOpen: boolean; chatMode: ChatMode; description: string;
  registrationUrl: string | null; panelists: Panelist[]; replay: { recordingId: string | null; shared: boolean }; phase: Phase;
  cap: { cap: number; by: "room" | "minutes"; minutesLeft: number | null; text: string }; registered: number | null;
};
type PollResult = { label: string; count: number };
type HostPoll = { id: string; kind: "poll" | "cloud"; question: string; options: string[]; open: boolean; total: number; results: PollResult[] };
type Live = {
  canManage: boolean; chatMode: ChatMode; panelists: Panelist[]; qaPollId: string | null;
  questions: { id: string; body: string; authorName: string; votes: number; answered: boolean; hidden: boolean; answer: string | null }[];
  chat: { id: string; authorName: string; authorKind: string; body: string; hidden: boolean; createdAt: string }[];
  attendees: { id: string; name: string; joined: boolean; watchingNow: boolean }[];
  polls: HostPoll[];
};
type Report = {
  title: string; totals: { registered: number; attended: number; averageMinutes: number; questions: number; answered: number };
  people: { id: string; name: string; email: string; registeredAt: string; attended: boolean; minutesWatched: number; questions: number }[];
  polls: { id: string; question: string; closed: boolean; results: PollResult[] }[];
};
type Join = { url: string; token: string; room: string };

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const CHAT_LABEL: Record<ChatMode, string> = { everyone: "Everyone can chat", hosts: "Only hosts and panelists", off: "Chat off" };
const PHASE_LABEL: Record<Phase, string> = { upcoming: "Not started", open: "Open now", ended: "Ended", cancelled: "Cancelled" };
const NO_VIDEO_REPLAY = "Recordings keep the transcript and summary, not video.";

export function useWebinarOn() { return !!useConfig().data?.webinar; }

// ------------------------------------------------------------------ meeting page card

export function WebinarCard({ meetingId, status }: { meetingId: string; status: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["webinar", meetingId], queryFn: async () => (await api.get<{ webinar: WebinarSettings }>(`/webinars/${meetingId}`)).webinar });
  const [busy, setBusy] = useState(false);
  const w = q.data;
  const toggle = async (on: boolean) => {
    setBusy(true);
    try { const r = await api.patch<{ webinar: WebinarSettings }>(`/webinars/${meetingId}`, { enabled: on }); qc.setQueryData(["webinar", meetingId], r.webinar); toast.success(on ? "Webinar mode is on" : "Webinar mode is off"); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="mt-4 p-5" data-testid="webinar-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">Webinar</h2>
          <p className="mt-1 text-[13px] text-muted">Hosts and panelists are on stage. Everyone else registers, watches, asks questions and votes in polls.</p>
        </div>
        {w?.canManage && status === "scheduled" && <Switch checked={!!w.enabled} onChange={(v) => void toggle(v)} label="Make this a webinar" disabled={busy} />}
      </div>
      {q.isPending ? <Skeleton className="mt-3 h-10" /> : q.error ? <LoadFailure error={q.error} onRetry={() => q.refetch()} className="mt-3" /> : w && w.enabled ? (
        <div className="mt-3 space-y-3">
          {w.registrationUrl && <div className="flex items-center gap-2"><Input readOnly value={w.registrationUrl} aria-label="Registration link" className="font-mono text-[12.5px]" /><CopyButton value={w.registrationUrl} /></div>}
          <p className="text-[12.5px] text-muted" data-testid="webinar-cap">{w.cap.text}</p>
          <div className="flex flex-wrap items-center gap-2">
            {w.registered !== null && <Badge tone="brand">{w.registered} registered</Badge>}
            <Badge>{w.registrationOpen ? "Registration open" : "Registration closed"}</Badge>
            <Badge>{CHAT_LABEL[w.chatMode]}</Badge>
            <ButtonLink size="sm" variant="secondary" to={`/app/meetings/${meetingId}/webinar`} className="ml-auto" data-testid="open-webinar">Open webinar</ButtonLink>
          </div>
        </div>
      ) : <p className="mt-3 text-[12.5px] text-subtle">{w?.canManage ? "Turn it on to get a registration page." : "Only the host or an admin can turn on webinar mode."}</p>}
    </Card>
  );
}

const PANELS = ["questions", "polls", "chat"] as const;

/** Arrow keys, Home and End move between tabs (roving focus), as in other tab lists. */
function onTabKeys<T extends string>(e: KeyboardEvent<HTMLElement>, ids: readonly T[], current: T, set: (id: T) => void) {
  const i = ids.indexOf(current);
  const next = e.key === "ArrowRight" ? (i + 1) % ids.length : e.key === "ArrowLeft" ? (i - 1 + ids.length) % ids.length : e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  set(ids[next]);
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[next]?.focus();
}

// ------------------------------------------------------------------ host page

type Tab = "live" | "report" | "replay" | "settings";
export function WebinarHostPage() {
  const { id } = useParams();
  const meeting = useQuery({ queryKey: ["meeting", id], queryFn: async () => (await api.get<{ meeting: { id: string; title: string; startsAt: string; durationMin: number; status: string } }>(`/meetings/${id}`)).meeting });
  const q = useQuery({ queryKey: ["webinar", id], queryFn: async () => (await api.get<{ webinar: WebinarSettings }>(`/webinars/${id}`)).webinar });
  const [tab, setTab] = useState<Tab>("live");
  const w = q.data, m = meeting.data;
  usePageTitle(m ? [`${m.title || "Meeting"} webinar`, "Meetings"] : null); // POL1
  // POL1: the shared card with Retry (a refused read keeps its own words), retrying whichever read failed.
  if (q.error || meeting.error) return <Card data-testid="webinar-error"><LoadFailure error={q.error || meeting.error} onRetry={() => { if (meeting.error) void meeting.refetch(); if (q.error) void q.refetch(); }} block /></Card>;
  if (!w || !m) return <Skeleton className="h-40" />;
  if (!w.enabled) return <Card><EmptyState icon={<IconVideo />} title="Webinar mode is off" body="Turn it on from the meeting page to get a registration page." action={<ButtonLink to={`/app/meetings/${id}`} variant="secondary">Back to the meeting</ButtonLink>} /></Card>;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "live", label: "Live", show: true }, { id: "report", label: "Registrations and report", show: w.canManage },
    { id: "replay", label: "Replay", show: w.canManage }, { id: "settings", label: "Settings", show: w.canManage },
  ];
  return (
    <div data-testid="webinar-host">
      <PageHeader eyebrow="Webinar" title={m.title} description={<>{when(m.startsAt)} · {m.durationMin} minutes · <Link className="text-brand-hover underline underline-offset-2" to={`/app/meetings/${m.id}`}>Meeting page</Link></>}
        actions={<Badge tone={w.phase === "open" ? "ok" : "neutral"}>{PHASE_LABEL[w.phase]}</Badge>} />
      <div role="tablist" aria-label="Webinar" className="mb-4 flex gap-1 overflow-x-auto border-b border-line" onKeyDown={(e) => onTabKeys(e, tabs.filter((t) => t.show).map((t) => t.id), tab, setTab)}>
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)} data-testid={`webinar-tab-${t.id}`}
            className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium", tab === t.id ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>{t.label}</button>
        ))}
      </div>
      {tab === "live" && <LiveTab meetingId={m.id} />}
      {tab === "report" && w.canManage && <ReportTab meetingId={m.id} panelists={w.panelists} />}
      {tab === "replay" && w.canManage && <ReplayTab meetingId={m.id} w={w} />}
      {tab === "settings" && w.canManage && <SettingsTab w={w} />}
    </div>
  );
}

function LiveTab({ meetingId }: { meetingId: string }) {
  const q = useQuery({ queryKey: ["webinar-live", meetingId], refetchInterval: 5000, queryFn: () => api.get<Live>(`/webinars/${meetingId}/live`) });
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["webinar-live", meetingId] });
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 403) return (
      <div data-testid="webinar-not-host"><EmptyState icon={<IconVideo />} title="Hosts and panelists run this webinar" body="You can join from the meeting page and watch. Ask the host to add you as a panelist if you need to speak or see the questions." action={<ButtonLink to={`/app/meetings/${meetingId}`} variant="secondary">Back to the meeting</ButtonLink>} /></div>
    );
    return <Card><LoadFailure error={q.error} onRetry={() => q.refetch()} block /></Card>; // POL1
  }
  if (!q.data) return <Skeleton className="h-60" />;
  const d = q.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-4">
        <QuestionsPanel meetingId={meetingId} d={d} onChange={refresh} />
        <PollsPanel meetingId={meetingId} d={d} onChange={refresh} />
      </div>
      <div className="space-y-4">
        <HostChat meetingId={meetingId} d={d} onChange={refresh} />
        <StagePanel meetingId={meetingId} d={d} onChange={refresh} />
      </div>
    </div>
  );
}

function QuestionsPanel({ meetingId, d, onChange }: { meetingId: string; d: Live; onChange: () => void }) {
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const act = async (id: string, body: Record<string, unknown>) => { try { await api.post(`/webinars/${meetingId}/questions/${id}`, body); setAnswering(null); setAnswer(""); onChange(); } catch (e) { showError(e as Error); } };
  return (
    <Card className="p-5" data-testid="webinar-questions">
      <h2 className="text-[13px] font-semibold">Questions <span className="font-normal text-muted">({d.questions.filter((x) => !x.hidden).length})</span></h2>
      {!d.questions.length ? <p className="mt-2 text-[12.5px] text-subtle">No questions yet. Attendees ask from their webinar page; the most upvoted rise to the top.</p> : (
        <ul className="mt-2 divide-y divide-line">
          {d.questions.map((x) => (
            <li key={x.id} className={cn("py-3", x.hidden && "-mx-2 rounded-md border border-dashed border-line-strong px-2")}>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 min-w-8 rounded-md bg-fill px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums" aria-label={`${x.votes} upvotes`}>{x.votes}</span>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13.5px]">{x.body}</p>
                  <p className="mt-0.5 text-[12px] text-muted">{x.authorName}{x.answered && " · Answered"}{x.hidden && " · Hidden from attendees"}</p>
                  {x.answer && <p className="mt-1 rounded-md bg-fill px-2 py-1 text-[12.5px]">{x.answer}</p>}
                  {answering === x.id && (
                    <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(x.id, { answer }); }}>
                      <Input autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type an answer" aria-label="Answer" maxLength={1000} />
                      <Button size="sm" type="submit" disabled={!answer.trim()}>Send</Button>
                    </form>
                  )}
                </div>
              </div>
              {d.canManage && (
                <div className="mt-2 flex flex-wrap gap-1 pl-11">
                  <Button size="sm" variant="ghost" onClick={() => void act(x.id, { answered: !x.answered })}>{x.answered ? "Mark open" : "Answered live"}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAnswering(answering === x.id ? null : x.id); setAnswer(x.answer ?? ""); }}>Type an answer</Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(x.id, { hidden: !x.hidden })} aria-label={x.hidden ? "Show question" : "Hide question"}>{x.hidden ? "Show" : "Hide"}</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PollsPanel({ meetingId, d, onChange }: { meetingId: string; d: Live; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [busy, setBusy] = useState(false);
  const launch = async () => {
    setBusy(true);
    try { await api.post(`/webinars/${meetingId}/polls`, { question, options: options.filter((o) => o.trim()) }); setOpen(false); setQuestion(""); setOptions(["", ""]); onChange(); toast.success("Poll launched"); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const close = async (pollId: string) => { try { await api.post(`/webinars/${meetingId}/polls/${pollId}/close`); onChange(); } catch (e) { showError(e as Error); } };
  return (
    <Card className="p-5" data-testid="webinar-polls">
      <div className="flex items-center justify-between gap-2"><h2 className="text-[13px] font-semibold">Polls</h2>{d.canManage && !open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="webinar-new-poll">Launch a poll</Button>}</div>
      {open && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void launch(); }}>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question" aria-label="Poll question" maxLength={300} autoFocus />
          {options.map((o, i) => <Input key={i} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Choice ${i + 1}`} aria-label={`Choice ${i + 1}`} maxLength={120} />)}
          <div className="flex flex-wrap gap-2">
            {options.length < 6 && <Button size="sm" variant="ghost" type="button" onClick={() => setOptions([...options, ""])}>Add a choice</Button>}
            <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit" loading={busy} disabled={!question.trim() || options.filter((o) => o.trim()).length < 2}>Launch</Button>
          </div>
        </form>
      )}
      {!d.polls.length ? !open && <p className="mt-2 text-[12.5px] text-subtle">No polls yet. Launch one and attendees vote from their page.</p> : (
        <ul className="mt-3 space-y-3">{d.polls.map((p) => (
          <li key={p.id} className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-2"><p className="text-[13.5px] font-medium">{p.question}</p>{p.open && d.canManage ? <Button size="sm" variant="ghost" onClick={() => void close(p.id)}>Close</Button> : <Badge>{p.open ? "Open" : "Closed"}</Badge>}</div>
            <Results results={p.results} total={p.total} />
          </li>
        ))}</ul>
      )}
    </Card>
  );
}

function Results({ results, total }: { results: PollResult[]; total: number }) {
  const max = Math.max(1, ...results.map((r) => r.count));
  return (
    <ul className="mt-2 space-y-1.5" aria-label="Results">
      {results.map((r, i) => (
        <li key={i} className="text-[12.5px]">
          <div className="flex justify-between gap-2"><span className="min-w-0 break-words">{r.label}</span><span className="tabular-nums text-muted">{r.count}</span></div>
          <div className="mt-0.5 h-1.5 rounded-full bg-fill"><div className="h-1.5 rounded-full bg-brand" style={{ width: `${Math.round((r.count / max) * 100)}%` }} /></div>
        </li>
      ))}
      <li className="text-[12px] text-subtle">{total} {total === 1 ? "vote" : "votes"}</li>
    </ul>
  );
}

function HostChat({ meetingId, d, onChange }: { meetingId: string; d: Live; onChange: () => void }) {
  const [text, setText] = useState("");
  const send = async () => { try { await api.post(`/webinars/${meetingId}/chat`, { body: text }); setText(""); onChange(); } catch (e) { showError(e as Error); } };
  const hide = async (id: string, hidden: boolean) => { try { await api.post(`/webinars/${meetingId}/chat/${id}/hide`, { hidden }); onChange(); } catch (e) { showError(e as Error); } };
  const setMode = async (chatMode: ChatMode) => { try { await api.patch(`/webinars/${meetingId}`, { chatMode }); onChange(); } catch (e) { showError(e as Error); } };
  return (
    <Card className="p-5" data-testid="webinar-host-chat">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Chat</h2>
        {d.canManage ? <Select value={d.chatMode} onChange={(e) => void setMode(e.target.value as ChatMode)} aria-label="Who can chat" className="w-auto text-[12.5px]">
          {(Object.keys(CHAT_LABEL) as ChatMode[]).map((k) => <option key={k} value={k}>{CHAT_LABEL[k]}</option>)}
        </Select> : <Badge>{CHAT_LABEL[d.chatMode]}</Badge>}
      </div>
      <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
        {!d.chat.length && <li className="text-[12.5px] text-subtle">No messages yet.</li>}
        {d.chat.map((c) => (
          <li key={c.id} className={cn("group flex items-start gap-2 text-[13px]", c.hidden && "-mx-2 rounded-md border border-dashed border-line-strong px-2 py-1")}>
            <div className="min-w-0 flex-1"><span className="font-medium">{c.authorName}</span>{c.authorKind === "member" && <span className="ml-1 text-[11px] text-brand-hover">Host</span>} <span className="break-words">{c.body}</span>{c.hidden && <Badge className="ml-1">Hidden from attendees</Badge>}</div>
            {d.canManage && <Button size="sm" variant="ghost" onClick={() => void hide(c.id, !c.hidden)} aria-label={c.hidden ? "Show message" : "Hide message"}>{c.hidden ? "Show" : "Hide"}</Button>}
          </li>
        ))}
      </ul>
      {d.chatMode !== "off" && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message everyone" aria-label="Chat message" maxLength={500} />
          <Button type="submit" size="sm" disabled={!text.trim()}>Send</Button>
        </form>
      )}
    </Card>
  );
}

function StagePanel({ meetingId, d, onChange }: { meetingId: string; d: Live; onChange: () => void }) {
  const team = useTeam();
  const [pick, setPick] = useState("");
  const set = async (kind: Panelist["kind"], id: string, on: boolean) => { try { await api.post(`/webinars/${meetingId}/panelists`, { kind, id, on }); setPick(""); onChange(); } catch (e) { showError(e as Error); } };
  const onStage = new Set(d.panelists.map((p) => `${p.kind}:${p.id}`));
  type TM = { userId?: string; id?: string; name?: string | null; email?: string; kind?: string };
  const members = ((team.data?.members ?? []) as unknown as TM[]).filter((x) => x.kind !== "agent").map((x) => ({ id: (x.userId ?? x.id) as string, name: x.name || x.email || "Member" })).filter((x) => !onStage.has(`member:${x.id}`));
  return (
    <Card className="p-5" data-testid="webinar-stage">
      <h2 className="text-[13px] font-semibold">Stage</h2>
      <p className="mt-1 text-[12.5px] text-muted">Hosts and panelists can speak and share their screen. Attendees watch.</p>
      <ul className="mt-2 space-y-1">
        {!d.panelists.length && <li className="text-[12.5px] text-subtle">No panelists yet.</li>}
        {d.panelists.map((p) => (
          <li key={`${p.kind}:${p.id}`} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate">{p.name} <span className="text-[11.5px] text-muted">{p.kind === "member" ? "Member" : "Registered"}</span></span>
            {d.canManage && <Button size="sm" variant="ghost" onClick={() => void set(p.kind, p.id, false)}>Move to audience</Button>}
          </li>
        ))}
      </ul>
      {d.canManage && members.length > 0 && (
        <div className="mt-3 flex gap-2">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a panelist" className="text-[12.5px]">
            <option value="">Add a member as panelist</option>
            {members.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!pick} onClick={() => void set("member", pick, true)}>Add</Button>
        </div>
      )}
      {d.canManage && d.attendees.length > 0 && (
        <>
          <h3 className="mt-4 text-[12.5px] font-semibold">Audience <span className="font-normal text-muted">({d.attendees.filter((a) => a.watchingNow).length} watching now)</span></h3>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {d.attendees.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0 truncate">{a.name}{a.watchingNow && <span className="ml-1 text-[11.5px] text-ok">Watching</span>}</span>
                {!onStage.has(`registrant:${a.id}`) && <Button size="sm" variant="ghost" onClick={() => void set("registrant", a.id, true)}>Bring on stage</Button>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

function ReportTab({ meetingId }: { meetingId: string; panelists: Panelist[] }) {
  const q = useQuery({ queryKey: ["webinar-report", meetingId], queryFn: () => api.get<Report>(`/webinars/${meetingId}/report`) });
  if (q.error) return <Card><LoadFailure error={q.error} onRetry={() => q.refetch()} block /></Card>; // POL1
  if (!q.data) return <Skeleton className="h-60" />;
  const r = q.data;
  return (
    <div className="space-y-4" data-testid="webinar-report">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Registered" value={r.totals.registered} />
        <StatTile label="Attended" value={r.totals.attended} hint={r.totals.registered ? `${Math.round((r.totals.attended / r.totals.registered) * 100)}% of registered` : undefined} />
        <StatTile label="Average minutes watched" value={r.totals.averageMinutes} />
        <StatTile label="Questions" value={r.totals.questions} hint={`${r.totals.answered} answered`} />
      </div>
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">People</h2>
          <a className="inline-flex items-center gap-1.5 rounded-lg bg-fill px-3 py-1.5 text-[12.5px] font-medium hover:bg-hover" href={`/api/webinars/${meetingId}/report.csv`} download data-testid="webinar-csv"><IconDownload className="h-3.5 w-3.5" />Download CSV</a>
        </div>
        {!r.people.length ? <p className="text-[12.5px] text-subtle">No one has registered yet. Share the registration link from the meeting page.</p> : (
          <div className={tableStyles.wrap} tabIndex={0} role="region" aria-label="Registrations">
            <table className={tableStyles.table}>
              <thead><tr className="text-left text-[12px] text-muted"><th className="px-3 py-2 font-medium">Name</th><th className="px-3 py-2 font-medium">Email</th><th className="px-3 py-2 font-medium">Attended</th><th className="px-3 py-2 text-right font-medium">Minutes</th><th className="px-3 py-2 text-right font-medium">Questions</th></tr></thead>
              <tbody className="divide-y divide-line">{r.people.map((p) => (
                <tr key={p.id} className="text-[13px]"><td className="max-w-48 truncate px-3 py-2">{p.name}</td><td className="max-w-56 truncate px-3 py-2 text-muted">{p.email}</td><td className="px-3 py-2">{p.attended ? "Yes" : "No"}</td><td className="px-3 py-2 text-right tabular-nums">{p.minutesWatched}</td><td className="px-3 py-2 text-right tabular-nums">{p.questions}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {r.polls.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">Poll results</h2><ul className="mt-2 space-y-4">{r.polls.map((p) => <li key={p.id}><p className="text-[13.5px] font-medium">{p.question}</p><Results results={p.results} total={p.results.reduce((n, x) => n + x.count, 0)} /></li>)}</ul></Card>}
    </div>
  );
}

function ReplayTab({ meetingId, w }: { meetingId: string; w: WebinarSettings }) {
  const qc = useQueryClient();
  const recs = useQuery({ queryKey: ["recordings", meetingId], queryFn: async () => (await api.get<{ recordings: { id: string; status: string; startedAt: string; durationSec: number }[] }>(`/meetings/${meetingId}/recordings`)).recordings });
  const [pick, setPick] = useState(w.replay.recordingId ?? "");
  const save = async (shared: boolean) => {
    try { const r = await api.put<{ webinar: WebinarSettings }>(`/webinars/${meetingId}/replay`, { recordingId: pick || null, shared }); qc.setQueryData(["webinar", meetingId], r.webinar); toast.success(shared ? "Replay shared with everyone who registered" : "Replay saved"); }
    catch (e) { showError(e as Error); }
  };
  const done = (recs.data ?? []).filter((r) => r.status === "done");
  return (
    <Card className="p-5" data-testid="webinar-replay-settings">
      <h2 className="text-[13px] font-semibold">Replay</h2>
      <p className="mt-1 text-[12.5px] text-muted">Share a recording of this meeting with everyone who registered. They open it from their personal link. {NO_VIDEO_REPLAY}</p>
      {recs.isPending ? <Skeleton className="mt-3 h-10" /> : !done.length ? <p className="mt-3 text-[12.5px] text-subtle">No finished recordings yet. Press Record during the webinar, and the transcript and summary show up here when it ends.</p> : (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Recording">
            <option value="">No replay</option>
            {done.map((r) => <option key={r.id} value={r.id}>{when(r.startedAt)} · {Math.round(r.durationSec / 60)} minutes</option>)}
          </Select>
          <Button size="sm" onClick={() => void save(!!pick)}>{pick ? "Share replay" : "Stop sharing"}</Button>
        </div>
      )}
      {w.replay.shared && <p className="mt-3 text-[12.5px] text-ok">Shared with everyone who registered.</p>}
    </Card>
  );
}

function SettingsTab({ w }: { w: WebinarSettings }) {
  const qc = useQueryClient();
  const [description, setDescription] = useState(w.description);
  const patch = async (body: Partial<Pick<WebinarSettings, "registrationOpen" | "chatMode" | "description" | "enabled">>) => {
    try { const r = await api.patch<{ webinar: WebinarSettings }>(`/webinars/${w.meetingId}`, body); qc.setQueryData(["webinar", w.meetingId], r.webinar); toast.success("Saved"); } catch (e) { showError(e as Error); }
  };
  return (
    <Card className="space-y-5 p-5" data-testid="webinar-settings">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-[13px] font-semibold">Registration</h2><p className="mt-1 text-[12.5px] text-muted">{w.cap.text}</p></div><Switch checked={w.registrationOpen} onChange={(v) => void patch({ registrationOpen: v })} label="Registration open" /></div>
      <Field label="About this webinar" hint="Shown on the registration page.">
        {(p) => <Textarea {...p} rows={3} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== w.description && void patch({ description })} />}
      </Field>
      <Field label="Who can chat">
        {(p) => <Select {...p} value={w.chatMode} onChange={(e) => void patch({ chatMode: e.target.value as ChatMode })}>{(Object.keys(CHAT_LABEL) as ChatMode[]).map((k) => <option key={k} value={k}>{CHAT_LABEL[k]}</option>)}</Select>}
      </Field>
      <p className="text-[12px] text-subtle">Streaming to thousands of people is not part of webinars yet.</p>
    </Card>
  );
}

// ------------------------------------------------------------------ public pages

function PublicShell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-dvh bg-bg px-4 py-6 text-fg">
      <div className={cn("mx-auto", wide ? "max-w-6xl" : "max-w-xl")}>
        <div className="mb-6"><Logo /></div>
        {children}
      </div>
    </main>
  );
}

type PublicInfo = { title: string; description: string; host: string; startsAt: string; durationMin: number; phase: Phase; registrationOpen: boolean; full: boolean; capText: string; panelists: string[] };
export function WebinarRegisterPage() {
  const { slug } = useParams();
  const q = useQuery({ queryKey: ["webinar-public", slug], retry: false, queryFn: () => api.get<PublicInfo>(`/public/webinars/r/${slug}`) });
  const openedAt = useRef(Date.now());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ status: "registered" | "already"; joinUrl?: string; message?: string; mailed?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError("Enter an email like name@example.com."); return; }
    setBusy(true); setError(null);
    try { setDone(await api.post(`/public/webinars/r/${slug}/register`, { name, email, website, openedAt: openedAt.current })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const i = q.data;
  return (
    <PublicShell>
      {q.isPending ? <Skeleton className="h-60" /> : !i ? <Card className="p-8 text-center" data-testid="webinar-missing"><h1 className="text-lg font-semibold">This webinar link doesn't work</h1><p className="mt-1 text-[13px] text-muted">Ask the host for a new link.</p></Card> : (
        <Card className="p-6" data-testid="webinar-register">
          <p className="text-[12.5px] font-medium text-brand-hover">Webinar{i.host && ` by ${i.host}`}</p>
          <h1 className="mt-1 break-words text-xl font-semibold">{i.title}</h1>
          <p className="mt-1 text-[13px] text-muted">{when(i.startsAt)} · {i.durationMin} minutes</p>
          {i.description && <p className="mt-3 whitespace-pre-wrap break-words text-[13.5px]">{i.description}</p>}
          {i.panelists.length > 0 && <p className="mt-3 text-[12.5px] text-muted">With {i.panelists.join(", ")}</p>}
          <div className="mt-5 border-t border-line pt-5">
            {done ? (
              <div data-testid="webinar-registered" role="status">
                <h2 className="text-[15px] font-semibold">{done.status === "registered" ? "You're registered" : "You're already registered"}</h2>
                {done.status === "registered" ? <>
                  <p className="mt-1 text-[13px] text-muted">{done.mailed ? "We emailed you a personal link." : "Keep this link, it's only for you."} Open it a few minutes before the start.</p>
                  {done.joinUrl && <ButtonLink className="mt-3" to={new URL(done.joinUrl).pathname}>Open your webinar page</ButtonLink>}
                </> : <p className="mt-1 text-[13px] text-muted">{done.message}</p>}
              </div>
            ) : i.phase === "ended" || i.phase === "cancelled" ? <p className="text-[13.5px]" data-testid="webinar-closed">{i.phase === "ended" ? "This webinar has ended." : "This webinar was cancelled."}</p>
              : !i.registrationOpen ? <p className="text-[13.5px]" data-testid="webinar-closed">Registration is closed.</p>
              : i.full ? <p className="text-[13.5px]" data-testid="webinar-full">This webinar is full. {i.capText}</p> : (
              <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <h2 className="text-[15px] font-semibold">Register</h2>
                <Field label="Your name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />}</Field>
                <Field label="Email" hint="We send your personal join link here. The host sees it; other attendees never do.">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required />}</Field>
                <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden"><label>Website<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" /></label></div>
                {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
                <Button type="submit" loading={busy} disabled={!name.trim() || !email.trim()} data-testid="webinar-register-submit">Register</Button>
                <p className="text-[12px] text-subtle">{i.capText}</p>
              </form>
            )}
          </div>
        </Card>
      )}
    </PublicShell>
  );
}

type AttendeeState = {
  title: string; description: string; host: string; startsAt: string; durationMin: number; phase: Phase; me: { name: string; role: "attendee" | "panelist" };
  chatMode: ChatMode; videoEnabled: boolean; canAsk: boolean; replay: boolean;
  questions: { id: string; body: string; authorName: string; votes: number; upvoted: boolean; mine: boolean; answered: boolean; hidden: boolean; answer: string | null }[];
  polls: (HostPoll & { multi: boolean; voted: boolean; myChoices: string[]; results: PollResult[] | null })[];
  chat: { id: string; authorName: string; host: boolean; body: string; createdAt: string }[];
};

function Stage() {
  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: false }, { source: Track.Source.ScreenShare, withPlaceholder: false }], { onlySubscribed: false });
  if (!tracks.length) return <div className="flex h-full min-h-60 items-center justify-center text-center text-[13.5px] text-white/80" data-testid="webinar-waiting">Waiting for the host to start. Keep this page open.</div>;
  return <GridLayout tracks={tracks} className="h-full min-h-60"><ParticipantTile /></GridLayout>;
}

export function WebinarAttendeePage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const key = ["webinar-attendee", token];
  const q = useQuery({ queryKey: key, retry: false, refetchInterval: 5000, queryFn: () => api.get<AttendeeState>(`/public/webinars/a/${token}`) });
  const [join, setJoin] = useState<(Join & { role: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"questions" | "polls" | "chat">("questions");
  const s = q.data;
  const set = (d: AttendeeState) => qc.setQueryData(key, d);
  const go = async () => {
    setBusy(true);
    try { setJoin(await api.post(`/public/webinars/a/${token}/join`)); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  // Minutes watched: one beat a minute while the stage is open.
  useEffect(() => {
    if (!join) return;
    const t = window.setInterval(() => void api.post(`/public/webinars/a/${token}/heartbeat`).catch(() => undefined), 60_000);
    return () => window.clearInterval(t);
  }, [join, token]);
  // Promoted or moved back: reconnect with the new rights.
  useEffect(() => { if (join && s && s.me.role !== join.role) void go(); }, [s?.me.role]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isPending) return <PublicShell wide><Skeleton className="h-80" /></PublicShell>;
  if (!s) return <PublicShell><Card className="p-8 text-center" data-testid="webinar-missing"><h1 className="text-lg font-semibold">This link doesn't work</h1><p className="mt-1 text-[13px] text-muted">It may have been replaced by a newer one. Check your email for the latest link.</p></Card></PublicShell>;
  return (
    <PublicShell wide>
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between" data-testid="webinar-attendee">
        <div className="min-w-0"><p className="text-[12.5px] font-medium text-brand-hover">Webinar{s.host && ` by ${s.host}`}</p><h1 className="break-words text-xl font-semibold">{s.title}</h1><p className="text-[13px] text-muted">{when(s.startsAt)} · {s.durationMin} minutes · You're {s.me.role === "panelist" ? "a panelist" : "watching"} as {s.me.name}</p></div>
        <Badge tone={s.phase === "open" ? "ok" : "neutral"}>{PHASE_LABEL[s.phase]}</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="overflow-hidden rounded-xl bg-[#0b0d12]">
          {join ? (
            <LiveKitRoom serverUrl={join.url} token={join.token} connect audio={join.role === "panelist"} video={join.role === "panelist"} onDisconnected={() => setJoin(null)} data-lk-theme="default" className="h-full">
              <Stage /><RoomAudioRenderer />
            </LiveKitRoom>
          ) : (
            <div className="flex min-h-60 flex-col items-center justify-center gap-3 p-6 text-center text-white">
              {s.phase === "upcoming" ? <><p className="text-[15px] font-semibold" data-testid="webinar-not-started">Starts {when(s.startsAt)}</p><p className="text-[13px] text-white/70">The stage opens 15 minutes before the start. You can come back to this page any time.</p></>
                : s.phase === "open" ? (s.videoEnabled ? <Button onClick={() => void go()} loading={busy} data-testid="webinar-watch"><IconVideo className="h-4 w-4" />Watch now</Button> : <p className="text-[13px] text-white/80">Video is not switched on for this workspace yet. Questions, polls and chat still work.</p>)
                : <><p className="text-[15px] font-semibold" data-testid="webinar-ended">{s.phase === "ended" ? "This webinar has ended" : "This webinar was cancelled"}</p>{s.replay && <ButtonLink to={`/w/a/${token}/replay`} variant="secondary">Open the replay</ButtonLink>}</>}
            </div>
          )}
        </div>
        <Card className="flex min-h-80 flex-col p-0">
          <div role="tablist" aria-label="Webinar panel" className="flex border-b border-line" onKeyDown={(e) => onTabKeys(e, PANELS, panel, setPanel)}>
            {PANELS.map((p) => (
              <button key={p} role="tab" type="button" aria-selected={panel === p} tabIndex={panel === p ? 0 : -1} onClick={() => setPanel(p)} data-testid={`attendee-tab-${p}`}
                className={cn("-mb-px flex-1 border-b-2 px-3 py-2.5 text-[13px] font-medium", panel === p ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {p === "questions" ? "Questions" : p === "polls" ? `Polls${s.polls.some((x) => x.open && !x.voted) ? " •" : ""}` : "Chat"}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {panel === "questions" && <AttendeeQuestions token={token!} s={s} onState={set} />}
            {panel === "polls" && <AttendeePolls token={token!} s={s} onState={set} />}
            {panel === "chat" && <AttendeeChat token={token!} s={s} onState={set} />}
          </div>
        </Card>
      </div>
    </PublicShell>
  );
}

function AttendeeQuestions({ token, s, onState }: { token: string; s: AttendeeState; onState: (d: AttendeeState) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => { setBusy(true); try { onState(await api.post(`/public/webinars/a/${token}/questions`, { body: text })); setText(""); toast.success("Question sent"); } catch (e) { showError(e as Error); } finally { setBusy(false); } };
  const up = async (id: string) => { try { onState(await api.post(`/public/webinars/a/${token}/questions/${id}/upvote`)); } catch (e) { showError(e as Error); } };
  return (
    <div className="space-y-3">
      {s.canAsk && s.phase === "open" ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Ask the hosts a question" aria-label="Your question" maxLength={500} />
          <Button size="sm" type="submit" loading={busy} disabled={!text.trim()} data-testid="webinar-ask">Ask</Button>
        </form>
      ) : <p className="text-[12.5px] text-subtle">{s.phase === "upcoming" ? "Questions open 15 minutes before the start." : "Questions are closed."}</p>}
      {!s.questions.length ? <p className="text-[12.5px] text-subtle">No questions yet. Be the first.</p> : (
        <ul className="space-y-2">{s.questions.map((x) => (
          <li key={x.id} className="flex gap-2 rounded-lg border border-line p-2.5">
            <button type="button" onClick={() => void up(x.id)} disabled={x.mine || x.answered || x.hidden} aria-pressed={x.upvoted} aria-label={`Upvote, ${x.votes} so far`}
              className={cn("flex h-9 min-w-9 flex-col items-center justify-center rounded-md text-[12px] font-semibold tabular-nums disabled:opacity-60", x.upvoted ? "bg-brand-soft text-brand-hover" : "bg-fill")}>▲<span>{x.votes}</span></button>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13px]">{x.body}</p>
              <p className="text-[11.5px] text-muted">{x.mine ? "You" : x.authorName}{x.answered && " · Answered"}{x.hidden && " · Hidden by the host"}</p>
              {x.answer && <p className="mt-1 rounded-md bg-fill px-2 py-1 text-[12.5px]"><span className="font-medium">Answer: </span>{x.answer}</p>}
            </div>
          </li>
        ))}</ul>
      )}
    </div>
  );
}

function AttendeePolls({ token, s, onState }: { token: string; s: AttendeeState; onState: (d: AttendeeState) => void }) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const vote = async (pollId: string, choices: string[]) => { try { onState(await api.post(`/public/webinars/a/${token}/polls/${pollId}/vote`, { choices })); } catch (e) { showError(e as Error); } };
  if (!s.polls.length) return <p className="text-[12.5px] text-subtle">No polls yet. When the host launches one it shows up here.</p>;
  return (
    <ul className="space-y-3">{s.polls.map((p) => (
      <li key={p.id} className="rounded-lg border border-line p-3" data-testid="attendee-poll">
        <div className="flex items-start justify-between gap-2"><p className="text-[13.5px] font-medium">{p.question}</p>{!p.open && <Badge>Closed</Badge>}</div>
        {p.results ? <Results results={p.results} total={p.total} /> : p.kind === "poll" ? (
          <form className="mt-2 space-y-1.5" onSubmit={(e) => { e.preventDefault(); void vote(p.id, picked[p.id] ?? []); }}>
            <fieldset><legend className="sr-only">{p.question}</legend>
              {p.options.map((o, i) => (
                <label key={i} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-hover">
                  <input type={p.multi ? "checkbox" : "radio"} name={`poll-${p.id}`} checked={(picked[p.id] ?? []).includes(String(i))}
                    onChange={(e) => setPicked({ ...picked, [p.id]: p.multi ? (e.target.checked ? [...(picked[p.id] ?? []), String(i)] : (picked[p.id] ?? []).filter((x) => x !== String(i))) : [String(i)] })} />{o}
                </label>
              ))}
            </fieldset>
            <Button size="sm" type="submit" disabled={!(picked[p.id] ?? []).length} data-testid="attendee-vote">Vote</Button>
          </form>
        ) : <CloudVote onVote={(w) => void vote(p.id, [w])} />}
      </li>
    ))}</ul>
  );
}
function CloudVote({ onVote }: { onVote: (w: string) => void }) {
  const [w, setW] = useState("");
  return <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); onVote(w); }}><Input value={w} onChange={(e) => setW(e.target.value)} placeholder="One word" aria-label="Your word" maxLength={40} /><Button size="sm" type="submit" disabled={!w.trim()}>Send</Button></form>;
}

function AttendeeChat({ token, s, onState }: { token: string; s: AttendeeState; onState: (d: AttendeeState) => void }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLLIElement | null>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [s.chat.length]);
  const send = async () => { try { onState(await api.post(`/public/webinars/a/${token}/chat`, { body: text })); setText(""); } catch (e) { showError(e as Error); } };
  const canSend = s.phase === "open" && (s.chatMode === "everyone" || (s.chatMode === "hosts" && s.me.role === "panelist"));
  if (s.chatMode === "off") return <p className="text-[12.5px] text-subtle" data-testid="attendee-chat-off">The host turned chat off.</p>;
  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 space-y-2">
        {!s.chat.length && <li className="text-[12.5px] text-subtle">No messages yet.</li>}
        {s.chat.map((c) => <li key={c.id} className="text-[13px]"><span className="font-medium">{c.authorName}</span>{c.host && <span className="ml-1 text-[11px] text-brand-hover">Host</span>} <span className="break-words">{c.body}</span></li>)}
        <li ref={end} aria-hidden="true" />
      </ul>
      {canSend ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something" aria-label="Chat message" maxLength={500} />
          <Button size="sm" type="submit" disabled={!text.trim()}>Send</Button>
        </form>
      ) : <p className="mt-3 text-[12px] text-subtle">{s.chatMode === "hosts" ? "Only hosts and panelists can chat right now." : "Chat opens 15 minutes before the start."}</p>}
    </div>
  );
}

type Replay = { title: string; host: string; startsAt: string; durationSec: number; summary: string | null; decisions: string[]; transcript: string; answered: { id: string; body: string; authorName: string; answer: string | null }[]; polls: { id: string; question: string; results: PollResult[] }[] };
export function WebinarReplayPage() {
  const { token } = useParams();
  const q = useQuery({ queryKey: ["webinar-replay", token], retry: false, queryFn: () => api.get<Replay>(`/public/webinars/a/${token}/replay`) });
  const [showAll, setShowAll] = useState(false);
  const r = q.data;
  const lines = useMemo(() => (r?.transcript ?? "").split("\n"), [r?.transcript]);
  return (
    <PublicShell>
      {q.isPending ? <Skeleton className="h-60" /> : !r ? <Card className="p-8 text-center" data-testid="webinar-no-replay"><h1 className="text-lg font-semibold">No replay yet</h1><p className="mt-1 text-[13px] text-muted">{(q.error as Error | null)?.message ?? "The host has not shared a replay yet."}</p><ButtonLink className="mt-4" variant="secondary" to={`/w/a/${token}`}>Back to the webinar</ButtonLink></Card> : (
        <div className="space-y-4" data-testid="webinar-replay">
          <div><p className="text-[12.5px] font-medium text-brand-hover">Replay{r.host && ` · ${r.host}`}</p><h1 className="break-words text-xl font-semibold">{r.title}</h1><p className="text-[13px] text-muted">{when(r.startsAt)} · {Math.round(r.durationSec / 60)} minutes recorded</p><p className="mt-1 text-[12px] text-subtle">{NO_VIDEO_REPLAY}</p></div>
          {r.summary && <Card className="p-5"><h2 className="text-[13px] font-semibold">Summary</h2><p className="mt-1 whitespace-pre-wrap text-[13.5px]">{r.summary}</p>{r.decisions.length > 0 && <><h3 className="mt-3 text-[12.5px] font-semibold">Decisions</h3><ul className="mt-1 list-disc pl-5 text-[13px]">{r.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>}</Card>}
          {r.answered.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">Questions answered</h2><ul className="mt-2 space-y-2">{r.answered.map((a) => <li key={a.id} className="text-[13px]"><p className="break-words font-medium">{a.body}</p>{a.answer && <p className="text-muted">{a.answer}</p>}</li>)}</ul></Card>}
          {r.polls.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">Poll results</h2><ul className="mt-2 space-y-4">{r.polls.map((p) => <li key={p.id}><p className="text-[13.5px] font-medium">{p.question}</p><Results results={p.results} total={p.results.reduce((n, x) => n + x.count, 0)} /></li>)}</ul></Card>}
          <Card className="p-5"><h2 className="text-[13px] font-semibold">Transcript</h2>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[13px] leading-6">{(showAll ? lines : lines.slice(0, 40)).join("\n")}</pre>
            {lines.length > 40 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowAll(!showAll)}>{showAll ? "Show less" : `Show all ${lines.length} lines`}</Button>}
          </Card>
        </div>
      )}
    </PublicShell>
  );
}
