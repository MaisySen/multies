/**
 * R96 chat plus in the web app: topics strip, poll / decision / Q&A / word cloud cards, the composer's Add menu,
 * the announcements feed and the call panel's Live tab. Everything hides when the server has the flag off.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { cn } from "@/web/lib/cn";
import { mailDate } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Textarea } from "@/web/components/ui/input";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { EmptyState, Skeleton } from "@/web/components/ui/misc";
import { IconMore, IconPin, IconPlus } from "@/web/components/ui/icons";
import { CHAT_PLUS_LIMITS as L, DECISION_RESULT_LABEL, POLL_KIND_LABEL, STANCE_LABEL, type PollKind, type Stance } from "@/shared/chat-plus";

export type Topic = { id: string; channelId: string; name: string; resolved: boolean; unread: number; total: number };
type Tally = { key: string; label: string; count: number; names: string[] };
export type PollView = {
  id: string; kind: PollKind; question: string; options: string[]; multi: boolean; anonymous: boolean; closesAt: string | null; closedAt: string | null; open: boolean;
  outcome: { result?: keyof typeof DECISION_RESULT_LABEL; summary?: string; winners?: string[] } | null; voters: number; mine: string[]; canVote: boolean; canManage: boolean;
  createdByName: string; tally?: Tally[]; reasons?: { name: string; stance: Stance; reason: string }[]; myReason?: string; standing?: { label: string } | null;
  cloud?: { word: string; count: number }[]; questions?: { id: string; body: string; authorName: string; votes: number; upvoted: boolean; mineQuestion: boolean; answered: boolean }[];
};

/** Whether chat plus is on for this workspace (the routes are absent when the flag is off). */
export function useChatPlus() {
  const q = useQuery({ queryKey: ["chat-plus", "status"], staleTime: 300_000, retry: false, queryFn: async () => { try { return (await api.get<{ on: boolean }>("/chat-plus/status")).on; } catch { return false; } } });
  return { on: q.data === true };
}

// ------------------------------------------------------------------ topics

export function TopicBar({ channelId, topicId, onPick, canAdmin }: { channelId: string; topicId: string | null; onPick: (id: string | null) => void; canAdmin: boolean }) {
  const qc = useQueryClient();
  const topics = useQuery({ queryKey: ["chat-plus", "topics", channelId], refetchInterval: 20_000, queryFn: async () => (await api.get<{ topics: Topic[] }>(`/chat-plus/channels/${channelId}/topics`)).topics });
  const [naming, setNaming] = useState<{ mode: "new" | "rename"; topic?: Topic } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["chat-plus", "topics", channelId] });
  const current = topics.data?.find((t) => t.id === topicId) ?? null;
  useEffect(() => {
    if (!topicId) return;
    void api.post(`/chat-plus/topics/${topicId}/read`, {}).then(refresh).catch(() => undefined);
  }, [topicId]); // eslint-disable-line react-hooks/exhaustive-deps
  const resolve = async (t: Topic) => {
    try { await api.patch(`/chat-plus/topics/${t.id}`, { resolved: !t.resolved }); await refresh(); await qc.invalidateQueries({ queryKey: ["chat", "messages"] }); } catch (e) { showError(e as Error); }
  };
  const list = topics.data ?? [];
  const chip = (active: boolean) => cn("inline-flex min-h-8 max-sm:min-h-10 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors duration-150",
    active ? "border-brand bg-brand/10 text-fg" : "border-line text-muted hover:bg-hover hover:text-fg");
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-4 py-1.5 max-sm:px-2" role="toolbar" aria-label="Topics" data-testid="topic-bar">
      <button type="button" className={chip(!topicId)} aria-pressed={!topicId} onClick={() => onPick(null)}>All messages</button>
      {list.map((t) => (
        <button key={t.id} type="button" className={chip(t.id === topicId)} aria-pressed={t.id === topicId} onClick={() => onPick(t.id)} data-testid="topic-chip">
          {t.resolved && <span aria-label="Resolved" className="text-ok">✓</span>}
          <span className={cn("max-w-40 truncate", t.resolved && "text-subtle")}>{t.name}</span>
          {t.unread > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white" aria-label={`${t.unread} unread`}>{t.unread}</span>}
        </button>
      ))}
      <button type="button" className={chip(false)} onClick={() => setNaming({ mode: "new" })} data-testid="topic-new"><IconPlus className="h-3.5 w-3.5" aria-hidden />New topic</button>
      {current && (
        <div className="ml-auto shrink-0">
          <Menu label={`Topic ${current.name}`} trigger={<button type="button" aria-label={`Options for topic ${current.name}`} className="inline-flex h-8 w-8 max-sm:h-10 max-sm:w-10 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg" data-testid="topic-more"><IconMore className="h-4 w-4" aria-hidden /></button>}>
            <MenuItem onSelect={() => void resolve(current)}>{current.resolved ? "Reopen topic" : "Mark as resolved"}</MenuItem>
            <MenuItem onSelect={() => setNaming({ mode: "rename", topic: current })}>Rename or merge</MenuItem>
          </Menu>
        </div>
      )}
      {naming && <TopicDialog channelId={channelId} topic={naming.topic} canAdmin={canAdmin} onClose={() => setNaming(null)} onDone={(id) => { setNaming(null); void refresh(); onPick(id); void qc.invalidateQueries({ queryKey: ["chat", "messages"] }); }} />}
    </div>
  );
}

