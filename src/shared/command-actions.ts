/**
 * R54 (plan idea 8): the command menu acts on typed words. A pure parser shared by the web (and the server
 * if it ever needs it): "assign MB-12 to Asha due Friday priority high" becomes one task ref plus clauses,
 * and resolveCommand turns those into the change and a plain words preview. Rules only, no model call.
 * Dates reuse the meeting action item parser (parseDue in action-items.ts). Unknown words return null so the
 * menu keeps searching as before.
 *
 * R55: more verbs. Status names are fuzzy but never a guess (two matches list the choices), labels add and remove
 * ("label MB-12 urgent", "MB-12 +urgent -later", "unlabel MB-12 urgent"), "move MB-12 to Website" moves the task to
 * another project when no status of its own project has that name, and snooze or archive say plainly that tasks
 * have neither today.
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
  | { kind: "label"; label: string }
  | { kind: "unlabel"; label: string }
  | { kind: "project"; query: string }
  | { kind: "unsupported"; verb: "snooze" | "archive" };

export interface ParsedCommand {
  ref: string;
  clauses: Clause[];
  /** R55: indexes of status clauses written with "move", which may name another project instead of a status. */
  moves?: number[];
}

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
const VERBS = new Set(["assign", "assigned", "unassign", "due", "by", "status", "move", "mark", "done", "complete", "finish", "close", "priority", "prio", "label", "tag", "unlabel", "untag", "snooze", "archive"]);
/** R55: verbs that only act with a ref typed, so a search for "archive" on a focused task stays a search. */
const REF_ONLY = new Set(["snooze", "archive", "by"]);
/** "+urgent" and "-later": a label to add or take off. */
const SIGIL_RE = /^([+-])([\p{L}\p{N}][\p{L}\p{N}_./:]{0,39})$/u;
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

/** Verbs that need words after them; one of these as the very last word is part of a name ("Blue Harbor move"). */
const NEEDS_WORDS = new Set(["assign", "assigned", "due", "by", "status", "move", "mark", "priority", "prio", "label", "tag", "unlabel", "untag"]);

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
    const first = tokens(rest)[0] ?? "";
    const lead = fold(first);
    if ((!VERBS.has(lead) || REF_ONLY.has(lead)) && !SIGIL_RE.test(first)) return null;
    ref = ctx.defaultRef;
  }
  const now = ctx.now ?? new Date();
  const toks = tokens(rest);
  // R55: a verb that needs words, typed as the last word after some words, belongs to those words (a name).
  const trailingWord = (at: number, sofar: string[]) => sofar.length > 0 && at === toks.length - 1 && NEEDS_WORDS.has(fold(toks[at]));
  const clauses: Clause[] = [];
  const moves: number[] = [];
  let i = 0;
  // Words up to the next verb (commas end a clause too).
  const take = (): string[] => {
    const out: string[] = [];
    while (i < toks.length && toks[i] !== "," && !(VERBS.has(fold(toks[i])) && !trailingWord(i, out)) && !(out.length > 0 && fold(toks[i]) === "and")) out.push(toks[i++]);
    return out;
  };
  const skip = (...w: string[]) => { while (i < toks.length && w.includes(fold(toks[i]))) i++; };
  while (i < toks.length) {
    const tok = toks[i];
    const w = fold(tok);
    if (w === "," || GLUE.has(w)) { i++; continue; }
    const sig = SIGIL_RE.exec(tok);
    if (sig) { clauses.push(sig[1] === "+" ? { kind: "label", label: sig[2] } : { kind: "unlabel", label: sig[2] }); i++; continue; }
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
        // R55: "move MB-12 to project Website" (or "to the Website project") names a project only.
        const explicit = w === "move" && fold(toks[i] ?? "") === "project" ? (i++, true) : false;
        skip("the");
        let words = take().join(" ");
        if (w === "move" && /\s+project$/i.test(words)) { words = words.replace(/\s+project$/i, ""); clauses.push({ kind: "project", query: words }); break; }
        if (!words) return null;
        if (explicit) clauses.push({ kind: "project", query: words });
        else if (["done", "complete", "completed", "finished", "closed"].includes(fold(words))) clauses.push({ kind: "done" });
        else { if (w === "move") moves.push(clauses.length); clauses.push({ kind: "status", query: words }); }
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
      case "unlabel": case "untag": {
        const words = take().join(" ").replace(/^["']|["']$/g, "").trim().slice(0, 40);
        if (!words) return null;
        clauses.push({ kind: "unlabel", label: words });
        break;
      }
      case "snooze": case "archive": {
        // Not task features today (no snooze or archive field on a task): the row says so, the rest is ignored.
        take();
        clauses.push({ kind: "unsupported", verb: w as "snooze" | "archive" });
        break;
      }
      default: {
        // "high priority" / "urgent" written before the word priority.
        if (PRIORITIES[w] && w !== "no" && fold(toks[i] ?? "") === "priority") { i++; clauses.push({ kind: "priority", priority: PRIORITIES[w] }); break; }
        return null;
      }
    }
  }
  if (!clauses.length) return null;
  return moves.length ? { ref, clauses, moves } : { ref, clauses };
}

