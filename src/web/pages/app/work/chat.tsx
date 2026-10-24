/** Team chat: channels and direct messages, threads, @mentions, files, and links into tasks and mail. */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, FileText, Hash, Lock, Mail, MessageSquare, Paperclip, Plus, Send, Users, X } from "lucide-react";
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { formatBytes, mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Avatar, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { useMe } from "@/web/lib/queries";

export interface ChatChannel {
  id: string; kind: "channel" | "dm"; name: string; topic: string; private: boolean; projectId: string | null; guestAccess: boolean; archived: boolean; joined: boolean;
  members: { id: string; name: string; email: string }[]; unread: number; mentions: number; lastMessageAt: string | null; lastMessage: { id: string; preview: string; authorName: string } | null;
}
export interface ChatMessage {
  id: string; channelId: string; parentId: string | null; author: { type: string; id: string | null; name: string }; body: string;
  mentions: { type: string; id: string; name: string }[]; links: { type: "task" | "thread" | "doc"; id: string; ref: string | null; title: string; messageId?: string }[];
  attachments: { id: string; filename: string; contentType: string; size: number }[]; replyCount: number; lastReplyAt: string | null; editedAt: string | null; deleted: boolean; createdAt: string;
}
interface Person { id: string; type: "member" | "agent"; name: string; email: string | null }

const TOKEN_RE = /(<@(?:member|agent):[A-Za-z0-9_-]+>|<#(?:task|thread|doc):[A-Za-z0-9_.@-]+>|<!(?:channel|here)>)/g;

/** Message text with mentions as names and links as chips. Never renders HTML from the message. */
function Body({ m }: { m: ChatMessage }) {
  const parts = m.body.split(TOKEN_RE);
  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
      {parts.map((p, i) => {
        const mention = p.match(/^<@(member|agent):(.+)>$/);
        if (mention) { const who = m.mentions.find((x) => x.type === mention[1] && x.id === mention[2]); return <span key={i} className="rounded bg-brand/15 px-1 font-medium text-brand-hover">@{who?.name ?? "someone"}</span>; }
        if (/^<!(channel|here)>$/.test(p)) return <span key={i} className="rounded bg-warn/15 px-1 font-medium text-warn">@channel</span>;
        const link = p.match(/^<#(task|thread|doc):(.+)>$/);
        if (link) { const l = m.links.find((x) => x.type === link[1] && (x.id === link[2] || x.ref === link[2])); return l ? <LinkChip key={i} l={l} /> : <span key={i}>{link[1]}</span>; }
        return <span key={i}>{p}</span>;
      })}
    </p>
  );
}

function LinkChip({ l }: { l: ChatMessage["links"][number] }) {
  const to = l.type === "task" ? `/app/tasks?task=${l.id}` : l.type === "doc" ? `/app/docs/${l.id}` : `/app/mail?m=${l.messageId ?? ""}`;
  const Icon = l.type === "task" ? CheckSquare : l.type === "doc" ? FileText : Mail;
  return (
    <Link to={to} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 align-middle text-[12.5px] hover:border-line-strong" data-testid="chat-link">
      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden /><span className="truncate">{l.ref ? `${l.ref} ` : ""}{l.title}</span>
    </Link>
  );
}

function Message({ m, onThread, onTask, onEdit, onDelete, mine, inThread }: { m: ChatMessage; mine: boolean; inThread?: boolean; onThread?: () => void; onTask: () => void; onEdit: () => void; onDelete: () => void }) {
  const taskLinks = m.links.filter((l) => l.type === "task");
  return (
    <li className="group flex gap-3 rounded-lg px-2 py-2 hover:bg-hover" data-testid="chat-message" id={`m-${m.id}`}>
      <Avatar label={m.author.name} className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-semibold">{m.author.name}</span>
          {m.author.type === "agent" && <span className="rounded bg-fill px-1 text-[11px] text-muted">agent</span>}
          <time className="text-[11.5px] text-subtle" dateTime={m.createdAt}>{mailDate(m.createdAt)}</time>
          {m.editedAt && !m.deleted && <span className="text-[11px] text-subtle">(edited)</span>}
        </div>
        {m.deleted ? <p className="text-[13px] italic text-subtle">Message deleted</p> : <Body m={m} />}
        {m.attachments.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {m.attachments.map((f) => (
              <li key={f.id}><a href={`/api/chat/files/${f.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12.5px] hover:border-line-strong"><Paperclip className="h-3.5 w-3.5" aria-hidden />{f.filename} <span className="text-subtle">{formatBytes(f.size)}</span></a></li>
            ))}
          </ul>
        )}
        {!inThread && m.replyCount > 0 && <button onClick={onThread} className="mt-1 text-[12.5px] font-medium text-brand-hover hover:underline">{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</button>}
        {taskLinks.length > 0 && m.body && !m.body.includes("<#task:") && <div className="mt-1 flex flex-wrap gap-1">{taskLinks.map((l) => <LinkChip key={l.id} l={l} />)}</div>}
      </div>
      {!m.deleted && (
        <div className="flex items-start gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          {!inThread && <Button variant="ghost" size="sm" onClick={onThread} aria-label="Reply in thread"><MessageSquare className="h-4 w-4" /></Button>}
          <Menu trigger={<button type="button" aria-label="More message actions" className="inline-flex h-8 items-center rounded-lg px-2 text-[13px] text-muted hover:bg-elevated hover:text-fg">More</button>}>
            <MenuItem onSelect={onTask} icon={<CheckSquare className="h-4 w-4" />}>Make task</MenuItem>
            {mine && <MenuItem onSelect={onEdit}>Edit</MenuItem>}
            <MenuItem onSelect={onDelete} danger>Delete</MenuItem>
          </Menu>
        </div>
      )}
    </li>
  );
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(new Error("Couldn't read that file."));
  r.readAsDataURL(file);
});

/** The box people type in: "@" opens a picker; names become mention tokens on send, task refs become links. */
function Composer({ people, placeholder, onSend, testId }: { people: Person[]; placeholder: string; onSend: (body: string, files: File[]) => Promise<void>; testId?: string }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const query = text.match(/(?:^|\s)@([\w.-]*)$/)?.[1];
  const matches = query === undefined ? [] : people.filter((p) => p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const pick = (p: Person) => { setText((t) => t.replace(/@([\w.-]*)$/, `@${p.name} `)); setPicked((l) => [...l.filter((x) => x.id !== p.id), p]); };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() && !files.length) return;
    let body = text;
    for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) body = body.split(`@${p.name}`).join(`<@${p.id}>`);
    if (/(^|\s)@(channel|here)\b/.test(body)) body = body.replace(/(^|\s)@(channel|here)\b/g, "$1<!channel>");
    body = body.replace(/(^|[\s(])([A-Z][A-Z0-9]{1,5}-\d{1,6})\b/g, "$1<#task:$2>");
    setBusy(true);
    try { await onSend(body, files); setText(""); setFiles([]); setPicked([]); } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="relative border-t border-line p-3">
      {matches.length > 0 && (
        <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-pop">
          {matches.map((p) => <li key={p.id}><button type="button" role="option" aria-selected={false} onClick={() => pick(p)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"><Avatar label={p.name} className="h-5 w-5" />{p.name}{p.type === "agent" && <span className="text-subtle">agent</span>}</button></li>)}
        </ul>
      )}
      {files.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{files.map((f, i) => <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px]">{f.name}<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button></span>)}</div>}
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${testId ?? "composer"}-input`}>Message</label>
        <textarea id={`${testId ?? "composer"}-input`} data-testid={testId} value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !matches.length) { e.preventDefault(); void submit(); } if (e.key === "Tab" && matches.length) { e.preventDefault(); pick(matches[0]); } }}
          className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm focus:border-brand/70 focus:outline-none focus:ring-4 focus:ring-brand/15" />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => setFiles((l) => [...l, ...Array.from(e.target.files ?? [])].slice(0, 5))} />
        <Button variant="ghost" size="icon" type="button" aria-label="Attach a file" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /></Button>
        <Button type="submit" size="icon" aria-label="Send" loading={busy}><Send className="h-4 w-4" /></Button>
      </div>
      <p className="mt-1 text-[11.5px] text-subtle">Enter to send, Shift Enter for a new line. Type @ to mention, or a task ref like OPS-12 to link it.</p>
    </form>
  );
}

export function ChatPage() {
  const { id: channelId } = useParams();
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const myId = me.data?.user.id;
  const [creating, setCreating] = useState<"channel" | "dm" | null>(null);
  const channels = useQuery({ queryKey: ["chat", "channels"], refetchInterval: 15_000, queryFn: async () => (await api.get<{ channels: ChatChannel[] }>("/chat/channels")).channels });
  const people = useQuery({ queryKey: ["chat", "people"], staleTime: 120_000, queryFn: async () => (await api.get<{ people: Person[] }>("/chat/people")).people });
  const list = channels.data ?? [];
  const current = list.find((c) => c.id === channelId) ?? (channelId ? undefined : list.find((c) => c.name === "general") ?? list[0]);
  useEffect(() => { if (!channelId && current) navigate(`/app/chat/${current.id}`, { replace: true }); }, [channelId, current, navigate]);
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  const messages = useQuery({
    queryKey: ["chat", "messages", current?.id], enabled: !!current, refetchInterval: visible ? 4000 : false,
    queryFn: async () => (await api.get<{ messages: ChatMessage[] }>(`/chat/channels/${current!.id}/messages?limit=100`)).messages,
  });
  const thread = useQuery({
    queryKey: ["chat", "thread", threadId], enabled: !!threadId, refetchInterval: visible ? 4000 : false,
    queryFn: () => api.get<{ message: ChatMessage; replies: ChatMessage[] }>(`/chat/messages/${threadId}/thread`),
  });
  const lastId = messages.data?.[messages.data.length - 1]?.id;
  useEffect(() => {
    if (!current || !lastId) return;
    void api.post(`/chat/channels/${current.id}/read`, {}).then(() => qc.invalidateQueries({ queryKey: ["chat", "channels"] })).catch(() => undefined);
  }, [current, lastId, qc]);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [lastId]);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["chat", "messages"] }), qc.invalidateQueries({ queryKey: ["chat", "thread"] }), qc.invalidateQueries({ queryKey: ["chat", "channels"] })]);
  const send = (parentId?: string) => async (body: string, files: File[]) => {
    const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type || undefined, contentBase64: await toBase64(f) })));
    await api.post(`/chat/channels/${current!.id}/messages`, { body, parentId, attachments: attachments.length ? attachments : undefined });
    await refresh();
  };
  const makeTask = async (m: ChatMessage) => {
    try { const r = await api.post<{ task: { id: string; ref: string } }>(`/chat/messages/${m.id}/task`, {}); await refresh(); navigate(`/app/tasks?task=${r.task.id}`); } catch (e) { showError(e as Error); }
  };
  const edit = async (m: ChatMessage) => {
    const next = window.prompt("Edit message", m.body);
    if (next === null || !next.trim()) return;
    try { await api.patch(`/chat/messages/${m.id}`, { body: next }); await refresh(); } catch (e) { showError(e as Error); }
  };
  const remove = async (m: ChatMessage) => {
    if (!window.confirm("Delete this message?")) return;
    try { await api.del(`/chat/messages/${m.id}`); await refresh(); } catch (e) { showError(e as Error); }
  };
  const openThread = (m: ChatMessage) => setParams((p) => { p.set("thread", m.id); return p; });
  const row = (m: ChatMessage, inThread = false) => (
    <Message key={m.id} m={m} inThread={inThread} mine={m.author.type === "member" && m.author.id === myId}
      onThread={() => openThread(m)} onTask={() => void makeTask(m)} onEdit={() => void edit(m)} onDelete={() => void remove(m)} />
  );
  const chans = list.filter((c) => c.kind === "channel");
  const dms = list.filter((c) => c.kind === "dm");
  const navItem = (c: ChatChannel, icon: ReactNode) => (
    <li key={c.id}>
      <Link to={`/app/chat/${c.id}`} aria-current={c.id === current?.id ? "page" : undefined}
        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px]", c.id === current?.id ? "bg-fill text-fg" : "text-muted hover:bg-hover hover:text-fg", c.unread > 0 && "font-semibold text-fg")}>
        {icon}<span className="flex-1 truncate">{c.name}</span>
        {c.mentions > 0 ? <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-fg" aria-label={`${c.mentions} mentions`}>{c.mentions}</span>
          : c.unread > 0 ? <span className="rounded-full bg-fill px-1.5 text-[11px]" aria-label={`${c.unread} unread`}>{c.unread}</span> : null}
      </Link>
    </li>
  );

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] sm:-m-6 lg:h-dvh">
      <h1 className="sr-only">Chat</h1>
      <nav aria-label="Channels" className={cn("w-full shrink-0 overflow-y-auto border-r border-line p-3 sm:w-60", current && channelId ? "hidden sm:block" : "block")}>
        <div className="mb-1 flex items-center justify-between px-2"><h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Channels</h2>
          <Button variant="ghost" size="icon" aria-label="New channel" onClick={() => setCreating("channel")}><Plus className="h-4 w-4" /></Button></div>
        {channels.isPending ? <Skeleton className="h-24" /> : <ul className="space-y-0.5">{chans.map((c) => navItem(c, c.private ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Hash className="h-3.5 w-3.5" aria-hidden />))}</ul>}
        <div className="mb-1 mt-4 flex items-center justify-between px-2"><h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">Direct messages</h2>
          <Button variant="ghost" size="icon" aria-label="New direct message" onClick={() => setCreating("dm")}><Plus className="h-4 w-4" /></Button></div>
        <ul className="space-y-0.5">{dms.map((c) => navItem(c, <Users className="h-3.5 w-3.5" aria-hidden />))}</ul>
        {!dms.length && <p className="px-2 text-[12.5px] text-subtle">No direct messages yet.</p>}
      </nav>
      <section aria-label={current ? `Messages in ${current.name}` : "Messages"} className={cn("flex min-w-0 flex-1 flex-col", !channelId && "hidden sm:flex", threadId && "hidden lg:flex")}>
        {current ? (
          <>
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
              <Link to="/app/chat" className="text-[13px] text-muted sm:hidden" onClick={(e) => { e.preventDefault(); navigate("/app/chat?list=1"); }}>Back</Link>
              <h2 className="truncate text-[15px] font-semibold">{current.kind === "channel" ? `#${current.name}` : current.name}</h2>
              {current.guestAccess && <span className="rounded bg-ok/15 px-1.5 text-[11.5px] text-ok">shared with guests</span>}
              <span className="truncate text-[12.5px] text-subtle">{current.topic}</span>
            </header>
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {messages.isPending ? <Skeleton className="h-40" /> : !messages.data?.length ? (
                <EmptyState icon={<MessageSquare />} title="Nothing here yet" body="Say hello. Mention people with @, link a task with its ref, or turn any message into a task." />
              ) : <ul>{messages.data.map((m) => row(m))}</ul>}
              <div ref={bottom} />
            </div>
            <Composer testId="chat-composer" people={people.data ?? []} placeholder={current.kind === "channel" ? `Message #${current.name}` : `Message ${current.name}`} onSend={send()} />
          </>
        ) : !channels.isPending && <EmptyState icon={<MessageSquare />} title="Pick a channel" body="Choose a channel or start a direct message." className="m-auto" />}
      </section>
      {threadId && (
        <aside aria-label="Thread" className="flex w-full shrink-0 flex-col border-l border-line lg:w-96">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-semibold">Thread</h2>
            <Button variant="ghost" size="icon" aria-label="Close thread" onClick={() => setParams((p) => { p.delete("thread"); return p; })}><X className="h-4 w-4" /></Button>
          </header>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {thread.data ? <ul>{row(thread.data.message, true)}<li className="my-2 border-t border-line" aria-hidden />{thread.data.replies.map((m) => row(m, true))}</ul> : <Skeleton className="h-24" />}
          </div>
          {current && <Composer testId="thread-composer" people={people.data ?? []} placeholder="Reply in thread" onSend={send(threadId)} />}
        </aside>
      )}
      <NewChannel open={creating === "channel"} onClose={() => setCreating(null)} onMade={(id) => { setCreating(null); void qc.invalidateQueries({ queryKey: ["chat", "channels"] }); navigate(`/app/chat/${id}`); }} />
      <NewDm open={creating === "dm"} people={(people.data ?? []).filter((p) => p.type === "member" && p.id !== `member:${myId}`)} onClose={() => setCreating(null)}
        onMade={(id) => { setCreating(null); void qc.invalidateQueries({ queryKey: ["chat", "channels"] }); navigate(`/app/chat/${id}`); }} />
    </div>
  );
}

