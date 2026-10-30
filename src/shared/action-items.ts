/**
 * Round 23 (R23.1): action items in a meeting's notes doc. Pure helpers shared by the server and the
 * web: find the task list items in a Tiptap document, and read an assignee ("@Name", "@email" or a
 * mention node) and a due date ("due Fri", "by 30 Oct", "by 2026-10-30", "tomorrow") out of each one.
 */

export interface PMNodeLike { type?: string; text?: string; attrs?: Record<string, unknown>; content?: PMNodeLike[] }

/** Someone an item can be assigned to: a workspace member or an agent. */
export interface ActionPerson { type: "member" | "agent"; id: string; name: string; email?: string | null }

export interface RawActionItem {
  /** Stable for the same text (case and spacing do not matter); a repeat of the same text gets "#2". */
  key: string;
  /** The item's text as written, mentions shown as "@Name". */
  text: string;
  checked: boolean;
  /** Ids of mention nodes in the item, if the editor made any. */
  mentionIds: string[];
}

export interface ParsedActionItem extends RawActionItem {
  title: string;
  assignee: { type: "member" | "agent"; id: string; name: string } | null;
  /** YYYY-MM-DD, or null. */
  due: string | null;
}

const MAX_ITEMS = 200;

/** Plain text of an inline run, mention nodes as "@label". Nested lists are left out. */
function inlineText(n: PMNodeLike, mentions: string[]): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention") {
    const id = typeof n.attrs?.id === "string" ? n.attrs.id : "";
    if (id) mentions.push(id);
    const label = typeof n.attrs?.label === "string" && n.attrs.label ? n.attrs.label : id;
    return label ? `@${label}` : "";
  }
  if (n.type === "hardBreak") return " ";
  if (n.type === "taskList" || n.type === "bulletList" || n.type === "orderedList") return "";
  return (n.content ?? []).map((c) => inlineText(c, mentions)).join(n.type === "paragraph" ? "" : " ");
}

export const normaliseItemText = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** FNV-1a, twice with different seeds: a short stable key, no crypto needed (a meeting has a few dozen items). */
export function itemKey(text: string): string {
  const s = normaliseItemText(text);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193 + 2) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Every task list item anywhere in the doc (not only under "Action items"), in document order. Empty items are skipped. */
export function collectTaskItems(doc: PMNodeLike | null | undefined): RawActionItem[] {
  const out: RawActionItem[] = [];
  const seen = new Map<string, number>();
  const walk = (n: PMNodeLike, depth: number) => {
    if (depth > 64 || out.length >= MAX_ITEMS) return;
    if (n.type === "taskItem") {
      const mentionIds: string[] = [];
      const text = (n.content ?? []).map((c) => inlineText(c, mentionIds)).join(" ").replace(/\s+/g, " ").trim();
      if (text) {
        const base = itemKey(text);
        const k = (seen.get(base) ?? 0) + 1;
        seen.set(base, k);
        out.push({ key: k === 1 ? base : `${base}#${k}`, text, checked: n.attrs?.checked === true, mentionIds });
      }
    }
    for (const c of n.content ?? []) walk(c, depth + 1);
  };
  if (doc) walk(doc, 0);
  return out;
}

// ---------------------------------------------------------------- dates

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_RE = "(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)";
const MON_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const pad = (n: number) => String(n).padStart(2, "0");