// ---------------------------------------------------------------- resolve against the task

export interface CmdTask { ref: string; labels: string[]; statusId?: string | null; assigneeId?: string | null; projectId?: string | null; category?: string | null }
export interface CmdProject { id: string; name: string; key: string; archived?: boolean; statuses: CmdStatus[]; /** R58 (MB-246): the number the next task there gets, when known. */ nextNumber?: number }

/** R55: what resolveCommand may also know: the workspace's projects (for move) and the labels in use. */
export interface ResolveExtra { projects?: CmdProject[]; knownLabels?: string[] }

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
  /** R55: the project the task moves to (status then holds the status it lands in). */
  project?: { id: string; name: string; key: string };
  /** R58 (MB-246): a move gives the task a new ref; `to` is null when the new number is not known yet. */
  refChange?: { from: string; to: string | null; key: string };
  /** R58 (MB-246): labels that no task uses yet; the menu asks before making them. */
  newLabels?: string[];
}

/** R58 (MB-246): the plain words for a ref that changes with a move. */
export function refChangeWords(c: { from: string; to: string | null; key: string }): string {
  return c.to ? `${c.from} becomes ${c.to}` : `${c.from} gets a new ${c.key} number`;
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

const byPosition = (statuses: CmdStatus[]) => statuses.slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

/**
 * R55: a status by name, never a guess. In order: the exact name; names that start with the words; names with a
 * word that starts with them ("progress" finds "In progress"); names that hold them. The first step with any hit
 * decides: one hit is the status, more are the choices. Then "todo", "doing" and "in progress" by category.
 */
export function statusChoices(query: string, statuses: CmdStatus[]): CmdStatus[] {
  const sorted = byPosition(statuses);
  const q = fold(query);
  if (!q) return [];
  const steps: ((s: CmdStatus) => boolean)[] = [
    (s) => fold(s.name) === q,
    (s) => fold(s.name).startsWith(q),
    (s) => fold(s.name).split(/\s+/).some((w) => w.startsWith(q)),
    (s) => q.length >= 3 && fold(s.name).includes(q),
  ];
  for (const f of steps) { const hit = sorted.filter(f); if (hit.length) return hit; }
  const cat = q === "todo" || q === "to do" ? "todo" : q === "doing" || q === "in progress" || q === "started" ? "doing" : null;
  const c = cat ? sorted.find((s) => s.category === cat) : undefined;
  return c ? [c] : [];
}

/** Find a status by its name, the start of its name, or "done" for the first done status (null when none or several). */
export function matchStatus(query: string | null, statuses: CmdStatus[]): CmdStatus | null {
  const sorted = byPosition(statuses);
  if (query === null) return sorted.find((s) => s.category === "done") ?? sorted.find((s) => fold(s.name) === "done") ?? null;
  const hit = statusChoices(query, statuses);
  return hit.length === 1 ? hit[0] : null;
}

/** R55: another project by key, name, the start of its name or a word in it. Archived projects and the task's own are left out. */
export function projectChoices(query: string, projects: CmdProject[], exceptId?: string | null): CmdProject[] {
  const list = projects.filter((p) => !p.archived && p.id !== exceptId);
  const q = fold(query);
  if (!q) return [];
  const steps: ((p: CmdProject) => boolean)[] = [
    (p) => fold(p.name) === q || fold(p.key) === q,
    (p) => fold(p.name).startsWith(q),
    (p) => fold(p.name).split(/\s+/).some((w) => w.startsWith(q)),
  ];
  for (const f of steps) { const hit = list.filter(f); if (hit.length) return hit; }
  return [];
}

/** The status a moved task lands in: the first of its category in the new project, else the first status (as the server picks). */
export function landingStatus(target: CmdProject, category?: string | null): CmdStatus | undefined {
  const sorted = byPosition(target.statuses);
  return sorted.find((s) => s.category === (category ?? "todo")) ?? sorted[0];
}

const names = (list: { name: string }[]) => list.slice(0, 4).map((x) => x.name).join(", ");

export function resolveCommand(cmd: ParsedCommand, task: CmdTask, statuses: CmdStatus[], now: Date = new Date(), extra: ResolveExtra = {}): ResolvedCommand {
  const out: ResolvedCommand = { preview: "", problems: [] };
  const parts: string[] = [];
  const labels = [...task.labels];
  let labelsTouched = false;
  const known = new Set((extra.knownLabels ?? []).map(fold));
  const projects = extra.projects ?? [];
  const moves = new Set(cmd.moves ?? []);
  // A move to another project first, so a status typed with it is read in the new project.
  let target: CmdProject | null = null;
  let movePart = -1;
  const handled = new Set<number>();
  const exact = (q: string, x: { name: string; key?: string }) => fold(x.name) === fold(q) || (!!x.key && fold(x.key) === fold(q));
  const moveTo = (p: CmdProject) => { target = p; out.project = { id: p.id, name: p.name, key: p.key }; movePart = parts.length; parts.push(`move to ${p.name}`); };
  cmd.clauses.forEach((c, i) => {
    if (c.kind === "project") {
      handled.add(i);
      const hit = projectChoices(c.query, projects, task.projectId);
      if (hit.length === 1 && !target) moveTo(hit[0]);
      else if (hit.length > 1) out.problems.push(`"${c.query}" matches ${names(hit)}. Type more of the name.`);
      else if (!hit.length) out.problems.push(`No other project called "${c.query}".`);
      return;
    }
    if (c.kind !== "status" || !moves.has(i) || !projects.length || target) return;
    const st = statusChoices(c.query, statuses);
    if (st.some((s) => exact(c.query, s))) return; // the exact status name wins
    const pr = projectChoices(c.query, projects, task.projectId);
    if (pr.length === 1 && (!st.length || exact(c.query, pr[0]))) { handled.add(i); moveTo(pr[0]); }
    else if (pr.length > 1 && !st.length) { handled.add(i); out.problems.push(`"${c.query}" matches ${names(pr)}. Type more of the name.`); }
    else if (pr.length && st.length) { handled.add(i); out.problems.push(`"${c.query}" could be the status ${names(st)} or the project ${names(pr)}. Type more of the name.`); }
  });
  const here = target ? (target as CmdProject).statuses : statuses;
  cmd.clauses.forEach((c, i) => {
    switch (c.kind) {
      case "assign": out.assignee = c.person; parts.push(`assign to ${c.person.name}`); break;
      case "unassign": out.assignee = null; parts.push("unassign"); break;
      case "assign-ambiguous": out.problems.push(`"${c.query}" matches ${names(c.choices)}. Type more of the name.`); break;
      case "assign-unknown": out.problems.push(`No one called "${c.query}" in this workspace.`); break;
      case "due": out.due = c.due; parts.push(`due ${dueWords(c.due, now)}`); break;
      case "due-clear": out.due = null; parts.push("no due date"); break;
      case "due-unknown": out.problems.push(`"${c.query}" is not a date. Try tomorrow, Fri or 30 Oct.`); break;
      case "project": break;
      case "status": case "done": {
        if (handled.has(i)) break;
        if (c.kind === "done") {
          const s = matchStatus(null, here);
          if (s) { out.status = s; parts.push(s.category === "done" ? `mark ${s.name}` : `status ${s.name}`); }
          else out.problems.push("This project has no done status.");
          break;
        }
        const hit = statusChoices(c.query, here);
        if (hit.length === 1) { out.status = hit[0]; parts.push(`status ${hit[0].name}`); }
        else if (hit.length > 1) out.problems.push(`"${c.query}" matches ${names(hit)}. Type more of the name.`);
        else if (moves.has(i) && projects.length && !target) out.problems.push(`No status or project called "${c.query}".`);
        else out.problems.push(`This project has no status called "${c.query}".`);
        break;
      }
      case "priority": out.priority = c.priority; parts.push(`priority ${PRIORITY_WORD[c.priority]}`); break;
      case "priority-unknown": out.problems.push("Priority is urgent, high, medium, low or none."); break;
      case "label": {
        const have = labels.find((l) => fold(l) === fold(c.label));
        if (!have) labels.push(c.label);
        labelsTouched = true;
        const fresh = !have && extra.knownLabels !== undefined && !known.has(fold(c.label));
        if (fresh) (out.newLabels ??= []).push(c.label);
        parts.push(fresh ? `label ${c.label} (a new label)` : `label ${have ?? c.label}`);
        break;
      }
      case "unlabel": {
        const at = labels.findIndex((l) => fold(l) === fold(c.label));
        if (at < 0) { out.problems.push(`${task.ref} has no label "${c.label}".`); break; }
        parts.push(`remove label ${labels[at]}`);
        labels.splice(at, 1);
        labelsTouched = true;
        break;
      }
      case "unsupported":
        out.problems.push(c.verb === "snooze"
          ? `Tasks can't be snoozed. Set a due date instead, like "${task.ref} due Mon".`
          : `Tasks can't be archived. Mark it done instead, like "${task.ref} done".`);
        break;
    }
  });
  if (labelsTouched) out.labels = labels;
  // A move names the status the task lands in when none was typed.
  if (target && out.project) {
    const t = target as CmdProject;
    if (!out.status || !t.statuses.some((s) => s.id === out.status!.id)) {
      const s = landingStatus(t, task.category);
      if (s) { out.status = s; parts[movePart] = `move to ${t.name} (status ${s.name})`; }
      else out.problems.push(`${t.name} has no statuses yet.`);
    }
    // R58 (MB-246): say that the ref changes, so a link or a ref someone wrote down is not a surprise later.
    out.refChange = { from: task.ref, to: t.nextNumber ? `${t.key}-${t.nextNumber}` : null, key: t.key };
    parts.splice(movePart + 1, 0, refChangeWords(out.refChange));
  }
  const verb = parts.join(", ");
  out.preview = `${task.ref}: ${verb || (cmd.clauses.some((c) => c.kind === "unsupported") ? cmd.clauses.find((c): c is Extract<Clause, { kind: "unsupported" }> => c.kind === "unsupported")!.verb : "no change")}`;
  if (!parts.length && !out.problems.length) out.problems.push("Nothing to change.");
  return out;
}