function NewChannel({ open, onClose, onMade }: { open: boolean; onClose: () => void; onMade: (id: string) => void }) {
  const [name, setName] = useState(""); const [topic, setTopic] = useState(""); const [priv, setPriv] = useState(false);
  const [projectId, setProjectId] = useState(""); const [guests, setGuests] = useState(false); const [busy, setBusy] = useState(false);
  const projects = useQuery({ queryKey: ["projects"], enabled: open, queryFn: async () => (await api.get<{ projects: { id: string; name: string }[] }>("/projects")).projects });
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { const r = await api.post<{ channel: { id: string } }>("/chat/channels", { name, topic, private: priv, projectId: projectId || undefined, guestAccess: !!projectId && guests && !priv }); setName(""); setTopic(""); onMade(r.channel.id); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New channel" description="Channels are for topics, teams or clients. Anyone in the workspace can join a public channel.">
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. sales" required />}</Field>
        <Field label="Topic (optional)">{(p) => <Input {...p} value={topic} onChange={(e) => setTopic(e.target.value)} />}</Field>
        <Field label="Project (optional)" hint="Link a client project to share this channel with its guests.">{(p) => (
          <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">None</option>{(projects.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        )}</Field>
        <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />Private: only people you add can see it</label>
        {projectId && !priv && <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />Share with this project's guests</label>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create channel</Button></div>
      </form>
    </Dialog>
  );
}

function NewDm({ open, onClose, onMade, people }: { open: boolean; onClose: () => void; onMade: (id: string) => void; people: Person[] }) {
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); if (!sel.length) return; setBusy(true);
    try { const r = await api.post<{ channel: { id: string } }>("/chat/dms", { userIds: sel.map((s) => s.replace(/^member:/, "")) }); setSel([]); onMade(r.channel.id); }
    catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  const sorted = useMemo(() => [...people].sort((a, b) => a.name.localeCompare(b.name)), [people]);
  return (
    <Dialog open={open} onClose={onClose} title="New direct message">
      <form onSubmit={submit} className="space-y-3 px-6 pb-6 pt-4">
        {!sorted.length ? <p className="text-[13.5px] text-muted">Invite teammates in Settings, Team to message them here.</p> : (
          <fieldset className="max-h-64 space-y-1 overflow-y-auto"><legend className="sr-only">People</legend>
            {sorted.map((p) => <label key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] hover:bg-hover">
              <input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />{p.name}<span className="text-subtle">{p.email}</span></label>)}
          </fieldset>
        )}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy} disabled={!sel.length}>Start</Button></div>
      </form>
    </Dialog>
  );
}