/** Today's calendar date in a time zone (a bad zone falls back to UTC). */
export function todayIn(now: Date, timeZone?: string | null): { y: number; m: number; d: number } {
  let tz = timeZone || "UTC";
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = "UTC"; }
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
function addDays(t: { y: number; m: number; d: number }, n: number) {
  const x = new Date(Date.UTC(t.y, t.m - 1, t.d + n));
  return ymd(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}
function validDate(y: number, m: number, d: number) {
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}
/** A day and month with no year: this year, or next year once the date has passed. */
function nearest(t: { y: number; m: number; d: number }, m: number, d: number): string | null {
  for (const y of [t.y, t.y + 1]) {
    if (!validDate(y, m, d)) continue;
    if (y > t.y || m > t.m || (m === t.m && d >= t.d)) return ymd(y, m, d);
  }
  return null;
}

/**
 * A due date in an item: "due Fri", "by Friday", "next Tue" (skips today), "by 30 Oct", "due Oct 30th",
 * "by 2026-10-30", "today", "tomorrow". Weekdays mean the next one on or after today, in the zone given.
 * Returns the date and the matched words (to take out of the title), or null.
 */
export function parseDue(text: string, now: Date, timeZone?: string | null): { due: string; match: string } | null {
  const t = todayIn(now, timeZone);
  const lead = "(?:^|\\s|,|\\()(?:(?:due|by|before|on)\\s+)?";
  const rules: { re: RegExp; fn: (m: RegExpExecArray) => string | null; needsLead?: boolean }[] = [
    { re: new RegExp(`${lead}(\\d{4})-(\\d{2})-(\\d{2})\\b`, "i"), fn: (m) => (validDate(+m[1], +m[2], +m[3]) ? ymd(+m[1], +m[2], +m[3]) : null) },
    { re: new RegExp(`${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i"), fn: (m) => dayMonth(+m[1], m[2], m[3]) },
    { re: new RegExp(`${lead}${MON_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"), fn: (m) => dayMonth(+m[2], m[1], m[3]) },
    { re: new RegExp(`${lead}(today|tonight|eod)\\b`, "i"), fn: () => addDays(t, 0) },
    { re: new RegExp(`${lead}(tomorrow|tmrw)\\b`, "i"), fn: () => addDays(t, 1) },
    { re: new RegExp(`${lead}(?:(next|this)\\s+)?${DAY_RE}\\b`, "i"), fn: (m) => weekday(m[2], m[1]), needsLead: true },
  ];
  function dayMonth(d: number, mon: string, year?: string) {
    const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase()) + 1;
    if (year) return validDate(+year, m, d) ? ymd(+year, m, d) : null;
    return nearest(t, m, d);
  }
  function weekday(name: string, next?: string) {
    const want = DAYS.indexOf(name.slice(0, 3).toLowerCase());
    const cur = new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();
    let diff = (want - cur + 7) % 7;
    if (next?.toLowerCase() === "next" && diff === 0) diff = 7;
    return addDays(t, diff);
  }
  for (const r of rules) {
    const m = r.re.exec(text);
    if (!m) continue;
    // A bare weekday ("Fri") only counts after due/by/before/on, so "Mon standup notes" is not a date.
    if (r.needsLead && !/^(?:[\s,(])?(?:due|by|before|on)\s/i.test(m[0]) && !/^(?:[\s,(])?(?:next|this)\s/i.test(m[0])) continue;
    const due = r.fn(m);
    if (due) return { due, match: m[0] };
  }
  return null;
}

// ---------------------------------------------------------------- assignees

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first person an item names: a mention node's id, else "@Full Name", "@email" or "@First" (a first
 * name only when one person has it). Longest name first; case does not matter.
 */
export function findAssignee(text: string, people: ActionPerson[], mentionIds: string[] = []): { person: ActionPerson; match: string | null } | null {
  for (const id of mentionIds) {
    const p = people.find((x) => x.id === id || `${x.type}:${x.id}` === id);
    if (p) {
      const label = new RegExp(`(^|\\s)@${escapeRe(p.name)}(?![\\w-])`, "i").exec(text);
      return { person: p, match: label ? label[0] : null };
    }
  }
  const firsts = new Map<string, ActionPerson[]>();
  for (const p of people) {
    const f = p.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (f) firsts.set(f, [...(firsts.get(f) ?? []), p]);
  }
  const tokens = people.flatMap((p) => [
    { t: p.name.trim(), p }, ...(p.email ? [{ t: p.email, p }] : []),
    ...(firsts.get(p.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "")?.length === 1 ? [{ t: p.name.trim().split(/\s+/)[0], p }] : []),
  ]).filter((x) => x.t).sort((x, y) => y.t.length - x.t.length);
  for (const { t, p } of tokens) {
    const m = new RegExp(`(^|[^\\w@])@${escapeRe(t)}(?![\\w-]|@|\\.\\w)`, "i").exec(text);
    if (m) return { person: p, match: m[0] };
  }
  return null;
}

/** Title, assignee and due date of one item. The matched words come out of the title. */
export function parseActionItem(item: RawActionItem, people: ActionPerson[], now: Date, timeZone?: string | null): ParsedActionItem {
  let title = item.text;
  const who = findAssignee(title, people, item.mentionIds);
  if (who?.match) title = title.replace(who.match, (m) => (/^[^@]/.test(m) ? m[0] : "") + " ");
  const due = parseDue(title, now, timeZone);
  if (due) title = title.replace(due.match, (m) => (/^[\s,(]/.test(m) ? m[0] : "") + " ");
  title = title.replace(/\(\s*\)/g, "").replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/^[\s,;:-]+|[\s,;:-]+$/g, "").trim();
  return { ...item, title: title || item.text, assignee: who ? { type: who.person.type, id: who.person.id, name: who.person.name } : null, due: due?.due ?? null };
}

/** Unchecked items, parsed. Checked ones are done in the meeting and never become tasks. */
export function actionItemsOf(doc: PMNodeLike | null | undefined, people: ActionPerson[], now: Date, timeZone?: string | null): ParsedActionItem[] {
  return collectTaskItems(doc).filter((i) => !i.checked).map((i) => parseActionItem(i, people, now, timeZone));
}

/** The text a new item is written into the doc as, so reading it back gives the same title, assignee and due. */
export function actionItemText(title: string, assignee?: { name: string } | null, due?: string | null) {
  return [title.trim(), assignee ? `@${assignee.name}` : "", due ? `due ${due}` : ""].filter(Boolean).join(" ");
}

/** The starting notes doc: Agenda, Notes and Action items, the last holding an empty checklist. */
export function notesTemplate(): PMNodeLike {
  const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
  return {
    type: "doc",
    content: [
      h("Agenda"), { type: "paragraph" },
      h("Notes"), { type: "paragraph" },
      h("Action items"), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }] }] },
    ],
  };
}

