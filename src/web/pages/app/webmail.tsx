import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyMailAction, type MailAction, type MailListData } from "@/web/lib/optimistic-mail"; // R30
import {
  Archive, ArrowLeft, Ban, Bot, Sparkles, File, FileEdit, FolderInput, Forward, Inbox, Paperclip, PenSquare, Reply, Search, Send, ShieldCheck, ShieldAlert, Star, Trash2, X,
} from "lucide-react";
import { toast } from "sonner";
import { showError } from "@/web/lib/show-error";
import { api } from "@/web/lib/api";
import { qk } from "@/web/lib/queries";
import type { Folder, Message, MailboxOverview, MessageListItem } from "@/web/lib/types";
import { Avatar, EmptyState, Kbd, Skeleton } from "@/web/components/ui/misc";
import { Button, ButtonLink } from "@/web/components/ui/button";
import { formatBytes, fullDate, initials, mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { HtmlBody, TextBody } from "./mail/html-body";
import { Compose, type ComposeDraft } from "./mail/compose";
import { ThreadPresenceLine } from "./inbox-presence";
import { useReopenedDrafts } from "@/web/lib/undo-send";
import { useLiveMail } from "@/web/lib/live-mail";
import { ProviderFolderNav, moveTargets, useProviderFolders } from "./mail/provider-folders";
import { InvoiceReminderDialog } from "./mail/invoice-reminder";
import { BYO_AI_LINE, useAiStatus } from "./ai-section";
import { MakeTask } from "./work/make-task";
import { SCHEDULE_VIEWS, isScheduleView, ReturnedStrip, ScheduleListView, SnoozeMenu, useScheduleList, type ScheduleItem } from "./mail/schedules";

type View = Folder | "starred" | "snoozed" | "scheduled" | `f:${string}`;
const FOLDER_UI: { id: View; label: string; icon: typeof Inbox }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "sent", label: "Sent", icon: Send },
  { id: "drafts", label: "Drafts", icon: FileEdit },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "spam", label: "Spam", icon: Ban },
  { id: "trash", label: "Trash", icon: Trash2 },
];

