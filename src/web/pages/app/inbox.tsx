import { useSearchParams } from "react-router";
import { AttachmentTools } from "./mail/attachment-tools"; // Tools P1
import { BatchTools } from "@/web/components/tools/batch-tools"; // Tools P2
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { IconAgent, IconArrowLeft, IconAttachment, IconInbox, IconReply, IconUser } from "@/web/components/ui/icon";
import { Button } from "@/web/components/ui/button";
import { Compose, type ComposeDraft } from "./mail/compose";
import { useReopenedDrafts } from "@/web/lib/undo-send";
import { replyDraftFor } from "./inbox-reply";
import { forgetOpenReply, openReplyDraft } from "@/web/lib/draft-autosave"; // R67 (MB-244)
import { api } from "@/web/lib/api";
import { useMailboxes } from "@/web/lib/queries";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { mailDate, fullDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useAgents } from "./agents";
import { ApprovalCard, type Approval } from "./approvals";
import { MakeTask } from "./work/make-task";
import { NoteCount, ThreadNotes, useNoteCounts } from "./inbox-comments";
import { AssigneeChip, InboxViewBar, ThreadAssignControls, useInboxView, type ThreadAssignee, type ThreadStatus } from "./inbox-assign";
import { ThreadCollab } from "./inbox-presence";
import { InboxZeroArt } from "@/web/components/illustrations"; // R36
import { useChannelsStatus } from "./channels-ui"; // C1
import { ChannelFilterControl, ChatRow, ChatView, mergeByDate, useChannelFilter, useChatConversations } from "./inbox-chat"; // C1
import { HelpdeskViewBar, TicketListBody, TicketPanel, WebChatView, useHelpdeskSettings, useTicketView, useTickets, type Ticket } from "./helpdesk"; // R119
import { Link } from "react-router";
import { IconSettings } from "@/web/components/ui/icon";

interface ThreadSummary {
  id: string; mailboxId: string; subject: string; snippet: string; lastMessageAt: string; messageCount: number; unreadCount: number;
  from: { address: string; name?: string }; lastSentBy: { type: "agent" | "person" | "external"; agentId?: string; name?: string | null };
  agentsInvolved: { agentId: string; name: string | null }[]; pendingApprovals: number;
  assignee?: ThreadAssignee | null; status?: ThreadStatus; lastInboundAt?: string | null;
}
interface ThreadMessage {
  id: string; direction: "inbound" | "outbound"; from: { address: string; name?: string }; to: { address: string }[]; subject: string; date: string;
  latestText: string; text: string; codes: string[]; attachments: { id: string; filename: string; url: string | null }[];
  sentBy: { type: "agent" | "person" | "external"; agentId?: string; name?: string | null };
}
interface Thread { id: string; mailboxId: string; subject: string; messages: ThreadMessage[]; pendingApprovals: Approval[] }

