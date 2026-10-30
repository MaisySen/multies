/**
 * C1 (chat channels, phase 1): chats in the shared inbox. The chat rows that merge into the mail list, the channel
 * filter, and the chat view (bubbles, the reply window pill, the composer, the template sheet once the 24 hour window
 * has closed, notes, and make a task from a message). Server: /api/channels/conversations/* (src/shared/channels.ts).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IconArrowLeft, IconAssign, IconAttachment, IconCheck, IconCheckCircle, IconCheckDouble, IconCircleDot, IconClock, IconClose,
  IconAgent, IconFile, IconHourglass, IconListPlus, IconSend, IconStickyNote, IconTrash, IconUserMinus, IconUserRound, IconWarning,
} from "@/web/components/ui/icon";
import { api, ApiError, errorMessage, newIdempotencyKey } from "@/web/lib/api";
import { useMe, useTeam } from "@/web/lib/queries";
import { cn } from "@/web/lib/cn";
import { fullDate, mailDate } from "@/web/lib/format";
import { Avatar, Badge, Card, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Menu, MenuItem, MenuLabel } from "@/web/components/ui/menu";
import {
  PROVIDER_LABEL, replyWindow,
  type ChannelProvider, type ChatMessage, type ChatTemplate, type ConversationDetail, type ConversationStatus, type ConversationSummary,
} from "@/shared/channels";
import { ChannelChip } from "./channels-ui";
import { chatQuery, closedWindowCopy, fileTooBig, fillTemplate, mergeByDate, sizeLabel, windowPill } from "@/web/lib/chat-channels";
export { mergeByDate };
import type { InboxView } from "./inbox-assign";

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

/* ---------- List ---------- */

/** "all", "email", or one chat provider. */
export type ChannelFilter = "all" | "email" | ChannelProvider;
const FILTER_KEY = "multies.inbox.channel";

export function useChannelFilter() {
  const [filter, setFilter] = useState<ChannelFilter>(() => { try { return (sessionStorage.getItem(FILTER_KEY) as ChannelFilter | null) ?? "all"; } catch { return "all"; } });
  const set = (f: ChannelFilter) => { setFilter(f); try { sessionStorage.setItem(FILTER_KEY, f); } catch { /* private mode */ } };
  return { filter, set };
}

export function useChatConversations(enabled: boolean, view: InboxView, assignee: string | null) {
  const { qs, hideDone } = chatQuery(view, assignee);
  return useQuery({
    queryKey: ["channels", "list", qs],
    queryFn: async () => {
      const r = await api.get<{ data: ConversationSummary[] }>(`/channels/conversations${qs}`);
      return hideDone ? r.data.filter((c) => c.status !== "done") : r.data;
    },
    enabled,
    refetchInterval: 20_000,
    retry: false,
  });
}