export function WebmailPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: qk.overview, queryFn: async () => (await api.get<{ mailboxes: MailboxOverview[] }>("/mail/overview")).mailboxes, refetchInterval: 30_000 });
  const mailboxes = useMemo(() => overview.data ?? [], [overview.data]);
  useLiveMail(mailboxes.some((m) => m.connected));
  const busiest = [...mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0];
  const mailboxId = params.get("mailbox") ?? busiest?.id ?? "";
  const folder = (params.get("folder") ?? "inbox") as View;
  const q = params.get("q") ?? "";
  const selected = params.get("m");
  const [search, setSearch] = useState(q);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => setSearch(q), [q]);

  const setParam = useCallback((patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    }, { replace: patch.m === undefined });
  }, [setParams]);

  const list = useInfiniteQuery({
    queryKey: ["mail", "list", mailboxId, folder, q],
    enabled: !!mailboxId && (!!q || !isScheduleView(folder)),
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<{ messages: MessageListItem[]; nextCursor: string | null }>(
      `/mail/messages?${new URLSearchParams({ mailboxId, ...(q ? { q } : folder.startsWith("f:") ? { remote: folder } : { folder }), ...(pageParam ? { cursor: pageParam } : {}) })}`,
    ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  // Round 20: snoozed threads and reminders that came back sit on top of Inbox, marked, until opened.
  const returned = useScheduleList("returned", mailboxId, folder === "inbox" && !q);
  const returnedItems = useMemo(() => (folder === "inbox" && !q ? returned.data ?? [] : []), [returned.data, folder, q]);
  const items = useMemo(() => {
    const all = list.data?.pages.flatMap((p) => p.messages) ?? [];
    const lifted = new Set(returnedItems.map((r) => r.threadId));
    return lifted.size ? all.filter((m) => !lifted.has(m.threadId)) : all;
  }, [list.data, returnedItems]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["mail"] });
  const listKey = ["mail", "list", mailboxId, folder, q];
  const act = useMutation({
    mutationFn: ({ ids, action, to }: { ids: string[]; action: string; to?: string }) => api.post("/mail/messages/bulk", { ids, action, ...(to ? { to } : {}) }),
    // R30: optimistic. The list changes at once; a refusal puts it back and says why.
    onMutate: async ({ ids, action }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const before = qc.getQueryData<MailListData>(listKey);
      qc.setQueryData<MailListData>(listKey, (d) => applyMailAction(d, ids, action as MailAction, folder, !!q));
      return { before };
    },
    onSuccess: (_r, v) => {
      const labels: Record<string, string> = { archive: "Archived", trash: "Moved to trash", spam: "Marked as spam", inbox: "Moved to inbox", delete: "Deleted forever", move: v.to ? `Moved to ${v.to.slice(2)}` : "Moved" };
      if (labels[v.action]) toast.success(labels[v.action]);
    },
    onError: (e, _v, ctx) => { if (ctx?.before) qc.setQueryData(listKey, ctx.before); showError(e); },
    onSettled: () => { void refresh(); },
  });

  const open = (id: string | null) => setParam({ m: id });
  const idx = items.findIndex((i) => i.id === selected);
  const current = idx >= 0 ? items[idx] : null;
  const move = (action: string) => {
    if (!current) return;
    const next = items[idx + 1] ?? items[idx - 1];
    act.mutate({ ids: [current.id], action });
    open(next?.id ?? null);
  };
  // Undo send (or a failed send) puts the message back into Compose, exactly as it was.
  // If another message is open in Compose, the taken back one waits and opens when that one closes.
  const waiting = useRef<ComposeDraft[]>([]);
  useReopenedDrafts<ComposeDraft>((d) => {
    if (!compose) { setCompose(d); return; }
    waiting.current.push(d);
    toast.info("Message taken back", { description: "It opens when you close the message you're writing." });
  });
  const closeCompose = () => setCompose(waiting.current.shift() ?? null);
  const openReturned = (it: ScheduleItem) => {
    if (!it.messageId) return;
    void api.post("/mail-schedules/opened", { messageId: it.messageId }).then(() => qc.invalidateQueries({ queryKey: ["mail", "schedules"] }));
    open(it.messageId);
  };
  // Edit a scheduled send: it comes out of Scheduled and back into Compose, to send or schedule again.
  const editScheduled = async (it: ScheduleItem) => {
    if (!it.send) return;
    try { await api.del(`/mail-schedules/${it.id}`); } catch (e) { showError(e as Error); return; }
    void qc.invalidateQueries({ queryKey: ["mail"] });
    setCompose({ mailboxId: it.mailboxId, to: it.send.to.join(", "), cc: it.send.cc.join(", ") || undefined, bcc: it.send.bcc.join(", ") || undefined, subject: it.send.subject, text: it.send.text, inReplyToId: it.send.inReplyToId ?? undefined });
    toast.info("Taken out of Scheduled", { description: "Edit it, then send it or schedule it again." });
  };
  const startCompose = (d?: Partial<ComposeDraft>) => setCompose({ mailboxId: mailboxId || mailboxes[0]?.id || "", to: "", subject: "", text: "", ...d });
  // ?compose=1 (from the setup checklist or the command palette) opens a new message once mailboxes load.
  // ?compose=name@example.com (from a contact page) opens it addressed to that person.
  const composeParam = params.get("compose");
  const wantsCompose = composeParam === "1" || !!composeParam?.includes("@");
  useEffect(() => {
    if (!wantsCompose || !mailboxes.length) return;
    setCompose({ mailboxId: mailboxId || mailboxes[0].id, to: composeParam?.includes("@") ? composeParam : "", subject: "", text: "" });
    setParams((p) => { const n = new URLSearchParams(p); n.delete("compose"); return n; }, { replace: true });
  }, [wantsCompose, composeParam, mailboxes, mailboxId, setParams]);

  // Keyboard shortcuts, Gmail-style.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (compose || e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      if (e.key === "j" && items.length) open(items[Math.min(idx + 1, items.length - 1)].id);
      else if (e.key === "k" && items.length) open(items[Math.max(idx - 1, 0)].id);
      else if (e.key === "c") { e.preventDefault(); startCompose(); }
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
      else if (e.key === "e" && current) move("archive");
      else if (e.key === "#" && current) move("trash");
      else if (e.key === "s" && current) act.mutate({ ids: [current.id], action: current.isStarred ? "unstar" : "star" });
      else if (e.key === "Escape" && selected) open(null);
      else return;
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  if (overview.isPending) return <div className="flex h-full"><div className="hidden w-60 border-r border-line p-4 md:block"><Skeleton className="mb-4 h-9" />{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="mb-2 h-7" />)}</div><div className="flex-1 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="mb-3 h-14" />)}</div></div>;
  if (!mailboxes.length) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState icon={<Inbox />} title="No mailboxes yet" body="Create a mailbox on one of your domains and its mail will show up here." action={<ButtonLink to="/app/mailboxes">Create a mailbox</ButtonLink>} />
      </div>
    );
  }
  const mb = mailboxes.find((m) => m.id === mailboxId) ?? busiest;

  return (
    <div className="flex h-full">
      {/* Folders */}
      <h1 className="sr-only">Mail</h1>
      <aside aria-label="Mailboxes and folders" className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/50 md:flex xl:w-60">
        <div className="p-3">
          <Button className="w-full" onClick={() => startCompose()}><PenSquare className="h-4 w-4" />Compose</Button>
          <button onClick={() => setInvoiceOpen(true)} className="mt-2 w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-hover hover:text-fg">Chase an unpaid invoice</button>
        </div>
        <div className="px-3">
          <label htmlFor="mailbox-switch" className="sr-only">Mailbox</label>
          <select id="mailbox-switch" value={mb.id} onChange={(e) => setParam({ mailbox: e.target.value, m: null, q: null })} className="h-9 w-full truncate rounded-lg border border-line bg-surface px-2 text-[13px] outline-none focus:border-brand/60">
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}{m.kind === "agent" ? " (agent)" : ""}{m.folders.inbox?.unread ? ` (${m.folders.inbox.unread})` : ""}</option>)}
          </select>
        </div>
        <nav className="mt-3 flex-1 space-y-0.5 overflow-y-auto px-3" aria-label="Folders">
          {FOLDER_UI.map(({ id, label, icon: Icon }) => {
            const unread = id === "inbox" || id === "spam" ? mb.folders[id as Folder]?.unread : undefined;
            const count = id === "drafts" ? mb.folders.drafts?.total : unread;
            return (
              <button key={id} onClick={() => setParam({ folder: id === "inbox" ? null : id, m: null, q: null })} aria-current={!q && folder === id ? "page" : undefined}
                className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors", !q && folder === id ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
                <Icon className="h-4 w-4" />{label}
                {!!count && <span className={cn("ml-auto text-[11px] tabular-nums", id === "inbox" ? "rounded bg-brand px-1.5 font-semibold text-brand-fg" : "text-subtle")}>{count}</span>}
              </button>
            );
          })}
          {SCHEDULE_VIEWS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setParam({ folder: id, m: null, q: null })} aria-current={!q && folder === id ? "page" : undefined}
              className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13.5px] transition-colors", !q && folder === id ? "bg-fill font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg")}>
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
          {mb.connectionId && <ProviderFolderNav connectionId={mb.connectionId} current={q ? "" : folder} onPick={(key) => setParam({ folder: key, m: null, q: null })} />}
        </nav>
        <div className="border-t border-line p-3 text-[11px] text-subtle">
          <div className="mb-1 flex justify-between"><span>Storage</span><span>{formatBytes(mb.usedBytes)} of {formatBytes(mb.quotaMb * 1024 * 1024)}</span></div>
          <div className="h-1 overflow-hidden rounded-full bg-fill"><div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, Math.min(100, (mb.usedBytes / (mb.quotaMb * 1048576)) * 100))}%` }} /></div>
          <div className="mt-3 hidden gap-x-3 gap-y-1 xl:flex xl:flex-wrap"><span><Kbd>c</Kbd> compose</span><span><Kbd>j</Kbd>/<Kbd>k</Kbd> move</span><span><Kbd>e</Kbd> archive</span><span><Kbd>t</Kbd> task</span><span><Kbd>/</Kbd> search</span></div>
        </div>
      </aside>

      {/* List */}
      <section className={cn("flex min-w-0 flex-col border-r border-line md:w-[340px] lg:w-[380px] xl:w-[420px]", selected ? "hidden md:flex" : "flex flex-1 md:flex-none")} aria-label="Messages">
        <div className="flex items-center gap-2 border-b border-line p-3">
          <select aria-label="Folder" value={q ? "search" : folder} onChange={(e) => setParam({ folder: e.target.value === "inbox" ? null : e.target.value, m: null, q: null })} className="h-9 rounded-lg border border-line bg-surface px-2 text-[13px] md:hidden">
            {q && <option value="search">Search</option>}
            {FOLDER_UI.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            {SCHEDULE_VIEWS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <form className="relative flex-1" role="search" onSubmit={(e) => { e.preventDefault(); setParam({ q: search.trim() || null, m: null }); }}>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <input ref={searchRef} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search mail" aria-label="Search mail"
              className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-8 text-[13px] outline-none placeholder:text-subtle focus:border-brand/60 focus:ring-4 focus:ring-brand/10" />
            {q && <button type="button" onClick={() => setParam({ q: null })} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-fg" aria-label="Clear search"><X className="h-3.5 w-3.5" /></button>}
          </form>
          <button className="inline-flex items-center justify-center rounded-lg border border-line p-2 text-muted md:hidden max-sm:h-10 max-sm:w-10" onClick={() => startCompose()} aria-label="Compose"><PenSquare className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center justify-between px-4 py-2 text-xs text-subtle">
          <span>{q ? `Results for “${q}”` : FOLDER_UI.find((f) => f.id === folder)?.label ?? SCHEDULE_VIEWS.find((f) => f.id === folder)?.label ?? folder.slice(2)}</span>
          {folder === "trash" && !q && items.length > 0 && <button className="text-muted hover:text-bad" onClick={() => act.mutate({ ids: items.map((i) => i.id), action: "delete" })}>Empty trash</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isScheduleView(folder) && !q ? <ScheduleListView view={folder} mailboxId={mailboxId} onOpen={open} onEdit={(it) => void editScheduled(it)} /> : <>
          <ReturnedStrip items={returnedItems} onOpen={openReturned} />
          {list.isPending ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="space-y-2 border-b border-line px-4 py-3.5"><Skeleton className="h-3.5 w-32" /><Skeleton className="h-3.5 w-56" /><Skeleton className="h-3 w-full" /></div>)
            : items.length === 0 ? (
              <EmptyState icon={q ? <Search /> : <Inbox />} title={q ? "No matches" : folder === "inbox" ? "Inbox zero" : "Nothing here"}
                body={q ? "Try a different word, a sender's address, or check the spelling." : folder === "inbox" ? `New mail to ${mb.address} lands here.` : "Messages you move here will show up in this folder."} />
            ) : (
              <ul>
                {items.map((m) => <ListRow key={m.id} m={m} active={m.id === selected} folder={folder}
                  onOpen={() => (m.folder === "drafts" ? openDraft(m.id) : open(m.id))}
                  onStar={() => act.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" })} />)}
              </ul>
            )}
          {list.hasNextPage && <div className="p-3"><Button variant="ghost" className="w-full" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>Load more</Button></div>}
          </>}
        </div>
      </section>

      {/* Reader */}
      <section className={cn("min-w-0 flex-1", selected ? "flex" : "hidden md:flex")} aria-label="Message">
        {current || selected ? (
          <Reader id={selected!} mailboxes={mailboxes} onBack={() => open(null)} onMove={move}
            onMoveTo={(m, to) => { act.mutate({ ids: [m.id], action: "move", to }); open(null); }}
            onCompose={startCompose} onStar={(m) => act.mutate({ ids: [m.id], action: m.isStarred ? "unstar" : "star" })} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div><div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-xl border border-line bg-elevated text-subtle"><Inbox className="h-5 w-5" /></div>
              <p className="text-sm text-muted">Select a message to read</p>
              <p className="mt-2 text-xs text-subtle">Press <Kbd>j</Kbd> to open the first one</p></div>
          </div>
        )}
      </section>

      <InvoiceReminderDialog open={invoiceOpen} onClose={() => setInvoiceOpen(false)} onCompose={startCompose} />
      {compose && <Compose key={JSON.stringify(compose).length + compose.subject} initial={compose} mailboxes={mailboxes} onClose={closeCompose} />}
    </div>
  );

  async function openDraft(id: string) {
    const { message } = await api.get<{ message: Message }>(`/mail/messages/${id}`);
    setCompose({ mailboxId: message.mailboxId, to: message.to.map((a) => a.address).join(", "), cc: message.cc.map((a) => a.address).join(", "), subject: message.subject, text: message.text, draftId: message.id, threadId: message.threadId });
  }
}

function ListRow({ m, active, folder, onOpen, onStar }: { m: MessageListItem; active: boolean; folder: View; onOpen: () => void; onStar: () => void }) {
  const who = folder === "sent" || folder === "drafts" ? `To: ${m.to.map((t) => t.name || t.address).join(", ") || "(no recipients)"}` : m.from.name || m.from.address;
  return (
    <li className={cn("group relative border-b border-line", active ? "bg-brand-soft/60" : "hover:bg-hover")}>
      <button onClick={onOpen} className="block w-full px-4 py-3 pr-10 text-left" aria-current={active || undefined}>
        <div className="flex items-baseline gap-2">
          {!m.isRead && <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full bg-brand" aria-label="Unread" />}
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", m.isRead ? "text-fg/75" : "font-semibold text-fg")}>{who}</span>
          <time className="shrink-0 text-[11.5px] text-subtle" dateTime={m.date}>{mailDate(m.date)}</time>
        </div>
        <div className={cn("mt-0.5 flex items-center gap-1.5 truncate text-[13px]", m.isRead ? "text-muted" : "text-fg/90")}>
          {m.sentByAgentId && <span className="inline-flex shrink-0 items-center gap-0.5 rounded border border-brand/40 px-1 text-[11px] text-brand-hover"><Bot className="h-3 w-3" aria-hidden />Agent</span>}
          {m.hasAttachments && <Paperclip className="h-3 w-3 shrink-0 text-subtle" />}<span className="truncate">{m.subject || "(no subject)"}</span>
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-subtle">{m.snippet || "\u00a0"}</div>
      </button>
      <button onClick={onStar} data-testid="mail-star" className={cn("absolute right-0 top-1 inline-flex h-10 w-10 items-center justify-center rounded-lg transition-opacity", m.isStarred ? "text-warn opacity-100" : "text-subtle opacity-0 hover:text-fg focus:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 max-sm:opacity-100")} aria-label={m.isStarred ? "Unstar" : "Star"} aria-pressed={m.isStarred}>
        <Star className={cn("h-4 w-4", m.isStarred && "fill-current")} />
      </button>
    </li>
  );
}

function Reader({ id, mailboxes, onBack, onMove, onMoveTo, onCompose, onStar }: {
  id: string; mailboxes: MailboxOverview[]; onBack: () => void; onMove: (a: string) => void; onMoveTo: (m: Message, to: string) => void; onCompose: (d: Partial<ComposeDraft>) => void; onStar: (m: Message) => void;
}) {
  const qc = useQueryClient();
  const { data, isPending, error } = useQuery({
    queryKey: ["mail", "message", id],
    queryFn: () => api.get<{ message: Message; thread: Message[] }>(`/mail/messages/${id}`),
  });
  useEffect(() => { if (data) qc.invalidateQueries({ queryKey: qk.overview }); }, [data, qc]);
  if (error) return <div className="grid flex-1 place-items-center text-sm text-muted">This message is no longer available.</div>;
  if (isPending || !data) return <div className="flex-1 space-y-4 p-6"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-48 w-full" /></div>;
  const { message: m, thread } = data;
  const last = thread[thread.length - 1] ?? m;
  const own = new Set(mailboxes.map((b) => b.address));

  const reply = (all: boolean, draft = "") => {
    const target = last;
    const to = own.has(target.from.address) ? target.to.map((t) => t.address) : [target.replyTo || target.from.address];
    const cc = all ? [...target.to, ...target.cc].map((a) => a.address).filter((a) => !own.has(a) && !to.includes(a)) : [];
    onCompose({
      mailboxId: target.mailboxId, to: to.join(", "), cc: cc.join(", "), inReplyToId: target.id, threadId: target.threadId,
      subject: /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`,
      text: `${draft}\n\nOn ${fullDate(target.date)}, ${target.from.name || target.from.address} wrote:\n${target.text.split("\n").map((l) => `> ${l}`).join("\n")}`,
    });
  };
  const forward = () => onCompose({
    mailboxId: last.mailboxId, to: "", subject: /^fwd?:/i.test(last.subject) ? last.subject : `Fwd: ${last.subject}`,
    text: `\n\n---------- Forwarded message ----------\nFrom: ${last.from.name ? `${last.from.name} <${last.from.address}>` : last.from.address}\nDate: ${fullDate(last.date)}\nSubject: ${last.subject}\nTo: ${last.to.map((t) => t.address).join(", ")}\n\n${last.text}`,
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-[57px] shrink-0 items-center gap-1 border-b border-line px-3">
        <button onClick={onBack} className="rounded-md p-2 text-muted hover:bg-hover hover:text-fg md:hidden" aria-label="Back to list"><ArrowLeft className="h-4 w-4" /></button>
        {m.folder !== "sent" && m.folder !== "drafts" && <>
          <SnoozeMenu messageId={m.id} onDone={onBack} />
          <IconBtn label={m.folder === "archive" ? "Move to inbox" : "Archive (e)"} onClick={() => onMove(m.folder === "archive" ? "inbox" : "archive")}><Archive /></IconBtn>
          <IconBtn label={m.folder === "spam" ? "Not spam" : "Report spam"} onClick={() => onMove(m.folder === "spam" ? "inbox" : "spam")}><Ban /></IconBtn>
        </>}
        <IconBtn label={m.folder === "trash" ? "Delete forever" : "Delete (#)"} onClick={() => onMove(m.folder === "trash" ? "delete" : "trash")}><Trash2 /></IconBtn>
        {m.remoteBox && m.folder !== "sent" && m.folder !== "drafts" && <MoveTo message={m} mailboxes={mailboxes} onMove={onMove} onMoveTo={onMoveTo} />}
        <IconBtn label={m.isStarred ? "Unstar (s)" : "Star (s)"} onClick={() => onStar(m)} active={m.isStarred}><Star className={cn(m.isStarred && "fill-current")} /></IconBtn>
        <div className="ml-auto flex gap-1">
          <IconBtn label="Reply" onClick={() => reply(false)}><Reply /></IconBtn>
          <IconBtn label="Forward" onClick={forward}><Forward /></IconBtn>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6 sm:px-8">
          <h1 className="text-xl font-semibold leading-snug tracking-tight">{m.subject || "(no subject)"}</h1>
          <div className="mt-2"><MakeTask messageId={last.id} threadId={last.threadId} shortcut /></div>
          {m.folder !== "drafts" && <ThreadPresenceLine threadId={m.threadId} />}
          <Assistant key={last.id} messageId={last.id} onDraft={(text) => reply(false, text)} />
          <div className="mt-6 space-y-4">
            {thread.map((t, i) => <ThreadMessage key={t.id} m={t} defaultOpen={i === thread.length - 1 || !t.isRead} />)}
          </div>
          <div className="mt-6 flex gap-2">
            <Button variant="secondary" onClick={() => reply(false)}><Reply className="h-4 w-4" />Reply</Button>
            {(last.to.length + last.cc.length > 1) && <Button variant="secondary" onClick={() => reply(true)}>Reply all</Button>}
            <Button variant="ghost" onClick={forward}><Forward className="h-4 w-4" />Forward</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

const TRIAGE_LABEL: Record<string, string> = { needs_reply: "Needs a reply", invoice: "Invoice", receipt: "Receipt", update: "Update", newsletter: "Newsletter", suspicious: "Looks suspicious" };

/** Summaries, triage and drafted replies, on the workspace's own AI key (bring your own AI). */
function Assistant({ messageId, onDraft }: { messageId: string; onDraft: (text: string) => void }) {
  const status = useAiStatus();
  const summary = useMutation({ mutationFn: () => api.post<{ summary: string; actionItems: string[] }>("/ai/summary", { messageId }), onError: (e) => showError(e) });
  const triage = useMutation({ mutationFn: () => api.post<{ triage: { category: string; priority: string; reason: string } }>("/ai/triage", { messageId }), onError: (e) => showError(e) });
  const draft = useMutation({ mutationFn: () => api.post<{ text: string }>("/ai/draft", { messageId }), onSuccess: (r) => onDraft(r.text), onError: (e) => showError(e) });
  if (!status.data) return null;
  if (!status.data.connected) {
    return (
      <section aria-label="Assistant" className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-elevated/60 p-3 text-sm text-muted">
        <Sparkles className="h-4 w-4 text-brand-hover" aria-hidden />
        <span>{BYO_AI_LINE}</span>
        <span className="ml-auto flex gap-2">
          <ButtonLink size="sm" variant="secondary" to="/agents#mcp">MCP setup</ButtonLink>
          <ButtonLink size="sm" variant="ghost" to="/app/settings#ai">Use your own key</ButtonLink>
        </span>
      </section>
    );
  }
  return (
    <section aria-label="Assistant" className="mt-4 rounded-xl border border-line bg-elevated/60 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-hover" aria-hidden />
        <Button size="sm" variant="secondary" loading={summary.isPending} onClick={() => summary.mutate()}>Summarise</Button>
        <Button size="sm" variant="secondary" loading={draft.isPending} onClick={() => draft.mutate()}>Draft a reply</Button>
        <Button size="sm" variant="ghost" loading={triage.isPending} onClick={() => triage.mutate()}>Sort it</Button>
        <span className="ml-auto text-xs text-subtle">On your {status.data.providerName} key</span>
      </div>
      {triage.data && (
        <p className="mt-3 text-sm"><span className={cn("mr-2 rounded border px-1.5 py-0.5 text-xs", triage.data.triage.category === "suspicious" ? "border-bad/50 text-bad" : "border-line text-muted")}>{TRIAGE_LABEL[triage.data.triage.category] ?? triage.data.triage.category}{triage.data.triage.priority === "high" ? ", urgent" : ""}</span>{triage.data.triage.reason}</p>
      )}
      {summary.data && (
        <div className="mt-3 text-sm">
          <p className="leading-relaxed">{summary.data.summary}</p>
          {summary.data.actionItems.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">{summary.data.actionItems.map((a) => <li key={a}>{a}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

function ThreadMessage({ m, defaultOpen }: { m: Message; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const auth = m.authResults;
  const authOk = auth && auth.dmarc === "pass";
  const authBad = auth && (auth.dmarc === "fail" || auth.spf === "fail");
  return (
    <article className="rounded-xl border border-line bg-surface">
      <button className="flex w-full items-start gap-3 p-4 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Avatar label={initials(m.from.name || m.from.address)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{m.from.name || m.from.address}</span>
            {m.from.name && <span className="truncate text-xs text-subtle">&lt;{m.from.address}&gt;</span>}
          </div>
          <div className="truncate text-xs text-subtle">
            {open ? <>to {m.to.map((t) => t.name || t.address).join(", ")}{m.cc.length ? `, cc ${m.cc.map((c) => c.address).join(", ")}` : ""}</> : m.snippet}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {authOk && <span title="SPF, DKIM and DMARC passed"><ShieldCheck className="h-4 w-4 text-ok" aria-label="Sender verified" /></span>}
          {authBad && <span title="Sender authentication failed"><ShieldAlert className="h-4 w-4 text-bad" aria-label="Sender not verified" /></span>}
          <time className="text-xs text-subtle" dateTime={m.date}>{fullDate(m.date)}</time>
        </div>
      </button>
      {open && (
        <div className="px-4 pb-5 sm:pl-[60px]">
          {m.html ? <HtmlBody html={m.html} /> : <TextBody text={m.text} />}
          {m.attachments.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {m.attachments.map((a) => (
                <a key={a.id} href={a.available ? `/api/mail/attachments/${a.id}` : undefined} download={a.filename} aria-disabled={!a.available}
                  className={cn("flex items-center gap-2.5 rounded-lg border border-line bg-elevated px-3 py-2 text-xs", a.available ? "hover:border-line-strong" : "cursor-not-allowed opacity-60")}
                  title={a.available ? `Download ${a.filename}` : "Too large to store inline"}>
                  <File className="h-4 w-4 text-subtle" /><span className="max-w-48 truncate font-medium">{a.filename}</span><span className="text-subtle">{formatBytes(a.sizeBytes)}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/** Move a connected mailbox's message to any synced folder at its provider (round 19). */
function MoveTo({ message: m, mailboxes, onMove, onMoveTo }: { message: Message; mailboxes: MailboxOverview[]; onMove: (a: string) => void; onMoveTo: (m: Message, to: string) => void }) {
  const connectionId = mailboxes.find((b) => b.id === m.mailboxId)?.connectionId;
  const { data } = useProviderFolders(connectionId);
  const targets = moveTargets(data, m.remoteBox);
  if (!connectionId || !targets.length) return null;
  return (
    <label className="relative flex items-center rounded-md p-2 text-muted hover:bg-hover hover:text-fg" title="Move to folder">
      <FolderInput className="h-4 w-4" aria-hidden />
      <select aria-label="Move to folder" value="" data-testid="move-to"
        onChange={(e) => { const to = e.target.value; if (!to) return; if (to.startsWith("f:")) onMoveTo(m, to); else onMove(to); }}
        className="absolute inset-0 cursor-pointer opacity-0">
        <option value="">Move to</option>
        {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </select>
    </label>
  );
}

function IconBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} className={cn("rounded-md p-2 transition-colors hover:bg-hover [&_svg]:h-4 [&_svg]:w-4", active ? "text-warn" : "text-muted hover:text-fg")}>
      {children}
    </button>
  );
}
