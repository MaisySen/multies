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
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-meetings"; // R104B

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
    try { const r = await api.patch<{ webinar: WebinarSettings }>(`/webinars/${meetingId}`, { enabled: on }); qc.setQueryData(["webinar", meetingId], r.webinar); toast.success(on ? tr("meetings.webinar_mode_is_on") : tr("meetings.webinar_mode_is_off")); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Card className="mt-4 p-5" data-testid="webinar-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold">{tr("meetings.webinar")}</h2>
          <p className="mt-1 text-[13px] text-muted">{tr("meetings.hosts_and_panelists_are_on_stage_everyone_else_r_2")}</p>
        </div>
        {w?.canManage && status === "scheduled" && <Switch checked={!!w.enabled} onChange={(v) => void toggle(v)} label={tr("meetings.make_this_a_webinar")} disabled={busy} />}
      </div>
      {q.isPending ? <Skeleton className="mt-3 h-10" /> : q.error ? <LoadFailure error={q.error} onRetry={() => q.refetch()} className="mt-3" /> : w && w.enabled ? (
        <div className="mt-3 space-y-3">
          {w.registrationUrl && <div className="flex items-center gap-2"><Input readOnly value={w.registrationUrl} aria-label={tr("meetings.registration_link")} className="font-mono text-[12.5px]" /><CopyButton value={w.registrationUrl} /></div>}
          <p className="text-[12.5px] text-muted" data-testid="webinar-cap">{w.cap.text}</p>
          <div className="flex flex-wrap items-center gap-2">
            {w.registered !== null && <Badge tone="brand">{w.registered} {tr("meetings.registered")}</Badge>}
            <Badge>{w.registrationOpen ? tr("meetings.registration_open") : tr("meetings.registration_closed")}</Badge>
            <Badge>{CHAT_LABEL[w.chatMode]}</Badge>
            <ButtonLink size="sm" variant="secondary" to={`/app/meetings/${meetingId}/webinar`} className="ml-auto" data-testid="open-webinar">{tr("meetings.open_webinar")}</ButtonLink>
          </div>
        </div>
      ) : <p className="mt-3 text-[12.5px] text-subtle">{w?.canManage ? tr("meetings.turn_it_on_to_get_a_registration_page") : tr("meetings.only_the_host_or_an_admin_can_turn_on_webinar_mo")}</p>}
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
  if (!w.enabled) return <Card><EmptyState icon={<IconVideo />} title={tr("meetings.webinar_mode_is_off")} body="Turn it on from the meeting page to get a registration page." action={<ButtonLink to={`/app/meetings/${id}`} variant="secondary">{tr("meetings.back_to_the_meeting")}</ButtonLink>} /></Card>;
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "live", label: tr("meetings.live"), show: true }, { id: "report", label: tr("meetings.registrations_and_report"), show: w.canManage },
    { id: "replay", label: tr("meetings.replay"), show: w.canManage }, { id: "settings", label: tr("common.settings"), show: w.canManage },
  ];
  return (
    <div data-testid="webinar-host">
      <PageHeader eyebrow="Webinar" title={m.title} description={<>{when(m.startsAt)} · {m.durationMin} {tr("meetings.minutes_3")} <Link className="text-brand-hover underline underline-offset-2" to={`/app/meetings/${m.id}`}>{tr("meetings.meeting_page")}</Link></>}
        actions={<Badge tone={w.phase === "open" ? "ok" : "neutral"}>{PHASE_LABEL[w.phase]}</Badge>} />
      <div role="tablist" aria-label={tr("meetings.webinar")} className="mb-4 flex gap-1 overflow-x-auto border-b border-line" onKeyDown={(e) => onTabKeys(e, tabs.filter((t) => t.show).map((t) => t.id), tab, setTab)}>
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
      <div data-testid="webinar-not-host"><EmptyState icon={<IconVideo />} title={tr("meetings.hosts_and_panelists_run_this_webinar")} body="You can join from the meeting page and watch. Ask the host to add you as a panelist if you need to speak or see the questions." action={<ButtonLink to={`/app/meetings/${meetingId}`} variant="secondary">{tr("meetings.back_to_the_meeting")}</ButtonLink>} /></div>
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
      <h2 className="text-[13px] font-semibold">{tr("meetings.questions")} <span className="font-normal text-muted">({d.questions.filter((x) => !x.hidden).length})</span></h2>
      {!d.questions.length ? <p className="mt-2 text-[12.5px] text-subtle">{tr("meetings.no_questions_yet_attendees_ask_from_their_webina")}</p> : (
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
                      <Input autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={tr("meetings.type_an_answer")} aria-label={tr("meetings.answer")} maxLength={1000} />
                      <Button size="sm" type="submit" disabled={!answer.trim()}>{tr("common.send")}</Button>
                    </form>
                  )}
                </div>
              </div>
              {d.canManage && (
                <div className="mt-2 flex flex-wrap gap-1 pl-11">
                  <Button size="sm" variant="ghost" onClick={() => void act(x.id, { answered: !x.answered })}>{x.answered ? tr("meetings.mark_open") : tr("meetings.answered_live")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setAnswering(answering === x.id ? null : x.id); setAnswer(x.answer ?? ""); }}>{tr("meetings.type_an_answer")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => void act(x.id, { hidden: !x.hidden })} aria-label={x.hidden ? tr("meetings.show_question") : tr("meetings.hide_question")}>{x.hidden ? tr("meetings.show") : tr("meetings.hide")}</Button>
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
    try { await api.post(`/webinars/${meetingId}/polls`, { question, options: options.filter((o) => o.trim()) }); setOpen(false); setQuestion(""); setOptions(["", ""]); onChange(); toast.success(tr("meetings.poll_launched")); }
    catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  const close = async (pollId: string) => { try { await api.post(`/webinars/${meetingId}/polls/${pollId}/close`); onChange(); } catch (e) { showError(e as Error); } };
  return (
    <Card className="p-5" data-testid="webinar-polls">
      <div className="flex items-center justify-between gap-2"><h2 className="text-[13px] font-semibold">{tr("meetings.polls")}</h2>{d.canManage && !open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="webinar-new-poll">{tr("meetings.launch_a_poll")}</Button>}</div>
      {open && (
        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); void launch(); }}>
          <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={tr("meetings.ask_a_question")} aria-label={tr("meetings.poll_question")} maxLength={300} autoFocus />
          {options.map((o, i) => <Input key={i} value={o} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} placeholder={tr("meetings.choice_count", { count: i + 1 })} aria-label={tr("meetings.choice_count", { count: i + 1 })} maxLength={120} />)}
          <div className="flex flex-wrap gap-2">
            {options.length < 6 && <Button size="sm" variant="ghost" type="button" onClick={() => setOptions([...options, ""])}>{tr("meetings.add_a_choice")}</Button>}
            <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>{tr("common.cancel")}</Button>
            <Button size="sm" type="submit" loading={busy} disabled={!question.trim() || options.filter((o) => o.trim()).length < 2}>{tr("meetings.launch")}</Button>
          </div>
        </form>
      )}
      {!d.polls.length ? !open && <p className="mt-2 text-[12.5px] text-subtle">{tr("meetings.no_polls_yet_launch_one_and_attendees_vote_from")}</p> : (
        <ul className="mt-3 space-y-3">{d.polls.map((p) => (
          <li key={p.id} className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-2"><p className="text-[13.5px] font-medium">{p.question}</p>{p.open && d.canManage ? <Button size="sm" variant="ghost" onClick={() => void close(p.id)}>{tr("meetings.close")}</Button> : <Badge>{p.open ? tr("tours.open") : tr("meetings.closed")}</Badge>}</div>
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
    <ul className="mt-2 space-y-1.5" aria-label={tr("meetings.results")}>
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
        <h2 className="text-[13px] font-semibold">{tr("nav.chat")}</h2>
        {d.canManage ? <Select value={d.chatMode} onChange={(e) => void setMode(e.target.value as ChatMode)} aria-label={tr("meetings.who_can_chat")} className="w-auto text-[12.5px]">
          {(Object.keys(CHAT_LABEL) as ChatMode[]).map((k) => <option key={k} value={k}>{CHAT_LABEL[k]}</option>)}
        </Select> : <Badge>{CHAT_LABEL[d.chatMode]}</Badge>}
      </div>
      <ul className="mt-2 max-h-80 space-y-2 overflow-y-auto">
        {!d.chat.length && <li className="text-[12.5px] text-subtle">{tr("meetings.no_messages_yet")}</li>}
        {d.chat.map((c) => (
          <li key={c.id} className={cn("group flex items-start gap-2 text-[13px]", c.hidden && "-mx-2 rounded-md border border-dashed border-line-strong px-2 py-1")}>
            <div className="min-w-0 flex-1"><span className="font-medium">{c.authorName}</span>{c.authorKind === "member" && <span className="ml-1 text-[11px] text-brand-hover">{tr("meetings.host")}</span>} <span className="break-words">{c.body}</span>{c.hidden && <Badge className="ml-1">{tr("meetings.hidden_from_attendees")}</Badge>}</div>
            {d.canManage && <Button size="sm" variant="ghost" onClick={() => void hide(c.id, !c.hidden)} aria-label={c.hidden ? tr("meetings.show_message") : tr("meetings.hide_message")}>{c.hidden ? tr("meetings.show") : tr("meetings.hide")}</Button>}
          </li>
        ))}
      </ul>
      {d.chatMode !== "off" && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("meetings.message_everyone")} aria-label={tr("meetings.chat_message")} maxLength={500} />
          <Button type="submit" size="sm" disabled={!text.trim()}>{tr("common.send")}</Button>
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
      <h2 className="text-[13px] font-semibold">{tr("meetings.stage")}</h2>
      <p className="mt-1 text-[12.5px] text-muted">{tr("meetings.hosts_and_panelists_can_speak_and_share_their_sc")}</p>
      <ul className="mt-2 space-y-1">
        {!d.panelists.length && <li className="text-[12.5px] text-subtle">{tr("meetings.no_panelists_yet")}</li>}
        {d.panelists.map((p) => (
          <li key={`${p.kind}:${p.id}`} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate">{p.name} <span className="text-[11.5px] text-muted">{p.kind === "member" ? tr("meetings.member") : tr("meetings.registered_2")}</span></span>
            {d.canManage && <Button size="sm" variant="ghost" onClick={() => void set(p.kind, p.id, false)}>{tr("meetings.move_to_audience")}</Button>}
          </li>
        ))}
      </ul>
      {d.canManage && members.length > 0 && (
        <div className="mt-3 flex gap-2">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={tr("meetings.add_a_panelist")} className="text-[12.5px]">
            <option value="">{tr("meetings.add_a_member_as_panelist")}</option>
            {members.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Button size="sm" variant="secondary" disabled={!pick} onClick={() => void set("member", pick, true)}>{tr("common.add")}</Button>
        </div>
      )}
      {d.canManage && d.attendees.length > 0 && (
        <>
          <h3 className="mt-4 text-[12.5px] font-semibold">{tr("meetings.audience")} <span className="font-normal text-muted">({d.attendees.filter((a) => a.watchingNow).length} {tr("meetings.watching_now")}</span></h3>
          <ul className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {d.attendees.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="min-w-0 truncate">{a.name}{a.watchingNow && <span className="ml-1 text-[11.5px] text-ok">{tr("meetings.watching")}</span>}</span>
                {!onStage.has(`registrant:${a.id}`) && <Button size="sm" variant="ghost" onClick={() => void set("registrant", a.id, true)}>{tr("meetings.bring_on_stage")}</Button>}
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
        <StatTile label={tr("meetings.registered_2")} value={r.totals.registered} />
        <StatTile label={tr("meetings.attended")} value={r.totals.attended} hint={r.totals.registered ? `${Math.round((r.totals.attended / r.totals.registered) * 100)}% of registered` : undefined} />
        <StatTile label={tr("meetings.average_minutes_watched")} value={r.totals.averageMinutes} />
        <StatTile label={tr("meetings.questions")} value={r.totals.questions} hint={`${r.totals.answered} answered`} />
      </div>
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold">{tr("nav.people")}</h2>
          <a className="inline-flex items-center gap-1.5 rounded-lg bg-fill px-3 py-1.5 text-[12.5px] font-medium hover:bg-hover" href={`/api/webinars/${meetingId}/report.csv`} download data-testid="webinar-csv"><IconDownload className="h-3.5 w-3.5" />{tr("meetings.download_csv")}</a>
        </div>
        {!r.people.length ? <p className="text-[12.5px] text-subtle">{tr("meetings.no_one_has_registered_yet_share_the_registration")}</p> : (
          <div className={tableStyles.wrap} tabIndex={0} role="region" aria-label={tr("meetings.registrations")}>
            <table className={tableStyles.table}>
              <thead><tr className="text-left text-[12px] text-muted"><th className="px-3 py-2 font-medium">{tr("common.name")}</th><th className="px-3 py-2 font-medium">{tr("common.email")}</th><th className="px-3 py-2 font-medium">{tr("meetings.attended")}</th><th className="px-3 py-2 text-right font-medium">{tr("meetings.minutes")}</th><th className="px-3 py-2 text-right font-medium">{tr("meetings.questions")}</th></tr></thead>
              <tbody className="divide-y divide-line">{r.people.map((p) => (
                <tr key={p.id} className="text-[13px]"><td className="max-w-48 truncate px-3 py-2">{p.name}</td><td className="max-w-56 truncate px-3 py-2 text-muted">{p.email}</td><td className="px-3 py-2">{p.attended ? tr("meetings.yes") : tr("meetings.no")}</td><td className="px-3 py-2 text-right tabular-nums">{p.minutesWatched}</td><td className="px-3 py-2 text-right tabular-nums">{p.questions}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {r.polls.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">{tr("meetings.poll_results")}</h2><ul className="mt-2 space-y-4">{r.polls.map((p) => <li key={p.id}><p className="text-[13.5px] font-medium">{p.question}</p><Results results={p.results} total={p.results.reduce((n, x) => n + x.count, 0)} /></li>)}</ul></Card>}
    </div>
  );
}

function ReplayTab({ meetingId, w }: { meetingId: string; w: WebinarSettings }) {
  const qc = useQueryClient();
  const recs = useQuery({ queryKey: ["recordings", meetingId], queryFn: async () => (await api.get<{ recordings: { id: string; status: string; startedAt: string; durationSec: number }[] }>(`/meetings/${meetingId}/recordings`)).recordings });
  const [pick, setPick] = useState(w.replay.recordingId ?? "");
  const save = async (shared: boolean) => {
    try { const r = await api.put<{ webinar: WebinarSettings }>(`/webinars/${meetingId}/replay`, { recordingId: pick || null, shared }); qc.setQueryData(["webinar", meetingId], r.webinar); toast.success(shared ? tr("meetings.replay_shared_with_everyone_who_registered") : tr("meetings.replay_saved")); }
    catch (e) { showError(e as Error); }
  };
  const done = (recs.data ?? []).filter((r) => r.status === "done");
  return (
    <Card className="p-5" data-testid="webinar-replay-settings">
      <h2 className="text-[13px] font-semibold">{tr("meetings.replay")}</h2>
      <p className="mt-1 text-[12.5px] text-muted">{tr("meetings.share_a_recording_of_this_meeting_with_everyone")} {NO_VIDEO_REPLAY}</p>
      {recs.isPending ? <Skeleton className="mt-3 h-10" /> : !done.length ? <p className="mt-3 text-[12.5px] text-subtle">{tr("meetings.no_finished_recordings_yet_press_record_during_t")}</p> : (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={tr("meetings.recording")}>
            <option value="">{tr("meetings.no_replay")}</option>
            {done.map((r) => <option key={r.id} value={r.id}>{when(r.startedAt)} · {Math.round(r.durationSec / 60)} {tr("meetings.minutes_2")}</option>)}
          </Select>
          <Button size="sm" onClick={() => void save(!!pick)}>{pick ? tr("meetings.share_replay") : tr("meetings.stop_sharing")}</Button>
        </div>
      )}
      {w.replay.shared && <p className="mt-3 text-[12.5px] text-ok">{tr("meetings.shared_with_everyone_who_registered")}</p>}
    </Card>
  );
}

function SettingsTab({ w }: { w: WebinarSettings }) {
  const qc = useQueryClient();
  const [description, setDescription] = useState(w.description);
  const patch = async (body: Partial<Pick<WebinarSettings, "registrationOpen" | "chatMode" | "description" | "enabled">>) => {
    try { const r = await api.patch<{ webinar: WebinarSettings }>(`/webinars/${w.meetingId}`, body); qc.setQueryData(["webinar", w.meetingId], r.webinar); toast.success(tr("common.saved")); } catch (e) { showError(e as Error); }
  };
  return (
    <Card className="space-y-5 p-5" data-testid="webinar-settings">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-[13px] font-semibold">{tr("meetings.registration")}</h2><p className="mt-1 text-[12.5px] text-muted">{w.cap.text}</p></div><Switch checked={w.registrationOpen} onChange={(v) => void patch({ registrationOpen: v })} label={tr("meetings.registration_open")} /></div>
      <Field label={tr("meetings.about_this_webinar")} hint={tr("meetings.shown_on_the_registration_page")}>
        {(p) => <Textarea {...p} rows={3} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== w.description && void patch({ description })} />}
      </Field>
      <Field label={tr("meetings.who_can_chat")}>
        {(p) => <Select {...p} value={w.chatMode} onChange={(e) => void patch({ chatMode: e.target.value as ChatMode })}>{(Object.keys(CHAT_LABEL) as ChatMode[]).map((k) => <option key={k} value={k}>{CHAT_LABEL[k]}</option>)}</Select>}
      </Field>
      <p className="text-[12px] text-subtle">{tr("meetings.streaming_to_thousands_of_people_is_not_part_of")}</p>
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
      {q.isPending ? <Skeleton className="h-60" /> : !i ? <Card className="p-8 text-center" data-testid="webinar-missing"><h1 className="text-lg font-semibold">{tr("meetings.this_webinar_link_doesn_t_work")}</h1><p className="mt-1 text-[13px] text-muted">{tr("meetings.ask_the_host_for_a_new_link")}</p></Card> : (
        <Card className="p-6" data-testid="webinar-register">
          <p className="text-[12.5px] font-medium text-brand-hover">{tr("meetings.webinar")}{i.host && ` by ${i.host}`}</p>
          <h1 className="mt-1 break-words text-xl font-semibold">{i.title}</h1>
          <p className="mt-1 text-[13px] text-muted">{when(i.startsAt)} · {i.durationMin} {tr("meetings.minutes_2")}</p>
          {i.description && <p className="mt-3 whitespace-pre-wrap break-words text-[13.5px]">{i.description}</p>}
          {i.panelists.length > 0 && <p className="mt-3 text-[12.5px] text-muted">{tr("meetings.with")} {i.panelists.join(", ")}</p>}
          <div className="mt-5 border-t border-line pt-5">
            {done ? (
              <div data-testid="webinar-registered" role="status">
                <h2 className="text-[15px] font-semibold">{done.status === "registered" ? tr("meetings.you_re_registered") : tr("meetings.you_re_already_registered")}</h2>
                {done.status === "registered" ? <>
                  <p className="mt-1 text-[13px] text-muted">{done.mailed ? tr("meetings.we_emailed_you_a_personal_link") : tr("meetings.keep_this_link_it_s_only_for_you")} {tr("meetings.open_it_a_few_minutes_before_the_start")}</p>
                  {done.joinUrl && <ButtonLink className="mt-3" to={new URL(done.joinUrl).pathname}>{tr("meetings.open_your_webinar_page")}</ButtonLink>}
                </> : <p className="mt-1 text-[13px] text-muted">{done.message}</p>}
              </div>
            ) : i.phase === "ended" || i.phase === "cancelled" ? <p className="text-[13.5px]" data-testid="webinar-closed">{i.phase === "ended" ? tr("meetings.this_webinar_has_ended") : tr("meetings.this_webinar_was_cancelled")}</p>
              : !i.registrationOpen ? <p className="text-[13.5px]" data-testid="webinar-closed">{tr("meetings.registration_is_closed")}</p>
              : i.full ? <p className="text-[13.5px]" data-testid="webinar-full">{tr("meetings.this_webinar_is_full_captext", { capText: i.capText })}</p> : (
              <form noValidate className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <h2 className="text-[15px] font-semibold">{tr("meetings.register")}</h2>
                <Field label={tr("auth.your_name")}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />}</Field>
                <Field label={tr("common.email")} hint={tr("meetings.we_send_your_personal_join_link_here_the_host_se")}>{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={254} required />}</Field>
                <div aria-hidden="true" className="absolute left-[-9999px] h-px w-px overflow-hidden"><label>{tr("meetings.website")}<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" /></label></div>
                {error && <p className="text-[13px] text-bad" role="alert">{error}</p>}
                <Button type="submit" loading={busy} disabled={!name.trim() || !email.trim()} data-testid="webinar-register-submit">{tr("meetings.register")}</Button>
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
  if (!tracks.length) return <div className="flex h-full min-h-60 items-center justify-center text-center text-[13.5px] text-white/80" data-testid="webinar-waiting">{tr("meetings.waiting_for_the_host_to_start_keep_this_page_ope")}</div>;
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
  if (!s) return <PublicShell><Card className="p-8 text-center" data-testid="webinar-missing"><h1 className="text-lg font-semibold">{tr("meetings.this_link_doesn_t_work")}</h1><p className="mt-1 text-[13px] text-muted">{tr("meetings.it_may_have_been_replaced_by_a_newer_one_check_y")}</p></Card></PublicShell>;
  return (
    <PublicShell wide>
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between" data-testid="webinar-attendee">
        <div className="min-w-0"><p className="text-[12.5px] font-medium text-brand-hover">{tr("meetings.webinar")}{s.host && ` by ${s.host}`}</p><h1 className="break-words text-xl font-semibold">{s.title}</h1><p className="text-[13px] text-muted">{when(s.startsAt)} · {s.durationMin} {tr("meetings.minutes_you_re")} {s.me.role === "panelist" ? tr("meetings.a_panelist") : "watching"} {tr("meetings.as")} {s.me.name}</p></div>
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
              {s.phase === "upcoming" ? <><p className="text-[15px] font-semibold" data-testid="webinar-not-started">{tr("meetings.starts")} {when(s.startsAt)}</p><p className="text-[13px] text-white/70">{tr("meetings.the_stage_opens_15_minutes_before_the_start_you")}</p></>
                : s.phase === "open" ? (s.videoEnabled ? <Button onClick={() => void go()} loading={busy} data-testid="webinar-watch"><IconVideo className="h-4 w-4" />{tr("meetings.watch_now")}</Button> : <p className="text-[13px] text-white/80">{tr("meetings.video_is_not_switched_on_for_this_workspace_yet")}</p>)
                : <><p className="text-[15px] font-semibold" data-testid="webinar-ended">{s.phase === "ended" ? tr("meetings.this_webinar_has_ended_2") : tr("meetings.this_webinar_was_cancelled_2")}</p>{s.replay && <ButtonLink to={`/w/a/${token}/replay`} variant="secondary">{tr("meetings.open_the_replay")}</ButtonLink>}</>}
            </div>
          )}
        </div>
        <Card className="flex min-h-80 flex-col p-0">
          <div role="tablist" aria-label={tr("meetings.webinar_panel")} className="flex border-b border-line" onKeyDown={(e) => onTabKeys(e, PANELS, panel, setPanel)}>
            {PANELS.map((p) => (
              <button key={p} role="tab" type="button" aria-selected={panel === p} tabIndex={panel === p ? 0 : -1} onClick={() => setPanel(p)} data-testid={`attendee-tab-${p}`}
                className={cn("-mb-px flex-1 border-b-2 px-3 py-2.5 text-[13px] font-medium", panel === p ? "border-brand text-fg" : "border-transparent text-muted hover:text-fg")}>
                {p === "questions" ? tr("meetings.questions") : p === "polls" ? `Polls${s.polls.some((x) => x.open && !x.voted) ? " •" : ""}` : tr("nav.chat")}
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
  const ask = async () => { setBusy(true); try { onState(await api.post(`/public/webinars/a/${token}/questions`, { body: text })); setText(""); toast.success(tr("meetings.question_sent")); } catch (e) { showError(e as Error); } finally { setBusy(false); } };
  const up = async (id: string) => { try { onState(await api.post(`/public/webinars/a/${token}/questions/${id}/upvote`)); } catch (e) { showError(e as Error); } };
  return (
    <div className="space-y-3">
      {s.canAsk && s.phase === "open" ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={tr("meetings.ask_the_hosts_a_question")} aria-label={tr("meetings.your_question")} maxLength={500} />
          <Button size="sm" type="submit" loading={busy} disabled={!text.trim()} data-testid="webinar-ask">{tr("meetings.ask")}</Button>
        </form>
      ) : <p className="text-[12.5px] text-subtle">{s.phase === "upcoming" ? tr("meetings.questions_open_15_minutes_before_the_start") : tr("meetings.questions_are_closed")}</p>}
      {!s.questions.length ? <p className="text-[12.5px] text-subtle">{tr("meetings.no_questions_yet_be_the_first")}</p> : (
        <ul className="space-y-2">{s.questions.map((x) => (
          <li key={x.id} className="flex gap-2 rounded-lg border border-line p-2.5">
            <button type="button" onClick={() => void up(x.id)} disabled={x.mine || x.answered || x.hidden} aria-pressed={x.upvoted} aria-label={`Upvote, ${x.votes} so far`}
              className={cn("flex h-9 min-w-9 flex-col items-center justify-center rounded-md text-[12px] font-semibold tabular-nums disabled:opacity-60", x.upvoted ? "bg-brand-soft text-brand-hover" : "bg-fill")}>▲<span>{x.votes}</span></button>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[13px]">{x.body}</p>
              <p className="text-[11.5px] text-muted">{x.mine ? tr("nav.you") : x.authorName}{x.answered && " · Answered"}{x.hidden && " · Hidden by the host"}</p>
              {x.answer && <p className="mt-1 rounded-md bg-fill px-2 py-1 text-[12.5px]"><span className="font-medium">{tr("meetings.answer_2")} </span>{x.answer}</p>}
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
  if (!s.polls.length) return <p className="text-[12.5px] text-subtle">{tr("meetings.no_polls_yet_when_the_host_launches_one_it_shows")}</p>;
  return (
    <ul className="space-y-3">{s.polls.map((p) => (
      <li key={p.id} className="rounded-lg border border-line p-3" data-testid="attendee-poll">
        <div className="flex items-start justify-between gap-2"><p className="text-[13.5px] font-medium">{p.question}</p>{!p.open && <Badge>{tr("meetings.closed")}</Badge>}</div>
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
            <Button size="sm" type="submit" disabled={!(picked[p.id] ?? []).length} data-testid="attendee-vote">{tr("meetings.vote")}</Button>
          </form>
        ) : <CloudVote onVote={(w) => void vote(p.id, [w])} />}
      </li>
    ))}</ul>
  );
}
function CloudVote({ onVote }: { onVote: (w: string) => void }) {
  const [w, setW] = useState("");
  return <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); onVote(w); }}><Input value={w} onChange={(e) => setW(e.target.value)} placeholder={tr("meetings.one_word")} aria-label={tr("meetings.your_word")} maxLength={40} /><Button size="sm" type="submit" disabled={!w.trim()}>{tr("common.send")}</Button></form>;
}

function AttendeeChat({ token, s, onState }: { token: string; s: AttendeeState; onState: (d: AttendeeState) => void }) {
  const [text, setText] = useState("");
  const end = useRef<HTMLLIElement | null>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [s.chat.length]);
  const send = async () => { try { onState(await api.post(`/public/webinars/a/${token}/chat`, { body: text })); setText(""); } catch (e) { showError(e as Error); } };
  const canSend = s.phase === "open" && (s.chatMode === "everyone" || (s.chatMode === "hosts" && s.me.role === "panelist"));
  if (s.chatMode === "off") return <p className="text-[12.5px] text-subtle" data-testid="attendee-chat-off">{tr("meetings.the_host_turned_chat_off")}</p>;
  return (
    <div className="flex h-full flex-col">
      <ul className="flex-1 space-y-2">
        {!s.chat.length && <li className="text-[12.5px] text-subtle">{tr("meetings.no_messages_yet")}</li>}
        {s.chat.map((c) => <li key={c.id} className="text-[13px]"><span className="font-medium">{c.authorName}</span>{c.host && <span className="ml-1 text-[11px] text-brand-hover">{tr("meetings.host")}</span>} <span className="break-words">{c.body}</span></li>)}
        <li ref={end} aria-hidden="true" />
      </ul>
      {canSend ? (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tr("meetings.say_something")} aria-label={tr("meetings.chat_message")} maxLength={500} />
          <Button size="sm" type="submit" disabled={!text.trim()}>{tr("common.send")}</Button>
        </form>
      ) : <p className="mt-3 text-[12px] text-subtle">{s.chatMode === "hosts" ? tr("meetings.only_hosts_and_panelists_can_chat_right_now") : tr("meetings.chat_opens_15_minutes_before_the_start")}</p>}
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
      {q.isPending ? <Skeleton className="h-60" /> : !r ? <Card className="p-8 text-center" data-testid="webinar-no-replay"><h1 className="text-lg font-semibold">{tr("meetings.no_replay_yet")}</h1><p className="mt-1 text-[13px] text-muted">{(q.error as Error | null)?.message ?? tr("meetings.the_host_has_not_shared_a_replay_yet")}</p><ButtonLink className="mt-4" variant="secondary" to={`/w/a/${token}`}>{tr("meetings.back_to_the_webinar")}</ButtonLink></Card> : (
        <div className="space-y-4" data-testid="webinar-replay">
          <div><p className="text-[12.5px] font-medium text-brand-hover">{tr("meetings.replay")}{r.host && ` · ${r.host}`}</p><h1 className="break-words text-xl font-semibold">{r.title}</h1><p className="text-[13px] text-muted">{when(r.startsAt)} · {Math.round(r.durationSec / 60)} {tr("meetings.minutes_recorded")}</p><p className="mt-1 text-[12px] text-subtle">{NO_VIDEO_REPLAY}</p></div>
          {r.summary && <Card className="p-5"><h2 className="text-[13px] font-semibold">{tr("meetings.summary")}</h2><p className="mt-1 whitespace-pre-wrap text-[13.5px]">{r.summary}</p>{r.decisions.length > 0 && <><h3 className="mt-3 text-[12.5px] font-semibold">{tr("meetings.decisions")}</h3><ul className="mt-1 list-disc pl-5 text-[13px]">{r.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul></>}</Card>}
          {r.answered.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">{tr("meetings.questions_answered")}</h2><ul className="mt-2 space-y-2">{r.answered.map((a) => <li key={a.id} className="text-[13px]"><p className="break-words font-medium">{a.body}</p>{a.answer && <p className="text-muted">{a.answer}</p>}</li>)}</ul></Card>}
          {r.polls.length > 0 && <Card className="p-5"><h2 className="text-[13px] font-semibold">{tr("meetings.poll_results")}</h2><ul className="mt-2 space-y-4">{r.polls.map((p) => <li key={p.id}><p className="text-[13.5px] font-medium">{p.question}</p><Results results={p.results} total={p.results.reduce((n, x) => n + x.count, 0)} /></li>)}</ul></Card>}
          <Card className="p-5"><h2 className="text-[13px] font-semibold">{tr("meetings.transcript")}</h2>
            <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-[13px] leading-6">{(showAll ? lines : lines.slice(0, 40)).join("\n")}</pre>
            {lines.length > 40 && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setShowAll(!showAll)}>{showAll ? tr("meetings.show_less") : tr("meetings.show_all_length_lines", { length: lines.length })}</Button>}
          </Card>
        </div>
      )}
    </PublicShell>
  );
}