export interface NotesSections { agenda: string[]; notes: string[]; other: string[] }

/** Agenda and notes lines by heading (task items are reported as action items, not here). */
export function sectionsOf(doc: PMNodeLike | null | undefined): NotesSections {
  const out: NotesSections = { agenda: [], notes: [], other: [] };
  let cur: keyof NotesSections | "actions" = "other";
  const lines = (n: PMNodeLike): string[] => {
    if (n.type === "taskList") return [];
    if (n.type === "bulletList" || n.type === "orderedList") return (n.content ?? []).flatMap((li) => (li.content ?? []).flatMap(lines));
    const t = inlineText(n, []).replace(/\s+/g, " ").trim();
    return t ? [t] : [];
  };
  for (const n of doc?.content ?? []) {
    if (n.type === "heading") {
      const t = inlineText(n, []).trim().toLowerCase();
      cur = /agenda/.test(t) ? "agenda" : /action/.test(t) ? "actions" : /notes?|minutes|discussion/.test(t) ? "notes" : "other";
      continue;
    }
    if (cur === "actions") { if (n.type !== "taskList") out.notes.push(...lines(n)); continue; }
    out[cur].push(...lines(n));
  }
  return out;
}

/** Puts a new unchecked item at the end of the first task list under "Action items" (or the last task list, or a new one). */
export function appendActionItem(doc: PMNodeLike, text: string): PMNodeLike {
  const item = { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
  const content = [...(doc.content ?? [])];
  const isEmpty = (i: PMNodeLike) => !inlineText(i, []).trim();
  let target = -1;
  let inActions = false;
  for (let i = 0; i < content.length; i++) {
    const n = content[i];
    if (n.type === "heading") inActions = /action/i.test(inlineText(n, []));
    if (n.type !== "taskList") continue;
    if (inActions) { target = i; break; }
    target = i; // the last list so far, used when no list sits under "Action items"
  }
  if (target === -1) {
    content.push({ type: "taskList", content: [item] });
  } else {
    const list = content[target];
    const items = (list.content ?? []).filter((i) => !isEmpty(i));
    content[target] = { ...list, content: [...items, item] };
  }
  return { ...doc, content };
}

/** A workspace person as the notes view lists them. */
export interface SummaryPerson { type: "member" | "agent"; id: string; name: string }

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The people a summary named, matched to the workspace by full name or a first name only one person has. */
export function matchPerson(name: string | null, people: SummaryPerson[]): SummaryPerson | null {
  if (!name) return null;
  const n = normName(name);
  const full = people.filter((p) => normName(p.name) === n);
  if (full.length === 1) return full[0];
  const first = people.filter((p) => normName(p.name).split(" ")[0] === n);
  return first.length === 1 ? first[0] : null;
}

/** Action items from the newest call summary that are not in the notes yet, as the action-items request takes them (round 23). */
export function summaryItemsToAdd(view: { actionItems: { title: string }[]; people: SummaryPerson[]; summaryActionItems?: { text: string; assignee: string | null; due: string | null }[] }) {
  const have = new Set(view.actionItems.map((i) => normName(i.title)));
  return (view.summaryActionItems ?? []).filter((i) => i.text.trim() && !have.has(normName(i.text))).map((i) => {
    const who = matchPerson(i.assignee, view.people);
    return { title: i.text.trim().slice(0, 300), ...(who ? { assignee: `${who.type}:${who.id}` } : {}), ...(i.due && /^\d{4}-\d{2}-\d{2}/.test(i.due) ? { due: i.due.slice(0, 10) } : {}) };
  });
}

