/**
 * R118: Social, Inbox. Comments, messages and mentions from every connected account in one list: assign, mark done,
 * reply (saved replies, the 24 hour window on Meta messages), internal notes, link to a contact, make a task.
 * Two panes at 1280 (list and conversation); one at a time on phones, with Back.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { api, errorMessage } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { timeAgo } from "@/web/lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "@/web/components/ui/misc";
import { Button } from "@/web/components/ui/button";
import { Input, Select, Textarea } from "@/web/components/ui/input";
import { Dialog } from "@/web/components/ui/dialog";
import { ConfirmDialog } from "@/web/components/ui/confirm";
import {
  IconBack, IconCheck, IconContacts, IconExternalLink, IconInbox, IconLock, IconNotes, IconPlus, IconRefresh, IconSearch, IconSend, IconTasks, IconTrash, IconUndo,
} from "@/web/components/ui/icon";
import { networkLabel } from "@/shared/social-p2";
import {
  INBOX_KIND_LABEL, NOTE_MAX, REPLY_MAX, fillSavedReply, replyWindow,
  type InboxItemView, type InboxListResponse, type InboxNoteView, type InboxThreadResponse, type SavedReplyView,
} from "@/shared/social-p2b";
import { LoadError, SocialSwitcher, useSocialP2b } from "./social";

type Tab = "open" | "mine" | "unassigned" | "done";
const TABS: { id: Tab; label: string }[] = [
  { id: "open", label: "Open" }, { id: "mine", label: "Mine" }, { id: "unassigned", label: "Unassigned" }, { id: "done", label: "Done" },
];

export const inboxKeys = { all: ["social-inbox"] as const, list: (q: string) => ["social-inbox", "list", q] as const, item: (id: string) => ["social-inbox", "item", id] as const, saved: ["social-saved-replies"] as const };

const initials = (s: string | null) => (s ?? "?").replace(/^[@u/]+/, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
const appName = (app: string) => (app === "testnet" ? "Test network" : networkLabel(app));

function Avatar({ name }: { name: string | null }) {
  return <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-fill text-[12.5px] font-semibold text-muted" aria-hidden>{initials(name)}</span>;
}

function WindowBadge({ item, now }: { item: InboxItemView; now: number }) {
  const w = replyWindow(item.app, item.kind, item.lastInboundAt, now);
  if (w.state === "none") return null;
  return w.state === "open" ? <Badge tone={w.leftMs < 3 * 3_600_000 ? "warn" : "neutral"} dot>{w.text}</Badge> : <Badge tone="neutral">Window closed</Badge>;
}

function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

/* ---------------------------------------------------------------- list */

function ItemRow({ item, active, onOpen, now }: { item: InboxItemView; active: boolean; onOpen: () => void; now: number }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? "true" : undefined} data-testid={`inbox-item-${item.id}`}
        className={cn("flex w-full gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand",
          active && "bg-fill")}>
        <Avatar name={item.authorName ?? item.authorHandle} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-fg">{item.authorName ?? item.authorHandle ?? "Someone"}</span>
            <span className="ml-auto shrink-0 text-[12px] text-subtle">{timeAgo(item.receivedAt)}</span>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <span>{INBOX_KIND_LABEL[item.kind]} on {appName(item.app)}</span>
            {item.assigneeName && <span aria-label={`Assigned to ${item.assigneeName}`}>· {item.assigneeName}</span>}
            {item.repliedAt && <span>· Replied</span>}
          </span>
          <span className="mt-1 line-clamp-2 break-words text-[13px] leading-snug text-muted">{item.text}</span>
          <span className="mt-1.5 flex"><WindowBadge item={item} now={now} /></span>
        </span>
      </button>
    </li>
  );
}

/* ---------------------------------------------------------------- dialogs */

