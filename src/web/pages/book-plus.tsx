/**
 * R92 public pages, logged out and phone first: a time poll (/book/poll/:token), an event (/book/event/:slug) and a
 * ticket with its QR code (/book/ticket/:id?c=). Every form carries the spam shield.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconCalendarDays, IconCheckCircle, IconClock, IconMapPin, IconTeam, IconVideo } from "@/web/components/ui/icon";
import { api, ApiError } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { Logo } from "@/web/components/logo";
import { QrCode } from "@/web/components/qr";
import { Button } from "@/web/components/ui/button";
import { Field, Input } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Honeypot, useShield } from "@/web/lib/use-shield";
import { POLL_ANSWER_LABEL, type PollAnswer } from "@/shared/booking-plus";

const dayLabel = (s: string, tz?: string) => new Date(s).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", timeZone: tz });
const timeLabel = (s: string, tz?: string) => new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
const fullLabel = (s: string, tz?: string) => new Date(s).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: tz });
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-bg px-4 py-8 text-fg sm:py-12">
      <div className="mx-auto max-w-2xl">{children}</div>
      <div className="mt-8 flex items-center justify-center gap-2 text-[12px] text-subtle">Made with <Logo className="h-4" /></div>
    </main>
  );
}
function Loading() {
  return <Shell><Card className="space-y-3 p-6"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-40" /></Card></Shell>;
}
function Missing({ title, body, retry }: { title: string; body: string; retry?: () => void }) {
  return <Shell><Card><EmptyState icon={<IconCalendarDays />} title={title} body={body} action={retry ? <Button variant="secondary" onClick={retry}>Try again</Button> : undefined} /></Card></Shell>;
}
function Meta({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return <div className="flex min-w-0 items-start gap-2 text-[14px] text-muted"><span className="mt-0.5 shrink-0 [&_svg]:h-4 [&_svg]:w-4">{icon}</span><span className="min-w-0 break-words">{children}</span></div>;
}

/* Time poll */

interface PublicPoll {
  id: string; title: string; description: string; location: string; durationMin: number; timezone: string; video: boolean; status: "open" | "closed"; open: boolean; host: string;
  winnerOptionId: string | null; deadlineAt: string | null; options: { id: string; startsAt: string }[];
  votes: { id: string; name: string; answers: Record<string, PollAnswer> }[]; totals: { optionId: string; yes: number; maybe: number; no: number; score: number }[]; best: string | null;
}
const ANSWER_STYLE: Record<PollAnswer, string> = {
  yes: "border-ok/40 bg-ok-soft text-fg", maybe: "border-warn/40 bg-warn-soft text-fg", no: "border-line-strong bg-fill text-muted",
};