/** The channel filter: a segmented control on desktop, the phone picker on a phone. */
export function ChannelFilterControl({ filter, set, providers }: { filter: ChannelFilter; set: (f: ChannelFilter) => void; providers: ChannelProvider[] }) {
  const opts: { v: ChannelFilter; label: string }[] = [{ v: "all", label: "All" }, { v: "email", label: "Email" }, { v: "whatsapp", label: "WhatsApp" }];
  for (const p of ["messenger", "instagram", "mock"] as const) if (providers.includes(p)) opts.push({ v: p, label: PROVIDER_LABEL[p] });
  return (
    <>
      <div role="group" aria-label="Channel" data-testid="channel-filter" className="inline-flex items-center gap-0.5 rounded-lg bg-fill p-0.5 max-sm:hidden">
        {opts.map((o) => (
          <button key={o.v} type="button" onClick={() => set(o.v)} aria-pressed={filter === o.v}
            className={cn("h-7 rounded-md px-3 text-[13px] font-medium transition-colors duration-150", filter === o.v ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>{o.label}</button>
        ))}
      </div>
      <div className="sm:hidden" data-testid="channel-filter-phone">
        <Select bare aria-label="Channel" value={filter} onChange={(e) => set(e.target.value as ChannelFilter)}
          phoneClassName={cn("h-11 min-w-[8.5rem] rounded-lg border border-line-strong bg-surface pl-3 pr-8 text-left text-[15px] font-medium", filter !== "all" && "border-brand/50 text-brand-hover")}>
          {opts.map((o) => <option key={o.v} value={o.v}>{o.v === "all" ? "All channels" : o.label}</option>)}
        </Select>
      </div>
    </>
  );
}

/** One chat in the shared list. */
export function ChatRow({ c, selected, onOpen, channelName }: { c: ConversationSummary; selected: boolean; onOpen: () => void; channelName?: string }) {
  return (
    <button onClick={onOpen} aria-current={selected} data-testid="chat-row" data-conv={c.id}
      className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-hover max-sm:min-h-[64px]", selected && "bg-fill/60")}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChannelChip provider={c.provider} compact />
          <span className={cn("truncate text-sm", c.unreadCount ? "font-semibold" : "font-medium")}>{c.contactName}</span>
          {c.unreadCount > 0 && <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-brand px-1 text-[11px] font-semibold text-brand-fg tabular-nums" aria-label={`${c.unreadCount} unread`}>{c.unreadCount}</span>}
        </span>
        <time className={cn("shrink-0 text-xs", c.unreadCount ? "font-semibold text-brand-hover" : "text-subtle")} dateTime={c.lastMessageAt}>{mailDate(c.lastMessageAt)}</time>
      </div>
      <div className={cn("mt-0.5 truncate text-sm", c.unreadCount ? "text-fg" : "text-muted")}>{c.snippet || "Attachment"}</div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="truncate text-subtle">{channelName ? `${PROVIDER_LABEL[c.provider]} · ${channelName}` : PROVIDER_LABEL[c.provider]}</span>
        {c.labels.map((l) => <Badge key={l}>{l}</Badge>)}
        {(c.assignee || c.status !== "open") && (
          <span className="ml-auto inline-flex items-center gap-1.5" data-testid="chat-assignee">
            {c.status === "waiting" && <IconHourglass className="h-3.5 w-3.5 text-subtle" aria-label="Waiting on the customer" />}
            {c.status === "done" && <IconCheckCircle className="h-3.5 w-3.5 text-ok" aria-label="Done" />}
            {c.assignee && <span title={`Assigned to ${c.assignee.name}`}><Avatar label={initials(c.assignee.name)} className="h-5 w-5 text-[9px]" /><span className="sr-only">Assigned to {c.assignee.name}</span></span>}
          </span>
        )}
      </div>
    </button>
  );
}

/* ---------- Chat view ---------- */

const detailKey = (id: string) => ["channels", "conv", id] as const;

interface Pending { key: string; text: string; file: { name: string; contentType: string; size: number } | null; date: string; failed: string | null; body: { text?: string; file?: { name: string; contentType: string; dataB64: string } } }

export function ChatView({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: detailKey(id), queryFn: () => api.get<ConversationDetail>(`/channels/conversations/${encodeURIComponent(id)}`), refetchInterval: 10_000 });
  const [pending, setPending] = useState<Pending[]>([]);
  const [closedByServer, setClosedByServer] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [notes, setNotes] = useState(false);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  useEffect(() => { setPending([]); setClosedByServer(false); }, [id]);

  // Mark read on open, and again when new messages arrive while it is open.
  const unread = q.data?.conversation.unreadCount ?? 0;
  useEffect(() => {
    if (!q.data || unread === 0) return;
    void api.post(`/channels/conversations/${encodeURIComponent(id)}/read`, {}).then(() => qc.invalidateQueries({ queryKey: ["channels", "list"] })).catch(() => undefined);
  }, [id, unread, q.data, qc]);

  const scroller = useRef<HTMLDivElement>(null);
  const count = (q.data?.messages.length ?? 0) + pending.length;
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [count, id]);

  const send = async (p: Pending) => {
    setPending((xs) => [...xs.filter((x) => x.key !== p.key), { ...p, failed: null }]);
    try {
      const r = await api.post<{ message: ChatMessage }>(`/channels/conversations/${encodeURIComponent(id)}/messages`, p.body, { idempotencyKey: p.key });
      qc.setQueryData<ConversationDetail>(detailKey(id), (d) => d && !d.messages.some((m) => m.id === r.message.id) ? { ...d, messages: [...d.messages, r.message] } : d);
      setPending((xs) => xs.filter((x) => x.key !== p.key));
      void qc.invalidateQueries({ queryKey: ["channels", "list"] });
    } catch (e) {
      if (e instanceof ApiError && e.code === "window_closed") {
        setPending((xs) => xs.filter((x) => x.key !== p.key));
        setClosedByServer(true);
        toast.error("The reply window has closed. Send an approved template instead.");
        return;
      }
      setPending((xs) => xs.map((x) => x.key === p.key ? { ...x, failed: errorMessage(e, "Couldn't send. Tap to try again.") } : x));
    }
  };

  if (q.isPending) return <Card className="p-5" data-testid="chat-view"><Skeleton className="h-6 w-1/2" /><Skeleton className="mt-6 h-10 w-2/3" /><Skeleton className="ml-auto mt-3 h-10 w-1/2" /><Skeleton className="mt-3 h-10 w-3/5" /></Card>;
  if (q.error) return <Card className="p-6 text-sm text-bad" data-testid="chat-view">{errorMessage(q.error, "Couldn't open this chat. Try again.")}</Card>;
  const d = q.data;
  const c = d.conversation;
  const w = closedByServer ? { open: false, closesAt: d.window.closesAt } : (d.window.closesAt ? replyWindow(c.lastInboundAt, now) : d.window);
  const pill = windowPill(w, now);
  const disconnected = d.channel.status === "disconnected";

  return (
    <Card data-testid="chat-view"
      className="flex flex-col overflow-hidden max-lg:fixed max-lg:inset-x-0 max-lg:top-0 max-lg:bottom-[var(--kb-h,0px)] max-lg:z-40 max-lg:rounded-none max-lg:border-0 max-lg:bg-bg max-lg:shadow-none lg:h-[calc(100dvh-11rem)]">
      {/* Header. On a phone the view is full screen and its bottom follows the keyboard (--kb-h from lib/keyboard-inset). */}
      <div className="border-b border-line bg-surface/90 px-3 py-2.5 backdrop-blur max-lg:pt-[calc(0.625rem+env(safe-area-inset-top))] md:px-4">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="-ml-1 grid h-11 w-11 shrink-0 place-items-center rounded-full text-brand-hover hover:bg-hover lg:hidden" aria-label="Back to the inbox"><IconArrowLeft className="h-5 w-5" /></button>
          <Avatar label={initials(c.contactName)} className="h-9 w-9 shrink-0 text-[13px] max-sm:hidden" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <h2 className="truncate text-[16px] font-semibold tracking-tight" data-testid="chat-contact">{c.contactName}</h2>
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-subtle">
              <ChannelChip provider={c.provider} className="max-sm:hidden" />
              <ChannelChip provider={c.provider} compact className="sm:hidden" />
              <span className="truncate">{c.contactHandle !== c.contactName ? `+${c.contactHandle.replace(/^\+/, "")} · ` : ""}{d.channel.name}</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => setNotes(true)} aria-label="Notes" title="Notes"><IconStickyNote className="h-[18px] w-[18px]" /></Button>
        </div>
        <ChatControls c={c} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span data-testid="window-pill" data-tone={pill.tone}
            className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium",
              pill.tone === "ok" && "bg-ok-soft text-ok", pill.tone === "warn" && "bg-warn-soft text-warn", pill.tone === "closed" && "bg-fill text-muted")}>
            <IconClock className="h-3.5 w-3.5" aria-hidden />{pill.label}
          </span>
          {disconnected && <Badge tone="warn">This number is disconnected</Badge>}
        </div>
      </div>

      {/* Messages */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-5" data-testid="chat-messages" aria-live="polite">
        <Bubbles messages={d.messages} pending={pending} conversationId={id} onRetry={(p) => void send(p)} />
      </div>

      {/* Composer, or the template prompt once the window has closed */}
      <div className="border-t border-line bg-surface px-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5 md:px-4">
        {disconnected ? <p className="py-2 text-center text-[13px] text-muted">Reconnect this number in Settings to reply.</p>
          : w.open ? <Composer onSend={(body, file) => void send({ key: newIdempotencyKey("chat"), text: body.text ?? "", file, date: new Date().toISOString(), failed: null, body })} />
          : (
            <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center" data-testid="window-closed">
              <p className="flex-1 text-[13px] leading-relaxed text-muted">{closedWindowCopy(c.provider)}</p>
              <Button onClick={() => setSheet(true)} className="max-sm:w-full">Choose a template</Button>
            </div>
          )}
      </div>
      <TemplateSheet open={sheet} onClose={() => setSheet(false)} conversationId={id} onSent={(m) => {
        qc.setQueryData<ConversationDetail>(detailKey(id), (x) => x && !x.messages.some((y) => y.id === m.id) ? { ...x, messages: [...x.messages, m] } : x);
        void qc.invalidateQueries({ queryKey: ["channels", "list"] });
      }} />
      <NotesSheet open={notes} onClose={() => setNotes(false)} conversationId={id} />
    </Card>
  );
}

