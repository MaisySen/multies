/**
 * R38 move your data: the plain file formats other apps read and write. Pure functions with no database
 * access, so the importer, the export and the tests share them.
 *   contacts: vCard 3.0 (and 2.1 or 4.0 on the way in), or a CSV with email, name, phone, title, company columns
 *   calendar: iCalendar (.ics) events in, one VEVENT per meeting out
 *   docs:     Markdown in (through markdownToDoc) and out (docToMarkdown below)
 *   mail:     mbox (the "From " separated format every desktop mail app imports)
 */
import Papa from "papaparse";
import { parseComponents, parseDuration, parseWhen } from "../suite/ics-parse";
import { foldLine, icsEscape, icsUtc } from "../suite/ics-write";

export class MoveFileError extends Error {}

// ------------------------------------------------------------------ contacts

export interface ContactIn { name: string; email: string; phone: string | null; title: string | null; company: string | null; notes: string }

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** QUAL1: no address is longer than 254 characters; the pattern backtracks quadratically on a huge value, so check length first. */
const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);
const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const vUnescape = (v: string) => v.replace(/\\([nN,;\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** Every card in a .vcf file. Cards without an email address are left out (a contact is keyed by email). */
export function parseVcards(text: string): { contacts: ContactIn[]; skipped: number } {
  const lines = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const contacts: ContactIn[] = [];
  let skipped = 0;
  let card: Record<string, string[]> | null = null;
  for (const raw of lines) {
    const i = raw.indexOf(":");
    if (i < 0) continue;
    const head = raw.slice(0, i).toUpperCase();
    const value = raw.slice(i + 1);
    const name = head.split(";")[0].replace(/^ITEM\d+\./, "");
    if (name === "BEGIN" && value.trim().toUpperCase() === "VCARD") { card = {}; continue; }
    if (name === "END" && card) {
      const email = clean(card.EMAIL?.[0]).toLowerCase();
      const n = (card.N?.[0] ?? "").split(";");
      const full = clean(card.FN?.[0]) || clean([n[1], n[2], n[0]].filter(Boolean).join(" "));
      if (email && isEmail(email)) {
        contacts.push({ name: vUnescape(full), email, phone: clean(card.TEL?.[0]) || null, title: clean(vUnescape(card.TITLE?.[0] ?? "")) || null,
          company: clean(vUnescape((card.ORG?.[0] ?? "").split(";")[0])) || null, notes: vUnescape(card.NOTE?.[0] ?? "").trim() });
      } else skipped++;
      card = null;
      continue;
    }
    if (card) (card[name] ??= []).push(value);
  }
  return { contacts, skipped };
}

/** A contacts CSV (the address book exports of the big mail apps, or any sheet with an email column). */
export function parseContactsCsv(text: string): { contacts: ContactIn[]; skipped: number } {
  const all = (Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: "greedy" }).data as string[][]).filter(Array.isArray);
  if (!all.length) throw new MoveFileError("This file is empty.");
  const h = all[0].map((x) => x.trim().toLowerCase());
  const find = (re: RegExp) => h.findIndex((x) => re.test(x));
  const email = find(/e-?mail/);
  if (email < 0) throw new MoveFileError("No email column found. Contacts need an email address.");
  const name = find(/^(name|full name|display name|contact name)$/), first = find(/^(first|given)( name)?$/), last = find(/^(last|family|sur)( ?name)?$/);
  const phone = find(/phone|mobile|tel/), title = find(/^(title|job title|position|role)$/), company = find(/company|organi[sz]ation|business/), notes = find(/^notes?$/);
  const at = (r: string[], i: number) => (i >= 0 ? clean(r[i]) : "");
  const contacts: ContactIn[] = [];
  let skipped = 0;
  for (const r of all.slice(1)) {
    const e = at(r, email).toLowerCase();
    if (!e || !isEmail(e)) { skipped++; continue; }
    contacts.push({ name: at(r, name) || [at(r, first), at(r, last)].filter(Boolean).join(" "), email: e, phone: at(r, phone) || null,
      title: at(r, title) || null, company: at(r, company) || null, notes: notes >= 0 ? (r[notes] ?? "").trim() : "" });
  }
  return { contacts, skipped };
}

export function readContacts(text: string): { contacts: ContactIn[]; skipped: number } {
  const body = text.replace(/^\uFEFF/, "");
  const out = /BEGIN:VCARD/i.test(body) ? parseVcards(body) : parseContactsCsv(body);
  // One row per email: the first card wins.
  const seen = new Set<string>();
  const contacts = out.contacts.filter((c) => !seen.has(c.email) && !!seen.add(c.email));
  return { contacts, skipped: out.skipped + (out.contacts.length - contacts.length) };
}

const vEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

export function toVcard(c: { name: string; email: string; phone?: string | null; title?: string | null; company?: string | null; notes?: string | null }) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${vEscape(c.name || c.email)}`, `N:${vEscape(c.name.split(" ").slice(1).join(" "))};${vEscape(c.name.split(" ")[0] ?? "")};;;`, `EMAIL;TYPE=INTERNET:${c.email}`];
  if (c.phone) lines.push(`TEL:${vEscape(c.phone)}`);
  if (c.title) lines.push(`TITLE:${vEscape(c.title)}`);
  if (c.company) lines.push(`ORG:${vEscape(c.company)}`);
  if (c.notes) lines.push(`NOTE:${vEscape(c.notes)}`);
  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n");
}

// ------------------------------------------------------------------ calendar

export interface EventIn { uid: string; title: string; startsAt: Date; durationMin: number; allDay: boolean; recurrence: string | null; description: string; invitees: string[] }

/** Events in an .ics file. A weekly rule is kept (meetings repeat weekly); other rules keep their first date and say so in the notes. */
export function parseIcsEvents(text: string, defaultTz = "UTC"): { events: EventIn[]; skipped: number } {
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new MoveFileError("This is not a calendar file (.ics).");
  const comps = parseComponents(text).flatMap((c) => (c.type === "VCALENDAR" ? c.children : [c])).filter((c) => c.type === "VEVENT");
  const events: EventIn[] = [];
  let skipped = 0;
  for (const c of comps) {
    const prop = (n: string) => c.props.find((p) => p.name === n);
    const start = prop("DTSTART") ? parseWhen(prop("DTSTART")!, defaultTz) : null;
    if (!start || prop("RECURRENCE-ID") || /CANCELLED/i.test(prop("STATUS")?.value ?? "")) { skipped++; continue; }
    const startsAt = start.allDay ? new Date(`${start.ymd}T00:00:00Z`) : start.at;
    const end = prop("DTEND") ? parseWhen(prop("DTEND")!, defaultTz) : null;
    let ms = end ? (end.allDay ? new Date(`${end.ymd}T00:00:00Z`) : end.at).getTime() - startsAt.getTime() : prop("DURATION") ? parseDuration(prop("DURATION")!.value) ?? 0 : start.allDay ? 86_400_000 : 3_600_000;
    if (!(ms > 0)) ms = 30 * 60_000;
    const rule = prop("RRULE")?.value.trim() ?? null;
    const weekly = rule && /FREQ=WEEKLY/i.test(rule) ? rule.replace(/^RRULE:/i, "") : null;
    const unesc = (v: string) => v.replace(/\\(n|N|,|;|\\)/g, (_m, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
    const notes = [unesc(prop("DESCRIPTION")?.value ?? ""), prop("LOCATION") ? `Where: ${unesc(prop("LOCATION")!.value)}` : "", rule && !weekly ? `Repeats in the original calendar: ${rule}` : ""].filter(Boolean).join("\n\n");
    events.push({
      uid: prop("UID")?.value.trim() || `${startsAt.toISOString()}|${prop("SUMMARY")?.value ?? ""}`,
      title: clean(unesc(prop("SUMMARY")?.value ?? "")).slice(0, 200) || "Event",
      startsAt, durationMin: Math.min(24 * 60, Math.max(5, Math.round(ms / 60_000))), allDay: start.allDay, recurrence: weekly, description: notes.slice(0, 20_000),
      invitees: c.props.filter((p) => p.name === "ATTENDEE").map((p) => p.value.replace(/^mailto:/i, "").trim().toLowerCase()).filter(isEmail).slice(0, 50),
    });
  }
  return { events, skipped };
}

export function toIcs(meetings: { id: string; title: string; startsAt: Date; durationMin: number; recurrence?: string | null; status?: string; invitees?: string[]; updatedAt?: Date }[], name = "Workspace calendar") {
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Multies//Export//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${icsEscape(name)}`];
  for (const m of meetings) {
    out.push("BEGIN:VEVENT", `UID:${m.id}@multies`, `DTSTAMP:${icsUtc(m.updatedAt ?? m.startsAt)}`, `DTSTART:${icsUtc(m.startsAt)}`,
      `DTEND:${icsUtc(new Date(m.startsAt.getTime() + m.durationMin * 60_000))}`, `SUMMARY:${icsEscape(m.title)}`);
    if (m.recurrence) out.push(`RRULE:${m.recurrence}`);
    if (m.status === "cancelled") out.push("STATUS:CANCELLED");
    for (const e of m.invitees ?? []) out.push(`ATTENDEE:mailto:${e}`);
    out.push("END:VEVENT");
  }
  out.push("END:VCALENDAR");
  return out.map(foldLine).join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------ docs

