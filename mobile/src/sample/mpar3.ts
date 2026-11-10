/**
 * MPAR3: the sample workspace's answers for Calendar, meeting notes and transcripts, saved replies, send later, secret
 * links, connected mailbox folders, bulk select and the shared inbox. Same paths and shapes as the web API.
 */
import type { Meeting, Message, Task } from "@/api/types";
import type {
  CalendarEvent, CalendarFeed, CalendarSource, MeetingNotes, MeetingRecording, OneItem, ProviderFolders, Snippet, ThreadComment, ThreadMember, ThreadState,
} from "@/lib/mpar3";
import { addDays, dayKey, startOfDay } from "@/lib/mpar3";
import { ApiError } from "@/api/errors";

export interface SampleMpar3 {
  sources: CalendarSource[]; feed: CalendarFeed; states: Record<string, ThreadState>; comments: ThreadComment[]; one: OneItem[];
  scheduled: number; secrets: number; seq: number; moved: Record<string, string>;
}
const ORIGIN = "https://multies.si";
export const SAMPLE_CONNECTION = "conn_hello";

export function sampleMpar3(now: number): SampleMpar3 {
  const t = (min: number) => new Date(now - min * 60_000).toISOString();
  return {
    sources: [
      { id: "cal_family", kind: "ics", name: "Family", color: "#AF52DE", enabled: true, createdAt: t(9000), connectionId: null, address: null, host: "calendar.google.com", calendars: [] },
      { id: "cal_holidays", kind: "ics", name: "Public holidays", color: "#34C759", enabled: true, createdAt: t(20000), connectionId: null, address: null, host: "calendars.icloud.com", calendars: [] },
    ],
    feed: { enabled: true, hint: "…7Kq2", includeTasks: true, createdAt: t(40000), resetAt: null },
    states: { thr_1: { threadId: "thr_1", status: "open", assignee: { id: "usr_sample", name: "Mia Nguyen" }, assignedAt: t(40), doneAt: null } },
    comments: [
      { id: "cmt_1", threadId: "thr_1", author: { type: "member", id: "usr_ben", name: "Ben Carter" }, body: "They paid the last two invoices late. Ask for payment before we bake the extra 4 kg.", mentions: [], editedAt: null, createdAt: t(35), canEdit: false, canDelete: true },
    ],
    one: [
      { kind: "mail", id: "msg_1", source: "mail", lane: "important", reason: "From someone you write to", remembered: false, title: "Wholesale order for Saturday markets", who: "Sam Patel", at: t(7), read: false, view: "inbox", snoozedUntil: null, link: "/app/mail?m=msg_1" },
      { kind: "ref", id: "chat_1", source: "mention", lane: "important", reason: "You were mentioned", remembered: false, title: "Can you check the kiosk power points before Friday?", who: "Ben Carter", at: t(25), read: false, view: "inbox", snoozedUntil: null, link: "/app/chat" },
      { kind: "ref", id: "task_1", source: "task", lane: "important", reason: "Assigned to you", remembered: false, title: "Order the new grinder", who: "Ben Carter", at: t(90), read: true, view: "inbox", snoozedUntil: null, link: "/app/tasks" },
      { kind: "mail", id: "msg_n1", source: "mail", lane: "noise", reason: "A newsletter", remembered: false, title: "This week at the roastery: five new single origins", who: "Bean Club", at: t(300), read: false, view: "inbox", snoozedUntil: null, link: "/app/mail" },
    ],
    scheduled: 0, secrets: 0, seq: 1, moved: {},
  };
}

const MEMBERS: ThreadMember[] = [
  { id: "usr_sample", name: "Mia Nguyen", email: "mia@harbourcoffee.com.au", agent: false },
  { id: "usr_ben", name: "Ben Carter", email: "ben@harbourcoffee.com.au", agent: false },
  { id: "usr_priya", name: "Priya Sharma", email: "priya@harbourcoffee.com.au", agent: false },
];

