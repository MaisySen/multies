/**
 * R54 (plan idea 8): the command menu acts on typed words. A pure parser shared by the web (and the server
 * if it ever needs it): "assign MB-12 to Asha due Friday priority high" becomes one task ref plus clauses,
 * and resolveCommand turns those into the change and a plain words preview. Rules only, no model call.
 * Dates reuse the meeting action item parser (parseDue in action-items.ts). Unknown words return null so the
 * menu keeps searching as before.
 */
import { parseDue } from "./action-items";

export type CmdPriority = "urgent" | "high" | "medium" | "low" | "none";
export interface CmdPerson { id: string; type: "member" | "agent"; name: string; email?: string | null }
export interface CmdStatus { id: string; name: string; category?: string; position?: number }

export type Clause =
  | { kind: "assign"; person: CmdPerson }
  | { kind: "assign-ambiguous"; query: string; choices: CmdPerson[] }
  | { kind: "assign-unknown"; query: string }
  | { kind: "unassign" }
  | { kind: "due"; due: string }
  | { kind: "due-clear" }
  | { kind: "due-unknown"; query: string }
  | { kind: "status"; query: string }
  | { kind: "done" }
  | { kind: "priority"; priority: CmdPriority }
  | { kind: "priority-unknown"; query: string }
  | { kind: "label"; label: string };

export interface ParsedCommand { ref: string; clauses: Clause[] }

export interface ParseContext {
  people: CmdPerson[];
  /** The signed in person, for "me". */
  me?: CmdPerson | null;
  now?: Date;
  timeZone?: string | null;
  /** The focused task's ref, used when the words name no task ("assign to me"). */
  defaultRef?: string | null;
}

const REF_RE = /(?:^|[\s,])([A-Za-z][A-Za-z0-9]{0,9}-\d{1,6})(?=$|[\s,.])/;
const VERBS = new Set(["assign", "assigned", "unassign", "due", "by", "status", "move", "mark", "done", "complete", "finish", "close", "priority", "prio", "label", "tag"]);
const GLUE = new Set(["and", "then", "set", "with", "to", "as", "it", "please", "&", "+"]);
const PRIORITIES: Record<string, CmdPriority> = { urgent: "urgent", high: "high", medium: "medium", med: "medium", normal: "medium", low: "low", none: "none", no: "none" };
const NOBODY = new Set(["nobody", "no one", "noone", "none", "unassigned"]);

/** Lower case, accents gone ("José" matches "jose"). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/** A person by "me", full name, email or its part before @, a first name only one person has, or the start of one name. */
export function matchPerson(query: string, people: CmdPerson[], me?: CmdPerson | null): Clause {
  const raw = query.replace(/^@/, "").trim();
  const q = fold(raw);
  if (NOBODY.has(q)) return { kind: "unassign" };
  if (q === "me" || q === "myself") return me ? { kind: "assign", person: me } : { kind: "assign-unknown", query: raw };
  const by = (f: (p: CmdPerson) => boolean) => people.filter(f);
  const one = (list: CmdPerson[]): Clause | null =>
    list.length === 1 ? { kind: "assign", person: list[0] } : list.length > 1 ? { kind: "assign-ambiguous", query: raw, choices: list } : null;
  const first = (p: CmdPerson) => fold(p.name).split(/\s+/)[0] ?? "";
  return one(by((p) => fold(p.name) === q))
    ?? one(by((p) => !!p.email && (fold(p.email) === q || fold(p.email).split("@")[0] === q)))
    ?? one(by((p) => first(p) === q))
    ?? (q.length >= 2 ? one(by((p) => fold(p.name).startsWith(q) || fold(p.name).split(/\s+/).some((w) => w.startsWith(q)))) : null)
    ?? { kind: "assign-unknown", query: raw };
}