function TopicDialog({ channelId, topic, onClose, onDone }: { channelId: string; topic?: Topic; canAdmin: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const [name, setName] = useState(topic?.name ?? "");
  const [clash, setClash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e?: FormEvent, merge = false) => {
    e?.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (!topic) onDone((await api.post<{ topic: Topic }>(`/chat-plus/channels/${channelId}/topics`, { name })).topic.id);
      else onDone((await api.patch<{ topic: Topic }>(`/chat-plus/topics/${topic.id}`, { name, merge })).topic.id);
    } catch (err) {
      const x = err as Error & { status?: number; code?: string };
      if (x.status === 409 || x.code === "topic_exists") setClash(x.message); else showError(x);
    } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={topic ? "Rename topic" : "New topic"} description={topic ? "Give it a new name. Picking the name of another topic merges the two." : "Topics keep one conversation together inside the channel."}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {clash ? <Button onClick={() => void save(undefined, true)} disabled={busy} data-testid="topic-merge">Merge topics</Button> : <Button onClick={() => void save()} disabled={busy || !name.trim()} data-testid="topic-save">{topic ? "Save" : "Create topic"}</Button>}
      </>}>
      <form onSubmit={(e) => void save(e)}>
        <Field label="Topic name" hint={clash ?? undefined}>{(p) => <Input {...p} autoFocus value={name} maxLength={L.topic} onChange={(e) => { setName(e.target.value); setClash(null); }} data-testid="topic-name" />}</Field>
      </form>
    </Dialog>
  );
}

