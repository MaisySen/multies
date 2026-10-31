/**
 * R119: helpdesk mode inside the shared inbox: the ticket list and views, the ticket panel over an open thread or
 * chat, and the website chat view. Settings live in ./helpdesk-settings.tsx.
 */
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { useTeam } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { mailDate, fullDate } from "@/web/lib/format";
import { Button } from "@/web/components/ui/button";
import { Select, Textarea } from "@/web/components/ui/input";
import { Badge, Card, EmptyState, Skeleton } from "@/web/components/ui/misc";
import {
  IconArrowLeft, IconChat, IconCheckCircle, IconCopy, IconGlobe, IconInbox, IconMail, IconSend, IconStickyNote, IconTimer, IconUserCheck,
} from "@/web/components/ui/icon";
import {
  CSAT_LABEL, KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, TICKET_PRIORITIES, TICKET_STATUSES, slaLabel, type CsatRating, type HelpdeskSettings, type SlaLevel,
  type SlaPart, type TicketKind, type TicketPriority, type TicketStatus, type TicketView,
} from "@/shared/helpdesk";

export interface Ticket {
  id: string; number: number; kind: TicketKind; refId: string; mailboxId: string | null; subject: string; snippet: string;
  requester: { name: string; email: string | null }; contactId: string | null; status: TicketStatus; priority: TicketPriority;
  assignee: { id: string; name: string } | null; createdAt: string; lastMessageAt: string; unread: number;
  sla: { first: SlaPart; resolve: SlaPart; worst: SlaLevel }; csat: { rating: CsatRating; comment: string | null; at: string } | null; offline: boolean;
}
interface TicketDetail { ticket: Ticket | null; contact?: { id: string; name: string; email: string } | null; history?: { id: string; number: number; subject: string; status: TicketStatus; createdAt: string }[]; csatOn?: boolean }
interface TicketList { on: boolean; tickets: Ticket[]; counts: { open: number; mine: number; unassigned: number; breaching: number } }
export interface HelpdeskSettingsOut { settings: HelpdeskSettings; widgetKey: string; canManage: boolean; on: boolean; snippet: string }
interface Macro { id: string; name: string; steps: unknown[] }

export const useHelpdeskSettings = () => useQuery({ queryKey: ["helpdesk", "settings"], queryFn: () => api.get<HelpdeskSettingsOut>("/helpdesk/settings"), staleTime: 60_000, retry: false });
const useMacros = (on: boolean) => useQuery({ queryKey: ["helpdesk", "macros"], queryFn: () => api.get<{ macros: Macro[] }>("/helpdesk/macros"), enabled: on, staleTime: 60_000 });

const KEY = "mq.helpdesk.view";
export function useTicketView() {
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { view: TicketView; priority: string; kind: string } | null; } catch { return null; } })();
  const [s, setS] = useState(saved ?? { view: "open" as TicketView, priority: "", kind: "" });
  const set = (p: Partial<typeof s>) => { const n = { ...s, ...p }; setS(n); try { sessionStorage.setItem(KEY, JSON.stringify(n)); } catch { /* private mode */ } };
  const q = new URLSearchParams({ view: s.view, ...(s.priority ? { priority: s.priority } : {}), ...(s.kind ? { kind: s.kind } : {}) }).toString();
  return { ...s, set, query: q };
}
export const useTickets = (on: boolean, query: string) =>
  useQuery({ queryKey: ["helpdesk", "tickets", query], queryFn: () => api.get<TicketList>(`/helpdesk/tickets?${query}`), enabled: on, refetchInterval: 20_000 });

const SLA_TONE: Record<SlaLevel, "neutral" | "ok" | "warn" | "bad" | "brand"> = { breached: "bad", warn: "warn", ok: "neutral", met: "ok", paused: "neutral", none: "neutral" };
const PRIORITY_TONE: Record<TicketPriority, "neutral" | "warn" | "bad"> = { low: "neutral", normal: "neutral", high: "warn", urgent: "bad" };
const KIND_ICON: Record<TicketKind, typeof IconMail> = { mail: IconMail, chat: IconChat, web: IconGlobe };

