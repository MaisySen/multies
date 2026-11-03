/** Team chat: channels and direct messages, threads, @mentions, files, and links into tasks and mail. */
import { NoChatArt } from "@/web/components/illustrations";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { CatchupCard } from "@/web/components/catchup-card"; // R31
import { chatPollMs, useLiveChat, useOutbox } from "@/web/lib/live-chat"; // R32
import { ChatLiveLine } from "./chat-live-r32"; // R32
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IconAgent, IconAttachment, IconBack, IconBlock, IconChat, IconClose, IconDocs, IconFlag, IconHash, IconInbox, IconLink, IconLock, IconMail, IconMore, IconPin, IconPinOff, IconPlus, IconSend, IconTasks, IconTeam, IconGlobe, IconVolume } from "@/web/components/ui/icon";
import { ChatLangLazy } from "@/web/components/lang-tools-r116-lazy"; // R116
import { api } from "@/web/lib/api";
import { showError } from "@/web/lib/show-error";
import { formatBytes, initials, mailDate } from "@/web/lib/format";
import { cn } from "@/web/lib/cn";
import { Button } from "@/web/components/ui/button";
import { requireText, useDialogs } from "@/web/components/ui/confirm";
import { Dialog } from "@/web/components/ui/dialog";
import { Field, Input, Select } from "@/web/components/ui/input";
import { Avatar, EmptyState, Skeleton } from "@/web/components/ui/misc";
import { Menu, MenuItem } from "@/web/components/ui/menu";
import { useConfig, useMe } from "@/web/lib/queries";
import { useStickToBottom } from "@/web/lib/stick-to-bottom";
import { composerHint, isPhoneWidth, isTouchOnly } from "@/web/lib/phone";
import { shouldOpenDefaultChannel } from "./chat-list-r49";
import { messageActions } from "@/web/lib/message-actions";
import { useCompactActions, useLongPress } from "@/web/lib/use-compact";
import { MessageActionSheet, copyText } from "./chat-actions-r25";
import { useProjects } from "./data";
import { CallHeaderStatus } from "./call-r23";
import { PendingBubbles } from "./chat-pending-r33";
import { newClientMsgId, pendingFor } from "@/web/lib/chat-outbox";
import { BlockedHiddenRow, useModeration } from "./report-sheet-r35"; // R35: report and block
import { AnnouncementsFeed, AnnouncementsNav, ChatPlusAdd, MoveToTopic, PollCard, TopicBar, useChatPlus, type Topic } from "./chat-plus-r96"; // R96
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)
import { useMentionPicker, useMentionsOn } from "@/web/components/mentions-td5"; // TD5
import { CallButton, CallCard, ChatSearch, JumpToUnread, ReactionPicker, Reactions, callPath, flashMessage, useFirstUnread, type ChatSearchResult, type Reaction } from "./chat-r20";
import { tr } from "@/web/i18n"; // R104B
import "@/web/i18n/w2/en-chat"; // R104B

export interface ChatChannel {
  id: string; kind: "channel" | "dm"; name: string; topic: string; private: boolean; projectId: string | null; guestAccess: boolean; archived: boolean; joined: boolean;
  members: { id: string; name: string; email: string; blockedByMe?: boolean }[]; unread: number; mentions: number; lastMessageAt: string | null; lastMessage: { id: string; preview: string; authorName: string } | null;
}
export interface ChatMessage {
  /** R96 chat plus */
  topicId?: string | null; poll?: { id: string; kind: string; question: string }; announcement?: boolean; updatedAt?: string;
  id: string; channelId: string; parentId: string | null; author: { type: string; id: string | null; name: string; title?: string | null; agent?: boolean }; body: string;
  mentions: { type: string; id: string; name: string }[]; links: { type: "task" | "thread" | "doc" | "project" | "contact" | "deal" | "meeting" | "form" | "invoice"; id: string; ref: string | null; title: string; messageId?: string; state?: "restricted" | "deleted"; url?: string; subtitle?: string }[];
  attachments: { id: string; filename: string; contentType: string; size: number }[]; replyCount: number; lastReplyAt: string | null; editedAt: string | null; deleted: boolean; createdAt: string;
  pinnedAt?: string | null; pinnedBy?: string | null; reactions?: Reaction[];
}
interface Person { id: string; type: "member" | "agent"; name: string; email: string | null; isAgent?: boolean; paused?: boolean }

