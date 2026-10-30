import { ApiError } from "@/api/errors";
import { viewOf } from "@/lib/triage";
import { snoozeUntil, type SnoozePreset } from "@/lib/snooze";
import type { AppNotification, ChatAttachment, ChatChannel, ChatLink, ChatMention, ChatMessage, ChatPerson, Message, NotificationSettings } from "@/api/types";
import { taskRoute, type SampleWork } from "./tasks";

/**
 * Team chat and the notifications inbox for the sample workspace: two channels, one DM, a thread,
 * mentions of Mia (the sample person), a linked task and an attachment, plus a filled inbox. The
 * same paths and shapes as /api/chat and /api/notifications, kept on the phone.
 */
const ME = "usr_sample";
const PEOPLE: ChatPerson[] = [
  { id: "member:usr_sample", type: "member", name: "Mia Nguyen", email: "mia@harbourcoffee.com.au" },
  { id: "member:usr_josh", type: "member", name: "Josh Tran", email: "josh@harbourcoffee.com.au" },
  { id: "member:usr_priya", type: "member", name: "Priya Shah", email: "priya@harbourcoffee.com.au" },
  { id: "agent:agt_invoice", type: "agent", name: "Invoice chaser", email: "accounts-agent@harbourcoffee.com.au" },
  { id: "agent:agt_support", type: "agent", name: "Support triage", email: "support-agent@harbourcoffee.com.au" },
];
const member = (userId: string) => {
  const p = PEOPLE.find((x) => x.id === `member:${userId}`)!;
  return { id: p.id, name: p.name, email: p.email };
};

export interface SampleChat {
  channels: Omit<ChatChannel, "unread" | "mentions" | "lastMessageAt" | "lastMessage">[];
  messages: ChatMessage[];
  lastRead: Record<string, string>;
  notifications: AppNotification[];
  settings: NotificationSettings;
  seq: number;
}

function author(id: string) {
  const p = PEOPLE.find((x) => x.id.endsWith(`:${id}`))!;
  return { type: p.type, id, name: p.name };
}