/** Topic chip on a message, and the Move to topic dialog. */
export function MoveToTopic({ open, messageId, channelId, current, onClose, onMoved }: { open: boolean; messageId: string; channelId: string; current: string | null; onClose: () => void; onMoved: () => void }) {
  const topics = useQuery({ queryKey: ["chat-plus", "topics", channelId], enabled: open, queryFn: async () => (await api.get<{ topics: Topic[] }>(`/chat-plus/channels/${channelId}/topics`)).topics });
  const move = async (topicId: string | null) => {
    try { await api.post(`/chat-plus/messages/${messageId}/topic`, { topicId }); onMoved(); } catch (e) { showError(e as Error); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Move to topic" description="The message and its thread move together.">
      <ul className="space-y-1" aria-label="Topics">
        <li><button type="button" className="w-full rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-hover disabled:opacity-50" disabled={!current} onClick={() => void move(null)}>No topic</button></li>
        {(topics.data ?? []).map((t) => (
          <li key={t.id}><button type="button" className="w-full rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-hover disabled:opacity-50" disabled={t.id === current} onClick={() => void move(t.id)} data-testid="move-topic-option">{t.resolved ? "✓ " : ""}{t.name}</button></li>
        ))}
        {topics.data && !topics.data.length && <li className="px-3 py-2 text-[13px] text-subtle">No topics yet. Start one from the topic bar.</li>}
      </ul>
    </Dialog>
  );
}

// ------------------------------------------------------------------ composer Add menu

export function ChatPlusAdd({ channelId, topicId, meetingId, isAdmin, onDone, compact }: { channelId?: string; topicId?: string | null; meetingId?: string; isAdmin: boolean; onDone: () => void; compact?: boolean }) {
  const [kind, setKind] = useState<PollKind | "announce" | null>(null);
  return (
    <>
      <Menu align="start" label="Add to chat" trigger={<button type="button" aria-label="Add a poll, decision, questions or word cloud" data-testid="chat-plus-add" className={cn("inline-flex items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted hover:bg-hover hover:text-fg", compact ? "h-8" : "h-8 max-sm:h-10")}><IconPlus className="h-4 w-4" aria-hidden /><span>Add</span></button>}>
        <MenuItem onSelect={() => setKind("poll")} hint="Ask and count">Poll</MenuItem>
        <MenuItem onSelect={() => setKind("decision")} hint="Agree, abstain, disagree or block">Decision</MenuItem>
        <MenuItem onSelect={() => setKind("qa")} hint="Live questions with upvotes">Questions</MenuItem>
        <MenuItem onSelect={() => setKind("cloud")} hint="Up to three words each">Word cloud</MenuItem>
        {isAdmin && channelId && <MenuItem onSelect={() => setKind("announce")} icon={<IconPin className="h-4 w-4" />}>Announcement</MenuItem>}
      </Menu>
      {kind === "announce" && channelId && <AnnounceDialog channelId={channelId} topicId={topicId ?? null} onClose={() => setKind(null)} onDone={() => { setKind(null); onDone(); }} />}
      {kind && kind !== "announce" && <NewPollDialog kind={kind} channelId={channelId} topicId={topicId ?? null} meetingId={meetingId} onClose={() => setKind(null)} onDone={() => { setKind(null); onDone(); }} />}
    </>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

function NewPollDialog({ kind, channelId, topicId, meetingId, onClose, onDone }: { kind: PollKind; channelId?: string; topicId: string | null; meetingId?: string; onClose: () => void; onDone: () => void }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [ends, setEnds] = useState(kind === "decision" ? toLocalInput(new Date(Date.now() + L.decisionDefaultHours * 3_600_000)) : "");
  const [busy, setBusy] = useState(false);
  const copy = {
    poll: { title: "New poll", label: "Question", ph: "Where should we have the team lunch?" },
    decision: { title: "New decision", label: "Proposal", ph: "Move the weekly standup to 10 am" },
    qa: { title: "New questions session", label: "Title", ph: "Town hall questions" },
    cloud: { title: "New word cloud", label: "Prompt", ph: "One word for this week" },
  }[kind];
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    try {
      await api.post("/chat-plus/polls", { kind, question, options: kind === "poll" ? options : undefined, multi, anonymous, closesAt: ends ? new Date(ends).toISOString() : null, channelId: channelId ?? null, topicId, meetingId: meetingId ?? null });
      onDone();
    } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={copy.title} className="sm:max-w-lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void submit()} disabled={busy || !question.trim()} data-testid="poll-create">Post</Button></>}>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <Field label={copy.label}>{(p) => <Input {...p} autoFocus value={question} maxLength={L.question} placeholder={copy.ph} onChange={(e) => setQuestion(e.target.value)} data-testid="poll-question" />}</Field>
        {kind === "poll" && (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-[12.5px] font-medium">Choices</legend>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input aria-label={`Choice ${i + 1}`} value={o} maxLength={L.option} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} data-testid="poll-option" />
                {options.length > 2 && <Button variant="ghost" size="sm" aria-label={`Remove choice ${i + 1}`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>Remove</Button>}
              </div>
            ))}
            {options.length < L.maxOptions && <Button variant="ghost" size="sm" onClick={() => setOptions([...options, ""])} data-testid="poll-add-option">Add a choice</Button>}
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> People can pick more than one</label>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} /> Hide who voted for what</label>
          </fieldset>
        )}
        {kind === "decision" && <p className="text-[12.5px] text-muted">Everyone picks Agree, Abstain, Disagree or Block. Any block stops it; otherwise it is agreed when more people agree than disagree. The outcome is posted in the thread when it closes.</p>}
        <Field label={kind === "decision" ? "Deadline" : "Ends (optional)"}>{(p) => <Input {...p} type="datetime-local" value={ends} onChange={(e) => setEnds(e.target.value)} data-testid="poll-ends" />}</Field>
      </form>
    </Dialog>
  );
}