/** The most urgent live clock in a few words, for a row. */
export function SlaChip({ sla, compact }: { sla: Ticket["sla"]; compact?: boolean }) {
  const part = sla.first.level === "warn" || sla.first.level === "breached" || (sla.first.level === "ok" && sla.resolve.level !== "breached" && sla.resolve.level !== "warn")
    ? (sla.first.level === "none" || sla.first.level === "met" ? sla.resolve : sla.first) : sla.resolve;
  const what = part === sla.first ? "First reply" : "Resolve";
  const text = slaLabel(part, what);
  if (!text || part.level === "met" || part.level === "none") return null;
  return <Badge tone={SLA_TONE[part.level]}><IconTimer className="h-3 w-3" aria-hidden />{compact ? text.replace(/^(First reply|Resolve) /, "") : text}</Badge>;
}

export function HelpdeskViewBar({ view, priority, kind, set, counts }: ReturnType<typeof useTicketView> & { counts?: TicketList["counts"] }) {
  const seg = (v: TicketView, label: string, n?: number) => (
    <button key={v} type="button" onClick={() => set({ view: v })} aria-pressed={view === v}
      className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 max-sm:h-11", view === v ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>
      {label}{n != null && n > 0 && <span className={cn("rounded-full px-1.5 text-[11px] tabular-nums", v === "breaching" ? "bg-bad-soft text-bad" : "bg-fill text-muted")}>{n}</span>}
    </button>
  );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="helpdesk-views">
      <div role="group" aria-label="Ticket views" className="flex flex-wrap gap-0.5 rounded-lg bg-fill p-0.5">
        {seg("open", "Open", counts?.open)}{seg("mine", "Mine", counts?.mine)}{seg("unassigned", "Unassigned", counts?.unassigned)}
        {seg("breaching", "Breaching", counts?.breaching)}{seg("solved", "Solved")}
      </div>
      <Select aria-label="Priority" value={priority} onChange={(e) => set({ priority: e.target.value })} className="h-8 w-auto text-[13px] max-sm:h-11">
        <option value="">Any priority</option>
        {[...TICKET_PRIORITIES].reverse().map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
      </Select>
      <Select aria-label="Channel" value={kind} onChange={(e) => set({ kind: e.target.value })} className="h-8 w-auto text-[13px] max-sm:h-11">
        <option value="">All channels</option>
        <option value="mail">Email</option><option value="chat">Chats</option><option value="web">Website chat</option>
      </Select>
    </div>
  );
}

