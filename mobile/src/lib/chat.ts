import type { ChatChannel, ChatLink, ChatMention, ChatMessage, ChatPerson } from "@/api/types";
import { LOCALE } from "./format";
import { tr } from "@/i18n";

/**
 * Team chat helpers. Message bodies are plain text with a small markup, the same in every client:
 *   <@member:ID> or <@agent:ID> mentions a person or an agent, <!channel> mentions the channel,
 *   <#task:ID>, <#thread:ID> and <#doc:ID> link a task, an email thread or a doc.
 * The server sends `mentions` and `links` already resolved with names and titles.
 */

/** How often the app asks for news, from the API contract: unread counts every 15 s, the open channel every 4 s. */
export const CHAT_POLL = { unreadMs: 15_000, channelMs: 4_000 } as const;

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; mention: ChatMention | null; self: boolean }
  | { kind: "link"; text: string; link: ChatLink | null };

const TOKEN = /<@(member|agent):([^>\s]+)>|<!channel>|<#(task|thread|doc):([^>\s]+)>/g;

/** Splits a body into plain text, "@Name" mentions and linked items, ready to draw. */
export function segments(m: Pick<ChatMessage, "body" | "mentions" | "links">, meId?: string | null): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const hit of m.body.matchAll(TOKEN)) {
    const at = hit.index ?? 0;
    if (at > last) out.push({ kind: "text", text: m.body.slice(last, at) });
    if (hit[0] === "<!channel>") {
      out.push({ kind: "mention", text: "@channel", mention: m.mentions.find((x) => x.type === "channel") ?? { type: "channel", id: "channel", name: "channel" }, self: true });
    } else if (hit[1]) {
      const type = hit[1] as "member" | "agent";
      const id = hit[2];
      const mention = m.mentions.find((x) => x.type === type && (x.id === id || x.id === `${type}:${id}`)) ?? null;
      out.push({ kind: "mention", text: `@${mention?.name ?? (type === "agent" ? "an agent" : "someone")}`, mention, self: !!meId && type === "member" && (meId === `member:${id}` || meId === id) });
    } else {
      const type = hit[3] as ChatLink["type"];
      const id = hit[4];
      const link = m.links.find((x) => x.type === type && x.id === id) ?? null;
      // Inline the short form (the ref, such as OPS-3); the chip under the message carries the full title.
      out.push({ kind: "link", text: link ? link.ref ?? link.title : type === "task" ? tr("m.chat.a_task") : type === "thread" ? tr("m.chat.an_email") : tr("m.chat.a_doc"), link });
    }
    last = at + hit[0].length;
  }
  if (last < m.body.length) out.push({ kind: "text", text: m.body.slice(last) });
  return out;
}

/** The body as plain words, for previews and notifications. */
export function plainText(m: Pick<ChatMessage, "body" | "mentions" | "links">): string {
  return segments(m).map((s) => s.text).join("");
}

export function linkLabel(l: ChatLink): string {
  return l.ref ? `${l.ref} ${l.title}` : l.title;
}

/** True when this message mentions the person reading it (or the whole channel). */
export function mentionsMe(m: Pick<ChatMessage, "body" | "mentions" | "links">, meId: string | null | undefined): boolean {
  return segments(m, meId).some((s) => s.kind === "mention" && s.self);
}

/**
 * The composer shows "@Name" while typing. Before sending, each picked name becomes its markup,
 * and "@channel" becomes <!channel>. Longer names go first so "@Jo Tran" never eats "@Jo".
 */
export function encodeMentions(text: string, picked: Pick<ChatPerson, "id" | "name">[]): string {
  let out = text;
  const seen = new Set<string>();
  const list = [...picked].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((a, b) => b.name.length - a.name.length);
  for (const p of list) {
    const id = p.id.includes(":") ? p.id : `member:${p.id}`;
    out = out.split(`@${p.name}`).join(`<@${id}>`);
  }
  return out.replace(/(^|\s)@channel\b/g, "$1<!channel>");
}

/** The "@query" being typed at the end of the text, or null. Used to open the mention picker. */
export function mentionQuery(text: string): string | null {
  const hit = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(text);
  return hit ? hit[2] : null;
}

/** Puts a picked person in place of the "@query" at the end of the text. */
export function insertMention(text: string, name: string): string {
  return text.replace(/(^|\s)@([\p{L}\p{N}._-]{0,30})$/u, `$1@${name} `);
}

export function filterPeople(people: ChatPerson[], query: string, limit = 6): ChatPerson[] {
  const q = query.toLowerCase();
  return people.filter((p) => !q || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q) || p.email.toLowerCase().startsWith(q)).slice(0, limit);
}

/** Channels first (by name), then DMs (newest first). Archived channels are left out. */
export function groupChannels(list: ChatChannel[]): { channels: ChatChannel[]; dms: ChatChannel[] } {
  const live = list.filter((c) => !c.archived);
  return {
    channels: live.filter((c) => c.kind === "channel").sort((a, b) => a.name.localeCompare(b.name, "en-AU")),
    dms: live.filter((c) => c.kind === "dm").sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)),
  };
}

export function channelTitle(c: Pick<ChatChannel, "kind" | "name">): string {
  return c.kind === "dm" ? c.name : `#${c.name}`;
}

/** Merges polled messages into what is on screen: changed ones replace, new ones go at the end, oldest first. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (!incoming.length) return current;
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** The newest change time among these messages, for ?since= polling. */
export function latestChange(list: ChatMessage[]): string | null {
  let best: string | null = null;
  for (const m of list) {
    const t = m.updatedAt > m.createdAt ? m.updatedAt : m.createdAt;
    if (!best || t > best) best = t;
  }
  return best;
}

/** Message time: 2:05 pm today, otherwise the date and time. */
export function messageTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString(LOCALE, { day: "numeric", month: "short" })}, ${time}`;
}

/** The signed in member's chat id ("member:<userId>") from /account/me, when known. */
export function memberId(userId: string | null | undefined): string | null {
  return userId ? `member:${userId}` : null;
}