const TOKEN_RE = /(<@(?:member|agent):[A-Za-z0-9_-]+>|<#(?:task|thread|doc):[A-Za-z0-9_.@-]+>|<!(?:channel|here)>)/g;
/** TD5: with MENTIONS_TD5 on, every record type is a chip (resolved on the server for this reader). */
const TOKEN_RE_TD5 = /(<@(?:member|agent):[A-Za-z0-9_-]+>|<#(?:task|thread|doc|project|contact|deal|meeting|form|invoice):[A-Za-z0-9_.@-]+>|<!(?:channel|here)>)/g;

/** Message text with mentions as names and links as chips. Never renders HTML from the message. */
function Body({ m }: { m: ChatMessage }) {
  const on = useMentionsOn();
  const parts = m.body.split(on ? TOKEN_RE_TD5 : TOKEN_RE);
  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
      {parts.map((p, i) => {
        const mention = p.match(/^<@(member|agent):(.+)>$/);
        if (mention) { const who = m.mentions.find((x) => x.type === mention[1] && x.id === mention[2]); return <span key={i} className="rounded bg-brand/15 px-1 font-medium text-brand-hover">@{who?.name ?? "someone"}</span>; }
        if (/^<!(channel|here)>$/.test(p)) return <span key={i} className="rounded bg-warn/15 px-1 font-medium text-warn">@channel</span>;
        const link = on ? p.match(/^<#(task|thread|doc|project|contact|deal|meeting|form|invoice):(.+)>$/) : p.match(/^<#(task|thread|doc):(.+)>$/);
        if (link) { const l = m.links.find((x) => x.type === link[1] && (x.id === link[2] || x.ref === link[2])); return l ? <LinkChip key={i} l={l} /> : <span key={i}>{link[1]}</span>; }
        return <span key={i}>{p}</span>;
      })}
    </p>
  );
}

function LinkChip({ l }: { l: ChatMessage["links"][number] }) {
  // TD5: a card the reader may not open says so and carries no title.
  if (l.state) return <span className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line bg-fill px-1.5 py-0.5 align-middle text-[12.5px] italic text-muted" data-testid="chat-link-muted"><IconLock className="h-3.5 w-3.5 shrink-0" aria-hidden />{l.state === "restricted" ? tr("chat.restricted_item") : tr("chat.deleted_item")}</span>;
  if (l.url && !["task", "doc", "thread"].includes(l.type)) {
    return (
      <Link to={l.url.startsWith("/app/") ? l.url : "#"} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 align-middle text-[12.5px] hover:border-line-strong" data-testid="chat-link">
        <IconLink className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden /><span className="truncate">{l.title}</span>{l.subtitle && <span className="shrink-0 text-[11.5px] text-subtle">{l.subtitle}</span>}
      </Link>
    );
  }
  const to = l.type === "task" ? `/app/tasks?task=${l.id}` : l.type === "doc" ? `/app/docs/${l.id}` : `/app/mail?m=${l.messageId ?? ""}`;
  const Icon = l.type === "task" ? IconTasks : l.type === "doc" ? IconDocs : IconMail;
  return (
    <Link to={to} className="mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 align-middle text-[12.5px] hover:border-line-strong" data-testid="chat-link">
      <Icon className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden /><span className="truncate">{l.ref ? `${l.ref} ` : ""}{l.title}</span>
    </Link>
  );
}

function Message({ m, onThread, onTask, onTriage, onEdit, onDelete, onPin, onReact, onReport, onBlock, onMove, myId, mine, inThread, role }: { m: ChatMessage; onMove?: () => void; mine: boolean; inThread?: boolean; onThread?: () => void; onTask: () => void; onTriage?: () => void; onEdit: () => void; onDelete: () => void; onPin?: () => void; onReact: (emoji: string) => void; onReport?: () => void; onBlock?: () => void; myId?: string; role?: string | null }) {
  const taskLinks = m.links.filter((l) => l.type === "task");
  const call = m.deleted ? null : callPath(m.body);
  // R25 wave 2: on phones and touch screens one More button (or a long press) opens the actions as a sheet.
  const compact = useCompactActions();
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => setSheet(true), compact && !m.deleted);
  // R116: Translate and Read aloud on a text message (TRANSLATE_R116).
  const langOn = !!useConfig().data?.translateR116 && !call && !m.poll && !!m.body.trim();
  const [langReq, setLangReq] = useState<{ kind: "translate" | "read"; n: number } | null>(null);
  const actions = compact ? messageActions({ deleted: m.deleted, inThread: !!inThread, mine, role, canPin: !!onPin, isReply: !!m.parentId, pinned: !!m.pinnedAt, canTriage: !!onTriage, hasText: !!m.body.trim(), canReport: !!onReport, authorName: m.author.name, lang: langOn }) : [];
  const runAction = (id: string) => {
    if (id === "thread") onThread?.(); else if (id === "copy") void copyText(preview(m)); else if (id === "translate" || id === "read") setLangReq({ kind: id, n: Date.now() }); else if (id === "triage") onTriage?.(); else if (id === "task") onTask();
    else if (id === "pin" || id === "unpin") onPin?.(); else if (id === "edit") onEdit(); else if (id === "delete") onDelete();
    else if (id === "report") onReport?.(); else if (id === "block") onBlock?.();
  };
  return (
    <li className={cn("group flex gap-3 rounded-lg px-2 py-2 hover:bg-hover", compact && "[-webkit-touch-callout:none]")} data-testid="chat-message" id={`m-${m.id}`} {...press}>
      <Avatar label={initials(m.author.name)} className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-semibold">{m.author.name}</span>
          {m.author.title && <span className="truncate text-[12px] text-muted">{m.author.title}</span>}
          {(m.author.type === "agent" || m.author.agent) && <span className="rounded bg-fill px-1 text-[11px] text-muted">{tr("chat.agent")}</span>}
          <time className="text-[11.5px] text-subtle" dateTime={m.createdAt}>{mailDate(m.createdAt)}</time>
          {m.editedAt && !m.deleted && <span className="text-[11px] text-subtle">{tr("chat.edited")}</span>}
          {m.announcement && !m.deleted && <span className="rounded bg-brand/15 px-1.5 text-[11px] text-brand-hover" data-testid="announcement-label">{tr("chat.announcement")}</span>}
          {m.pinnedAt && !m.deleted && <span className="inline-flex items-center gap-1 text-[11px] text-subtle" data-testid="pinned-label"><IconPin className="h-3 w-3" aria-hidden />{tr("chat.pinned")}{m.pinnedBy ? ` by ${m.pinnedBy}` : ""}</span>}
          {compact && !m.deleted && (
            <button type="button" onClick={() => setSheet(true)} aria-label={tr("chat.message_actions")} aria-haspopup="dialog" data-testid="message-more" className="-my-2.5 -mr-2 ml-auto inline-flex h-10 w-10 shrink-0 items-center justify-center self-center rounded-lg text-subtle active:bg-elevated">
              <IconMore className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
        {m.deleted ? <p className="text-[13px] italic text-subtle">{tr("chat.message_deleted")}</p> : call ? <CallCard path={call} by={m.author.name} at={m.createdAt} channelId={m.channelId} /> : m.poll ? <PollCard pollId={m.poll.id} version={m.updatedAt} /> : <Body m={m} />}
        {langOn && !m.deleted && <ChatLangLazy id={m.id} text={preview(m)} request={langReq} onHandled={() => setLangReq(null)} />}
        {m.attachments.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {m.attachments.map((f) => (
              <li key={f.id}><a href={`/api/chat/files/${f.id}`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12.5px] hover:border-line-strong"><IconAttachment className="h-3.5 w-3.5" aria-hidden />{f.filename} <span className="text-subtle">{formatBytes(f.size)}</span></a></li>
            ))}
          </ul>
        )}
        {!inThread && m.replyCount > 0 && <button onClick={onThread} className="mt-1 text-[12.5px] font-medium text-brand-hover hover:underline">{m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}</button>}
        {taskLinks.length > 0 && m.body && !m.body.includes("<#task:") && <div className="mt-1 flex flex-wrap gap-1">{taskLinks.map((l) => <LinkChip key={l.id} l={l} />)}</div>}
        {!m.deleted && <Reactions reactions={m.reactions} myId={myId} onToggle={onReact} />}
      </div>
      {compact && sheet && !m.deleted && <MessageActionSheet open onClose={() => setSheet(false)} author={m.author.name} excerpt={preview(m)} actions={actions} onAction={runAction} onReact={onReact} />}
      {!m.deleted && !compact && (
        <div className="flex items-start gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100">
          <ReactionPicker onPick={onReact} />
          {!inThread && <Button variant="ghost" size="sm" onClick={onThread} aria-label={tr("chat.reply_in_thread")}><IconChat className="h-4 w-4" /></Button>}
          <Menu trigger={<button type="button" aria-label={tr("chat.more_message_actions")} className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-fg"><IconMore className="h-4 w-4" aria-hidden /></button>}>
            {langOn && <MenuItem onSelect={() => setLangReq({ kind: "translate", n: Date.now() })} icon={<IconGlobe className="h-4 w-4" />}>{tr("chat.translate")}</MenuItem>}
            {langOn && <MenuItem onSelect={() => setLangReq({ kind: "read", n: Date.now() })} icon={<IconVolume className="h-4 w-4" />}>{tr("chat.read_aloud")}</MenuItem>}
            <MenuItem onSelect={onTask} icon={<IconTasks className="h-4 w-4" />}>{tr("chat.make_task")}</MenuItem>
            {onTriage && <MenuItem onSelect={onTriage} icon={<IconInbox className="h-4 w-4" />}>{tr("tasks.send_to_triage")}</MenuItem>}
            {onPin && !m.parentId && <MenuItem onSelect={onPin} icon={m.pinnedAt ? <IconPinOff className="h-4 w-4" /> : <IconPin className="h-4 w-4" />}>{m.pinnedAt ? tr("chat.unpin") : tr("chat.pin_to_channel")}</MenuItem>}
            {onMove && !m.parentId && !m.deleted && <MenuItem onSelect={onMove} icon={<IconHash className="h-4 w-4" />}>{tr("chat.move_to_topic")}</MenuItem>}
            {mine && <MenuItem onSelect={onEdit}>{tr("chat.edit")}</MenuItem>}
            <MenuItem onSelect={onDelete} danger>{tr("chat.delete")}</MenuItem>
            {onReport && !mine && <MenuItem onSelect={onReport} icon={<IconFlag className="h-4 w-4" />}>{tr("chat.report_message")}</MenuItem>}
            {onBlock && !mine && <MenuItem onSelect={onBlock} icon={<IconBlock className="h-4 w-4" />} danger>{tr("chat.block_name", { name: m.author.name })}</MenuItem>}
          </Menu>
        </div>
      )}
    </li>
  );
}

/** One line of a message for previews: mentions and links as plain words. */
const preview = (m: ChatMessage) => {
  const names = new Map(m.mentions.map((x) => [`${x.type}:${x.id}`, x.name]));
  const links = new Map(m.links.map((l) => [`${l.type}:${l.id}`, l.ref ?? l.title]));
  return m.body.replace(TOKEN_RE, (t) => {
    const inner = t.slice(2, -1);
    if (t.startsWith("<@")) return `@${names.get(inner) ?? "someone"}`;
    if (t.startsWith("<#")) return links.get(inner) ?? "a link";
    return "@channel";
  }).replace(/\s+/g, " ").trim();
};

/** The channel's pinned messages: the newest pin in one line, the rest a tap away. */
function PinnedBar({ pins, onOpen, onUnpin }: { pins: ChatMessage[]; onOpen: (m: ChatMessage) => void; onUnpin: (m: ChatMessage) => void }) {
  const [open, setOpen] = useState(false);
  if (!pins.length) return null;
  const first = pins[0];
  return (
    <div className="border-b border-line bg-surface px-4 py-2" data-testid="pinned-bar">
      <div className="flex items-center gap-2 text-[13px]">
        <IconPin className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => onOpen(first)}>
          <span className="font-medium">{first.author.name}:</span> {preview(first) || tr("chat.attachment")}
        </button>
        <button type="button" className="shrink-0 text-[12.5px] font-medium text-brand-hover hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? tr("chat.hide") : pins.length === 1 ? tr("chat.1_pinned") : tr("chat.length_pinned", { length: pins.length })}
        </button>
      </div>
      {open && (
        <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto" aria-label={tr("chat.pinned_messages")}>
          {pins.map((m) => (
            <li key={m.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
              <button type="button" className="min-w-0 flex-1 text-left text-[13px]" onClick={() => onOpen(m)}>
                <span className="font-medium">{m.author.name}</span> <span className="text-[11.5px] text-subtle">{mailDate(m.createdAt)}</span>
                <span className="block truncate text-muted">{preview(m) || tr("chat.attachment")}</span>
              </button>
              <Button variant="ghost" size="icon" aria-label={tr("chat.unpin_the_message_from_name", { name: m.author.name })} onClick={() => onUnpin(m)}><IconPinOff className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(new Error("Couldn't read that file."));
  r.readAsDataURL(file);
});

/** The box people type in: "@" opens a picker; names become mention tokens on send, task refs become links. */
function Composer({ people, placeholder, onSend, testId, onType }: { people: Person[]; placeholder: string; onSend: (body: string, files: File[]) => Promise<void>; testId?: string; onType?: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [picked, setPicked] = useState<Person[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // R25 (DF-10): no keyboard hints on touch screens or phone widths, and a real project key as the sample.
  const projects = useProjects();
  const hint = composerHint({ touch: isTouchOnly() || isPhoneWidth(), projectKey: projects.data?.find((p) => !p.archived)?.key });
  const on = useMentionsOn(); // TD5: one picker for people and records
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const picker = useMentionPicker(inputRef, text, setText, people.filter((p) => !p.paused).map((p) => ({ key: p.id, name: p.name, insert: `@${p.name} `, hint: p.type === "agent" || p.isAgent ? tr("mail.agent") : undefined, onPick: () => setPicked((l) => [...l.filter((x) => x.id !== p.id), p]) })), { enabled: on });
  const query = on ? undefined : text.match(/(?:^|\s)@([\w.-]*)$/)?.[1];
  const matches = query === undefined ? [] : people.filter((p) => !p.paused && p.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);
  const pick = (p: Person) => { setText((t) => t.replace(/@([\w.-]*)$/, `@${p.name} `)); setPicked((l) => [...l.filter((x) => x.id !== p.id), p]); };
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!text.trim() && !files.length) return;
    let body = on ? picker.toTokens(text) : text;
    for (const p of [...picked].sort((a, b) => b.name.length - a.name.length)) body = body.split(`@${p.name}`).join(`<@${p.id}>`);
    if (/(^|\s)@(channel|here)\b/.test(body)) body = body.replace(/(^|\s)@(channel|here)\b/g, "$1<!channel>");
    body = body.replace(/(^|[\s(])([A-Z][A-Z0-9]{1,5}-\d{1,6})\b/g, "$1<#task:$2>");
    setBusy(true);
    try { await onSend(body, files); setText(""); setFiles([]); setPicked([]); picker.reset(); } catch (err) { showError(err as Error); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="relative border-t border-line p-3 max-sm:px-2 max-sm:py-1.5">
      {on && picker.list}
      {matches.length > 0 && (
        <ul role="listbox" aria-label={tr("chat.mention_someone")} className="absolute bottom-full left-3 mb-1 w-64 overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-pop">
          {matches.map((p) => <li key={p.id}><button type="button" role="option" aria-selected={false} onClick={() => pick(p)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-hover"><Avatar label={initials(p.name)} className="h-5 w-5 text-[9px]" />{p.name}{(p.type === "agent" || p.isAgent) && <span className="inline-flex items-center gap-0.5 text-subtle" data-testid="mention-agent-badge"><IconAgent className="h-3 w-3" aria-hidden />{tr("mail.agent")}</span>}</button></li>)}
        </ul>
      )}
      {files.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{files.map((f, i) => <span key={i} className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[12px]">{f.name}<button type="button" aria-label={tr("chat.remove_name", { name: f.name })} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}><IconClose className="h-3 w-3" /></button></span>)}</div>}
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={`${testId ?? "composer"}-input`}>{tr("compose.message")}</label>
        <textarea ref={inputRef} id={`${testId ?? "composer"}-input`} data-testid={testId} value={text} onChange={(e) => { setText(e.target.value); if (e.target.value) onType?.(); if (on) requestAnimationFrame(picker.sync); }} rows={1} placeholder={placeholder}
          onClick={on ? picker.sync : undefined} aria-activedescendant={on ? picker.activeId : undefined} aria-autocomplete={on ? "list" : undefined}
          onKeyDown={(e) => { if (on && picker.onKeyDown(e)) return; if (e.key === "Enter" && !e.shiftKey && !matches.length) { e.preventDefault(); void submit(); } if (e.key === "Tab" && matches.length) { e.preventDefault(); pick(matches[0]); } }}
          className="max-h-40 min-h-10 flex-1 resize-y rounded-lg border border-line bg-surface px-3 py-2 text-sm max-sm:min-h-11 max-sm:resize-none max-sm:rounded-[22px] max-sm:px-4 max-sm:py-2.5 max-sm:text-[16px] focus:border-brand/70 focus:outline-none focus:ring-4 focus:ring-brand/15" />
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => setFiles((l) => [...l, ...Array.from(e.target.files ?? [])].slice(0, 5))} />
        <Button variant="ghost" size="icon" type="button" aria-label={tr("chat.attach_a_file")} onClick={() => fileRef.current?.click()}><IconAttachment className="h-4 w-4" /></Button>
        <Button type="submit" size="icon" aria-label={tr("common.send")} loading={busy} data-testid={testId === "chat-composer" ? "chat-send" : undefined} className="max-sm:rounded-full"><IconSend className="h-4 w-4" /></Button>
      </div>
      <p className="mt-1 text-[11.5px] text-subtle max-sm:sr-only" data-testid="composer-hint">{hint}</p>
    </form>
  );
}

export function ChatPage() {
  const { confirm, prompt, dialogs } = useDialogs();
  const moderation = useModeration(); // R35: report and block
  const { id: channelId } = useParams();
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const myId = me.data?.user.id;
  // R96 chat plus: topics, announcements, votes. Hidden when the server has the flag off.
  const plus = useChatPlus();
  const annView = plus.on && params.get("view") === "announcements";
  const isAdmin = me.data?.organization?.role === "owner" || me.data?.organization?.role === "admin";
  const [topicId, setTopicId] = useState<string | null>(null);
  const [moving, setMoving] = useState<ChatMessage | null>(null);
  const [creating, setCreating] = useState<"channel" | "dm" | null>(null);
  // R32: live chat over a socket; while it is open the polls below slow to a 60 second safety net.
  const live = useLiveChat(myId);
  const outboxItems = useOutbox(live.outbox);
  const channels = useQuery({ queryKey: ["chat", "channels"], refetchInterval: chatPollMs(live.live, 15_000), queryFn: async () => (await api.get<{ channels: ChatChannel[] }>("/chat/channels")).channels });
  const people = useQuery({ queryKey: ["chat", "people"], staleTime: 120_000, queryFn: async () => (await api.get<{ people: Person[] }>("/chat/people")).people });
  const list = channels.data ?? [];
  const current = list.find((c) => c.id === channelId) ?? (channelId ? undefined : list.find((c) => c.name === "general") ?? list[0]);
  // R49: on a phone, Back lands on the channel list (?list=1) instead of bouncing straight into a channel.
  const listParam = params.get("list");
  useEffect(() => { if (!annView && current && shouldOpenDefaultChannel({ channelId, hasDefault: true, listParam, phone: isPhoneWidth() })) navigate(`/app/chat/${current.id}`, { replace: true }); }, [channelId, current, navigate, listParam, annView]);
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  const messages = useQuery({
    queryKey: ["chat", "messages", current?.id], enabled: !!current, refetchInterval: visible ? chatPollMs(live.live, 4000) : false,
    queryFn: async () => (await api.get<{ messages: ChatMessage[] }>(`/chat/channels/${current!.id}/messages?limit=100`)).messages,
  });
  useEffect(() => { setTopicId(null); }, [current?.id]);
  const topicMsgs = useQuery({
    queryKey: ["chat", "topic-messages", current?.id, topicId], enabled: !!current && !!topicId, refetchInterval: visible ? chatPollMs(live.live, 4000) : false,
    queryFn: async () => (await api.get<{ messages: ChatMessage[] }>(`/chat/channels/${current!.id}/messages?limit=100&topicId=${encodeURIComponent(topicId!)}`)).messages,
  });
  // R96: with a topic picked, the server's topic page plus anything newer the channel list already holds.
  const shown = useMemo(() => {
    if (!topicId) return messages.data;
    const byId = new Map<string, ChatMessage>();
    for (const m of topicMsgs.data ?? []) byId.set(m.id, m);
    for (const m of messages.data ?? []) if (m.topicId === topicId) byId.set(m.id, m);
    return [...byId.values()].filter((m) => m.topicId === topicId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [topicId, topicMsgs.data, messages.data]);
  const topicName = topicId ? qc.getQueryData<Topic[]>(["chat-plus", "topics", current?.id])?.find((t) => t.id === topicId)?.name : undefined;
  const thread = useQuery({
    queryKey: ["chat", "thread", threadId], enabled: !!threadId, refetchInterval: visible ? chatPollMs(live.live, 4000) : false,
    queryFn: () => api.get<{ message: ChatMessage; replies: ChatMessage[] }>(`/chat/messages/${threadId}/thread`),
  });
  const pins = useQuery({
    queryKey: ["chat", "pins", current?.id], enabled: !!current && current.kind === "channel", refetchInterval: visible ? 30_000 : false,
    queryFn: async () => (await api.get<{ pins: ChatMessage[] }>(`/chat/channels/${current!.id}/pins`)).pins,
  });
  const lastId = messages.data?.[messages.data.length - 1]?.id;
  // Marks the channel read once per new last message (keyed on ids: the channel list refetch makes new objects).
  const currentId = current?.id;
  // Round 20: the first unread message is read before the channel is marked read.
  const firstUnread = useFirstUnread(currentId);
  const unreadChecked = !firstUnread.isPending;
  useEffect(() => {
    if (!currentId || !lastId || !unreadChecked) return;
    void api.post(`/chat/channels/${currentId}/read`, {}).then(() => qc.invalidateQueries({ queryKey: ["chat", "channels"] })).catch(() => undefined);
  }, [currentId, lastId, qc, unreadChecked]);
  const bottom = useRef<HTMLDivElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const scrollContent = useRef<HTMLDivElement>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["chat", "messages"] }), qc.invalidateQueries({ queryKey: ["chat", "thread"] }), qc.invalidateQueries({ queryKey: ["chat", "channels"] }), qc.invalidateQueries({ queryKey: ["chat", "pins"] })]);
  const send = (parentId?: string) => async (body: string, files: File[]) => {
    // R33: text goes through the outbox (client id, held until the socket's hello, ack, one retry).
    if (!files.length) { live.outbox.enqueue({ channelId: current!.id, parentId: parentId ?? null, body, topicId: parentId ? null : topicId }); return; }
    const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, contentType: f.type || undefined, contentBase64: await toBase64(f) })));
    await api.post(`/chat/channels/${current!.id}/messages`, { body, parentId, topicId: parentId ? undefined : topicId ?? undefined, attachments: attachments.length ? attachments : undefined, clientMsgId: newClientMsgId() });
    await refresh();
  };
  const makeTask = async (m: ChatMessage) => {
    try { const r = await api.post<{ task: { id: string; ref: string } }>(`/chat/messages/${m.id}/task`, {}); await refresh(); navigate(`/app/tasks?task=${r.task.id}`); } catch (e) { showError(e as Error); }
  };
  const sendToTriage = async (m: ChatMessage) => {
    try { await api.post(`/chat/messages/${m.id}/task`, { triage: true }); await refresh(); navigate("/app/triage"); } catch (e) { showError(e as Error); }
  };
  const edit = async (m: ChatMessage) => {
    const next = await prompt({ title: tr("chat.edit_message"), label: tr("compose.message"), initial: m.body, multiline: true, hint: tr("chat.cmd_enter_or_ctrl_enter_saves"), validate: requireText("a message") });
    if (next === null || !next.trim()) return;
    try { await api.patch(`/chat/messages/${m.id}`, { body: next }); await refresh(); } catch (e) { showError(e as Error); }
  };
  const remove = async (m: ChatMessage) => {
    if (!(await confirm({ title: tr("chat.delete_this_message"), description: m.body.length > 80 ? `"${m.body.slice(0, 80)}..." is removed for everyone in the channel.` : `"${m.body}" is removed for everyone in the channel.`, confirmLabel: tr("chat.delete_message") }))) return;
    try { await api.del(`/chat/messages/${m.id}`); await refresh(); } catch (e) { showError(e as Error); }
  };
  const togglePin = async (m: ChatMessage) => {
    try {
      if (m.pinnedAt) await api.del(`/chat/messages/${m.id}/pin`); else await api.post(`/chat/messages/${m.id}/pin`, {});
      await refresh();
    } catch (e) { showError(e as Error); }
  };
  const openThread = (m: ChatMessage) => setParams((p) => { p.set("thread", m.id); return p; });
  const react = async (m: ChatMessage, emoji: string) => {
    try { await api.post(`/chat/messages/${m.id}/reactions`, { emoji }); await refresh(); } catch (e) { showError(e as Error); }
  };
  /** A search result: replies open their thread, other messages scroll into view (or open beside the channel when not loaded). */
  const openResult = (r: ChatSearchResult) => {
    if (r.parentId) { navigate(`/app/chat/${r.channelId}?thread=${r.parentId}`); return; }
    if (r.channelId === current?.id && flashMessage(r.id)) return;
    navigate(`/app/chat/${r.channelId}?m=${r.id}`);
  };
  const jumpTo = params.get("m");
  // R100b: open at the newest message and stay there while cards and pictures load (not one screen above it).
  const stick = useStickToBottom(scrollBox, scrollContent, `${current?.id ?? ""}:${topicId ?? ""}`, !!jumpTo);
  useEffect(() => { if (!jumpTo) stick.toEnd(); }, [lastId]); // eslint-disable-line react-hooks/exhaustive-deps -- only when a new message arrives
  useEffect(() => {
    if (!jumpTo || !messages.data) return;
    stick.release();
    if (!flashMessage(jumpTo)) setParams((p) => { p.delete("m"); p.set("thread", jumpTo); return p; }, { replace: true });
    else setParams((p) => { p.delete("m"); return p; }, { replace: true });
  }, [jumpTo, messages.data, setParams, stick]);
  /** Scrolls to a pinned message when it is on screen, otherwise opens it beside the channel. */
  const openPin = (m: ChatMessage) => {
    const el = document.getElementById(`m-${m.id}`);
    if (el) { stick.release(); el.scrollIntoView({ block: "center" }); el.classList.add("bg-hover"); window.setTimeout(() => el.classList.remove("bg-hover"), 1500); }
    else openThread(m);
  };
  // R35: the server leaves blocked people's messages out; live events are dropped here too.
  const fromBlocked = (m: ChatMessage) => m.author.type === "member" && !!m.author.id && moderation.blocked.has(m.author.id);
  const hiddenHere = !!current?.members?.some((x) => x.blockedByMe) || (messages.data ?? []).some(fromBlocked);
  const reportable = (m: ChatMessage) => m.author.type === "member" && !!m.author.id && m.author.id !== myId;
  const reportCtx = (): "chat" | "dm" => (current?.kind === "dm" ? "dm" : "chat");
  const row = (m: ChatMessage, inThread = false) => fromBlocked(m) ? null : (
    <Message key={m.id} m={m} inThread={inThread} mine={m.author.type === "member" && m.author.id === myId}
      onReport={reportable(m) ? () => moderation.report({ targetType: "message", messageId: m.id, userId: m.author.id!, name: m.author.name, context: reportCtx() }) : undefined}
      onBlock={reportable(m) ? () => void moderation.block(m.author.id!, m.author.name) : undefined}
      onThread={() => openThread(m)} onTask={() => void makeTask(m)} onTriage={() => void sendToTriage(m)} onEdit={() => void edit(m)} onDelete={() => void remove(m)}
      onMove={plus.on && current?.kind === "channel" && !inThread && ((m.author.type === "member" && m.author.id === myId) || isAdmin) ? () => setMoving(m) : undefined}
      onPin={current?.kind === "channel" ? () => void togglePin(m) : undefined} onReact={(e) => void react(m, e)} myId={myId} role={me.data?.organization?.role} />
  );
  const chans = list.filter((c) => c.kind === "channel");
  const dms = list.filter((c) => c.kind === "dm");
  const navItem = (c: ChatChannel, icon: ReactNode) => (
    <li key={c.id}>
      <Link to={`/app/chat/${c.id}`} aria-current={c.id === current?.id ? "page" : undefined}
        data-testid="chat-channel"
        className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] max-sm:min-h-11 max-sm:gap-3 max-sm:rounded-lg max-sm:px-3 max-sm:text-[16px] max-sm:[&>svg]:h-[18px] max-sm:[&>svg]:w-[18px]", c.id === current?.id ? "bg-fill text-fg" : "text-muted hover:bg-hover hover:text-fg", c.unread > 0 && "font-semibold text-fg")}>
        {icon}<span className="flex-1 truncate">{c.name}</span>
        {c.mentions > 0 ? <span className="rounded-full bg-brand px-1.5 text-[11px] font-semibold text-brand-fg" aria-label={`${c.mentions} mentions`}>{c.mentions}</span>
          : c.unread > 0 ? <span className="rounded-full bg-fill px-1.5 text-[11px]" aria-label={`${c.unread} unread`}>{c.unread}</span> : null}
      </Link>
    </li>
  );

  return (
    <div className="-m-4 flex h-[calc(100dvh-3.5rem)] sm:-m-6 lg:h-dvh max-sm:-mx-4 max-sm:-my-6 max-md:h-[calc(100dvh-3rem-env(safe-area-inset-top)-var(--tabbar-h,0px))]" data-testid="chat-page">
      {dialogs}
      {moderation.sheet}
      <h1 className="sr-only">{tr("nav.chat")}</h1>
      <nav aria-label={tr("chat.channels")} className={cn("w-full shrink-0 overflow-y-auto border-r border-line p-3 sm:w-60", (current && channelId) || annView ? "hidden sm:block" : "block")}>
        {plus.on && <AnnouncementsNav active={annView} onOpen={() => navigate("/app/chat?view=announcements")} />}
        <div className="mb-1 flex items-center justify-between px-2"><h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{tr("chat.channels")}</h2>
          <Button variant="ghost" size="icon" aria-label={tr("chat.new_channel")} onClick={() => setCreating("channel")}><IconPlus className="h-4 w-4" /></Button></div>
        {channels.isError && !channels.data ? <LoadError compact onRetry={() => channels.refetch()} /> : channels.isPending ? <Skeleton className="h-24" /> : <ul className="space-y-0.5">{chans.map((c) => navItem(c, c.private ? <IconLock className="h-3.5 w-3.5" aria-hidden /> : <IconHash className="h-3.5 w-3.5" aria-hidden />))}</ul>}
        <div className="mb-1 mt-4 flex items-center justify-between px-2"><h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{tr("notifcat.direct_messages")}</h2>
          <Button variant="ghost" size="icon" aria-label={tr("chat.new_direct_message")} onClick={() => setCreating("dm")}><IconPlus className="h-4 w-4" /></Button></div>
        <ul className="space-y-0.5">{dms.map((c) => navItem(c, <IconTeam className="h-3.5 w-3.5" aria-hidden />))}</ul>
        {!dms.length && <p className="px-2 text-[12.5px] text-subtle">{tr("chat.no_direct_messages_yet")}</p>}
      </nav>
      <section aria-label={current ? tr("chat.messages_in_name", { name: current.name }) : tr("mail.messages")} className={cn("flex min-w-0 flex-1 flex-col", !channelId && !annView && "hidden sm:flex", threadId && "hidden lg:flex")}>
        {annView ? (
          <>
            <header className="flex min-h-14 items-center gap-2 border-b border-line px-4 py-2.5 max-sm:px-2">
              <Link to="/app/chat?list=1" className="inline-flex min-h-11 items-center gap-0.5 rounded-lg pl-1 pr-2 text-[15px] text-brand-hover hover:bg-hover sm:hidden"><IconBack className="h-4 w-4" aria-hidden />{tr("nav.chat")}</Link>
              <h2 className="text-[15px] font-semibold">{tr("chat.announcements")}</h2>
            </header>
            <AnnouncementsFeed onOpenMessage={(cid, mid) => navigate(`/app/chat/${cid}#m-${mid}`)} />
          </>
        ) : current ? (
          <>
            <header className="flex min-h-14 items-center gap-2 border-b border-line px-4 py-2.5 max-sm:gap-1 max-sm:px-2 max-sm:py-1" data-testid="chat-head">
              <Link to="/app/chat" className="-my-2 -ml-2 max-sm:my-0 max-sm:ml-0 inline-flex min-h-11 shrink-0 items-center gap-0.5 rounded-lg pl-1 pr-2 text-[15px] text-brand-hover transition-colors duration-150 hover:bg-hover sm:hidden" onClick={(e) => { e.preventDefault(); navigate("/app/chat?list=1"); }}><IconBack className="h-5 w-5" aria-hidden />{tr("common.back")}</Link>
              <h2 className="min-w-0 truncate text-[15px] font-semibold">{current.kind === "channel" ? `#${current.name}` : current.name}</h2>
              {current.guestAccess && <span className="shrink-0 rounded bg-ok/15 px-1.5 text-[11.5px] text-ok max-sm:hidden">{tr("chat.shared_with_guests")}</span>}
              <span className="min-w-0 truncate text-[12.5px] text-subtle max-sm:hidden">{current.topic}</span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {current.kind === "dm" && (() => {
                  // R35: a one to one DM header offers Report and Block (or Unblock) for the other person.
                  const others = current.members.filter((x) => x.id.replace(/^member:/, "") !== myId);
                  if (others.length !== 1) return null;
                  const o = others[0]; const oid = o.id.replace(/^member:/, ""); const isBlocked = moderation.blocked.has(oid);
                  return (
                    <Menu trigger={<button type="button" aria-label={tr("chat.more_options_for_name", { name: o.name })} data-testid="dm-more" className="inline-flex h-8 w-8 max-sm:h-11 max-sm:w-11 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-fg"><IconMore className="h-4 w-4" aria-hidden /></button>}>
                      <MenuItem onSelect={() => moderation.report({ targetType: "user", userId: oid, name: o.name, context: "dm" })} icon={<IconFlag className="h-4 w-4" />}>{tr("chat.report_name", { name: o.name })}</MenuItem>
                      {isBlocked ? <MenuItem onSelect={() => void moderation.unblock(oid, o.name)} icon={<IconBlock className="h-4 w-4" />}>{tr("chat.unblock_name", { name: o.name })}</MenuItem>
                        : <MenuItem onSelect={() => void moderation.block(oid, o.name)} icon={<IconBlock className="h-4 w-4" />} danger>{tr("chat.block_name", { name: o.name })}</MenuItem>}
                    </Menu>
                  );
                })()}
                <CallHeaderStatus channelId={current.id} />
                <ChatSearch channelId={current.id} onOpen={openResult} />
                {!current.archived && <CallButton channelId={current.id} onStarted={refresh} />}
              </div>
            </header>
            {plus.on && current.kind === "channel" && <TopicBar channelId={current.id} topicId={topicId} onPick={setTopicId} canAdmin={isAdmin} />}
            <PinnedBar pins={pins.data ?? []} onOpen={openPin} onUnpin={(m) => void togglePin(m)} />
            <div ref={scrollBox} className="flex-1 overflow-y-auto px-2 py-2" data-testid="chat-scroll">
              <div ref={scrollContent}>
              <CatchupCard key={`catchup-${current.id}`} type="channel" id={current.id} />
              <JumpToUnread key={current.id} first={firstUnread.data} onJump={(id) => { stick.release(); if (!flashMessage(id)) openThread({ id } as ChatMessage); }} />
              {messages.isError && !messages.data ? <LoadError onRetry={() => messages.refetch()} /> : messages.isPending ? <Skeleton className="h-40" /> : !shown?.length ? pendingFor(outboxItems, current.id, null).length ? null : topicId ? (
                <EmptyState icon={<IconChat />} title={tr("chat.no_messages_in_this_topic_yet")} body="Write the first one below. It goes into this topic." />
              ) : (
                <EmptyState icon={<IconChat />} art={<NoChatArt />} title={tr("chat.nothing_here_yet")} body="Say hello. Mention people with @, link a task with its ref, or turn any message into a task." />
              ) : <ul>{hiddenHere && <BlockedHiddenRow />}{shown.map((m) => row(m))}</ul>}
              <PendingBubbles outbox={live.outbox} channelId={current.id} parentId={null} authorName={me.data?.user.name ?? undefined} />
              <div ref={bottom} />
              </div>
            </div>
            <ChatLiveLine store={live.typing} channelId={current.id} degraded={live.degraded} />
            {plus.on && !current.archived && (
              <div className="flex min-w-0 items-center gap-2 px-4 pt-1 max-sm:px-2">
                <ChatPlusAdd channelId={current.id} topicId={topicId} isAdmin={isAdmin} onDone={() => void refresh()} />
                {topicId && <span className="min-w-0 truncate text-[12px] text-subtle" data-testid="posting-in">{tr("chat.posting_in")} {topicName ?? tr("chat.this_topic")}</span>}
              </div>
            )}
            {moving && <MoveToTopic open messageId={moving.id} channelId={moving.channelId} current={moving.topicId ?? null} onClose={() => setMoving(null)} onMoved={() => { setMoving(null); void refresh(); void qc.invalidateQueries({ queryKey: ["chat-plus"] }); void qc.invalidateQueries({ queryKey: ["chat", "topic-messages"] }); }} />}
            <Composer testId="chat-composer" people={people.data ?? []} placeholder={current.kind === "channel" ? tr("chat.message_name", { name: current.name }) : tr("chat.message_name_2", { name: current.name })} onSend={send()} onType={() => live.onType(current.id)} />
          </>
        ) : !channels.isPending && <EmptyState icon={<IconChat />} art={<NoChatArt />} title={tr("chat.pick_a_channel")} body="Choose a channel or start a direct message." className="m-auto" />}
      </section>
      {threadId && (
        <aside aria-label={tr("chat.thread")} className="flex w-full shrink-0 flex-col border-l border-line lg:w-96">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[15px] font-semibold">{tr("chat.thread")}</h2>
            <Button variant="ghost" size="icon" aria-label={tr("chat.close_thread")} onClick={() => setParams((p) => { p.delete("thread"); return p; })}><IconClose className="h-4 w-4" /></Button>
          </header>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {thread.data ? <ul>{row(thread.data.message, true)}<li className="my-2 border-t border-line" aria-hidden />{thread.data.replies.map((m) => row(m, true))}</ul> : <Skeleton className="h-24" />}
            {current && <PendingBubbles outbox={live.outbox} channelId={current.id} parentId={threadId} authorName={me.data?.user.name ?? undefined} />}
          </div>
          {current && <Composer testId="thread-composer" people={people.data ?? []} placeholder={tr("chat.reply_in_thread")} onSend={send(threadId)} onType={() => live.onType(current.id)} />}
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
    <Dialog open={open} onClose={onClose} title={tr("chat.new_channel")} description={tr("chat.channels_are_for_topics_teams_or_clients_anyone")}>
      <form onSubmit={submit} className="space-y-4 px-6 pb-6 pt-4">
        <Field label={tr("common.name")}>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr("chat.e_g_sales")} required />}</Field>
        <Field label={tr("chat.topic_optional")}>{(p) => <Input {...p} value={topic} onChange={(e) => setTopic(e.target.value)} />}</Field>
        <Field label={tr("chat.project_optional")} hint={tr("chat.link_a_client_project_to_share_this_channel_with")}>{(p) => (
          <Select {...p} value={projectId} onChange={(e) => setProjectId(e.target.value)}><option value="">{tr("tasks.none")}</option>{(projects.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select>
        )}</Field>
        <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />{tr("chat.private_only_people_you_add_can_see_it")}</label>
        {projectId && !priv && <label className="flex items-center gap-2 text-[13.5px]"><input type="checkbox" checked={guests} onChange={(e) => setGuests(e.target.checked)} />{tr("chat.share_with_this_project_s_guests")}</label>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button type="submit" loading={busy}>{tr("chat.create_channel")}</Button></div>
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
    <Dialog open={open} onClose={onClose} title={tr("chat.new_direct_message")}>
      <form onSubmit={submit} className="space-y-3 px-6 pb-6 pt-4">
        {!sorted.length ? <p className="text-[13.5px] text-muted">{tr("chat.invite_teammates_in_settings_team_to_message_the")}</p> : (
          <fieldset className="max-h-64 space-y-1 overflow-y-auto"><legend className="sr-only">{tr("nav.people")}</legend>
            {sorted.map((p) => <label key={p.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] hover:bg-hover">
              <input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel((l) => (e.target.checked ? [...l, p.id] : l.filter((x) => x !== p.id)))} />{p.name}<span className="text-subtle">{p.email}</span></label>)}
          </fieldset>
        )}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>{tr("common.cancel")}</Button><Button type="submit" loading={busy} disabled={!sel.length}>{tr("tours.start")}</Button></div>
      </form>
    </Dialog>
  );
}