export function TicketRow({ t, selected, onOpen }: { t: Ticket; selected: boolean; onOpen: () => void }) {
  const Icon = KIND_ICON[t.kind];
  return (
    <button onClick={onOpen} aria-current={selected} data-testid="ticket-row"
      className={cn("block w-full px-4 py-3 text-left transition-colors duration-150 hover:bg-hover", selected && "bg-fill/60")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-sm", t.unread ? "font-semibold" : "font-medium")}>
          <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" aria-label={KIND_LABEL[t.kind]} />
          <span className="truncate">{t.requester.name || t.requester.email || "Customer"}</span>
        </span>
        <time className="shrink-0 text-xs text-subtle" dateTime={t.lastMessageAt}>{mailDate(t.lastMessageAt)}</time>
      </div>
      <div className="truncate text-sm"><span className="mr-1.5 font-mono text-xs text-subtle">#{t.number}</span>{t.subject || "(no subject)"}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        {t.status !== "open" && <Badge tone={t.status === "solved" ? "ok" : "neutral"}>{STATUS_LABEL[t.status]}</Badge>}
        {(t.priority === "high" || t.priority === "urgent") && <Badge tone={PRIORITY_TONE[t.priority]}>{PRIORITY_LABEL[t.priority]}</Badge>}
        <SlaChip sla={t.sla} compact />
        {t.assignee ? <Badge><IconUserCheck className="h-3 w-3" aria-hidden />{t.assignee.name}</Badge> : t.status !== "solved" && <span className="text-subtle">Unassigned</span>}
        {t.csat && <Badge tone={t.csat.rating === "bad" ? "bad" : t.csat.rating === "great" ? "ok" : "neutral"}>Rated {CSAT_LABEL[t.csat.rating].toLowerCase()}</Badge>}
      </div>
    </button>
  );
}

const EMPTY: Record<TicketView, { title: string; body: string }> = {
  open: { title: "No open tickets", body: "New mail and chats to the inboxes you picked show up here." },
  mine: { title: "Nothing assigned to you", body: "Tickets you take or are given show up here." },
  unassigned: { title: "Every ticket has an owner", body: "New tickets wait here until someone takes them." },
  breaching: { title: "Nothing close to its target", body: "Tickets near or past their reply or resolve time show up here." },
  solved: { title: "No solved tickets yet", body: "Solved tickets stay here, with the customer's rating when they leave one." },
  all: { title: "No tickets yet", body: "New mail and chats show up here." },
};
export function TicketListBody({ list, view, selectedId, onOpen }: { list: ReturnType<typeof useTickets>; view: TicketView; selectedId: string | null; onOpen: (t: Ticket) => void }) {
  if (list.isPending) return <div className="space-y-3 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}</div>;
  if (list.error) return <div className="p-6 text-sm"><p className="text-bad">{errorMessage(list.error)}</p><Button size="sm" variant="secondary" className="mt-3" onClick={() => list.refetch()}>Try again</Button></div>;
  const rows = list.data?.tickets ?? [];
  if (!rows.length) return <EmptyState icon={view === "breaching" ? <IconCheckCircle /> : <IconInbox />} title={EMPTY[view].title} body={EMPTY[view].body} />;
  return <ul className="divide-y divide-line">{rows.map((t) => <li key={t.id}><TicketRow t={t} selected={selectedId === t.id} onOpen={() => onOpen(t)} /></li>)}</ul>;
}

/** Status, priority, owner, clocks, contact and macros over an open thread, chat or website chat. */
export function TicketPanel({ kind, refId, ticketId, onReplyText }: { kind: TicketKind; refId?: string; ticketId?: string; onReplyText?: (text: string) => void }) {
  const qc = useQueryClient();
  const key = ["helpdesk", "ticket", kind, refId ?? ticketId];
  const q = useQuery({
    queryKey: key, retry: false,
    queryFn: () => ticketId ? api.get<TicketDetail>(`/helpdesk/tickets/${ticketId}`) : api.get<TicketDetail>(`/helpdesk/tickets/by-ref?kind=${kind}&ref=${encodeURIComponent(refId ?? "")}`),
  });
  const team = useTeam();
  const macros = useMacros(!!q.data?.ticket);
  const [macroReply, setMacroReply] = useState<string | null>(null);
  const done = (d: TicketDetail) => { qc.setQueryData(key, d); qc.invalidateQueries({ queryKey: ["helpdesk", "tickets"] }); };
  const patch = useMutation({
    mutationFn: (b: { status?: TicketStatus; priority?: TicketPriority; assigneeUserId?: string | null }) => api.patch<TicketDetail>(`/helpdesk/tickets/${q.data!.ticket!.id}`, b),
    onSuccess: (d, b) => { done(d); qc.invalidateQueries({ queryKey: ["team-inbox"] }); if (b.status === "solved") toast.success(d.csatOn ? "Solved. The customer gets a short survey." : "Solved"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const run = useMutation({
    mutationFn: (id: string) => api.post<TicketDetail & { reply: string | null; ran: { name: string } }>(`/helpdesk/tickets/${q.data!.ticket!.id}/macros/${id}`),
    onSuccess: (d) => {
      done(d);
      if (d.reply) { if (onReplyText) onReplyText(d.reply); else setMacroReply(d.reply); }
      toast.success(`Ran ${d.ran.name}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const contact = useMutation({
    mutationFn: () => api.post<{ contactId: string }>(`/helpdesk/tickets/${q.data!.ticket!.id}/contact`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); toast.success("Added to contacts"); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isPending) return <Card className="p-4"><Skeleton className="h-5 w-1/3" /><Skeleton className="mt-3 h-9" /></Card>;
  if (q.error || !q.data?.ticket) return null;
  const t = q.data.ticket;
  const people = (team.data?.members ?? []).filter((m) => m.kind === "human");
  const busy = patch.isPending || run.isPending;
  const first = slaLabel(t.sla.first, "First reply"), resolve = slaLabel(t.sla.resolve, "Resolve");
  return (
    <Card className="p-4" data-testid="ticket-panel">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold">#{t.number}</span>
        <Badge>{KIND_LABEL[t.kind]}</Badge>
        {first && <Badge tone={SLA_TONE[t.sla.first.level]}><IconTimer className="h-3 w-3" aria-hidden />{first}</Badge>}
        {resolve && <Badge tone={SLA_TONE[t.sla.resolve.level]}><IconTimer className="h-3 w-3" aria-hidden />{resolve}</Badge>}
        {t.csat && <Badge tone={t.csat.rating === "bad" ? "bad" : t.csat.rating === "great" ? "ok" : "neutral"}>Rated {CSAT_LABEL[t.csat.rating].toLowerCase()}</Badge>}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-xs font-medium text-muted">Status
          <Select value={t.status} disabled={busy} onChange={(e) => patch.mutate({ status: e.target.value as TicketStatus })} className="mt-1 h-9 w-full text-sm max-sm:h-11">
            {TICKET_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </Select>
        </label>
        <label className="text-xs font-medium text-muted">Priority
          <Select value={t.priority} disabled={busy} onChange={(e) => patch.mutate({ priority: e.target.value as TicketPriority })} className="mt-1 h-9 w-full text-sm max-sm:h-11">
            {[...TICKET_PRIORITIES].reverse().map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
          </Select>
        </label>
        <label className="text-xs font-medium text-muted">Owner
          <Select value={t.assignee?.id ?? ""} disabled={busy} onChange={(e) => patch.mutate({ assigneeUserId: e.target.value || null })} className="mt-1 h-9 w-full text-sm max-sm:h-11">
            <option value="">Nobody</option>
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.name || m.email}</option>)}
            {t.assignee && !people.some((m) => m.userId === t.assignee!.id) && <option value={t.assignee.id}>{t.assignee.name}</option>}
          </Select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 truncate text-muted">{t.requester.name}{t.requester.email && t.requester.email !== t.requester.name ? ` · ${t.requester.email}` : ""}</span>
        {q.data.contact ? <Link to={`/app/contacts?contact=${q.data.contact.id}`} className="text-[13px] font-medium text-brand hover:underline">Open contact</Link>
          : t.requester.email ? <Button size="sm" variant="ghost" onClick={() => contact.mutate()} loading={contact.isPending}>Add to contacts</Button> : null}
        <div className="ml-auto flex items-center gap-2 max-sm:ml-0 max-sm:w-full">
          {(macros.data?.macros.length ?? 0) > 0 && (
            <Select aria-label="Run a macro" value="" disabled={busy} onChange={(e) => e.target.value && run.mutate(e.target.value)} className="h-8 w-auto text-[13px] max-sm:h-11 max-sm:flex-1">
              <option value="">Run a macro</option>
              {macros.data!.macros.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          )}
          {t.status !== "solved" && <Button size="sm" onClick={() => patch.mutate({ status: "solved" })} disabled={busy} className="max-sm:flex-1"><IconCheckCircle className="h-4 w-4" aria-hidden />Solve</Button>}
        </div>
      </div>
      {macroReply && (
        <div className="mt-3 rounded-lg border border-line p-3 text-sm">
          <p className="mb-1 text-xs font-medium text-muted">Reply from the macro</p>
          <p className="whitespace-pre-wrap">{macroReply}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(macroReply); toast.success("Copied. Paste it in the reply box."); }}><IconCopy className="h-4 w-4" aria-hidden />Copy</Button>
            <Button size="sm" variant="ghost" onClick={() => setMacroReply(null)}>Dismiss</Button>
          </div>
        </div>
      )}
      {(q.data.history?.length ?? 0) > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-[13px] text-muted hover:text-fg">Earlier tickets from this customer ({q.data.history!.length})</summary>
          <ul className="mt-2 space-y-1">{q.data.history!.map((h) => <li key={h.id} className="flex gap-2 text-[13px]"><span className="font-mono text-subtle">#{h.number}</span><span className="truncate">{h.subject}</span><span className="ml-auto shrink-0 text-subtle">{STATUS_LABEL[h.status]}</span></li>)}</ul>
        </details>
      )}
      {t.csat?.comment && <p className="mt-3 rounded-lg bg-fill p-3 text-sm"><span className="font-medium">Customer comment: </span>{t.csat.comment}</p>}
    </Card>
  );
}

interface WebMsg { id: string; author: "visitor" | "agent" | "bot" | "system" | "note"; name: string | null; text: string; via: string | null; at: string }
interface WebThread { messages: WebMsg[]; visitorTyping: boolean; visitorOnline: boolean; page: string | null; email: string | null; offline: boolean }

/** A website chat, live: polls every 3 s while open, typing marks both ways, replies and internal notes. */
export function WebChatView({ ticketId, onBack }: { ticketId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const key = ["helpdesk", "web", ticketId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<WebThread>(`/helpdesk/tickets/${ticketId}/web`), refetchInterval: 3000 });
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const typedAt = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void api.post(`/helpdesk/tickets/${ticketId}/read`).then(() => qc.invalidateQueries({ queryKey: ["helpdesk", "tickets"] }), () => {}); }, [ticketId, qc]);
  const n = q.data?.messages.length ?? 0;
  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [n]);
  const send = useMutation({
    mutationFn: () => api.post<WebThread>(`/helpdesk/tickets/${ticketId}/web`, { text, note }),
    onSuccess: (d) => { qc.setQueryData(key, d); setText(""); qc.invalidateQueries({ queryKey: ["helpdesk", "ticket"] }); qc.invalidateQueries({ queryKey: ["helpdesk", "tickets"] }); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const typing = (v: string) => {
    setText(v);
    const now = Date.now();
    if (!note && now - typedAt.current > 3000) { typedAt.current = now; void api.post(`/helpdesk/tickets/${ticketId}/typing`).catch(() => {}); }
  };
  const d = q.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={onBack} className="grid shrink-0 place-items-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg lg:hidden max-sm:-ml-1.5 max-sm:h-11 max-sm:w-11" aria-label="Back to tickets"><IconArrowLeft className="h-4 w-4" /></button>
        <h2 className="min-w-0 flex-1 text-lg font-semibold tracking-tight">Website chat</h2>
        {d && <Badge tone={d.visitorOnline ? "ok" : "neutral"} dot>{d.visitorOnline ? "On the site now" : d.email ? "Away, replies go by email" : "Away"}</Badge>}
      </div>
      <TicketPanel kind="web" ticketId={ticketId} onReplyText={(t) => { setNote(false); setText(t); }} />
      <Card className="flex flex-col overflow-hidden">
        {d?.page && <p className="border-b border-line px-4 py-2 text-xs text-subtle">Started on <span className="font-mono [overflow-wrap:anywhere]">{d.page}</span></p>}
        <div ref={logRef} role="log" aria-label="Chat messages" aria-live="polite" className="flex max-h-[min(52dvh,520px)] min-h-[200px] flex-col gap-2 overflow-y-auto p-4" data-testid="web-chat-log">
          {q.isPending ? <><Skeleton className="h-10 w-2/3" /><Skeleton className="ml-auto h-10 w-1/2" /></>
            : q.error ? <p className="text-sm text-bad">{errorMessage(q.error)}</p>
            : d!.messages.map((m) => m.author === "system" ? (
              <p key={m.id} className="self-center text-xs text-subtle">{m.text === "csat" ? "Survey sent to the visitor" : m.text}</p>
            ) : (
              <div key={m.id} className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm",
                m.author === "visitor" && "self-start rounded-bl-md bg-fill",
                m.author === "agent" && "self-end rounded-br-md bg-brand text-brand-fg",
                m.author === "bot" && "self-start rounded-bl-md border border-dashed border-line-strong",
                m.author === "note" && "self-end rounded-br-md border border-warn/40 bg-warn-soft")}>
                <p className={cn("mb-0.5 text-[11px]", m.author === "agent" ? "text-brand-fg/80" : "text-subtle")}>
                  {m.author === "visitor" ? "Visitor" : m.author === "bot" ? "Automatic answer" : m.author === "note" ? `Note by ${m.name}` : m.name}
                  {" · "}<time dateTime={m.at} title={fullDate(m.at)}>{mailDate(m.at)}</time>{m.via === "mail" ? " · also sent by email" : ""}
                </p>
                <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</p>
              </div>
            ))}
        </div>
        <p className="h-5 px-4 text-xs text-subtle" aria-live="polite">{d?.visitorTyping ? "Visitor is typing" : ""}</p>
        <form className="border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(); }}>
          <div role="group" aria-label="Message type" className="mb-2 inline-flex gap-0.5 rounded-lg bg-fill p-0.5">
            {[["reply", "Reply", IconSend], ["note", "Note", IconStickyNote]].map(([k, label, I]) => {
              const Ico = I as typeof IconSend;
              return <button key={k as string} type="button" aria-pressed={note === (k === "note")} onClick={() => setNote(k === "note")}
                className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium max-sm:h-11", note === (k === "note") ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}><Ico className="h-3.5 w-3.5" aria-hidden />{label as string}</button>;
            })}
          </div>
          <Textarea aria-label={note ? "Internal note" : "Reply to the visitor"} value={text} onChange={(e) => typing(e.target.value)} rows={3} maxLength={4000}
            placeholder={note ? "Only your team sees notes" : d && !d.visitorOnline && d.email ? "The visitor is away. Your reply also goes to their email." : "Write a reply"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (text.trim()) send.mutate(); } }} className={cn(note && "bg-warn-soft")} />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs text-subtle max-sm:hidden">Enter sends, Shift Enter adds a line</span>
            <Button type="submit" size="sm" loading={send.isPending} disabled={!text.trim()} className="max-sm:w-full">{note ? "Add note" : "Send reply"}</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
