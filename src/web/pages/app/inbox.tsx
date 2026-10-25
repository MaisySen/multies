import { useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Inbox, Paperclip, User } from "lucide-react";
import { api } from "@/web/lib/api";
import { useMailboxes } from "@/web/lib/queries";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { mailDate, fullDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { useAgents } from "./agents";
import { ApprovalCard, type Approval } from "./approvals";
import { MakeTask } from "./work/make-task";
import { ThreadCollab } from "./inbox-presence";

interface ThreadSummary {
  id: string; mailboxId: string; subject: string; snippet: string; lastMessageAt: string; messageCount: number; unreadCount: number;
  from: { address: string; name?: string }; lastSentBy: { type: "agent" | "person" | "external"; agentId?: string; name?: string | null };
  agentsInvolved: { agentId: string; name: string | null }[]; pendingApprovals: number;
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
  const threads = useQuery({ queryKey: ["team-inbox"], queryFn: () => api.get<{ data: ThreadSummary[] }>("/agents/threads"), refetchInterval: 20_000 });
  const mailboxes = useMailboxes();
  const agents = useAgents();
  const boxName = (id: string) => mailboxes.data?.find((m) => m.id === id)?.address ?? agents.data?.find((a) => a.inboxId === id)?.address ?? "";
  const open = (id: string | null) => setParams(id ? { thread: id } : {}, { replace: false });
  return (
    <>
      <PageHeader title="Shared inbox" description="Your team and your agents on the same threads. Agent replies are labelled, and anything waiting for approval shows in place." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Card className={cn("overflow-hidden lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto", selected && "hidden lg:block")}>
          {threads.isPending ? <div className="space-y-3 p-4">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
            : threads.error ? <p className="p-6 text-sm text-bad">{threads.error.message}</p>
            : !threads.data.data.length ? <EmptyState icon={<Inbox />} title="No threads yet" body="Mail to your mailboxes and agent inboxes shows up here." />
            : (
              <ul className="divide-y divide-line">
                {threads.data.data.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => open(t.id)} aria-current={selected === t.id} className={cn("block w-full px-4 py-3 text-left transition-colors hover:bg-hover", selected === t.id && "bg-fill/60")}>
                      <div className="flex items-baseline justify-between gap-3">
                        <span className={cn("truncate text-sm", t.unreadCount ? "font-semibold" : "font-medium")}>{t.from.name ?? t.from.address}</span>
                        <time className="shrink-0 text-xs text-subtle" dateTime={t.lastMessageAt}>{mailDate(t.lastMessageAt)}</time>
                      </div>
                      <div className="truncate text-sm">{t.subject || "(no subject)"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="truncate font-mono text-subtle">{boxName(t.mailboxId)}</span>
                        {t.agentsInvolved.map((a) => <Badge key={a.agentId} tone="brand"><Bot className="h-3 w-3" aria-hidden />{a.name ?? "Agent"}{t.lastSentBy.type === "agent" && t.lastSentBy.agentId === a.agentId ? " replied" : ""}</Badge>)}
                        {t.pendingApprovals > 0 && <Badge tone="warn">Reply waiting for approval</Badge>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
        </Card>
        <div className={cn("lg:sticky lg:top-6 lg:self-start", !selected && "hidden lg:block")}>
          {selected ? <ThreadView id={selected} onBack={() => open(null)} /> : <Card><EmptyState icon={<Inbox />} title="Pick a thread" body="See every message, who wrote it, and what an agent wants to send next." /></Card>}
        </div>
      </div>
    </>
  );
}

function ThreadView({ id, onBack }: { id: string; onBack: () => void }) {
  const thread = useQuery({ queryKey: ["team-inbox", id], queryFn: () => api.get<Thread>(`/agents/threads/${id}`) });
  if (thread.isPending) return <Card className="p-5"><Skeleton className="h-6 w-2/3" /><Skeleton className="mt-4 h-32" /></Card>;
  if (thread.error) return <Card className="p-6 text-sm text-bad">{thread.error.message}</Card>;
  const t = thread.data;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg lg:hidden" aria-label="Back to threads"><ArrowLeft className="h-4 w-4" /></button>
        <h2 className="text-lg font-semibold tracking-tight">{t.subject || "(no subject)"}</h2>
      </div>
      <ThreadCollab threadId={t.id} />
      {t.messages.length > 0 && <MakeTask messageId={t.messages[t.messages.length - 1].id} threadId={t.id} />}
      {t.messages.map((m) => (
        <Card key={m.id} className={cn("p-4", m.sentBy.type === "agent" && "border-brand/40")}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {m.sentBy.type === "agent" ? <Badge tone="brand"><Bot className="h-3 w-3" aria-hidden />{m.sentBy.name ?? "Agent"}</Badge>
              : m.sentBy.type === "person" ? <Badge><User className="h-3 w-3" aria-hidden />Team</Badge> : null}
            <span className="font-medium">{m.from.name ?? m.from.address}</span>
            <span className="text-xs text-subtle">to {m.to.map((x) => x.address).join(", ")}</span>
            <time className="ml-auto text-xs text-subtle" dateTime={m.date} title={fullDate(m.date)}>{mailDate(m.date)}</time>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">{m.latestText || m.text}</p>
          {(m.codes.length > 0 || m.attachments.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-subtle">
              {m.codes.map((c) => <span key={c} className="rounded border border-line px-1.5 py-0.5 font-mono">code {c}</span>)}
              {m.attachments.map((a) => <span key={a.id} className="inline-flex items-center gap-1"><Paperclip className="h-3 w-3" aria-hidden />{a.filename}</span>)}
            </div>
          )}
        </Card>
      ))}
      {t.pendingApprovals.map((a) => <ApprovalCard key={a.id} a={a} compact />)}
    </div>
  );
}