export function PollVotePage() {
  const { token = "" } = useParams();
  const qc = useQueryClient();
  const key = `r92-poll-${token}`;
  const poll = useQuery({ queryKey: ["pub-poll", token], retry: false, queryFn: async () => (await api.get<{ poll: PublicPoll }>(`/pub/booking/polls/${token}`)).poll });
  const saved = useMemo(() => { try { return JSON.parse(localStorage.getItem(key) ?? "null") as { voteId: string; editToken: string } | null; } catch { return null; } }, [key]);
  const [mine, setMine] = useState(saved);
  const [answers, setAnswers] = useState<Record<string, PollAnswer>>({});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const shield = useShield("poll");

  useEffect(() => {
    if (!poll.data || !mine) return;
    const v = poll.data.votes.find((x) => x.id === mine.voteId);
    if (v) { setAnswers(v.answers); setName(v.name); }
  }, [poll.data, mine]);

  if (poll.isPending) return <Loading />;
  if (poll.isError) return poll.error instanceof ApiError && poll.error.status === 404
    ? <Missing title="This poll is not here" body="The link may be wrong, or the poll was deleted. Ask whoever sent it for a new link." />
    : <Missing title="We could not load this poll" body="Check your connection and try again." retry={() => poll.refetch()} />;
  const p = poll.data;
  const tz = zone();
  const totals = Object.fromEntries(p.totals.map((t) => [t.optionId, t]));
  const winner = p.options.find((o) => o.id === p.winnerOptionId);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter your name.");
    if (!Object.keys(answers).length) return setError("Answer at least one time.");
    setBusy(true);
    try {
      if (mine) {
        await api.put(`/pub/booking/polls/${token}/votes/${mine.voteId}`, { editToken: mine.editToken, name, ...(email ? { email } : {}), answers });
      } else {
        const r = await shield.send((s) => api.post<{ voteId: string; editToken: string }>(`/pub/booking/polls/${token}/votes`, { name, email: email || undefined, answers, shield: s }));
        const m = { voteId: r.voteId, editToken: r.editToken };
        try { localStorage.setItem(key, JSON.stringify(m)); } catch { /* private mode */ }
        setMine(m);
      }
      setDone(true);
      await qc.invalidateQueries({ queryKey: ["pub-poll", token] });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <Card className="p-5 sm:p-7">
        <p className="text-[13px] font-medium text-subtle">{p.host ? `${p.host} asks when you are free` : "When are you free?"}</p>
        <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-tight sm:text-[26px]">{p.title}</h1>
        <div className="mt-3 space-y-1.5">
          <Meta icon={<IconClock />}>{p.durationMin} minutes · times shown in {tz}</Meta>
          {p.location && <Meta icon={<IconMapPin />}>{p.location}</Meta>}
          {p.video && <Meta icon={<IconVideo />}>Video call link sent when a time is picked</Meta>}
        </div>
        {p.description && <p className="mt-4 whitespace-pre-wrap text-[14px] text-fg">{p.description}</p>}
      </Card>

      {winner ? (
        <Card className="mt-4 flex items-start gap-3 border-ok/40 p-5" data-testid="poll-winner">
          <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
          <div><p className="font-semibold">A time was picked</p><p className="text-[14px] text-muted">{fullLabel(winner.startsAt, tz)}</p></div>
        </Card>
      ) : !p.open ? (
        <Card className="mt-4 p-5 text-[14px] text-muted">This poll is closed, so answers can't change.</Card>
      ) : null}

      <form onSubmit={send} className="relative mt-4" noValidate>
        <Card className="p-0">
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
            <h2 className="text-[15px] font-semibold">{p.open ? "Your answer for each time" : "Answers"}</h2>
            <span className="text-[13px] text-subtle">{p.votes.length} {p.votes.length === 1 ? "person" : "people"} answered</span>
          </div>
          <ul className="divide-y divide-line">
            {p.options.map((o) => {
              const t = totals[o.id];
              const best = p.best === o.id && p.votes.length > 0;
              const who = p.votes.filter((v) => v.answers[o.id] === "yes" || v.answers[o.id] === "maybe");
              return (
                <li key={o.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center" data-testid="poll-option">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[15px] font-semibold">{dayLabel(o.startsAt, tz)}</span>
                      <span className="text-[15px] text-muted">{timeLabel(o.startsAt, tz)}</span>
                      {best && <Badge tone="ok">Best so far</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-[13px] text-subtle" title={who.map((v) => v.name).join(", ")}>
                      {t.yes} yes{t.maybe ? `, ${t.maybe} if need be` : ""}{who.length ? ` · ${who.slice(0, 4).map((v) => v.name).join(", ")}${who.length > 4 ? ` and ${who.length - 4} more` : ""}` : ""}
                    </p>
                  </div>
                  {p.open && (
                    <div role="radiogroup" aria-label={`${dayLabel(o.startsAt, tz)} ${timeLabel(o.startsAt, tz)}`} className="grid shrink-0 grid-cols-3 gap-1.5 sm:w-[300px]">
                      {(["yes", "maybe", "no"] as PollAnswer[]).map((a) => (
                        <button key={a} type="button" role="radio" aria-checked={answers[o.id] === a} onClick={() => setAnswers({ ...answers, [o.id]: a })}
                          className={cn("min-h-11 rounded-lg border px-2 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand", answers[o.id] === a ? ANSWER_STYLE[a] : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg")}>
                          {POLL_ANSWER_LABEL[a]}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
        {p.open && (
          <Card className="mt-4 space-y-4 p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name">{(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />}</Field>
              <Field label="Email (optional)" hint="We send the final time here.">{(f) => <Input {...f} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={200} />}</Field>
            </div>
            <Honeypot {...shield.honeypot} />
            {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
            {done && !error && <p role="status" className="text-[14px] text-ok">Thanks, your answers are saved. You can change them here until the poll closes.</p>}
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy ? "Saving" : mine ? "Save changes" : "Send answers"}</Button>
          </Card>
        )}
      </form>
    </Shell>
  );
}

/* Event */

interface PublicEvent {
  slug: string; title: string; description: string; location: string; onlineUrl: string; startsAt: string; endsAt: string; timezone: string; capacity: number | null; waitlist: boolean;
  status: "published" | "cancelled"; organiser: string; spotsLeft: number | null; full: boolean; waitlistOpen: boolean; waiting: number; past: boolean;
}
interface Rsvped { status: "going" | "waitlist" | "resent"; ticketId?: string; code?: string; url?: string }

function EventCard({ e }: { e: PublicEvent }) {
  const tz = zone();
  return (
    <Card className="p-5 sm:p-7">
      {e.organiser && <p className="text-[13px] font-medium text-subtle">{e.organiser}</p>}
      <h1 className="mt-1 text-[22px] font-semibold leading-tight tracking-tight sm:text-[26px]">{e.title}</h1>
      <div className="mt-3 space-y-1.5">
        <Meta icon={<IconCalendarDays />}>{fullLabel(e.startsAt, tz)} to {timeLabel(e.endsAt, tz)}</Meta>
        {e.location && <Meta icon={<IconMapPin />}>{e.location}</Meta>}
        {e.onlineUrl && <Meta icon={<IconVideo />}>Online link in your ticket</Meta>}
        {e.capacity != null && <Meta icon={<IconTeam />}>{e.full ? (e.waitlistOpen ? "Full, waitlist open" : "Full") : `${e.spotsLeft} of ${e.capacity} places left`}</Meta>}
      </div>
      {e.description && <p className="mt-4 whitespace-pre-wrap text-[14px] text-fg">{e.description}</p>}
    </Card>
  );
}

export function EventRsvpPage() {
  const { slug = "" } = useParams();
  const ev = useQuery({ queryKey: ["pub-event", slug], retry: false, queryFn: async () => (await api.get<{ event: PublicEvent }>(`/pub/booking/events/${slug}`)).event });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Rsvped | null>(null);
  const shield = useShield("event");
  if (ev.isPending) return <Loading />;
  if (ev.isError) return ev.error instanceof ApiError && ev.error.status === 404
    ? <Missing title="This event is not here" body="The link may be wrong, or the event is not open yet." />
    : <Missing title="We could not load this event" body="Check your connection and try again." retry={() => ev.refetch()} />;
  const e = ev.data;
  const closed = e.status === "cancelled" || e.past || (e.full && !e.waitlistOpen);
  const send = async (evt: FormEvent) => {
    evt.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Enter your name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Enter a valid email address.");
    setBusy(true);
    try {
      setDone(await shield.send((s) => api.post<Rsvped>(`/pub/booking/events/${slug}/rsvp`, { name, email, shield: s })));
      void ev.refetch();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <EventCard e={e} />
      {done ? (
        <Card className="mt-4 p-5 sm:p-7" data-testid="rsvp-done">
          {done.status === "going" && done.url ? (
            <TicketBody url={done.url} code={done.code ?? ""} name={name} lead="You're going. Your ticket is below and in your email." />
          ) : done.status === "waitlist" ? (
            <p className="text-[15px]"><strong>You're on the waitlist.</strong> We'll email your ticket if a place opens up.</p>
          ) : (
            <p className="text-[15px]"><strong>Check your email.</strong> If this address is signed up, we've sent the ticket to it again.</p>
          )}
        </Card>
      ) : closed ? (
        <Card className="mt-4 p-5 text-[14px] text-muted">{e.status === "cancelled" ? "This event was cancelled." : e.past ? "This event has ended." : "This event is full."}</Card>
      ) : (
        <form onSubmit={send} noValidate className="relative mt-4">
          <Card className="space-y-4 p-5 sm:p-7">
            <h2 className="text-[16px] font-semibold">{e.full ? "Join the waitlist" : "Get a free ticket"}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Your name">{(f) => <Input {...f} value={name} onChange={(x) => setName(x.target.value)} autoComplete="name" maxLength={80} />}</Field>
              <Field label="Email" hint="Your ticket goes here.">{(f) => <Input {...f} type="email" value={email} onChange={(x) => setEmail(x.target.value)} autoComplete="email" maxLength={200} />}</Field>
            </div>
            <Honeypot {...shield.honeypot} />
            {error && <p role="alert" className="text-[14px] text-bad">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">{busy ? "Saving" : e.full ? "Join the waitlist" : "Get my ticket"}</Button>
          </Card>
        </form>
      )}
    </Shell>
  );
}

function TicketBody({ url, code, name, lead }: { url: string; code: string; name: string; lead?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {lead && <p className="text-[15px]">{lead}</p>}
      <div className="rounded-xl border border-line bg-white p-3"><QrCode value={url} size={208} label={`Ticket QR code for ${name}`} /></div>
      <p className="font-mono text-[22px] font-semibold tracking-[0.2em]" data-testid="ticket-code">{code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code}</p>
      <p className="text-[13px] text-subtle">Show this at the door, or read out the code.</p>
    </div>
  );
}

interface PublicTicket { ticket: { id: string; name: string; status: "going" | "waitlist" | "cancelled"; checkedIn: boolean; code: string; url: string }; event: PublicEvent }

export function TicketPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const code = params.get("c") ?? "";
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const t = useQuery({ queryKey: ["pub-ticket", id, code], retry: false, queryFn: () => api.get<PublicTicket>(`/pub/booking/tickets/${id}?c=${encodeURIComponent(code)}`) });
  if (t.isPending) return <Loading />;
  if (t.isError) return t.error instanceof ApiError && t.error.status === 404
    ? <Missing title="This ticket is not here" body="Open the link from your ticket email again." />
    : <Missing title="We could not load your ticket" body="Check your connection and try again." retry={() => t.refetch()} />;
  const { ticket, event } = t.data;
  const cancel = async () => {
    setBusy(true);
    try { await api.post(`/pub/booking/tickets/${id}/cancel`, { c: code }); await t.refetch(); } finally { setBusy(false); setConfirming(false); }
  };
  return (
    <Shell>
      <EventCard e={event} />
      <Card className="mt-4 p-5 sm:p-7" data-testid="ticket">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="truncate text-[16px] font-semibold">{ticket.name}</h2>
          <Badge tone={ticket.status === "going" ? "ok" : ticket.status === "waitlist" ? "warn" : "neutral"}>{ticket.checkedIn ? "Checked in" : ticket.status === "going" ? "Going" : ticket.status === "waitlist" ? "Waitlist" : "Cancelled"}</Badge>
        </div>
        {ticket.status === "going" && event.status !== "cancelled" ? <TicketBody url={ticket.url} code={ticket.code.replace(" ", "")} name={ticket.name} />
          : ticket.status === "waitlist" ? <p className="text-[14px] text-muted">You're on the waitlist. We'll email your ticket if a place opens up.</p>
            : <p className="text-[14px] text-muted">{event.status === "cancelled" ? "This event was cancelled." : "You gave up your place."}</p>}
        {ticket.status !== "cancelled" && event.status !== "cancelled" && !event.past && (
          <div className="mt-6 border-t border-line pt-4">
            {confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[14px]">Give up your place? Someone on the waitlist may take it.</span>
                <Button variant="danger" size="sm" disabled={busy} onClick={cancel}>Yes, give it up</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep it</Button>
              </div>
            ) : <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>I can't come</Button>}
          </div>
        )}
      </Card>
    </Shell>
  );
}