/** Resolves the markup in a body to mentions and links, as the server does. */
function resolve(body: string, work: SampleWork, mail: Message[]): { mentions: ChatMention[]; links: ChatLink[] } {
  const mentions: ChatMention[] = [];
  const links: ChatLink[] = [];
  for (const hit of body.matchAll(/<@(member|agent):([^>\s]+)>|<!channel>|<#(task|thread|doc):([^>\s]+)>/g)) {
    if (hit[0] === "<!channel>") mentions.push({ type: "channel", id: "channel", name: "channel" });
    else if (hit[1]) {
      const p = PEOPLE.find((x) => x.id === `${hit[1]}:${hit[2]}`);
      if (p) mentions.push({ type: hit[1] as "member" | "agent", id: hit[2], name: p.name });
    } else if (hit[3] === "task") {
      const t = work.tasks.find((x) => x.id === hit[4]);
      if (t) links.push({ type: "task", id: t.id, ref: t.ref, title: t.title });
    } else if (hit[3] === "thread") {
      const m = mail.find((x) => x.threadId === hit[4] || x.id === hit[4]);
      if (m) links.push({ type: "thread", id: hit[4], ref: null, title: m.subject });
    }
  }
  return { mentions, links };
}

export function sampleChat(now: number, work: SampleWork, mail: Message[]): SampleChat {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const chase = work.tasks.find((t) => t.title.startsWith("Chase"))!;
  const order = work.tasks.find((t) => t.title.startsWith("Confirm Saturday"))!;
  const bas = work.tasks.find((t) => t.title.startsWith("Lodge"))!;
  const chat: SampleChat = {
    channels: [
      { id: "chn_general", kind: "channel", name: "general", topic: "Everything for the Harbour Coffee team", private: false, projectId: null, guestAccess: false, archived: false,
        members: ["usr_sample", "usr_josh", "usr_priya"].map(member), createdAt: ago(60 * 24 * 30), joined: true },
      { id: "chn_markets", kind: "channel", name: "markets", topic: "Saturday stalls and wholesale", private: false, projectId: null, guestAccess: false, archived: false,
        members: ["usr_sample", "usr_josh"].map(member), createdAt: ago(60 * 24 * 20), joined: true },
      { id: "dm_josh", kind: "dm", name: "Josh Tran", topic: null, private: true, projectId: null, guestAccess: false, archived: false,
        members: ["usr_sample", "usr_josh"].map(member), createdAt: ago(60 * 24 * 10), joined: true },
    ],
    messages: [],
    lastRead: { chn_general: ago(70), chn_markets: ago(1), dm_josh: ago(60 * 24 * 11) },
    notifications: [],
    settings: {
      mention: { inApp: true, push: true }, assignment: { inApp: true, push: true }, comment: { inApp: true, push: false },
      approval: { inApp: true, push: true }, due_soon: { inApp: true, push: true }, chat: { inApp: true, push: true },
      email: { inApp: false, push: false }, status: { inApp: true, push: false },
    },
    seq: 0,
  };
  const add = (channelId: string, who: string, body: string, minutesAgo: number, extra: Partial<ChatMessage> = {}) => {
    const at = ago(minutesAgo);
    const m: ChatMessage = {
      id: `cmsg_${++chat.seq}`, channelId, parentId: null, author: author(who), body, ...resolve(body, work, mail), attachments: [],
      replyCount: 0, lastReplyAt: null, editedAt: null, deleted: false, createdAt: at, updatedAt: at, ...extra,
    };
    chat.messages.push(m);
    if (m.parentId) {
      const p = chat.messages.find((x) => x.id === m.parentId)!;
      p.replyCount += 1; p.lastReplyAt = at; p.updatedAt = at;
    }
    return m;
  };
  add("chn_general", "usr_josh", "Morning all. The roaster is booked for Thursday, so get any blend changes to me by Wednesday.", 95);
  const ask = add("chn_general", "usr_priya", `<@member:${ME}> can you look at the Green Roof Cafe invoice? <#task:${chase.id}> is still open.`, 62);
  add("chn_general", ME, `On it. Li says the remittance came in this morning: <#thread:${mail.find((x) => x.id === "msg_3")!.threadId}>`, 57, { parentId: ask.id });
  add("chn_general", "agt_invoice", "Payment matched against the bank feed. I'll mark INV-1042 paid once Mia confirms.", 52, { parentId: ask.id });
  add("chn_general", ME, "<!channel> the stall roster for Saturday is on the board. Swap shifts in #markets.", 21);
  const slip: ChatAttachment = { id: "cfile_1", filename: "packing-slip-bondi.pdf", contentType: "application/pdf", size: 48_200 };
  const ready = add("chn_general", "usr_josh", `<@member:${ME}> 12 kg house blend is packed for Bondi Bakehouse. Slip attached. <#task:${order.id}>`, 8, { attachments: [slip] });
  add("chn_markets", "usr_josh", "Marrickville stall needs a second grinder this week.", 60 * 26);
  add("chn_markets", ME, "I'll bring the spare from the kiosk.", 60 * 25);
  const dm = add("dm_josh", "usr_josh", "Can you cover the Marrickville stall from 7 on Saturday?", 14);

  const n = (id: string, category: string, type: string, entityType: string, entityId: string, title: string, actor: string | null, minutesAgo: number, read: boolean, link: string): AppNotification =>
    ({ id, category, type, entityType, entityId, title, actor: actor ? { type: actor.startsWith("agt_") ? "agent" : "member", id: actor, name: author(actor).name } : null, read, createdAt: ago(minutesAgo), link });
  chat.notifications = [
    n("ntf_1", "mention", "chat.mention", "chat_message", ready.id, "Josh Tran mentioned you in #general", "usr_josh", 8, false, `/app/chat/chn_general?m=${ready.id}`),
    n("ntf_2", "chat", "chat.dm", "chat_message", dm.id, "Josh Tran sent you a message", "usr_josh", 14, false, `/app/chat/dm_josh?m=${dm.id}`),
    n("ntf_3", "approval", "approval.requested", "approval", "apr_1", "Invoice chaser wants to send \"Invoice INV-1051 is 14 days overdue\"", "agt_invoice", 30, false, "/app/approvals"),
    n("ntf_4", "mention", "chat.mention", "chat_message", ask.id, "Priya Shah mentioned you in #general", "usr_priya", 62, false, `/app/chat/chn_general?m=${ask.id}`),
    n("ntf_5", "assignment", "task.assigned", "task", bas.id, `${bas.ref} ${bas.title} was assigned to you`, "usr_josh", 50, true, `/app/tasks?task=${bas.id}`),
    n("ntf_6", "comment", "task.commented", "task", chase.id, `Mia Nguyen commented on ${chase.ref}`, null, 70, true, `/app/tasks?task=${chase.id}`),
    n("ntf_7", "due_soon", "task.due_soon", "task", order.id, `${order.ref} ${order.title} is due tomorrow`, null, 120, true, `/app/tasks?task=${order.id}`),
  ];
  return chat;
}

function unreadOf(chat: SampleChat, channelId: string) {
  const since = chat.lastRead[channelId] ?? "";
  const fresh = chat.messages.filter((m) => m.channelId === channelId && !m.parentId && m.author.id !== ME && m.createdAt > since);
  return {
    unread: fresh.length,
    mentions: fresh.filter((m) => m.mentions.some((x) => x.type === "channel" || (x.type === "member" && x.id === ME))).length,
  };
}

function present(chat: SampleChat, c: SampleChat["channels"][number]): ChatChannel {
  const top = chat.messages.filter((m) => m.channelId === c.id && !m.parentId);
  const last = top[top.length - 1];
  const preview = last ? last.body.replace(/<@(member|agent):([^>]+)>/g, (_s, t: string, id: string) => `@${PEOPLE.find((p) => p.id === `${t}:${id}`)?.name ?? "someone"}`).replace(/<!channel>/g, "@channel").replace(/<#(task|thread|doc):[^>]+>/g, (_s, t: string) => `[${t}]`) : "";
  return { ...c, ...unreadOf(chat, c.id), lastMessageAt: last?.createdAt ?? null, lastMessage: last ? { id: last.id, preview: preview.slice(0, 120), authorName: last.author.name } : null };
}

function channelOf(chat: SampleChat, id: string) {
  const c = chat.channels.find((x) => x.id === id);
  if (!c) throw new ApiError(404, "not_found", "Channel not found.");
  return c;
}

function messageOf(chat: SampleChat, id: string) {
  const m = chat.messages.find((x) => x.id === id);
  if (!m) throw new ApiError(404, "not_found", "Message not found.");
  return m;
}

function counts(chat: SampleChat) {
  const out: Record<string, number> = {};
  for (const x of chat.notifications) if (!x.read && x.category) out[x.category] = (out[x.category] ?? 0) + 1;
  return out;
}

/** Answers /chat and /notifications. Returns undefined for any other path. */
export function chatRoute(chat: SampleChat, work: SampleWork, mail: Message[], method: string, parts: string[], params: Record<string, string>, body: unknown): unknown {
  const [root, a, b, c] = parts;
  const input = (body ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();

  if (root === "notifications") {
    if (method === "GET" && a === "settings") return { settings: chat.settings };
    if (method === "PUT" && a === "settings") {
      const patch = (input.settings ?? {}) as Record<string, { inApp?: boolean; push?: boolean }>;
      for (const [k, v] of Object.entries(patch)) chat.settings[k] = { ...(chat.settings[k] ?? { inApp: true, push: true }), ...v };
      return { settings: chat.settings };
    }
    if (method === "GET" && !a) {
      let list = [...chat.notifications].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
      // R31 triage: the same views as the server (Inbox, Later, Done) with their counts.
      const nowMs = Date.now();
      const viewCounts = { inbox: 0, later: 0, done: 0 };
      for (const x of chat.notifications) viewCounts[viewOf(x, nowMs)]++;
      const view = params.view === "later" || params.view === "done" || params.view === "inbox" ? params.view : null;
      if (view) list = list.filter((x) => viewOf(x, nowMs) === view);
      if (params.category) list = list.filter((x) => x.category === params.category);
      if (params.unread === "1") list = list.filter((x) => !x.read && viewOf(x, nowMs) === "inbox");
      const limit = Number(params.limit) || 50;
      const unread = chat.notifications.filter((x) => !x.read && viewOf(x, nowMs) === "inbox").length;
      return { notifications: list.slice(0, limit), unread, counts: counts(chat), hasMore: list.length > limit, viewCounts };
    }
    if (method === "POST" && a === "done" && !b) {
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
      let updated = 0;
      for (const x of chat.notifications) if (ids.includes(x.id) && !x.doneAt) { x.doneAt = now; x.snoozedUntil = null; x.read = true; updated++; }
      return { ok: true, updated };
    }
    if (method === "POST" && a && (b === "done" || b === "undone" || b === "snooze")) {
      const x = chat.notifications.find((y) => y.id === a);
      if (!x) throw new ApiError(404, "not_found", "Notification not found.");
      if (b === "done") { x.doneAt = now; x.snoozedUntil = null; x.read = true; }
      else if (b === "undone") { x.doneAt = null; x.snoozedUntil = null; }
      else {
        const until = typeof input.until === "string" ? input.until
          : snoozeUntil((input.preset as SnoozePreset) ?? "tomorrow").toISOString();
        if (!(Date.parse(until) > Date.now())) throw new ApiError(422, "bad_time", "Pick a time in the future.");
        x.snoozedUntil = until; x.doneAt = null; x.read = true;
      }
      return { ok: true };
    }
    if (method === "POST" && a === "read") {
      const ids = Array.isArray(input.ids) ? (input.ids as string[]) : null;
      const category = typeof input.category === "string" ? input.category : null;
      let updated = 0;
      for (const x of chat.notifications) {
        if (x.read) continue;
        if (ids ? ids.includes(x.id) : category ? x.category === category : true) { x.read = true; updated++; }
      }
      return { ok: true, updated };
    }
    if (method === "POST" && a && b === "unread") {
      const x = chat.notifications.find((y) => y.id === a);
      if (!x) throw new ApiError(404, "not_found", "Notification not found.");
      x.read = false;
      return { ok: true };
    }
    return undefined;
  }

  if (root !== "chat") return undefined;
  if (method === "GET" && a === "channels" && !b) return { channels: chat.channels.map((x) => present(chat, x)) };
  if (method === "GET" && a === "people") return { people: PEOPLE.filter((p) => p.id !== `member:${ME}`) };
  if (method === "GET" && a === "unread") {
    const per: Record<string, { unread: number; mentions: number }> = {};
    for (const x of chat.channels) per[x.id] = unreadOf(chat, x.id);
    const all = Object.values(per);
    return { total: all.reduce((s, x) => s + x.unread, 0), mentions: all.reduce((s, x) => s + x.mentions, 0), channels: per };
  }
  if (method === "POST" && a === "dms") {
    const ids = [...new Set([...((input.userIds as string[]) ?? []), ME])].sort();
    if (ids.length < 2) throw new ApiError(422, "validation_error", "Pick at least one person.");
    const found = chat.channels.find((x) => x.kind === "dm" && x.members.map((m) => m.id.split(":")[1]).sort().join() === ids.join());
    if (found) return { channel: present(chat, found) };
    const members = ids.map((id) => { const p = PEOPLE.find((x) => x.id === `member:${id}`); if (!p) throw new ApiError(422, "bad_member", "That person isn't in this workspace."); return { id: p.id, name: p.name, email: p.email }; });
    const ch = { id: `dm_s${++chat.seq}`, kind: "dm" as const, name: members.filter((m) => m.id !== `member:${ME}`).map((m) => m.name).join(", "), topic: null, private: true, projectId: null, guestAccess: false, archived: false, members, createdAt: now, joined: true };
    chat.channels.push(ch);
    return { channel: present(chat, ch) };
  }
  if (a === "channels" && b) {
    const ch = channelOf(chat, b);
    if (method === "GET" && !c) return { channel: present(chat, ch) };
    if (method === "POST" && c === "join") { ch.joined = true; return { channel: present(chat, ch) }; }
    if (method === "POST" && c === "read") { chat.lastRead[ch.id] = now; return { ok: true }; }
    if (method === "GET" && c === "messages") {
      let list = chat.messages.filter((m) => m.channelId === ch.id && !m.parentId);
      if (params.since) return { messages: list.filter((m) => m.createdAt > params.since || m.updatedAt > params.since), hasMore: false };
      if (params.before) { const at = list.findIndex((m) => m.id === params.before); list = at >= 0 ? list.slice(0, at) : list; }
      const limit = Number(params.limit) || 50;
      return { messages: list.slice(-limit), hasMore: list.length > limit };
    }
    if (method === "POST" && c === "messages") {
      const text = String(input.body ?? "").trim();
      const files = Array.isArray(input.attachments) ? (input.attachments as { filename: string; contentType?: string; contentBase64: string }[]) : [];
      if (!text && !files.length) throw new ApiError(422, "validation_error", "Write a message first.");
      const parentId = typeof input.parentId === "string" ? input.parentId : null;
      if (parentId) messageOf(chat, parentId);
      const m: ChatMessage = {
        id: `cmsg_${++chat.seq}`, channelId: ch.id, parentId, author: author(ME), body: text, ...resolve(text, work, mail),
        attachments: files.map((f, i) => ({ id: `cfile_s${chat.seq}_${i}`, filename: f.filename, contentType: f.contentType ?? "application/octet-stream", size: Math.floor((f.contentBase64.length * 3) / 4) })),
        replyCount: 0, lastReplyAt: null, editedAt: null, deleted: false, createdAt: now, updatedAt: now,
      };
      chat.messages.push(m);
      if (parentId) { const p = messageOf(chat, parentId); p.replyCount += 1; p.lastReplyAt = now; p.updatedAt = now; }
      chat.lastRead[ch.id] = now;
      return { message: m };
    }
  }
  if (a === "messages" && b) {
    const m = messageOf(chat, b);
    if (method === "GET" && !c) return { message: m, channel: present(chat, channelOf(chat, m.channelId)) };
    if (method === "GET" && c === "thread") return { message: m, replies: chat.messages.filter((x) => x.parentId === m.id) };
    if (method === "POST" && c === "task") {
      const ch = channelOf(chat, m.channelId);
      const words = m.body.replace(/<[@#!][^>]*>/g, "").replace(/\s+/g, " ").trim();
      const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : words.slice(0, 80) || "Task from chat";
      const made = taskRoute(work, mail, "POST", ["tasks"], {}, { title, notes: `From ${ch.kind === "dm" ? ch.name : `#${ch.name}`}, ${m.author.name}: ${words}` }) as { task: { id: string } };
      return made;
    }
  }
  return undefined;
}

/** R35: a sample person's name by user id, for the blocked people list. */
export function samplePersonName(userId: string): string | undefined {
  return PEOPLE.find((p) => p.id.endsWith(`:${userId}`))?.name;
}