/** Assign and status, PATCHed on the conversation. */
function ChatControls({ c }: { c: ConversationSummary }) {
  const qc = useQueryClient();
  const me = useMe();
  const team = useTeam();
  const people = (team.data?.members ?? []).filter((m) => m.kind === "human");
  const myId = me.data?.user.id;
  const patch = useMutation({
    mutationFn: (body: { assigneeUserId?: string | null; status?: ConversationStatus }) => api.patch<{ conversation: ConversationSummary }>(`/channels/conversations/${encodeURIComponent(c.id)}`, body),
    onSuccess: (r, body) => {
      qc.setQueryData<ConversationDetail>(detailKey(c.id), (d) => d ? { ...d, conversation: r.conversation } : d);
      void qc.invalidateQueries({ queryKey: ["channels", "list"] });
      if ("assigneeUserId" in body) toast.success(r.conversation.assignee ? `Assigned to ${r.conversation.assignee.name}` : "Unassigned");
      else toast.success(r.conversation.status === "done" ? "Marked done" : r.conversation.status === "waiting" ? "Waiting on the customer" : "Reopened");
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't change this chat. Try again.")),
  });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="chat-assign">
      <Menu align="start" trigger={
        <Button variant="outline" size="sm" loading={patch.isPending && patch.variables && "assigneeUserId" in patch.variables} aria-label={c.assignee ? `Assigned to ${c.assignee.name}. Change` : "Assign"}>
          {c.assignee ? <><Avatar label={initials(c.assignee.name)} className="h-5 w-5 text-[9px]" />{c.assignee.name}</> : <><IconAssign className="h-4 w-4" aria-hidden />Assign</>}
        </Button>
      }>
        {myId && c.assignee?.userId !== myId && <MenuItem icon={<IconUserRound />} onSelect={() => patch.mutate({ assigneeUserId: myId })}>Assign to me</MenuItem>}
        <MenuLabel>Team</MenuLabel>
        {people.map((m) => (
          <MenuItem key={m.userId} icon={c.assignee?.userId === m.userId ? <IconCheck /> : <Avatar label={initials(m.name)} className="h-4 w-4 text-[8px]" />} onSelect={() => patch.mutate({ assigneeUserId: m.userId })}>{m.name}</MenuItem>
        ))}
        {c.assignee && <MenuItem icon={<IconUserMinus />} onSelect={() => patch.mutate({ assigneeUserId: null })}>Unassign</MenuItem>}
      </Menu>
      {c.status === "open"
        ? <Button variant="ghost" size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ status: "waiting" })}><IconHourglass className="h-4 w-4" aria-hidden />Waiting</Button>
        : <Button variant="ghost" size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ status: "open" })}><IconCircleDot className="h-4 w-4" aria-hidden />Reopen</Button>}
      {c.status !== "done" && <Button variant="secondary" size="sm" disabled={patch.isPending} onClick={() => patch.mutate({ status: "done" })}><IconCheckCircle className="h-4 w-4" aria-hidden />Mark done</Button>}
    </div>
  );
}

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function Ticks({ m }: { m: Pick<ChatMessage, "delivery"> }) {
  if (m.delivery === "read") return <IconCheckDouble className="h-3.5 w-3.5 text-[#7FD3FF]" aria-label="Read" />;
  if (m.delivery === "delivered") return <IconCheckDouble className="h-3.5 w-3.5 opacity-80" aria-label="Delivered" />;
  if (m.delivery === "sent") return <IconCheck className="h-3.5 w-3.5 opacity-80" aria-label="Sent" />;
  if (m.delivery === "pending") return <IconClock className="h-3 w-3 opacity-80" aria-label="Sending" />;
  if (m.delivery === "failed") return <IconWarning className="h-3.5 w-3.5" aria-label="Not delivered" />;
  return null;
}