interface PmNode { type: string; text?: string; content?: PmNode[]; attrs?: Record<string, unknown>; marks?: { type: string; attrs?: Record<string, unknown> }[] }

function inlineMd(nodes: PmNode[] = []): string {
  return nodes.map((n) => {
    if (n.type === "hardBreak") return "  \n";
    if (n.type === "mention") return `@${String(n.attrs?.label ?? n.attrs?.id ?? "")}`;
    if (n.type !== "text") return inlineMd(n.content);
    let t = n.text ?? "";
    for (const m of n.marks ?? []) {
      if (m.type === "bold") t = `**${t}**`;
      else if (m.type === "italic") t = `*${t}*`;
      else if (m.type === "strike") t = `~~${t}~~`;
      else if (m.type === "code") t = `\`${t}\``;
      else if (m.type === "link" && typeof m.attrs?.href === "string") t = `[${t}](${m.attrs.href})`;
    }
    return t;
  }).join("");
}

function blockMd(n: PmNode, indent = ""): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "doc": return kids.map((k) => blockMd(k)).filter((s) => s !== "").join("\n\n");
    case "heading": return `${"#".repeat(Math.min(6, Number(n.attrs?.level ?? 1)))} ${inlineMd(kids)}`;
    case "paragraph": return indent + inlineMd(kids);
    case "blockquote": return kids.map((k) => blockMd(k)).join("\n\n").split("\n").map((l) => `> ${l}`).join("\n");
    case "codeBlock": return `\`\`\`${String(n.attrs?.language ?? "")}\n${kids.map((k) => k.text ?? "").join("")}\n\`\`\``;
    case "horizontalRule": return "---";
    case "bulletList": case "orderedList": case "taskList":
      return kids.map((li, i) => {
        const mark = n.type === "orderedList" ? `${i + 1}.` : n.type === "taskList" ? `- [${li.attrs?.checked ? "x" : " "}]` : "-";
        const [first, ...rest] = li.content ?? [];
        const head = `${indent}${mark} ${first ? inlineMd(first.content) : ""}`;
        return [head, ...rest.map((r) => blockMd(r, indent + "  "))].join("\n");
      }).join("\n");
    case "image": return `![${String(n.attrs?.alt ?? "")}](${String(n.attrs?.src ?? "")})`;
    case "table": return kids.map((row, i) => {
      const cells = (row.content ?? []).map((c) => (c.content ?? []).map((p) => inlineMd(p.content)).join(" ").replace(/\|/g, "\\|"));
      const line = `| ${cells.join(" | ")} |`;
      return i === 0 ? `${line}\n| ${cells.map(() => "---").join(" | ")} |` : line;
    }).join("\n");
    default: return kids.length ? kids.map((k) => blockMd(k, indent)).join("\n\n") : inlineMd([n]);
  }
}