const ymd = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** "tomorrow", "Fri", "next Tue", "30 Oct", "2026-10-30", "in 3 days", "in 2 weeks"; null when not a date. */
export function parseDueWords(words: string, now: Date, timeZone?: string | null): string | null {
  const w = words.trim().replace(/[.,;]+$/, "");
  if (!w) return null;
  const rel = /^in\s+(\d{1,3}|a|an|one|two|three)\s+(day|days|week|weeks)$/i.exec(w);
  if (rel) {
    const n = ({ a: 1, an: 1, one: 1, two: 2, three: 3 } as Record<string, number>)[rel[1].toLowerCase()] ?? Number(rel[1]);
    const today = parseDue("due today", now, timeZone);
    if (!today) return null;
    const d = new Date(`${today.due}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n * (rel[2].toLowerCase().startsWith("week") ? 7 : 1));
    return ymd(d);
  }
  const text = `due ${w}`;
  const hit = parseDue(text, now, timeZone);
  // The date words must be the whole clause, so "due Friday maybe" is not read as Friday.
  if (!hit || fold(hit.match) !== fold(text)) return null;
  return hit.due;
}

/** Split words into tokens, keeping "@Full Name" style tokens as typed. */
function tokens(s: string): string[] {
  return s.replace(/,/g, " , ").split(/\s+/).filter(Boolean);
}

/**
 * Typed words to a task ref and clauses, or null when the words are not a command (then the menu searches).
 * Needs a task ref (or the focused task) and at least one verb; any word outside a clause makes it a search.
 */
export function parseCommand(input: string, ctx: ParseContext): ParsedCommand | null {
  const text = input.normalize("NFC").trim();
  if (!text || text.length > 300) return null;
  const refHit = REF_RE.exec(text);
  let ref = refHit ? refHit[1].toUpperCase() : null;
  const rest = refHit ? (text.slice(0, refHit.index) + " " + text.slice(refHit.index + refHit[0].length)) : text;
  if (!ref) {
    if (!ctx.defaultRef) return null;
    // Without a ref the words must start with a verb ("assign to me", "done"), so a plain search stays a search.
    const lead = fold(tokens(rest)[0] ?? "");
    if (!VERBS.has(lead) || lead === "by") return null;
    ref = ctx.defaultRef;
  }
  const now = ctx.now ?? new Date();
  const toks = tokens(rest);
  const clauses: Clause[] = [];
  let i = 0;
  // Words up to the next verb (commas end a clause too).
  const take = (): string[] => {
    const out: string[] = [];
    while (i < toks.length && toks[i] !== "," && !VERBS.has(fold(toks[i])) && !(out.length > 0 && fold(toks[i]) === "and")) out.push(toks[i++]);
    return out;
  };
  const skip = (...w: string[]) => { while (i < toks.length && w.includes(fold(toks[i]))) i++; };
  while (i < toks.length) {
    const tok = toks[i];
    const w = fold(tok);
    if (w === "," || GLUE.has(w)) { i++; continue; }
    if (tok.startsWith("@") && tok.length > 1) {
      // "@Asha" or "@Asha Rao": the longest run of words that names one person.
      const run = [tok];
      let j = i + 1;
      while (j < toks.length && toks[j] !== "," && !VERBS.has(fold(toks[j])) && !GLUE.has(fold(toks[j]))) run.push(toks[j++]);
      let best: Clause | null = null; let used = 1;
      for (let n = run.length; n >= 1; n--) {
        const c = matchPerson(run.slice(0, n).join(" "), ctx.people, ctx.me);
        if (c.kind === "assign" || c.kind === "unassign") { best = c; used = n; break; }
        if (n === 1) { best = c; used = 1; }
      }
      clauses.push(best!); i += used; continue;
    }
    i++;
    switch (w) {
      case "assign": case "assigned": {
        skip("to", "it");
        const who = take().join(" ");
        if (!who) return null;
        clauses.push(matchPerson(who, ctx.people, ctx.me));
        break;
      }
      case "unassign": clauses.push({ kind: "unassign" }); skip("it"); break;
      case "due": case "by": {
        skip("on", "date");
        const words = take().join(" ");
        if (!words) return null;
        const f = fold(words);
        if (["none", "never", "nothing", "no date", "clear"].includes(f)) clauses.push({ kind: "due-clear" });
        else { const due = parseDueWords(words, now, ctx.timeZone); clauses.push(due ? { kind: "due", due } : { kind: "due-unknown", query: words }); }
        break;
      }
      case "status": case "move": case "mark": {
        skip("to", "as", "into");
        if (["done", "complete", "finish", "close"].includes(fold(toks[i] ?? ""))) { i++; clauses.push({ kind: "done" }); break; }
        const words = take().join(" ");
        if (!words) return null;
        if (["done", "complete", "completed", "finished", "closed"].includes(fold(words))) clauses.push({ kind: "done" });
        else clauses.push({ kind: "status", query: words });
        break;
      }
      case "done": case "complete": case "finish": case "close": clauses.push({ kind: "done" }); break;
      case "priority": case "prio": {
        skip("to", "as", "is");
        const words = take();
        if (!words.length) return null;
        const p = PRIORITIES[fold(words.join(" "))] ?? (fold(words.join(" ")) === "no priority" ? "none" : undefined);
        clauses.push(p ? { kind: "priority", priority: p } : { kind: "priority-unknown", query: words.join(" ") });
        break;
      }
      case "label": case "tag": {
        const words = take().join(" ").replace(/^["']|["']$/g, "").trim().slice(0, 40);
        if (!words) return null;
        clauses.push({ kind: "label", label: words });
        break;
      }
      default: {
        // "high priority" / "urgent" written before the word priority.
        if (PRIORITIES[w] && w !== "no" && fold(toks[i] ?? "") === "priority") { i++; clauses.push({ kind: "priority", priority: PRIORITIES[w] }); break; }
        return null;
      }
    }
  }
  return clauses.length ? { ref, clauses } : null;
}

// ---------------------------------------------------------------- resolve against the task

export interface CmdTask { ref: string; labels: string[]; statusId?: string | null; assigneeId?: string | null }

export interface ResolvedCommand {
  /** Plain words: "MB-12: assign to Asha Rao, due Fri 30 Oct, priority High". */
  preview: string;
  /** Why it cannot run (an unknown person, two people match, a status that does not exist). Empty when it can. */
  problems: string[];
  assignee?: CmdPerson | null;
  due?: string | null;
  status?: CmdStatus;
  priority?: CmdPriority;
  labels?: string[];
}

const PRIORITY_WORD: Record<CmdPriority, string> = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low", none: "No priority" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-30" to "Fri 30 Oct" (with the year when it is not this year). */
export function dueWords(iso: string, now: Date = new Date()): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const year = d.getUTCFullYear() !== now.getFullYear() ? ` ${d.getUTCFullYear()}` : "";
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

/** Find a status by its name, the start of its name, or "done" for the first done status. */
export function matchStatus(query: string | null, statuses: CmdStatus[]): CmdStatus | null {
  const sorted = statuses.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (query === null) return sorted.find((s) => s.category === "done") ?? sorted.find((s) => fold(s.name) === "done") ?? null;
  const q = fold(query);
  const exact = sorted.find((s) => fold(s.name) === q);
  if (exact) return exact;
  const starts = sorted.filter((s) => fold(s.name).startsWith(q));
  if (starts.length === 1) return starts[0];
  if (q === "todo" || q === "to do") return sorted.find((s) => s.category === "todo") ?? null;
  if (q === "doing") return sorted.find((s) => s.category === "doing") ?? null;
  return null;
}

export function resolveCommand(cmd: ParsedCommand, task: CmdTask, statuses: CmdStatus[], now: Date = new Date()): ResolvedCommand {
  const out: ResolvedCommand = { preview: "", problems: [] };
  const parts: string[] = [];
  const labels = [...task.labels];
  for (const c of cmd.clauses) {
    switch (c.kind) {
      case "assign": out.assignee = c.person; parts.push(`assign to ${c.person.name}`); break;
      case "unassign": out.assignee = null; parts.push("unassign"); break;
      case "assign-ambiguous": out.problems.push(`"${c.query}" matches ${c.choices.slice(0, 4).map((p) => p.name).join(", ")}. Type more of the name.`); break;
      case "assign-unknown": out.problems.push(`No one called "${c.query}" in this workspace.`); break;
      case "due": out.due = c.due; parts.push(`due ${dueWords(c.due, now)}`); break;
      case "due-clear": out.due = null; parts.push("no due date"); break;
      case "due-unknown": out.problems.push(`"${c.query}" is not a date. Try tomorrow, Fri or 30 Oct.`); break;
      case "status": case "done": {
        const s = matchStatus(c.kind === "done" ? null : c.query, statuses);
        if (s) { out.status = s; parts.push(c.kind === "done" && s.category === "done" ? `mark ${s.name}` : `status ${s.name}`); }
        else out.problems.push(c.kind === "done" ? "This project has no done status." : `This project has no status called "${c.query}".`);
        break;
      }
      case "priority": out.priority = c.priority; parts.push(`priority ${PRIORITY_WORD[c.priority]}`); break;
      case "priority-unknown": out.problems.push("Priority is urgent, high, medium, low or none."); break;
      case "label": {
        if (!labels.some((l) => fold(l) === fold(c.label))) labels.push(c.label);
        out.labels = labels; parts.push(`label ${c.label}`);
        break;
      }
    }
  }
  out.preview = `${task.ref}: ${parts.join(", ") || "no change"}`;
  if (!parts.length && !out.problems.length) out.problems.push("Nothing to change.");
  return out;
}