function AnnounceDialog({ channelId, topicId, onClose, onDone }: { channelId: string; topicId: string | null; onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async () => {
    setBusy(true);
    try { await api.post(`/chat-plus/channels/${channelId}/announcements`, { body, topicId }); await qc.invalidateQueries({ queryKey: ["chat-plus", "announcements"] }); onDone(); } catch (e) { showError(e as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="New announcement" description="It is pinned in the channel and shows in Announcements, with who has seen it."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void submit()} disabled={busy || !body.trim()} data-testid="announce-post">Announce</Button></>}>
      <Field label="Announcement">{(p) => <Textarea {...p} autoFocus rows={5} value={body} onChange={(e) => setBody(e.target.value)} data-testid="announce-body" />}</Field>
    </Dialog>
  );
}

// ------------------------------------------------------------------ cards

function timeLeft(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "closing";
  const h = Math.round(ms / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days left` : h >= 1 ? `${h} h left` : `${Math.max(1, Math.round(ms / 60_000))} min left`;
}

export function usePoll(pollId: string, version?: string, guest = false) {
  return useQuery({
    queryKey: ["chat-plus", "poll", pollId, version ?? ""], refetchInterval: (q) => (q.state.data?.open ? 15_000 : false),
    queryFn: async () => (await api.get<{ poll: PollView }>(`${guest ? "/guest" : ""}/chat-plus/polls/${pollId}`)).poll,
  });
}

export function PollCard({ pollId, version, guest }: { pollId: string; version?: string; guest?: boolean }) {
  const q = usePoll(pollId, version, guest);
  if (q.isPending) return <Skeleton className="mt-1 h-24 max-w-md" />;
  if (!q.data) return <p className="text-[13px] text-subtle">This vote is not available.</p>;
  return <PollBody poll={q.data} onChange={() => void q.refetch()} />;
}

export function PollBody({ poll, onChange }: { poll: PollView; onChange: () => void }) {
  const qc = useQueryClient();
  const act = async (path: string, body: unknown = {}) => {
    try { const r = await api.post<{ poll: PollView }>(path, body); qc.setQueryData(["chat-plus", "poll", poll.id], r.poll); onChange(); } catch (e) { showError(e as Error); }
  };
  const status = poll.open ? (poll.closesAt ? timeLeft(poll.closesAt) : "Open") : "Closed";
  return (
    <section className="mt-1 max-w-xl rounded-xl border border-line bg-surface p-3" aria-label={`${POLL_KIND_LABEL[poll.kind]}: ${poll.question}`} data-testid="poll-card" data-kind={poll.kind}>
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="rounded bg-fill px-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{POLL_KIND_LABEL[poll.kind]}</span>
        <h3 className="min-w-0 flex-1 text-[14px] font-semibold">{poll.question}</h3>
        <span className={cn("text-[11.5px]", poll.open ? "text-subtle" : "text-muted")} data-testid="poll-status">{status}</span>
      </header>
      {(poll.kind === "poll" || poll.kind === "decision") && <ChoiceList poll={poll} act={act} />}
      {poll.kind === "cloud" && <Cloud poll={poll} act={act} />}
      {poll.kind === "qa" && <Questions poll={poll} act={act} />}
      <footer className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-subtle">
        <span>{poll.kind === "qa" ? `${poll.questions?.length ?? 0} questions` : `${poll.voters} ${poll.voters === 1 ? "vote" : "votes"}`}{poll.anonymous ? " · anonymous" : ""} · by {poll.createdByName}</span>
        {poll.canManage && poll.open && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void act(`/chat-plus/polls/${poll.id}/close`)} data-testid="poll-close">Close now</Button>}
      </footer>
    </section>
  );
}

type Act = (path: string, body?: unknown) => Promise<void>;

function ChoiceList({ poll, act }: { poll: PollView; act: Act }) {
  const [reason, setReason] = useState(poll.myReason ?? "");
  const [pendingBlock, setPendingBlock] = useState(false);
  const total = Math.max(1, poll.tally?.reduce((t, x) => t + x.count, 0) ?? 0);
  const pick = (key: string) => {
    if (!poll.canVote) return;
    if (poll.kind === "decision" && key === "block" && !reason.trim()) { setPendingBlock(true); return; }
    const mine = poll.mine.includes(key);
    const next = poll.multi ? (mine ? poll.mine.filter((k) => k !== key) : [...poll.mine, key]) : mine ? [] : [key];
    void act(`/chat-plus/polls/${poll.id}/vote`, { choices: next, reason: poll.kind === "decision" ? reason : undefined });
  };
  return (
    <div>
      {poll.kind === "decision" && (poll.standing || poll.outcome?.result) && (
        <p className="mb-2 text-[12.5px]" data-testid="decision-standing">
          {poll.outcome?.result ? <><strong>Outcome:</strong> {poll.outcome.summary}</> : <>Right now: <strong>{poll.standing!.label}</strong></>}
        </p>
      )}
      {poll.kind === "poll" && !poll.open && poll.outcome?.winners && <p className="mb-2 text-[12.5px]"><strong>Result:</strong> {poll.outcome.winners.length ? poll.outcome.winners.join(", ") : "No votes"}</p>}
      <ul className={cn(poll.kind === "decision" ? "grid grid-cols-2 gap-1.5 sm:grid-cols-4" : "space-y-1.5")} role="list">
        {poll.tally?.map((t) => {
          const mine = poll.mine.includes(t.key);
          const pct = Math.round((t.count / total) * 100);
          return (
            <li key={t.key}>
              <button type="button" disabled={!poll.canVote} aria-pressed={mine} onClick={() => pick(t.key)} data-testid="poll-choice"
                title={t.names.length ? t.names.join(", ") : undefined}
                className={cn("relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-lg border px-3 text-left text-[13px] transition-colors duration-150 disabled:cursor-default",
                  mine ? "border-brand" : "border-line", poll.canVote && "hover:bg-hover")}>
                <span aria-hidden className={cn("absolute inset-y-0 left-0", t.key === "block" ? "bg-danger/15" : "bg-brand/15")} style={{ width: `${pct}%` }} />
                <span className="relative flex-1 truncate">{mine ? "✓ " : ""}{t.label}</span>
                <span className="relative text-[12px] tabular-nums text-muted">{t.count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {poll.kind === "decision" && poll.canVote && (
        <div className="mt-2">
          <label className="sr-only" htmlFor={`reason-${poll.id}`}>Your reason</label>
          <Input id={`reason-${poll.id}`} placeholder={pendingBlock ? "Say why you block, then pick Block again" : "Add a reason (optional)"} value={reason} maxLength={L.reason}
            aria-invalid={pendingBlock && !reason.trim()} onChange={(e) => { setReason(e.target.value); setPendingBlock(false); }} data-testid="decision-reason" />
        </div>
      )}
      {!!poll.reasons?.length && (
        <ul className="mt-2 space-y-1 text-[12.5px]" aria-label="Reasons">
          {poll.reasons.map((r, i) => <li key={i}><strong>{r.name}</strong> <span className="text-muted">({STANCE_LABEL[r.stance]})</span>: {r.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

function Cloud({ poll, act }: { poll: PollView; act: Act }) {
  const [text, setText] = useState(poll.mine.join(", "));
  const max = Math.max(1, ...(poll.cloud ?? []).map((w) => w.count));
  return (
    <div>
      {poll.cloud?.length ? (
        <p className="flex flex-wrap items-baseline justify-center gap-x-3 gap-y-1 py-2" aria-label="Word cloud" data-testid="word-cloud">
          {poll.cloud.map((w) => <span key={w.word} className="text-brand-hover" style={{ fontSize: `${13 + Math.round((w.count / max) * 17)}px`, fontWeight: w.count === max ? 700 : 500 }} title={`${w.count}`}>{w.word}</span>)}
        </p>
      ) : <p className="py-2 text-center text-[12.5px] text-subtle">No words yet.</p>}
      {poll.canVote && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(`/chat-plus/polls/${poll.id}/vote`, { choices: [text] }); }}>
          <label className="sr-only" htmlFor={`cloud-${poll.id}`}>Your words</label>
          <Input id={`cloud-${poll.id}`} placeholder="Up to three words, split with commas" value={text} onChange={(e) => setText(e.target.value)} data-testid="cloud-input" />
          <Button type="submit" size="sm" disabled={!text.trim()} data-testid="cloud-send">Send</Button>
        </form>
      )}
    </div>
  );
}

function Questions({ poll, act }: { poll: PollView; act: Act }) {
  const [text, setText] = useState("");
  return (
    <div>
      {poll.canVote && (
        <form className="mb-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void act(`/chat-plus/polls/${poll.id}/questions`, { body: text }).then(() => setText("")); }}>
          <label className="sr-only" htmlFor={`q-${poll.id}`}>Your question</label>
          <Input id={`q-${poll.id}`} placeholder="Ask a question" maxLength={L.item} value={text} onChange={(e) => setText(e.target.value)} data-testid="qa-input" />
          <Button type="submit" size="sm" disabled={!text.trim()} data-testid="qa-ask">Ask</Button>
        </form>
      )}
      {!poll.questions?.length ? <p className="text-[12.5px] text-subtle">No questions yet.</p> : (
        <ol className="space-y-1.5" aria-label="Questions">
          {poll.questions.map((q) => (
            <li key={q.id} className={cn("flex items-start gap-2 rounded-lg border border-line px-2 py-1.5", q.answered && "opacity-70")} data-testid="qa-item">
              <button type="button" aria-pressed={q.upvoted} aria-label={`Upvote: ${q.body}`} disabled={!poll.canVote || q.mineQuestion || q.answered}
                onClick={() => void act(`/chat-plus/questions/${q.id}/upvote`)} data-testid="qa-upvote"
                className={cn("flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-md border text-[11px] tabular-nums", q.upvoted ? "border-brand text-brand-hover" : "border-line text-muted", "disabled:cursor-default")}>
                <span aria-hidden>▲</span>{q.votes}
              </button>
              <div className="min-w-0 flex-1">
                <p className="text-[13px]">{q.body}</p>
                <p className="text-[11.5px] text-subtle">{q.authorName}{q.answered ? " · answered" : ""}</p>
              </div>
              {poll.canManage && <Button variant="ghost" size="sm" onClick={() => void act(`/chat-plus/questions/${q.id}/answered`, { answered: !q.answered })}>{q.answered ? "Reopen" : "Answered"}</Button>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ announcements

type FeedItem = { message: { id: string; body: string; author: { name: string }; createdAt: string; channelId: string }; channel: { id: string; name: string }; seenCount: number; audience: number; seenByMe: boolean };

export function useAnnouncements(enabled: boolean) {
  return useQuery({ queryKey: ["chat-plus", "announcements"], enabled, refetchInterval: 60_000, queryFn: () => api.get<{ announcements: FeedItem[]; unseen: number; canPost: boolean }>("/chat-plus/announcements") });
}

export function AnnouncementsNav({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const feed = useAnnouncements(true);
  const n = feed.data?.unseen ?? 0;
  return (
    <button type="button" onClick={onOpen} aria-current={active ? "page" : undefined} data-testid="announcements-nav"
      className={cn("mb-3 flex min-h-9 max-sm:min-h-11 w-full items-center gap-2 rounded-lg px-2 text-[13.5px]", active ? "bg-selected font-medium" : "text-muted hover:bg-hover hover:text-fg")}>
      <IconPin className="h-3.5 w-3.5" aria-hidden /><span className="flex-1 text-left">Announcements</span>
      {n > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-white" aria-label={`${n} new`}>{n}</span>}
    </button>
  );
}

export function AnnouncementsFeed({ onOpenMessage }: { onOpenMessage: (channelId: string, messageId: string) => void }) {
  const feed = useAnnouncements(true);
  const qc = useQueryClient();
  const [receipts, setReceipts] = useState<string | null>(null);
  const unseen = useMemo(() => (feed.data?.announcements ?? []).filter((a) => !a.seenByMe).map((a) => a.message.id), [feed.data]);
  useEffect(() => {
    if (!unseen.length) return;
    const t = setTimeout(() => { void api.post("/chat-plus/announcements/seen", { messageIds: unseen }).then(() => qc.invalidateQueries({ queryKey: ["chat-plus", "announcements"] })).catch(() => undefined); }, 1200);
    return () => clearTimeout(t);
  }, [unseen.join(","), qc]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 max-sm:px-2" data-testid="announcements-feed">
      {feed.isPending ? <Skeleton className="h-40" /> : !feed.data?.announcements.length ? (
        <EmptyState icon={<IconPin />} title="No announcements yet" body={feed.data?.canPost ? "Post one from a channel: Add, then Announcement. It is pinned and shows here for everyone who can see the channel." : "When an admin posts an announcement in a channel you can see, it shows here."} />
      ) : (
        <ul className="mx-auto max-w-2xl space-y-3">
          {feed.data.announcements.map((a) => (
            <li key={a.message.id} className={cn("rounded-xl border bg-surface p-4", a.seenByMe ? "border-line" : "border-brand")} data-testid="announcement">
              <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[12px] text-subtle">
                <span className="font-semibold text-fg">{a.message.author.name}</span>
                <button type="button" className="hover:underline" onClick={() => onOpenMessage(a.channel.id, a.message.id)}>#{a.channel.name}</button>
                <time dateTime={a.message.createdAt}>{mailDate(a.message.createdAt)}</time>
                {!a.seenByMe && <span className="rounded bg-brand/15 px-1.5 text-[11px] text-brand-hover">New</span>}
              </div>
              <p className="whitespace-pre-wrap text-[14px]">{a.message.body}</p>
              <button type="button" className="mt-2 text-[12px] text-muted hover:text-fg hover:underline" onClick={() => setReceipts(a.message.id)} data-testid="announcement-seen">Seen by {a.seenCount} of {a.audience}</button>
            </li>
          ))}
        </ul>
      )}
      {receipts && <ReceiptsDialog messageId={receipts} onClose={() => setReceipts(null)} />}
    </div>
  );
}

function ReceiptsDialog({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ["chat-plus", "receipts", messageId], queryFn: () => api.get<{ seenCount: number; audience: number; seen: { name: string; readAt: string }[] | null }>(`/chat-plus/announcements/${messageId}/receipts`) });
  return (
    <Dialog open onClose={onClose} title="Seen by" description={q.data ? `${q.data.seenCount} of ${q.data.audience} people` : undefined}>
      {q.isPending ? <Skeleton className="h-16" /> : q.data?.seen ? (
        <ul className="max-h-72 space-y-1 overflow-y-auto">{q.data.seen.map((s, i) => <li key={i} className="flex justify-between text-[13px]"><span>{s.name}</span><time className="text-subtle" dateTime={s.readAt}>{mailDate(s.readAt)}</time></li>)}</ul>
      ) : <p className="text-[13px] text-muted">Only the poster and admins see names.</p>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ meetings

/** The call panel's Live tab: polls, decisions, questions and word clouds for this meeting. */
export function MeetingLivePanel({ meetingId, isAdmin }: { meetingId: string; isAdmin: boolean }) {
  const q = useQuery({ queryKey: ["chat-plus", "meeting", meetingId], refetchInterval: 8000, queryFn: async () => (await api.get<{ polls: PollView[] }>(`/chat-plus/meetings/${meetingId}/polls`)).polls });
  return (
    <div className="space-y-3 p-3" data-testid="meeting-live">
      <div className="flex items-center justify-between"><h3 className="text-[13px] font-semibold">Live polls and questions</h3><ChatPlusAdd meetingId={meetingId} isAdmin={isAdmin} onDone={() => void q.refetch()} compact /></div>
      {q.isPending ? <Skeleton className="h-24" /> : !q.data?.length ? <p className="text-[12.5px] text-subtle">Nothing yet. Use Add to run a poll, take questions or make a word cloud during the call.</p>
        : q.data.map((p) => <PollBody key={p.id} poll={p} onChange={() => void q.refetch()} />)}
    </div>
  );
}
