import { ApiError } from "@/api/errors";
import type { Message } from "@/api/types";
import { describeConditions, type MailRule, type MailRuleRun, type RuleCondition, type RuleInput, type TabStyle } from "@/lib/mail-rules";

/**
 * 1.10.7: Inbox tabs, labels, snoozed mail and mail rules in the sample workspace, with the same shapes the server
 * answers (R85), so the browser preview, tests and screenshots work with no server.
 */
export interface SampleMailExtras {
  style: TabStyle;
  pins: { s: Record<string, string>; t: Record<string, string> };
  labels: Record<string, string[]>;
  rules: MailRule[];
  runs: Record<string, MailRuleRun[]>;
  snoozes: { id: string; messageId: string; threadId: string; mailboxId: string; dueAt: string; status: "pending" | "returned" }[];
  seq: number;
}

const BUILT_IN: Record<Exclude<TabStyle, "off">, { id: string; name: string }[]> = {
  classic: [{ id: "important", name: "Important" }, { id: "other", name: "Other" }],
  categories: [{ id: "primary", name: "Primary" }, { id: "updates", name: "Updates" }, { id: "promotions", name: "Promotions" }],
};
const ROBOT = /^(noreply|no-reply|notifications?|bookings|team|news|newsletter|marketing|offers|hello|deals)/i;
const PROMO = /(% off|sale|offer|deal|newsletter|webinar|discount)/i;

/** The tab a sample message sits in, pins first (the same order as the server). */
export function sampleTabOf(s: SampleMailExtras, m: Pick<Message, "threadId" | "from" | "subject">): string {
  const pinned = s.pins.t[m.threadId] ?? s.pins.s[m.from.address.toLowerCase()];
  const ids = s.style === "off" ? [] : BUILT_IN[s.style].map((t) => t.id);
  if (pinned && ids.includes(pinned)) return pinned;
  const robot = ROBOT.test(m.from.address.split("@")[0] ?? "");
  if (s.style === "classic") return robot ? "other" : "important";
  if (!robot) return "primary";
  return PROMO.test(m.subject) ? "promotions" : "updates";
}