/** A doc as Markdown: headings, lists, task lists, quotes, code, links, tables and images. */
export function docToMarkdown(title: string, content: string | PmNode) {
  let doc: PmNode;
  try { doc = typeof content === "string" ? JSON.parse(content) as PmNode : content; } catch { doc = { type: "doc", content: [] }; }
  const body = blockMd(doc).trim();
  return `# ${title}\n\n${body}\n`;
}

// ------------------------------------------------------------------ mail

const mboxDate = (d: Date) => d.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4");
const addr = (list: string) => { try { const a = JSON.parse(list) as (string | { address?: string; name?: string })[]; return a.map((x) => (typeof x === "string" ? x : x.name ? `"${x.name.replace(/"/g, "")}" <${x.address}>` : x.address ?? "")).filter(Boolean).join(", "); } catch { return ""; } };
const hdr = (s: string) => s.replace(/[\r\n]+/g, " ");

export interface MailOut { fromAddress: string; fromName?: string | null; to: string; cc: string; subject: string; text?: string | null; html?: string | null; messageIdHeader?: string | null; inReplyTo?: string | null; createdAt: Date }

/** One message in mbox form (mboxrd: "From " lines in the body gain a ">"). Text and HTML go as multipart/alternative. */
export function toMboxEntry(m: MailOut) {
  const date = new Date(m.createdAt);
  const boundary = `mm-${date.getTime().toString(36)}`;
  const head = [
    `From ${m.fromAddress || "unknown"} ${mboxDate(date)}`,
    `From: ${m.fromName ? `"${hdr(m.fromName).replace(/"/g, "")}" <${m.fromAddress}>` : m.fromAddress}`,
    `To: ${hdr(addr(m.to))}`, ...(addr(m.cc) ? [`Cc: ${hdr(addr(m.cc))}`] : []),
    `Subject: ${hdr(m.subject ?? "")}`, `Date: ${date.toUTCString()}`,
    ...(m.messageIdHeader ? [`Message-ID: ${hdr(m.messageIdHeader)}`] : []), ...(m.inReplyTo ? [`In-Reply-To: ${hdr(m.inReplyTo)}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = (m.text ?? "").replace(/\r\n/g, "\n");
  const body = m.html
    ? [`Content-Type: multipart/alternative; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", text, `--${boundary}`, "Content-Type: text/html; charset=utf-8", "", m.html.replace(/\r\n/g, "\n"), `--${boundary}--`]
    : ["Content-Type: text/plain; charset=utf-8", "", text];
  return [...head, ...body].join("\n").replace(/\n(>*From )/g, "\n>$1") + "\n\n";
}