/** The shared inbox: every thread across the mailboxes you can open, agents' work labelled. */
export function TeamInboxPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("thread");
  const selectedConv = params.get("conv"); // C1: an open chat
  const selectedTicket = params.get("ticket"); // R119: an open website chat
  const iv = useInboxView();
  // R119: helpdesk mode. When a workspace turns it on, the list shows tickets (mail, chats, website chats) with their clocks.
  const hds = useHelpdeskSettings();
  const hdOn = !!hds.data?.on;
  const [mode, setModeState] = useState<"tickets" | "all">(() => { try { return sessionStorage.getItem("mq.inbox.mode") === "all" ? "all" : "tickets"; } catch { return "tickets"; } });
  const setMode = (m: "tickets" | "all") => { setModeState(m); try { sessionStorage.setItem("mq.inbox.mode", m); } catch { /* private mode */ } };
  const ticketsMode = hdOn && mode === "tickets";
  const tv = useTicketView();
  const tlist = useTickets(ticketsMode, tv.query);
  const openTicket = (t: Ticket) => setParams(t.kind === "mail" ? { thread: t.refId } : t.kind === "chat" ? { conv: t.refId } : { ticket: t.id }, { replace: false });
  const threads = useQuery({ queryKey: ["team-inbox", "list", iv.query], queryFn: () => api.get<{ data: ThreadSummary[] }>(`/agents/threads${iv.query}`), refetchInterval: 20_000 });
  const noteCounts = useNoteCounts(threads.data?.data.map((t) => t.id) ?? []);
  const mailboxes = useMailboxes();
  const agents = useAgents();
  // C1: chats from WhatsApp, Messenger and Instagram merge into the same list when the workspace has them on.
  const channels = useChannelsStatus();
  const chatOn = !!channels.data?.enabled;
  const chats = useChatConversations(chatOn, iv.view, iv.assignee);
  const cf = useChannelFilter();
  const filter = chatOn ? cf.filter : "all";
  const channelName = (id: string) => channels.data?.channels.find((c) => c.id === id)?.name;
  const providers = [...new Set((channels.data?.channels ?? []).map((c) => c.provider))];
  const boxName = (id: string) => mailboxes.data?.find((m) => m.id === id)?.address ?? agents.data?.find((a) => a.inboxId === id)?.address ?? "";
  const open = (id: string | null) => setParams(id ? { thread: id } : {}, { replace: false });
  // R56 (MB-242): reply to the customer right here, in the same composer as Mail (undo send, saved replies, draft autosave).
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  useReopenedDrafts<ComposeDraft>((d) => setCompose(d));
  const sendable = mailboxes.data ?? [];
  const openConv = (id: string) => setParams({ conv: id }, { replace: false });
  const mail = filter === "all" || filter === "email" ? threads.data?.data ?? [] : [];
  const chatRows = chatOn && filter !== "email" ? (chats.data ?? []).filter((c) => filter === "all" || c.provider === filter) : [];
  const rows = mergeByDate(mail, chatRows);
  const anySelected = !!(selected || selectedConv || selectedTicket);
  const pending = threads.isPending || (chatOn && chats.isPending && filter !== "email");
  return (
    <>
      <PageHeader title="Shared inbox" actions={(hdOn || hds.data?.canManage) ? <Link to="/app/inbox/helpdesk" className="inline-flex h-9 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted transition-colors hover:bg-hover hover:text-fg max-sm:min-h-11" data-testid="helpdesk-settings-link"><IconSettings className="h-4 w-4" aria-hidden />Helpdesk</Link> : undefined} description={ticketsMode ? "Every customer conversation as a ticket, with an owner, a priority and reply times." : chatOn ? "Mail and customer chats in one place, with your team and your agents. Agent replies are labelled." : "Your team and your agents on the same threads. Agent replies are labelled, and anything waiting for approval shows in place."} />
      <div className={cn(anySelected && "max-lg:hidden")}>
      {hdOn && (
        <div role="group" aria-label="Show" className="mb-3 inline-flex gap-0.5 rounded-lg bg-fill p-0.5" data-testid="inbox-mode">
          {(["tickets", "all"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={cn("h-7 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 max-sm:h-11", mode === m ? "bg-elevated text-fg shadow-sm" : "text-muted hover:text-fg")}>{m === "tickets" ? "Tickets" : "All conversations"}</button>
          ))}
        </div>
      )}
      {ticketsMode ? <HelpdeskViewBar {...tv} counts={tlist.data?.counts} /> : <InboxViewBar {...iv} />}
      </div>
      {chatOn && !ticketsMode && <div className="-mt-1 mb-4"><ChannelFilterControl filter={filter} set={cf.set} providers={providers} /></div>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">{/* R67 (MB-252): one column never grows past the phone width */}
        <Card className={cn("overflow-hidden lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto", anySelected && "hidden lg:block")}>
          {ticketsMode ? <TicketListBody list={tlist} view={tv.view} selectedId={tlist.data?.tickets.find((t) => (t.kind === "mail" && t.refId === selected) || (t.kind === "chat" && t.refId === selectedConv) || t.id === selectedTicket)?.id ?? null} onOpen={openTicket} />
            : pending ? <div className="space-y-3 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            : threads.error ? <p className="p-6 text-sm text-bad">{threads.error.message}</p>
            : !rows.length ? (filter === "all" || filter === "email"
              ? <EmptyState icon={<IconInbox />} art={<InboxZeroArt />} title={filter === "email" ? "No email here" : "No threads yet"} body={chatOn ? "Mail and customer chats show up here." : "Mail to your mailboxes and agent inboxes shows up here."} />
              : <EmptyState icon={<IconInbox />} title="No chats here" body="New customer messages on this channel show up here." />)
            : (
              <ul className="divide-y divide-line">
                {rows.map((r) => r.kind === "chat" ? (
                  <li key={`c-${r.item.id}`}><ChatRow c={r.item} channelName={channelName(r.item.channelId)} selected={selectedConv === r.item.id} onOpen={() => openConv(r.item.id)} /></li>
                ) : (() => { const t = r.item; return (
                  <li key={t.id}>
                    <button onClick={() => open(t.id)} aria-current={selected === t.id} className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-hover", selected === t.id && "bg-fill/60")}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={cn("truncate text-sm", t.unreadCount ? "font-semibold" : "font-medium")}>{t.from.name ?? t.from.address}</span>
                        <time className="shrink-0 text-xs text-subtle" dateTime={t.lastMessageAt}>{mailDate(t.lastMessageAt)}</time>
                      </div>
                      <div className="truncate text-sm">{t.subject || "(no subject)"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="truncate font-mono text-subtle">{boxName(t.mailboxId)}</span>
                        {t.agentsInvolved.map((a) => <Badge key={a.agentId} tone="brand"><IconAgent className="h-3 w-3" aria-hidden />{a.name ?? "Agent"}{t.lastSentBy.type === "agent" && t.lastSentBy.agentId === a.agentId ? " replied" : ""}</Badge>)}
                        {t.pendingApprovals > 0 && <Badge tone="warn">Reply waiting for approval</Badge>}
                        <AssigneeChip assignee={t.assignee} status={t.status} lastInboundAt={t.lastInboundAt} />
                        <NoteCount n={noteCounts[t.id]} />
                      </div>
                    </button>
                  </li>
                ); })())}
              </ul>
            )}
        </Card>
        <div className={cn("min-w-0 lg:sticky lg:top-6 lg:self-start", !anySelected && "hidden lg:block")}>
          {selectedTicket && hdOn ? <WebChatView ticketId={selectedTicket} onBack={() => open(null)} />
            : selectedConv && chatOn ? <div className="space-y-3">{hdOn && <TicketPanel kind="chat" refId={selectedConv} />}<ChatView id={selectedConv} onBack={() => open(null)} /></div>
            : selected ? <ThreadView helpdesk={hdOn} id={selected} onBack={() => open(null)} canReply={(mailboxId) => sendable.some((m) => m.id === mailboxId)} own={sendable.map((m) => m.address)} onReply={setCompose} />
            : <Card><EmptyState icon={<IconInbox />} title={ticketsMode ? "Pick a ticket" : chatOn ? "Pick a thread or a chat" : "Pick a thread"} body={ticketsMode ? "See the conversation, its owner and reply times, and answer from here." : chatOn ? "See every message, who wrote it, and reply from here." : "See every message, who wrote it, and what an agent wants to send next."} /></Card>}
        </div>
      </div>
      {compose && <Compose key={`${compose.inReplyToId ?? "new"}:${compose.draftId ?? ""}`} initial={compose} mailboxes={sendable} onClose={() => setCompose(null)} />}
    </>
  );
}

function ThreadView({ id, onBack, canReply, own, onReply, helpdesk }: { id: string; onBack: () => void; canReply: (mailboxId: string) => boolean; own: string[]; onReply: (d: ComposeDraft) => void; helpdesk?: boolean }) {
  const thread = useQuery({ queryKey: ["team-inbox", id], queryFn: () => api.get<Thread>(`/agents/threads/${id}`) });
  // R67 (MB-244): a reply that was open here when the page reloaded opens again, with its saved draft.
  const resumed = useRef<string | null>(null);
  const data = thread.data;
  useEffect(() => {
    if (!data || !data.messages.length || !canReply(data.mailboxId)) return;
    const draftId = openReplyDraft(data.id);
    if (!draftId || resumed.current === draftId) return;
    resumed.current = draftId;
    const base = replyDraftFor(data, own, false);
    api.get<{ message: { id: string; folder: string; threadId: string; mailboxId: string; to: { address: string }[]; cc: { address: string }[]; subject: string; text: string } }>(`/mail/messages/${draftId}`).then(({ message: dm }) => {
      if (dm.folder !== "drafts" || dm.threadId !== data.id) { forgetOpenReply(data.id); return; }
      onReply({ ...base, mailboxId: dm.mailboxId, to: dm.to.map((a) => a.address).join(", "), cc: dm.cc.map((a) => a.address).join(", "), subject: dm.subject, text: dm.text, draftId: dm.id, resumed: true });
    }, () => forgetOpenReply(data.id));
  }, [data, canReply, own, onReply]);
  if (thread.isPending) return <Card className="p-5"><Skeleton className="h-6 w-2/3" /><Skeleton className="mt-4 h-32" /></Card>;
  if (thread.error) return <Card className="p-6 text-sm text-bad">{thread.error.message}</Card>;
  const t = thread.data;
  return (
    <div className="space-y-3">
      {/* R67 (MB-249, MB-252): on a phone the subject takes the whole line and the actions sit under it, nothing cut off. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="inbox-thread-head">
        <button onClick={onBack} className="grid shrink-0 place-items-center rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg lg:hidden max-sm:-ml-1.5 max-sm:h-11 max-sm:w-11" aria-label="Back to threads"><IconArrowLeft className="h-4 w-4" /></button>
        <h2 className="min-w-0 flex-1 basis-[12rem] break-words text-lg font-semibold tracking-tight">{t.subject || "(no subject)"}</h2>
        <ThreadAssignControls threadId={t.id} />
      </div>
      {helpdesk && <TicketPanel kind="mail" refId={t.id} onReplyText={canReply(t.mailboxId) && t.messages.length ? (text) => onReply({ ...replyDraftFor(t, own, false), text }) : undefined} />}
      <ThreadCollab threadId={t.id} />
      {t.messages.length > 0 && <MakeTask messageId={t.messages[t.messages.length - 1].id} threadId={t.id} />}
      {t.messages.map((m) => (
        <Card key={m.id} className={cn("p-4", m.sentBy.type === "agent" && "border-brand/40")}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {m.sentBy.type === "agent" ? <Badge tone="brand"><IconAgent className="h-3 w-3" aria-hidden />{m.sentBy.name ?? "Agent"}</Badge>
              : m.sentBy.type === "person" ? <Badge><IconUser className="h-3 w-3" aria-hidden />Team</Badge> : null}
            <span className="font-medium">{m.from.name ?? m.from.address}</span>
            <span className="min-w-0 text-xs text-subtle [overflow-wrap:anywhere]">to {m.to.map((x) => x.address).join(", ")}</span>
            <time className="ml-auto text-xs text-subtle" dateTime={m.date} title={fullDate(m.date)}>{mailDate(m.date)}</time>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg/90 [overflow-wrap:anywhere]">{m.latestText || m.text}</p>
          {(m.codes.length > 0 || m.attachments.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-subtle">
              {m.codes.map((c) => <span key={c} className="rounded border border-line px-1.5 py-0.5 font-mono">code {c}</span>)}
              {m.attachments.map((a) => (
                <span key={a.id} className="inline-flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1"><IconAttachment className="h-3 w-3" aria-hidden />{a.filename}</span>
                  {a.url && <AttachmentTools id={a.id} filename={a.filename} compact />}
                </span>
              ))}
            </div>
          )}
        </Card>
      ))}
      <BatchTools attachments={t.messages.flatMap((m) => m.attachments.map((a) => ({ id: a.id, filename: a.filename, available: !!a.url })))} /> {/* Tools P2: batch */}
      {t.pendingApprovals.map((a) => <ApprovalCard key={a.id} a={a} compact />)}
      {canReply(t.mailboxId) && t.messages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" data-testid="inbox-reply-bar">
          <Button onClick={() => onReply(replyDraftFor(t, own, false))} className="max-sm:min-h-11 max-sm:flex-1"><IconReply className="h-4 w-4" aria-hidden />Reply</Button>
          <Button variant="secondary" onClick={() => onReply(replyDraftFor(t, own, true))} className="max-sm:min-h-11 max-sm:flex-1"><IconReply className="h-4 w-4" aria-hidden />Reply all</Button>
          <span className="text-xs text-subtle max-sm:w-full">Goes to the customer. Team notes below stay inside your team.</span>
        </div>
      )}
      <ThreadNotes threadId={t.id} />
    </div>
  );
}