function Bubbles({ messages, pending, conversationId, onRetry }: { messages: ChatMessage[]; pending: Pending[]; conversationId: string; onRetry: (p: Pending) => void }) {
  const [active, setActive] = useState<string | null>(null);
  if (!messages.length && !pending.length) return <p className="py-10 text-center text-sm text-muted">No messages yet.</p>;
  let lastDay = "";
  return (
    <ol className="space-y-1.5">
      {messages.map((m) => {
        const day = dayLabel(m.date);
        const sep = day !== lastDay; lastDay = day;
        return (
          <li key={m.id}>
            {sep && <div className="my-3 text-center"><span className="rounded-full bg-fill px-2.5 py-0.5 text-[11px] font-medium text-subtle">{day}</span></div>}
            <Bubble m={m} active={active === m.id} onToggle={() => setActive(active === m.id ? null : m.id)} conversationId={conversationId} />
          </li>
        );
      })}
      {pending.map((p) => (
        <li key={p.key} className="flex justify-end">
          <button type="button" disabled={!p.failed} onClick={() => onRetry(p)} data-testid="chat-bubble" data-direction="out" data-delivery={p.failed ? "failed" : "pending"}
            className={cn("max-w-[80%] rounded-[18px] rounded-br-md px-3.5 py-2 text-left text-[15px] leading-snug text-white sm:max-w-[70%]", p.failed ? "bg-[#0071E3]/60 ring-1 ring-bad" : "bg-[#0071E3]/80")}>
            {p.file && <span className="mb-1 flex items-center gap-1.5 text-[13px]"><IconFile className="h-4 w-4" aria-hidden />{p.file.name}</span>}
            {p.text && <span className="whitespace-pre-wrap break-words">{p.text}</span>}
            <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-white/75">{p.failed ? "Not sent" : "Sending"}<Ticks m={{ delivery: p.failed ? "failed" : "pending" }} /></span>
            {p.failed && <span className="mt-1 block text-[12px] text-white">{p.failed}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Bubble({ m, active, onToggle, conversationId }: { m: ChatMessage; active: boolean; onToggle: () => void; conversationId: string }) {
  const out = m.direction === "out";
  const failed = m.delivery === "failed";
  const draft = m.delivery === "draft";
  const isImage = m.media && m.media.url && (m.kind === "image" || m.kind === "sticker" || m.media.contentType.startsWith("image/"));
  return (
    <div className={cn("group flex items-end gap-1.5", out ? "flex-row-reverse" : "flex-row")}>
      <div onClick={onToggle} data-testid="chat-bubble" data-direction={m.direction} data-delivery={m.delivery}
        className={cn("max-w-[80%] rounded-[18px] px-3.5 py-2 text-[15px] leading-snug sm:max-w-[70%]",
          out && draft ? "rounded-br-md border border-dashed border-[#0071E3]/60 bg-[#0071E3]/[0.06] text-fg"
            : out ? "rounded-br-md bg-[#0071E3] text-white" : "rounded-bl-md bg-fill text-fg",
          failed && "bg-bad-soft text-fg ring-1 ring-bad/40")}>
        {draft && <span className="mb-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-[#0071E3]" data-testid="draft-label"><IconAgent className="h-3.5 w-3.5" aria-hidden />Draft by {m.agent?.name ?? "an agent"}</span>}
        {m.templateName && <span className={cn("mb-1 block text-[11px] font-medium uppercase tracking-wide", out && !failed && !draft ? "text-white/75" : "text-subtle")}>Template · {m.templateName}</span>}
        {isImage && (
          <a href={m.media!.url!} target="_blank" rel="noreferrer" className="-mx-1.5 -mt-0.5 mb-1 block overflow-hidden rounded-[12px]" onClick={(e) => e.stopPropagation()}>
            <img src={m.media!.url!} alt={m.text || m.media!.filename || "Image"} loading="lazy" className="max-h-64 w-full min-w-[160px] object-cover" />
          </a>
        )}
        {m.media && !isImage && (
          <a href={m.media.url ?? undefined} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className={cn("mb-1 flex items-center gap-2 rounded-xl px-2.5 py-2 text-[13px]", out && !failed ? "bg-white/15" : "bg-surface")}>
            <IconFile className="h-5 w-5 shrink-0" aria-hidden />
            <span className="min-w-0"><span className="block truncate font-medium">{m.media.filename || "File"}</span><span className="block text-[11px] opacity-75">{sizeLabel(m.media.size)}</span></span>
          </a>
        )}
        {m.text && !(isImage && m.kind === "image" && !m.text) && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
        {!m.text && !m.media && m.kind !== "text" && <p className="italic opacity-75">{m.kind === "unsupported" ? "A message this inbox can't show yet" : `A ${m.kind} message`}</p>}
        <span className={cn("mt-0.5 flex items-center justify-end gap-1 text-[11px]", out && !failed && !draft ? "text-white/75" : "text-subtle")}>
          {out && !draft && m.agent && <span className="flex items-center gap-0.5 truncate"><IconAgent className="h-3 w-3" aria-hidden />{m.agent.name} ·</span>}
          {out && !draft && !m.agent && m.sentBy && <span className="truncate">{m.sentBy.name} ·</span>}
          <time dateTime={m.date} title={fullDate(m.date)}>{clock(m.date)}</time>
          {out && !draft && <Ticks m={m} />}
        </span>
        {failed && <span className="mt-1 block text-[12px] font-medium text-bad" data-testid="bubble-error">Not delivered{m.error ? `: ${m.error}` : ""}</span>}
        {draft && <DraftActions messageId={m.id} conversationId={conversationId} />}
      </div>
      <MessageTaskButton messageId={m.id} conversationId={conversationId} visible={active} />
    </div>
  );
}

/** One tap sends an agent's draft as written; Discard throws it away. Nothing reaches the customer before Send. */
function DraftActions({ messageId, conversationId }: { messageId: string; conversationId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"send" | "discard" | null>(null);
  const act = async (what: "approve" | "discard") => {
    setBusy(what === "approve" ? "send" : "discard");
    try {
      await api.post(`/channels/messages/${encodeURIComponent(messageId)}/${what}`, {});
      if (what === "discard") toast.success("Draft discarded");
    } catch (e) {
      toast.error(errorMessage(e, what === "approve" ? "Couldn't send the draft. Try again." : "Couldn't discard the draft. Try again."));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: detailKey(conversationId) });
      void qc.invalidateQueries({ queryKey: ["channels", "list"] });
    }
  };
  return (
    <span className="mt-2 flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="ghost" onClick={() => void act("discard")} loading={busy === "discard"} disabled={!!busy} data-testid="draft-discard"><IconTrash className="h-3.5 w-3.5" aria-hidden />Discard</Button>
      <Button size="sm" onClick={() => void act("approve")} loading={busy === "send"} disabled={!!busy} data-testid="draft-send"><IconSend className="h-3.5 w-3.5" aria-hidden />Send</Button>
    </span>
  );
}

function MessageTaskButton({ messageId, conversationId, visible }: { messageId: string; conversationId: string; visible: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ task: { id: string; ref: string } }>(`/channels/messages/${encodeURIComponent(messageId)}/task`, {}, { idempotencyKey: `chat-task-${messageId}-${Date.now() >> 12}` });
      await qc.invalidateQueries({ queryKey: ["tasks"] });
      toast.success(`${r.task.ref} created`, { action: { label: "Open", onClick: () => navigate(`/app/tasks?view=list&task=${encodeURIComponent(r.task.id)}`) } });
    } catch (e) { toast.error(errorMessage(e, "Couldn't make a task. Try again.")); } finally { setBusy(false); }
  };
  void conversationId;
  return (
    <button type="button" onClick={() => void make()} disabled={busy} aria-label="Make a task from this message" title="Make a task" data-testid="message-task"
      className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full text-subtle transition-opacity duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 disabled:opacity-40 max-sm:h-11 max-sm:w-11",
        visible ? "opacity-100" : "opacity-0 group-hover:opacity-100 max-sm:pointer-events-none max-sm:opacity-0")}>
      <IconListPlus className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** Reads a file as base64 (no data: prefix). */
function readB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function Composer({ onSend }: { onSend: (body: Pending["body"], file: Pending["file"]) => void }) {
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);
  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    const big = fileTooBig(f.name, f.size);
    if (big) { setErr(big); return; }
    setFile(f);
  };
  const submit = async () => {
    const t = text.trim();
    if (!t && !file) return;
    let body: Pending["body"] = t ? { text: t } : {};
    let meta: Pending["file"] = null;
    if (file) {
      try { body = { ...body, file: { name: file.name, contentType: file.type || "application/octet-stream", dataB64: await readB64(file) } }; meta = { name: file.name, contentType: file.type, size: file.size }; }
      catch { setErr("Couldn't read that file. Try another one."); return; }
    }
    onSend(body, meta);
    setText(""); setFile(null);
    ta.current?.focus();
  };
  return (
    <div data-testid="chat-composer">
      {(file || err) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {file && <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-elevated py-1 pl-2.5 pr-1 text-[13px]"><IconFile className="h-4 w-4 shrink-0 text-subtle" aria-hidden /><span className="truncate">{file.name}</span><span className="text-subtle">{sizeLabel(file.size)}</span>
            <button type="button" onClick={() => setFile(null)} className="grid h-7 w-7 place-items-center rounded-full text-subtle hover:bg-hover" aria-label={`Remove ${file.name}`}><IconClose className="h-3.5 w-3.5" /></button></span>}
          {err && <p role="alert" className="text-[13px] text-bad" data-testid="composer-error">{err}</p>}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <input ref={picker} type="file" className="hidden" data-testid="composer-file" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        <button type="button" onClick={() => picker.current?.click()} aria-label="Attach a file" title="Attach a file (up to 5 MB)"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-fg"><IconAttachment className="h-5 w-5" /></button>
        <Textarea ref={ta} rows={1} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply" placeholder="Write a reply"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}
          className="max-h-40 min-h-11 flex-1 resize-none rounded-[22px] py-2.5 text-[15px] leading-snug" />
        <button type="button" onClick={() => void submit()} disabled={!text.trim() && !file} aria-label="Send"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#0071E3] text-white transition-[transform,opacity] duration-150 active:scale-95 disabled:opacity-35"><IconSend className="h-5 w-5" /></button>
      </div>
    </div>
  );
}

function TemplateSheet({ open, onClose, conversationId, onSent }: { open: boolean; onClose: () => void; conversationId: string; onSent: (m: ChatMessage) => void }) {
  const q = useQuery({ queryKey: ["channels", "templates", conversationId], queryFn: () => api.get<{ templates: ChatTemplate[] }>(`/channels/conversations/${encodeURIComponent(conversationId)}/templates`), enabled: open, staleTime: 5 * 60_000 });
  const [pick, setPick] = useState<ChatTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = useMemo(() => newIdempotencyKey("tpl"), [pick, open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!open) { setPick(null); setParams([]); setErr(null); } }, [open]);
  const choose = (t: ChatTemplate) => { setPick(t); setParams(Array.from({ length: t.params }, () => "")); setErr(null); };
  const missing = pick ? params.some((p) => !p.trim()) : true;
  const send = async () => {
    if (!pick || missing) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post<{ message: ChatMessage }>(`/channels/conversations/${encodeURIComponent(conversationId)}/template`, { name: pick.name, language: pick.language, params: params.map((p) => p.trim()) }, { idempotencyKey: key });
      onSent(r.message);
      toast.success("Template sent");
      onClose();
    } catch (e) { setErr(errorMessage(e, "Couldn't send the template. Try again.")); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Choose a template" description="Approved templates can be sent at any time.">
      <div className="max-h-[60dvh] space-y-2 overflow-y-auto px-6 pb-2 pt-4" data-testid="template-sheet">
        {q.isPending ? <><Skeleton className="h-16 rounded-xl" /><Skeleton className="h-16 rounded-xl" /></>
          : q.error ? <p className="text-sm text-bad">{errorMessage(q.error, "Couldn't load templates. Try again.")}</p>
          : !q.data.templates.length ? <p className="text-sm text-muted">No approved templates yet.</p>
          : q.data.templates.map((t) => {
            const on = pick?.name === t.name && pick.language === t.language;
            return (
              <div key={`${t.name}-${t.language}`} className={cn("rounded-xl border transition-colors duration-150", on ? "border-brand bg-brand-soft/40" : "border-line")}>
                <button type="button" onClick={() => choose(t)} aria-pressed={on} data-testid="template-option" className="block w-full px-3.5 py-3 text-left">
                  <span className="flex items-center gap-2"><span className="text-[14px] font-semibold">{t.name}</span><Badge>{t.category.toLowerCase()}</Badge><span className="ml-auto text-[12px] text-subtle">{t.language}</span></span>
                  <span className="mt-1 block whitespace-pre-wrap text-[13px] leading-relaxed text-muted">{on ? fillTemplate(t.body, params, t.paramNames) : t.body}</span>
                </button>
                {on && t.params > 0 && (
                  <div className="space-y-2 border-t border-line px-3.5 py-3">
                    {params.map((v, i) => (
                      <label key={i} className="block">
                        <span className="mb-1 block text-[12px] font-medium text-subtle">{t.paramNames?.[i] ? `Value for ${t.paramNames[i].replace(/_/g, " ")}` : `Value for {{${i + 1}}}`}</span>
                        <Input value={v} onChange={(e) => setParams((ps) => ps.map((p, j) => j === i ? e.target.value : p))} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {err && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-[13px] text-bad">{err}</p>}
      </div>
      <div className="flex flex-col-reverse gap-2 px-6 pb-5 pt-3 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void send()} loading={busy} disabled={!pick || missing}>Send</Button>
      </div>
    </Dialog>
  );
}

interface Note { id: string; body: string; author: { id: string; name: string }; createdAt: string }

function NotesSheet({ open, onClose, conversationId }: { open: boolean; onClose: () => void; conversationId: string }) {
  const qc = useQueryClient();
  const key = ["channels", "notes", conversationId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<{ notes: Note[] }>(`/channels/conversations/${encodeURIComponent(conversationId)}/notes`), enabled: open });
  const [body, setBody] = useState("");
  const add = useMutation({
    mutationFn: (b: string) => api.post<{ note: Note }>(`/channels/conversations/${encodeURIComponent(conversationId)}/notes`, { body: b }),
    onSuccess: () => { setBody(""); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save the note. Try again.")),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Notes" description="Only your team sees these. The customer never does.">
      <div className="max-h-[50dvh] space-y-3 overflow-y-auto px-6 pt-4" data-testid="chat-notes">
        {q.isPending ? <Skeleton className="h-12 rounded-xl" />
          : q.error ? <p className="text-sm text-bad">{errorMessage(q.error, "Couldn't load notes.")}</p>
          : !q.data.notes.length ? <p className="text-sm text-muted">No notes yet.</p>
          : q.data.notes.map((n) => (
            <div key={n.id} className="rounded-xl bg-[#FFF8E1] px-3.5 py-2.5 text-[14px] text-[#3D3200] dark:bg-[#3A3214] dark:text-[#F5E9B8]">
              <p className="whitespace-pre-wrap break-words">{n.body}</p>
              <p className="mt-1 text-[11px] opacity-70">{n.author.name} · {mailDate(n.createdAt)}</p>
            </div>
          ))}
      </div>
      <form className="flex items-end gap-2 px-6 pb-5 pt-3" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim()); }}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} aria-label="New note" placeholder="Add a note for your team" className="flex-1 resize-none" />
        <Button type="submit" loading={add.isPending} disabled={!body.trim()}>Add</Button>
      </form>
    </Dialog>
  );
}