const SNIPPETS: Snippet[] = [
  { id: "snp_1", name: "Order received", subject: null, shortcut: "order", shared: true, body: "Thanks {first_name}, your order is in. We will have it ready for pick up on Saturday morning." },
  { id: "snp_2", name: "Invoice attached", subject: "Your invoice", shortcut: "inv", shared: true, body: "Hi {first_name}, your invoice is attached. Payment is due within 14 days. Thank you!" },
  { id: "snp_3", name: "Out of stock", subject: null, shortcut: null, shared: false, body: "Sorry {first_name}, that blend is sold out this week. The next roast is on Tuesday." },
];

const FOLDERS: ProviderFolders = {
  maxExtra: 10,
  folders: [
    { key: "archive", path: "Archive", name: "Archive", role: "archive", synced: true },
    { key: "f:Suppliers", path: "Suppliers", name: "Suppliers", role: null, synced: true },
    { key: "f:Wholesale", path: "Wholesale", name: "Wholesale", role: null, synced: true },
    { key: "f:Receipts/2026", path: "Receipts/2026", name: "Receipts 2026", role: null, synced: false },
  ],
};

function events(s: SampleMpar3, now: number, from: Date, to: Date, meetings: Meeting[], tasks: Task[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  const at = (days: number, h: number, m = 0) => { const d = addDays(startOfDay(new Date(now)), days); d.setHours(h, m, 0, 0); return d; };
  for (const m of meetings) {
    const start = s.moved[m.id] ?? m.startsAt;
    const end = new Date(Date.parse(start) + m.durationMin * 60_000).toISOString();
    out.push({ id: m.id, kind: "meeting", title: m.title, start, end, allDay: false, url: `${ORIGIN}/app/meetings/${m.id}`, sourceId: null, sourceName: null, color: null, readOnly: false });
  }
  out.push({ id: "mtg_s3", kind: "meeting", title: "Roastery tasting with suppliers", start: at(-2, 15).toISOString(), end: at(-2, 16).toISOString(), allDay: false, url: `${ORIGIN}/app/meetings/mtg_s3`, sourceId: null, sourceName: null, color: null, readOnly: false });
  for (const t of tasks) {
    if (!t.due || t.status === "done") continue;
    const day = t.due.slice(0, 10);
    out.push({ id: `task:${t.id}`, kind: "due", title: `Due: ${t.title} (${t.ref})`, start: day, end: dayKey(addDays(new Date(`${day}T00:00:00`), 1)), allDay: true, url: `${ORIGIN}/app/tasks/${t.id}`, sourceId: null, sourceName: null, color: null, readOnly: false });
  }
  const fam = s.sources.find((x) => x.id === "cal_family");
  if (fam?.enabled) {
    out.push({ id: "ext_1", kind: "external", title: "School pick up", start: at(0, 15, 15).toISOString(), end: at(0, 15, 45).toISOString(), allDay: false, url: null, sourceId: fam.id, sourceName: fam.name, color: fam.color, readOnly: true, location: "Bondi Public School" });
    out.push({ id: "ext_2", kind: "external", title: "Dinner at Nonna's", start: at(2, 18, 30).toISOString(), end: at(2, 21).toISOString(), allDay: false, url: null, sourceId: fam.id, sourceName: fam.name, color: fam.color, readOnly: true, location: null });
  }
  const hol = s.sources.find((x) => x.id === "cal_holidays");
  if (hol?.enabled) out.push({ id: "ext_3", kind: "external", title: "Melbourne Cup day", start: dayKey(at(5, 0)), end: dayKey(at(6, 0)), allDay: true, url: null, sourceId: hol.id, sourceName: hol.name, color: hol.color, readOnly: true });
  return out.filter((e) => { const a = e.allDay ? new Date(`${e.start}T00:00:00`) : new Date(e.start); return a < to && (e.allDay ? new Date(`${e.end}T00:00:00`) : new Date(e.end)) > from; })
    .sort((a, b) => a.start.localeCompare(b.start));
}

function notes(m: Meeting | undefined, id: string): MeetingNotes {
  const title = m?.title ?? "Roastery tasting with suppliers";
  const startsAt = m?.startsAt ?? new Date(Date.now() - 2 * 86_400_000).toISOString();
  return {
    meeting: { id, title, startsAt, endsAt: new Date(Date.parse(startsAt) + (m?.durationMin ?? 60) * 60_000).toISOString(), status: m ? "scheduled" : "ended", invitees: m?.invitees ?? ["sam@greenroofcafe.com.au"], joinUrl: `${ORIGIN}/app/meetings/${id}`, recurrence: null },
    timeZone: "Australia/Sydney",
    doc: { id: `doc_${id}`, title: `Notes: ${title}`, updatedAt: new Date(Date.now() - 3600_000).toISOString(), text: "" },
    agenda: ["Taste the three new single origins", "Wholesale prices for the markets", "Delivery days from December"],
    notes: ["The Ethiopian roast was the favourite; keep it light.", "Sam can deliver on Tuesdays and Fridays from December.", "Prices stay the same until the end of January."],
    actionItems: [
      { key: "a1", text: "Send Sam the December order", title: "Send Sam the December order", assignee: "Mia Nguyen", due: dayKey(addDays(new Date(), 3)), task: null },
      { key: "a2", text: "Update the wholesale price list", title: "Update the wholesale price list", assignee: "Ben Carter", due: null, task: { id: "tsk_s9", ref: "KIO-9", title: "Update the wholesale price list", done: false } },
    ],
    pending: 1,
    summary: "The team tasted three new coffees and picked the Ethiopian for the markets. Deliveries move to Tuesdays and Fridays from December and prices hold until January.",
    summaryActionItems: [{ text: "Send Sam the December order", assignee: "Mia", due: null }],
  };
}
function recordings(id: string): MeetingRecording[] {
  const startedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return [{
    id: `rec_${id}`, status: "done", stale: false, startedBy: { id: "usr_sample", name: "Mia Nguyen" }, startedAt, endedAt: new Date(Date.parse(startedAt) + 1520_000).toISOString(), durationSec: 1520,
    transcript: "[00:04] Mia: Thanks for coming in. Let's start with the three new coffees.\n\n[01:12] Sam: The Ethiopian is my pick. It is bright without being sour.\n\n[03:40] Ben: Agreed. Can we keep the price the same for the markets?\n\n[04:05] Sam: Until the end of January, yes. From December I can deliver on Tuesdays and Fridays.",
    truncated: false, summary: null, error: null,
  }];
}

/** Answers a path for these screens, or undefined when it is not one of them. */
export function mpar3Route(s: SampleMpar3, method: string, path: string, body: unknown, params: Record<string, string | undefined>, ctx: { now: number; meetings: Meeting[]; tasks: Task[]; messages: Message[] }): unknown {
  const b = (body ?? {}) as Record<string, unknown>;
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  // Calendar
  if (method === "GET" && path === "/calendar/events") {
    const from = new Date(params.from ?? new Date(ctx.now - 7 * 86_400_000).toISOString());
    const to = new Date(params.to ?? new Date(from.getTime() + 35 * 86_400_000).toISOString());
    return { from: from.toISOString(), to: to.toISOString(), timezone: "Australia/Sydney", events: events(s, ctx.now, from, to, ctx.meetings, ctx.tasks), errors: [] };
  }
  if (method === "GET" && path === "/calendar/sources") return { data: s.sources };
  if (method === "POST" && path === "/calendar/sources") {
    const url = String(b.url ?? "");
    if (!/^(https?|webcal):\/\//i.test(url)) throw new ApiError(422, "validation_failed", "Paste a calendar link that starts with https or webcal.");
    let host = "calendar"; try { host = new URL(url.replace(/^webcal:/i, "https:")).host; } catch { /* kept */ }
    const src: CalendarSource = { id: `cal_${++s.seq}`, kind: "ics", name: String(b.name ?? "") || host, color: "#FF9500", enabled: true, createdAt: new Date().toISOString(), connectionId: null, address: null, host, calendars: [] };
    s.sources.push(src);
    return { source: src };
  }
  if (parts[0] === "calendar" && parts[1] === "sources" && parts[2]) {
    const src = s.sources.find((x) => x.id === parts[2]);
    if (!src) throw new ApiError(404, "not_found", "Calendar not found");
    if (method === "PATCH") { if (typeof b.enabled === "boolean") src.enabled = b.enabled; if (typeof b.name === "string") src.name = b.name; return { source: src }; }
    if (method === "DELETE") { s.sources = s.sources.filter((x) => x !== src); return { ok: true }; }
  }
  if (path === "/calendar/feed") {
    if (method === "GET") return { feed: s.feed };
    if (method === "POST") { s.feed = { enabled: true, hint: "…9Zp4", includeTasks: b.includeTasks !== false, createdAt: s.feed.createdAt ?? new Date().toISOString(), resetAt: new Date().toISOString() }; return { feed: { ...s.feed, url: `${ORIGIN}/cal/sample9Zp4.ics`, webcalUrl: "webcal://multies.si/cal/sample9Zp4.ics" } }; }
    if (method === "PATCH") { s.feed = { ...s.feed, includeTasks: !!b.includeTasks }; return { feed: s.feed }; }
    if (method === "DELETE") { s.feed = { enabled: false, hint: null, includeTasks: true, createdAt: null, resetAt: null }; return { ok: true }; }
  }
  if (method === "PATCH" && parts[0] === "meetings" && parts.length === 2) {
    const m = ctx.meetings.find((x) => x.id === parts[1]);
    if (!m) throw new ApiError(404, "not_found", "Meeting not found");
    if (typeof b.startsAt === "string") { s.moved[m.id] = b.startsAt; m.startsAt = b.startsAt; m.endsAt = new Date(Date.parse(b.startsAt) + m.durationMin * 60_000).toISOString(); }
    if (typeof b.title === "string" && b.title.trim()) m.title = b.title.trim();
    return { meeting: m };
  }
  // Meeting notes and transcripts
  if (method === "GET" && parts[0] === "meeting-notes" && parts.length === 2) return notes(ctx.meetings.find((m) => m.id === parts[1]), parts[1]);
  if (method === "GET" && parts[0] === "meetings" && parts[2] === "recordings" && parts.length === 3) return { recordings: recordings(parts[1]), setup: { ready: true } };
  // Saved replies, send later, secret links
  // PRIV1b (P55): the same paths as the server (/api/mail/snippets).
  if (method === "GET" && path === "/mail/snippets") return { snippets: SNIPPETS };
  if (method === "POST" && parts[0] === "mail" && parts[1] === "snippets" && parts[3] === "render") {
    const sn = SNIPPETS.find((x) => x.id === parts[2]);
    if (!sn) throw new ApiError(404, "not_found", "Saved reply not found");
    const to = String(b.to ?? "");
    const first = to ? (to.split("@")[0].split(/[._-]/)[0] || "there") : "there";
    const name = first.charAt(0).toUpperCase() + first.slice(1);
    return { id: sn.id, subject: sn.subject ?? "", body: sn.body.replace(/\{first_name\}/g, name), variables: { first_name: name } };
  }
  if (method === "POST" && path === "/mail-schedules/send") {
    const m = (b.message ?? {}) as { to?: string[] };
    if (!m.to?.length) throw new ApiError(422, "validation_failed", "Add a recipient");
    s.scheduled += 1;
    return { ok: true, schedule: { id: `sch_${s.scheduled}`, kind: "send", at: new Date(ctx.now + 86_400_000).toISOString() } };
  }
  if (method === "POST" && path === "/tools/secrets") {
    if (typeof b.ciphertext !== "string" || !b.ciphertext) throw new ApiError(422, "validation_failed", "Nothing to lock");
    s.secrets += 1;
    return { secret: { id: `sec_${s.secrets}`, url: `${ORIGIN}/x/sample${s.secrets}` } };
  }
  // Connected mailbox folders and bulk select
  if (method === "GET" && parts[0] === "connections" && parts[2] === "folders") return FOLDERS;
  if (method === "POST" && path === "/mail/messages/bulk") {
    const ids = Array.isArray(b.ids) ? (b.ids as string[]) : [];
    const action = String(b.action ?? "");
    let n = 0;
    for (const m of ctx.messages) {
      if (!ids.includes(m.id)) continue;
      n += 1;
      if (action === "read") m.isRead = true;
      else if (action === "unread") m.isRead = false;
      else if (action === "star") m.isStarred = true;
      else if (action === "unstar") m.isStarred = false;
      else if (action === "archive" || action === "inbox" || action === "spam" || action === "trash") m.folder = action;
      else if (action === "move") m.folder = "archive";
    }
    return { ok: true, updated: n };
  }
  // Shared inbox: assign, status, comments, One inbox
  if (parts[0] === "threads" && parts.length >= 3) {
    const id = parts[1];
    if (!ctx.messages.some((m) => m.threadId === id)) throw new ApiError(404, "not_found", "Thread not found");
    const st = s.states[id] ?? { threadId: id, status: "open", assignee: null, assignedAt: null, doneAt: null };
    if (method === "GET" && parts[2] === "state") return { state: st, members: MEMBERS };
    if (method === "POST" && parts[2] === "assign") {
      const who = b.userId ? MEMBERS.find((x) => x.id === b.userId) : null;
      if (b.userId && !who) throw new ApiError(422, "validation_failed", "That person cannot open this mailbox.");
      s.states[id] = { ...st, assignee: who ? { id: who.id, name: who.name } : null, assignedAt: who ? new Date().toISOString() : null };
      return { state: s.states[id] };
    }
    if (method === "POST" && parts[2] === "status") {
      const v = String(b.status ?? "");
      if (!["open", "waiting", "done"].includes(v)) throw new ApiError(422, "validation_failed", "Pick open, waiting or done.");
      s.states[id] = { ...st, status: v as ThreadState["status"], doneAt: v === "done" ? new Date().toISOString() : null };
      return { state: s.states[id] };
    }
    if (parts[2] === "comments") {
      if (method === "GET") return { threadId: id, comments: s.comments.filter((c) => c.threadId === id), mentionable: MEMBERS };
      if (method === "POST") {
        const text = String(b.body ?? "").trim();
        if (!text) throw new ApiError(422, "validation_failed", "Write a note first.");
        const c: ThreadComment = { id: `cmt_${++s.seq}`, threadId: id, author: { type: "member", id: "usr_sample", name: "Mia Nguyen" }, body: text, mentions: [], editedAt: null, createdAt: new Date().toISOString(), canEdit: true, canDelete: true };
        s.comments.push(c);
        return { comment: c };
      }
      if (method === "DELETE" && parts[3]) { s.comments = s.comments.filter((c) => c.id !== parts[3]); return { ok: true }; }
    }
  }
  if (method === "GET" && path === "/one-inbox") {
    const lane = params.lane === "noise" ? "noise" : "important";
    const view = (["inbox", "later", "done"].includes(params.view ?? "") ? params.view : "inbox") as OneItem["view"];
    const inView = s.one.filter((i) => i.view === view);
    const count = (l: string, unread = false) => s.one.filter((i) => i.view === "inbox" && i.lane === l && (!unread || !i.read)).length;
    return { items: inView.filter((i) => i.lane === lane), counts: { important: count("important"), noise: count("noise"), importantUnread: count("important", true), noiseUnread: count("noise", true) }, sources: {}, lane, view, source: "all" };
  }
  if (method === "POST" && path === "/one-inbox/act") {
    const refs = Array.isArray(b.items) ? (b.items as { kind: string; id: string }[]) : [];
    const hit = (i: OneItem) => refs.some((r) => r.kind === i.kind && r.id === i.id);
    for (const i of s.one) {
      if (!hit(i)) continue;
      if (b.action === "done") i.view = "done";
      if (b.action === "undone") i.view = "inbox";
      if (b.action === "read") i.read = true;
      if (b.action === "unread") i.read = false;
      if (b.action === "snooze") { i.view = "later"; i.snoozedUntil = new Date(ctx.now + 86_400_000).toISOString(); }
    }
    return { ok: true };
  }
  return undefined;
}