export function sampleMailExtras(now: number, messages: Message[]): SampleMailExtras {
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const at = (days: number, hour: number) => { const d = new Date(now + days * 86_400_000); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
  // Two more inbox mails so every tab has something in it.
  if (!messages.some((m) => m.id === "msg_p1")) {
    const base = messages[0];
    messages.push(
      { ...base, id: "msg_p1", threadId: "thr_p1", from: { address: "offers@beanmarket.com.au", name: "Bean Market" }, subject: "20% off green beans this week", isRead: false, isStarred: false, hasAttachments: false, attachments: [], date: ago(60 * 5),
        text: "This week only: 20% off every green bean from Colombia and Ethiopia. Shop now at https://beanmarket.com.au/offers/green-beans-october", snippet: "This week only: 20% off every green bean from Colombia and Ethiopia." },
      { ...base, id: "msg_p2", threadId: "thr_p2", from: { address: "notifications@squareup.com.au", name: "Square" }, subject: "Your payout of A$2,140.60 is on its way", isRead: false, isStarred: false, hasAttachments: false, attachments: [], date: ago(60 * 9),
        text: "Your payout of A$2,140.60 for 30 October will reach your bank account ending 4021 within 1 business day.", snippet: "Your payout of A$2,140.60 for 30 October will reach your bank account ending 4021 within 1 business day." },
      { ...base, id: "msg_s1", threadId: "thr_s1", folder: "archive", from: { address: "anna@cupsandsaucers.com.au", name: "Anna Rossi" }, subject: "Cup samples for the new kiosk", isRead: true, date: ago(60 * 30),
        text: "Hi Mia, the cup samples ship Monday. Let me know which size you like.", snippet: "Hi Mia, the cup samples ship Monday. Let me know which size you like." },
    );
  }
  const rule = (r: Partial<MailRule> & Pick<MailRule, "id" | "name" | "conditions" | "actions">): MailRule => ({
    mailboxId: "mbx_mia", match: "all", enabled: true, position: 0, runCount: 0, lastRunAt: null, lastError: null, createdAt: ago(60 * 24 * 6), updatedAt: ago(60 * 24 * 6), ...r,
  });
  return {
    style: "categories",
    pins: { s: {}, t: {} },
    labels: { thr_3: ["Invoices"], thr_4: ["Kiosk"] },
    rules: [
      rule({ id: "mrl_s1", name: "Invoices", position: 0, runCount: 12, lastRunAt: ago(80), conditions: [{ field: "subject", value: "invoice" }], actions: [{ kind: "label", label: "Invoices" }, { kind: "star" }] }),
      rule({ id: "mrl_s2", name: "Market bookings to Sam", position: 1, runCount: 3, lastRunAt: ago(60 * 30), conditions: [{ field: "domain", value: "marrickvillemarkets.org.au" }], actions: [{ kind: "forward", to: "sam@harbourcoffee.com.au" }, { kind: "archive" }] }),
      rule({ id: "mrl_s3", name: "Offers to Promotions", position: 2, enabled: false, runCount: 0, conditions: [{ field: "subject", value: "% off" }, { field: "from", value: "offers" }], match: "any", actions: [{ kind: "move_to_tab", tab: "promotions" }, { kind: "mark_read" }] }),
    ],
    runs: {
      mrl_s1: [
        { id: "mrr_1", messageId: "msg_3", from: "li.chen@greenroofcafe.com.au", subject: "Re: Invoice INV-1042 overdue", status: "ok", steps: [{ action: "label", ok: true }, { action: "star", ok: true }], createdAt: ago(80) },
        { id: "mrr_2", messageId: null, from: "accounts@coastalcatering.com.au", subject: "Invoice INV-1047", status: "partial", steps: [{ action: "label", ok: true }, { action: "star", ok: false, detail: "the mail was deleted first" }], createdAt: ago(60 * 26) },
      ],
      mrl_s2: [{ id: "mrr_3", messageId: "msg_6", from: "bookings@marrickvillemarkets.org.au", subject: "Stall confirmed for Sunday 1 November", status: "ok", steps: [{ action: "forward", ok: true }, { action: "archive", ok: true }], createdAt: ago(60 * 30) }],
    },
    snoozes: [
      { id: "msc_s1", messageId: "msg_s1", threadId: "thr_s1", mailboxId: "mbx_mia", dueAt: at(1, 8), status: "pending" },
      { id: "msc_s2", messageId: "msg_6", threadId: "thr_6", mailboxId: "mbx_mia", dueAt: ago(60 * 2), status: "returned" },
    ],
    seq: 10,
  };
}

const summary = ({ text: _t, cc: _c, bcc: _b, html: _h, attachments: _a, replyTo: _r, ...rest }: Message) => rest;

/** Narrows a sample mail list by Inbox tab and label, and puts each thread's labels on its rows. */
export function sampleListExtras(s: SampleMailExtras, list: Message[], params: Record<string, string>): Message[] {
  let out = list;
  if (params.folder === "inbox" && !params.q) {
    const hidden = new Set(s.snoozes.filter((z) => z.status === "pending").map((z) => z.threadId));
    out = out.filter((m) => !hidden.has(m.threadId));
    if (params.split && s.style !== "off") out = out.filter((m) => sampleTabOf(s, m) === params.split);
  }
  if (params.label) out = out.filter((m) => (s.labels[m.threadId] ?? []).some((l) => l.toLowerCase() === params.label.toLowerCase()));
  return out.map((m) => (s.labels[m.threadId]?.length ? { ...m, labels: [...s.labels[m.threadId]] } : m));
}

/** Records a snooze (the transport's POST /mail-schedules/snooze). */
export function sampleSnooze(s: SampleMailExtras, m: Message, dueAt: string) {
  s.snoozes = s.snoozes.filter((z) => z.threadId !== m.threadId);
  s.snoozes.push({ id: `msc_s${++s.seq}`, messageId: m.id, threadId: m.threadId, mailboxId: m.mailboxId, dueAt, status: "pending" });
}

function matches(conds: RuleCondition[], match: "all" | "any", m: Message): boolean {
  const test = (c: RuleCondition) => {
    const v = c.value.trim().toLowerCase();
    switch (c.field) {
      case "from": return `${m.from.address} ${m.from.name ?? ""}`.toLowerCase().includes(v);
      case "to": return m.to.some((a) => a.address.toLowerCase().includes(v));
      case "subject": return m.subject.toLowerCase().includes(v);
      case "domain": { const host = m.from.address.toLowerCase().split("@")[1] ?? ""; const d = v.replace(/^@+/, ""); return host === d || host.endsWith(`.${d}`); }
      case "hasAttachment": return m.hasAttachments;
    }
  };
  return match === "any" ? conds.some(test) : conds.every(test);
}

/** The sample answers for tabs, labels, snoozed and rules. Undefined for any other path. */
export function mailExtrasRoute(s: SampleMailExtras, messages: Message[], method: string, path: string, params: Record<string, string>, body: unknown, now = Date.now()): unknown {
  const parts = path.split("/").filter(Boolean);
  const tabsFor = (mailboxId?: string) => (s.style === "off" ? [] : BUILT_IN[s.style].map((t) => ({
    ...t, builtIn: true,
    unread: messages.filter((m) => m.folder === "inbox" && !m.isRead && (!mailboxId || m.mailboxId === mailboxId)
      && !s.snoozes.some((z) => z.status === "pending" && z.threadId === m.threadId) && sampleTabOf(s, m) === t.id).length,
  })));
  const settings = () => ({ style: s.style, chosen: true, defaultTab: s.style === "off" ? "" : BUILT_IN[s.style][0].id, senders: Object.entries(s.pins.s).map(([address, tab]) => ({ address, tab })) });

  if (path === "/mail/splits" && method === "GET") { const tabs = tabsFor(params.mailboxId); return { splits: [], tabs, style: s.style, defaultTab: tabs[0]?.id ?? "" }; }
  if (path === "/mail/splits/settings" && method === "GET") return settings();
  if (path === "/mail/splits/style" && method === "PUT") { s.style = ((body ?? {}) as { style: TabStyle }).style; return settings(); }
  if (path === "/mail/splits/teach" && method === "POST") {
    const b = (body ?? {}) as { messageId: string; tab: string; sender?: boolean };
    const m = messages.find((x) => x.id === b.messageId);
    if (!m) throw new ApiError(404, "not_found", "Message not found.");
    const sender = m.from.address.toLowerCase();
    const previous = { thread: s.pins.t[m.threadId] ?? null, sender: b.sender === false ? undefined : s.pins.s[sender] ?? null };
    s.pins.t[m.threadId] = b.tab;
    if (b.sender !== false) s.pins.s[sender] = b.tab;
    return { tab: b.tab, threadId: m.threadId, sender: b.sender === false ? null : sender, previous };
  }
  if (path === "/mail/splits/pins/restore" && method === "POST") {
    const b = (body ?? {}) as { threadId?: string; thread?: string | null; sender?: string; senderTab?: string | null };
    if (b.threadId) { if (b.thread) s.pins.t[b.threadId] = b.thread; else delete s.pins.t[b.threadId]; }
    if (b.sender) { const k = b.sender.toLowerCase(); if (b.senderTab) s.pins.s[k] = b.senderTab; else delete s.pins.s[k]; }
    return settings();
  }

  if (path === "/mail/labels") {
    if (method === "GET") {
      const n = new Map<string, number>();
      for (const ls of Object.values(s.labels)) for (const l of ls) n.set(l, (n.get(l) ?? 0) + 1);
      return { labels: [...n].map(([label, threads]) => ({ label, threads })).sort((a, b) => a.label.localeCompare(b.label)) };
    }
    const b = (method === "DELETE" ? params : body ?? {}) as { threadId: string; label: string };
    const cur = s.labels[b.threadId] ?? [];
    s.labels[b.threadId] = method === "POST" ? (cur.some((l) => l.toLowerCase() === b.label.toLowerCase()) ? cur : [...cur, b.label.trim()]) : cur.filter((l) => l.toLowerCase() !== b.label.toLowerCase());
    return { labels: s.labels[b.threadId] };
  }

  if (path === "/mail-schedules" && method === "GET") {
    const view = params.view === "returned" ? "returned" : params.view === "snoozed" ? "pending" : null;
    if (!view) return { items: [] };
    const items = s.snoozes.filter((z) => z.status === view && (!params.mailboxId || z.mailboxId === params.mailboxId))
      .sort((a, b) => (view === "pending" ? a.dueAt.localeCompare(b.dueAt) : b.dueAt.localeCompare(a.dueAt)))
      .map((z) => { const m = messages.find((x) => x.id === z.messageId); return { id: z.id, kind: "snooze", status: z.status, mailboxId: z.mailboxId, threadId: z.threadId, messageId: z.messageId, dueAt: z.dueAt, createdAt: z.dueAt, error: null, message: m ? summary(m) : null, send: null }; });
    return { items };
  }
  if (parts[0] === "mail-schedules" && parts.length === 2 && method === "DELETE") {
    const z = s.snoozes.find((x) => x.id === parts[1]);
    if (!z) throw new ApiError(404, "not_found", "Not found.");
    s.snoozes = s.snoozes.filter((x) => x !== z);
    messages.filter((m) => m.threadId === z.threadId && m.folder === "archive").forEach((m) => { m.folder = "inbox"; });
    return { ok: true };
  }

  if (parts[0] === "mail" && parts[1] === "rules") {
    const id = parts[2];
    const find = () => { const r = s.rules.find((x) => x.id === id); if (!r) throw new ApiError(404, "not_found", "Rule not found."); return r; };
    if (!id && method === "GET") return { rules: [...s.rules].sort((a, b) => a.position - b.position) };
    if (!id && method === "POST") {
      const b = body as RuleInput;
      if (!b?.name?.trim()) throw new ApiError(400, "bad_request", "Name the rule.");
      const r: MailRule = { id: `mrl_s${++s.seq}`, name: b.name.trim(), mailboxId: b.mailboxId, match: b.match ?? "all", conditions: b.conditions, actions: b.actions, enabled: b.enabled ?? true, position: s.rules.length, runCount: 0, lastRunAt: null, lastError: null, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
      s.rules.push(r);
      return { rule: r };
    }
    if (id === "test" && method === "POST") {
      const b = body as { mailboxId: string; match: "all" | "any"; conditions: RuleCondition[] };
      const recent = messages.filter((m) => m.folder === "inbox" && (!b.mailboxId || m.mailboxId === b.mailboxId));
      const hits = recent.filter((m) => matches(b.conditions, b.match ?? "all", m));
      return { scanned: recent.length, matched: hits.length, sample: hits.slice(0, 10).map((m) => ({ id: m.id, from: m.from.name || m.from.address, subject: m.subject, snippet: m.snippet.slice(0, 140), date: m.date })) };
    }
    if (parts[3] === "runs" && method === "GET") { find(); return { runs: s.runs[id] ?? [] }; }
    if (parts[3] === "run-recent" && method === "POST") {
      const r = find();
      const hits = messages.filter((m) => m.folder === "inbox" && m.mailboxId === r.mailboxId && matches(r.conditions, r.match, m));
      for (const m of hits) {
        for (const a of r.actions) if (a.kind === "label") s.labels[m.threadId] = [...new Set([...(s.labels[m.threadId] ?? []), a.label])];
        (s.runs[r.id] ??= []).unshift({ id: `mrr_${++s.seq}`, messageId: m.id, from: m.from.address, subject: m.subject, status: "ok", steps: r.actions.map((a) => ({ action: a.kind, ok: true })), createdAt: new Date(now).toISOString() });
      }
      r.runCount += hits.length;
      if (hits.length) r.lastRunAt = new Date(now).toISOString();
      return { ran: hits.length, matched: hits.length };
    }
    if (method === "GET") return { rule: find() };
    if (method === "PATCH") { const r = find(); Object.assign(r, body as object, { updatedAt: new Date(now).toISOString() }); return { rule: r }; }
    if (method === "DELETE") { find(); s.rules = s.rules.filter((x) => x.id !== id); return { deleted: true }; }
  }
  return undefined;
}

export { describeConditions };