function ContactDialog({ item, open, onClose }: { item: InboxItemView; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState(item.authorName ?? "");
  const term = q.trim();
  const found = useQuery({
    queryKey: ["social-inbox-contacts", term],
    queryFn: () => api.get<{ contacts: { id: string; name: string; email: string }[] }>(`/contacts?limit=8${term ? `&q=${encodeURIComponent(term)}` : ""}`),
    enabled: open,
    staleTime: 30_000,
  });
  const link = useMutation({
    mutationFn: (contactId: string | null) => api.patch<{ item: InboxItemView }>(`/social/inbox/${encodeURIComponent(item.id)}`, { contactId }),
    onSuccess: (_r, id) => { toast.success(id ? "Linked to the contact" : "Contact link removed"); void qc.invalidateQueries({ queryKey: inboxKeys.all }); onClose(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't link the contact. Try again.")),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Link to a contact" description="The conversation shows on the contact, and the contact's name shows here.">
      <label className="relative block">
        <span className="sr-only">Search contacts</span>
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="pl-9" autoFocus />
      </label>
      <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-line" aria-busy={found.isPending}>
        {found.isPending ? <div className="space-y-2 p-3"><Skeleton className="h-8 rounded" /><Skeleton className="h-8 rounded" /></div>
          : found.error ? <p className="p-3 text-[13px] text-bad" role="alert">{errorMessage(found.error, "Couldn't search contacts.")}</p>
          : !found.data?.contacts.length ? <p className="p-3 text-[13px] text-muted">No contacts match. Add the person in Contacts first.</p>
          : <ul className="divide-y divide-line">{found.data.contacts.map((c) => (
              <li key={c.id}>
                <button type="button" className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                  onClick={() => link.mutate(c.id)} disabled={link.isPending}>
                  <Avatar name={c.name || c.email} />
                  <span className="min-w-0"><span className="block truncate text-[14px] font-medium">{c.name || c.email}</span><span className="block truncate text-[12px] text-muted">{c.email}</span></span>
                  {item.contactId === c.id && <IconCheck className="ml-auto h-4 w-4 text-ok" aria-label="Linked" />}
                </button>
              </li>))}</ul>}
      </div>
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        {item.contactId ? <Button variant="ghost" size="sm" onClick={() => link.mutate(null)} loading={link.isPending && link.variables === null}>Remove link</Button> : <span />}
        <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  );
}

function SavedRepliesDialog({ open, onClose, canManage }: { open: boolean; onClose: () => void; canManage: boolean }) {
  const qc = useQueryClient();
  const saved = useSavedReplies(open);
  const [edit, setEdit] = useState<SavedReplyView | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [removing, setRemoving] = useState<SavedReplyView | null>(null);
  const reset = () => { setEdit(null); setTitle(""); setBody(""); };
  const save = useMutation({
    mutationFn: () => (edit ? api.patch(`/social/saved-replies/${encodeURIComponent(edit.id)}`, { title, body }) : api.post("/social/saved-replies", { title, body })),
    onSuccess: () => { toast.success(edit ? "Saved reply updated" : "Saved reply added"); reset(); void qc.invalidateQueries({ queryKey: inboxKeys.saved }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't save. Try again.")),
  });
  const remove = useMutation({
    mutationFn: (r: SavedReplyView) => api.del(`/social/saved-replies/${encodeURIComponent(r.id)}`),
    onSuccess: () => { toast.success("Saved reply removed"); setRemoving(null); void qc.invalidateQueries({ queryKey: inboxKeys.saved }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't remove it. Try again.")),
  });
  return (
    <Dialog open={open} onClose={onClose} title="Saved replies" description={canManage ? "Answers the team reuses. {name} becomes the person's first name." : "Answers the team reuses. Owners and admins change them."}>
      <ul className="max-h-60 divide-y divide-line overflow-y-auto rounded-lg border border-line" data-testid="saved-replies-list">
        {saved.isPending ? <li className="p-3"><Skeleton className="h-8 rounded" /></li>
          : !saved.data?.length ? <li className="p-3 text-[13px] text-muted">No saved replies yet.</li>
          : saved.data.map((r) => (
            <li key={r.id} className="flex items-start gap-2 p-3">
              <span className="min-w-0 flex-1"><span className="block text-[14px] font-medium">{r.title}</span><span className="block line-clamp-2 whitespace-pre-line text-[12.5px] text-muted">{r.body}</span></span>
              {canManage && <>
                <Button variant="ghost" size="sm" onClick={() => { setEdit(r); setTitle(r.title); setBody(r.body); }} aria-label={`Edit ${r.title}`}>Edit</Button>
                <Button variant="ghost" size="sm" className="text-bad hover:text-bad" onClick={() => setRemoving(r)} aria-label={`Remove ${r.title}`}><IconTrash className="h-4 w-4" aria-hidden /></Button>
              </>}
            </li>))}
      </ul>
      {canManage && (
        <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} data-testid="saved-reply-form">
          <label className="block text-[13px] font-medium">Name<Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="Opening hours" className="mt-1" /></label>
          <label className="block text-[13px] font-medium">Reply<Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={REPLY_MAX} rows={3} placeholder="Hi {name}, we're open 9 to 5 on weekdays." className="mt-1" /></label>
          <div className="flex justify-end gap-2">
            {edit && <Button type="button" variant="ghost" size="sm" onClick={reset}>Cancel</Button>}
            <Button type="submit" size="sm" loading={save.isPending} disabled={!title.trim() || !body.trim()}><IconPlus className="h-4 w-4" aria-hidden />{edit ? "Save changes" : "Add saved reply"}</Button>
          </div>
        </form>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} busy={remove.isPending}
        title={removing ? `Remove "${removing.title}"?` : "Remove"} confirmLabel="Remove" description="The team won't see it in the reply box any more." />
    </Dialog>
  );
}

function useSavedReplies(enabled = true) {
  return useQuery({ queryKey: inboxKeys.saved, queryFn: () => api.get<{ replies: SavedReplyView[] }>("/social/saved-replies").then((r) => r.replies), enabled, staleTime: 60_000 });
}

/* ---------------------------------------------------------------- conversation */

function NoteBubble({ n }: { n: InboxNoteView }) {
  if (n.kind === "note") {
    return (
      <li className="rounded-lg border border-dashed border-line-strong bg-fill/60 px-3 py-2.5" data-testid="inbox-note">
        <p className="flex items-center gap-1.5 text-[12px] font-medium text-muted"><IconLock className="h-3.5 w-3.5" aria-hidden />Internal note · {n.authorName ?? "Teammate"} · {timeAgo(n.createdAt)}</p>
        <p className="mt-1 whitespace-pre-line break-words text-[13.5px]">{n.text}</p>
      </li>
    );
  }
  return (
    <li className="ml-auto max-w-[85%] rounded-lg border border-line bg-surface px-3 py-2.5 shadow-card" data-testid="inbox-reply" data-status={n.status}>
      <p className="whitespace-pre-line break-words text-[13.5px]">{n.text}</p>
      <p className={cn("mt-1 text-[12px]", n.status === "failed" ? "text-bad" : "text-muted")}>
        {n.status === "failed" ? `Didn't send. ${n.error ?? ""}` : `Sent by ${n.authorName ?? "a teammate"} · ${timeAgo(n.createdAt)}`}
      </p>
    </li>
  );
}

function Conversation({ id, list, onBack, now }: { id: string; list: InboxListResponse; onBack: () => void; now: number }) {
  const qc = useQueryClient();
  const thread = useQuery({ queryKey: inboxKeys.item(id), queryFn: () => api.get<InboxThreadResponse>(`/social/inbox/${encodeURIComponent(id)}`) });
  const saved = useSavedReplies();
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [contactOpen, setContactOpen] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setText(""); setMode("reply"); }, [id]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: inboxKeys.all }); };
  const patch = useMutation({
    mutationFn: (body: { status?: "open" | "done"; assigneeId?: string | null }) => api.patch<{ item: InboxItemView }>(`/social/inbox/${encodeURIComponent(id)}`, body),
    onSuccess: (_r, body) => { if (body.status) toast.success(body.status === "done" ? "Marked done" : "Reopened"); else toast.success(body.assigneeId ? "Assigned" : "Unassigned"); refresh(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't change that. Try again.")),
  });
  const send = useMutation({
    mutationFn: () => (mode === "note"
      ? api.post<{ note: InboxNoteView }>(`/social/inbox/${encodeURIComponent(id)}/notes`, { text })
      : api.post<{ note: InboxNoteView }>(`/social/inbox/${encodeURIComponent(id)}/reply`, { text })),
    onSuccess: (r) => {
      if (r.note.status === "failed") toast.error(r.note.error ?? "The reply didn't send.");
      else { toast.success(mode === "note" ? "Note added" : "Reply sent"); setText(""); }
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't send. Try again.")),
  });
  const task = useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/social/inbox/${encodeURIComponent(id)}/task`, {}),
    onSuccess: () => { toast.success("Task made"); refresh(); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't make the task. Try again.")),
  });

  if (thread.isPending) return <Card className="space-y-3 p-5" aria-busy="true"><Skeleton className="h-6 w-1/2 rounded" /><Skeleton className="h-20 rounded-lg" /><Skeleton className="h-24 rounded-lg" /></Card>;
  if (thread.error) return <LoadError error={thread.error} retry={() => void thread.refetch()} what="this conversation" />;
  const { item, notes } = thread.data;
  const w = replyWindow(item.app, item.kind, item.lastInboundAt, now);
  const cantReply = item.app === "instagram" && item.kind === "mention" ? "Instagram doesn't take replies to mentions from Multies. Open the post to reply there." : w.state === "closed" ? w.text : null;
  const isMine = item.assigneeId === list.me;
  const limit = mode === "note" ? NOTE_MAX : REPLY_MAX;
  const submit = () => { if (text.trim() && !send.isPending && !(mode === "reply" && cantReply)) send.mutate(); };

  return (
    <Card className="flex min-h-[28rem] flex-col" data-testid="inbox-thread">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 md:px-5">
        <Button variant="ghost" size="sm" className="lg:hidden" onClick={onBack} aria-label="Back to the list"><IconBack className="h-4 w-4" aria-hidden />Back</Button>
        <Avatar name={item.authorName ?? item.authorHandle} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold">{item.authorName ?? item.authorHandle ?? "Someone"}</h2>
          <p className="truncate text-[12.5px] text-muted">{INBOX_KIND_LABEL[item.kind]} on {item.accountLabel}{item.authorHandle && item.authorHandle !== item.authorName ? ` · ${item.authorHandle}` : ""}</p>
        </div>
        {item.status === "open"
          ? <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: "done" })} loading={patch.isPending && patch.variables?.status === "done"} data-testid="inbox-done"><IconCheck className="h-4 w-4" aria-hidden />Mark done</Button>
          : <Button size="sm" variant="outline" onClick={() => patch.mutate({ status: "open" })} loading={patch.isPending && patch.variables?.status === "open"} data-testid="inbox-reopen"><IconUndo className="h-4 w-4" aria-hidden />Reopen</Button>}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] md:px-5">
        {list.canManage ? (
          <label className="flex items-center gap-2">
            <span className="text-muted">Assigned to</span>
            <Select value={item.assigneeId ?? ""} onChange={(e) => patch.mutate({ assigneeId: e.target.value || null })} className="h-9 w-44" data-testid="inbox-assign">
              <option value="">No one</option>
              {list.people.map((p) => <option key={p.id} value={p.id}>{p.id === list.me ? `${p.name} (you)` : p.name}</option>)}
            </Select>
          </label>
        ) : isMine
          ? <Button size="sm" variant="ghost" onClick={() => patch.mutate({ assigneeId: null })} data-testid="inbox-letgo">Let go</Button>
          : <Button size="sm" variant="ghost" onClick={() => patch.mutate({ assigneeId: list.me })} disabled={!!item.assigneeId} data-testid="inbox-take">{item.assigneeId ? `With ${item.assigneeName ?? "a teammate"}` : "Take it"}</Button>}
        <Button size="sm" variant="ghost" onClick={() => setContactOpen(true)} data-testid="inbox-contact"><IconContacts className="h-4 w-4" aria-hidden />{item.contactName ? item.contactName : "Link to contact"}</Button>
        {item.taskId
          ? <Link to={`/app/tasks?task=${encodeURIComponent(item.taskId)}`} className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 font-medium text-fg hover:bg-hover"><IconTasks className="h-4 w-4" aria-hidden />Open task</Link>
          : <Button size="sm" variant="ghost" onClick={() => task.mutate()} loading={task.isPending} data-testid="inbox-task"><IconTasks className="h-4 w-4" aria-hidden />Make a task</Button>}
        {item.postUrl && <a href={item.postUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5 font-medium text-muted hover:bg-hover hover:text-fg"><IconExternalLink className="h-4 w-4" aria-hidden />Open on {appName(item.app)}</a>}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-5">
        {item.postText && <p className="rounded-lg bg-fill px-3 py-2 text-[12.5px] text-muted"><span className="font-medium text-fg">On your post: </span>{item.postText}</p>}
        <ul className="space-y-3">
          <li className="max-w-[85%] rounded-lg border border-line bg-fill/40 px-3 py-2.5">
            <p className="whitespace-pre-line break-words text-[14px]">{item.text}</p>
            <p className="mt-1 text-[12px] text-muted">{timeAgo(item.receivedAt)}</p>
          </li>
          {notes.map((n) => <NoteBubble key={n.id} n={n} />)}
        </ul>
      </div>

      <div className="border-t border-line px-4 py-3 md:px-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Write" className="flex gap-1 rounded-lg bg-fill p-1">
            {(["reply", "note"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  mode === m ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
                {m === "reply" ? <IconSend className="h-4 w-4" aria-hidden /> : <IconNotes className="h-4 w-4" aria-hidden />}{m === "reply" ? "Reply" : "Internal note"}
              </button>
            ))}
          </div>
          {mode === "reply" && !!saved.data?.length && (
            <Select value="" onChange={(e) => { const r = saved.data?.find((x) => x.id === e.target.value); if (r) { setText(fillSavedReply(r.body, item.authorName)); box.current?.focus(); } }} className="h-9 w-48" aria-label="Insert a saved reply" data-testid="inbox-saved-pick">
              <option value="">Saved replies</option>
              {saved.data.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </Select>
          )}
          {w.state === "open" && mode === "reply" && <span className="text-[12.5px] text-muted" data-testid="inbox-window">{w.text}</span>}
        </div>
        {mode === "reply" && cantReply ? (
          <p className="rounded-lg bg-fill px-3 py-2.5 text-[13px] text-muted" data-testid="inbox-cant-reply">{cantReply} You can still add an internal note.</p>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="sr-only" htmlFor="inbox-text">{mode === "note" ? "Internal note" : "Reply"}</label>
            <Textarea id="inbox-text" ref={box} value={text} onChange={(e) => setText(e.target.value)} maxLength={limit} rows={3} data-testid="inbox-text"
              placeholder={mode === "note" ? "Only your team sees notes" : `Reply to ${item.authorName ?? "them"} on ${appName(item.app)}`}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
              className={cn(mode === "note" && "border-dashed")} />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[12px] text-subtle">Ctrl Enter sends · {[...text].length} of {limit}</span>
              <Button type="submit" size="sm" loading={send.isPending} disabled={!text.trim()} data-testid="inbox-send">
                {mode === "note" ? <IconNotes className="h-4 w-4" aria-hidden /> : <IconSend className="h-4 w-4" aria-hidden />}{mode === "note" ? "Add note" : "Send reply"}
              </Button>
            </div>
          </form>
        )}
      </div>
      <ContactDialog key={item.id} item={item} open={contactOpen} onClose={() => setContactOpen(false)} />
    </Card>
  );
}

/* ---------------------------------------------------------------- page */

export function SocialInboxPage() {
  const on = useSocialP2b();
  const qc = useQueryClient();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "open") as Tab;
  const app = params.get("app") ?? "";
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [savedOpen, setSavedOpen] = useState(false);
  const selected = params.get("item");
  const qs = useMemo(() => {
    const u = new URLSearchParams();
    u.set("status", tab === "done" ? "done" : "open");
    if (tab === "mine" || tab === "unassigned") u.set("view", tab);
    if (app) u.set("app", app);
    if (search.trim()) u.set("q", search.trim());
    return u.toString();
  }, [tab, app, search]);
  const list = useQuery({ queryKey: inboxKeys.list(qs), queryFn: () => api.get<InboxListResponse>(`/social/inbox?${qs}`), enabled: on, placeholderData: (prev) => prev });
  const sync = useMutation({
    mutationFn: (_manual: boolean) => api.post<{ added: number; skipped: boolean }>("/social/inbox/sync", {}),
    onSuccess: (r, manual) => { if (manual && !r.skipped) toast.success(r.added ? `${r.added} new` : "Up to date"); void qc.invalidateQueries({ queryKey: inboxKeys.all }); },
    onError: (e) => toast.error(errorMessage(e, "Couldn't check the networks. Try again.")),
  });
  const synced = useRef(false);
  useEffect(() => {
    if (list.data?.stale && !synced.current) { synced.current = true; sync.mutate(false); }
  }, [list.data?.stale, sync]);
  const set = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: k !== "item" });

  if (!on) return <div><PageHeader title="Inbox" /><Card className="p-5 text-sm text-muted">The Social inbox isn't switched on for this workspace yet.</Card></div>;
  const data = list.data;
  const apps = [...new Set((data?.sources ?? []).filter((s) => s.state !== "posting_only").map((s) => s.app))];
  const counts = data?.counts;
  const problems = (data?.sources ?? []).filter((s) => s.state === "error" || s.state === "posting_only");
  const noSources = !!data && !data.sources.some((s) => s.state !== "posting_only") && !data.items.length;

  return (
    <div data-testid="social-inbox">
      <PageHeader title="Inbox" description="Comments, messages and mentions from every account in one place."
        actions={<div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setSavedOpen(true)} data-testid="inbox-saved"><IconNotes className="h-4 w-4" aria-hidden />Saved replies</Button>
          <Button variant="outline" size="sm" onClick={() => sync.mutate(true)} loading={sync.isPending} data-testid="inbox-refresh"><IconRefresh className="h-4 w-4" aria-hidden />Refresh</Button>
        </div>} />
      <SocialSwitcher />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Show" className="flex gap-1 overflow-x-auto rounded-lg border border-line bg-fill/50 p-1">
          {TABS.map((t) => {
            const n = counts ? counts[t.id] : null;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => { set("tab", t.id === "open" ? null : t.id); set("item", null); }} data-testid={`inbox-tab-${t.id}`}
                className={cn("inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                  tab === t.id ? "bg-surface text-fg shadow-card" : "text-muted hover:text-fg")}>
                {t.label}{n != null && <span className="tabular-nums text-subtle">{n}</span>}
              </button>
            );
          })}
        </div>
        <Select value={app} onChange={(e) => set("app", e.target.value || null)} className="h-9 w-40" aria-label="Network">
          <option value="">All networks</option>
          {apps.map((a) => <option key={a} value={a}>{appName(a)}</option>)}
        </Select>
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Search the inbox</span>
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" className="h-9 pl-9" />
        </label>
        {data?.syncedAt && <span className="text-[12px] text-subtle">Checked {timeAgo(data.syncedAt)}</span>}
      </div>

      {problems.length > 0 && (
        <ul className="mb-3 space-y-1" data-testid="inbox-sources">
          {problems.map((s) => (
            <li key={s.accountId} className={cn("flex items-start gap-2 text-[12.5px]", s.state === "error" ? "text-warn" : "text-muted")}>
              <span className="font-medium">{s.label}:</span><span>{s.text}</span>
              {s.state === "error" && <Link to="/app/social/accounts" className="font-medium underline underline-offset-2">Check the account</Link>}
            </li>
          ))}
        </ul>
      )}

      {list.isPending ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]" aria-busy="true">
          <Card className="space-y-3 p-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</Card>
          <Card className="hidden p-4 lg:block"><Skeleton className="h-64 rounded-lg" /></Card>
        </div>
      ) : list.error && !data ? <LoadError error={list.error} retry={() => void list.refetch()} what="the inbox" />
        : noSources ? (
          <Card data-testid="inbox-empty-accounts"><EmptyState icon={<IconInbox />} title="Connect an account to see replies here"
            body="Comments and messages from Facebook Pages, Instagram and Reddit land here. LinkedIn, TikTok and X are posting only for now."
            action={<Link to="/app/social/accounts" className="inline-flex min-h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand/90">Go to Accounts</Link>} /></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_1fr]">
            <Card className={cn("overflow-hidden", selected && "max-lg:hidden")} data-testid="inbox-list">
              {!data?.items.length ? (
                <EmptyState icon={<IconInbox />} title={tab === "done" ? "Nothing done yet" : search || app ? "Nothing matches" : "All caught up"}
                  body={tab === "done" ? "Conversations you mark done show here." : search || app ? "Try another search or network." : "New comments, messages and mentions land here."} />
              ) : (
                <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto" aria-label="Conversations">
                  {data.items.map((it) => <ItemRow key={it.id} item={it} active={it.id === selected} onOpen={() => set("item", it.id)} now={now} />)}
                </ul>
              )}
            </Card>
            <div className={cn(!selected && "max-lg:hidden")}>
              {selected && data ? <Conversation id={selected} list={data} onBack={() => set("item", null)} now={now} />
                : <Card className="grid min-h-[28rem] place-items-center p-6 text-center text-[13.5px] text-muted"><p>Pick a conversation to read and reply.</p></Card>}
            </div>
          </div>
        )}
      <SavedRepliesDialog open={savedOpen} onClose={() => setSavedOpen(false)} canManage={!!data?.canManage} />
    </div>
  );
}
