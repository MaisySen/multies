/**
 * R26 (MB-86): the task query language, shared by the web filter bar and the server. A hand written parser: no eval,
 * no dependency. Terms are ANDed; commas inside one term mean "any of"; a leading minus negates a term.
 *
 *   assignee:me status:doing label:bug priority:>=high due:<7d sprint:current type:bug project:MB
 *   "free text" -label:wontfix created:>2026-10-01 points:>=3 has:subtasks is:overdue
 *
 * A query with no known key in it (for example "re: invoice") is plain text, as the old search box was.
 */

export type QueryOp = "=" | "<" | "<=" | ">" | ">=";
export type QueryKey = "assignee" | "status" | "label" | "priority" | "due" | "sprint" | "type" | "project" | "created" | "updated" | "points" | "has" | "is" | "title";

/** R34: history operators over the change rows: `status WAS doing`, `status CHANGED FROM todo TO doing AFTER -7d BY me`. */
export const HISTORY_KEYS = ["status", "assignee", "priority"] as const;
export type HistoryKey = (typeof HISTORY_KEYS)[number];
export interface HistoryTerm {
  kind: "history"; key: HistoryKey; op: "was" | "changed"; values: string[];
  from?: string[]; to?: string[]; after?: string; before?: string; by?: string; negate: boolean; pos: number;
}

export type QueryTerm =
  | { kind: "text"; value: string; negate: boolean; pos: number }
  | { kind: "field"; key: QueryKey; op: QueryOp; values: string[]; negate: boolean; pos: number }
  | HistoryTerm;

/** R34: a query with OR, AND, NOT or brackets is a tree; a plain list of terms (ANDed) has no tree. */
export type QueryNode = { op: "and" | "or"; items: QueryNode[] } | { op: "not"; item: QueryNode } | { op: "term"; term: QueryTerm };

export interface ParsedQuery { terms: QueryTerm[]; plain: boolean; tree?: QueryNode }

/** Bad query: `position` is the 1 based character where the problem starts. */
export class TaskQueryError extends Error {
  constructor(message: string, readonly position: number) { super(`${message} (at character ${position})`); this.name = "TaskQueryError"; }
}

export const QUERY_MAX_LENGTH = 500;
export const QUERY_MAX_TERMS = 30;
/** A query holds at most this many values. */
export const QUERY_MAX_VALUES = 30;
/**
 * Every value binds a few SQL variables (a person's name is the costliest: two subqueries) and D1 allows 100 per
 * statement. queryCost() counts them; a query over this budget is refused, leaving room for the list's own filters.
 */
export const QUERY_MAX_COST = 80;

/** SQL variables a term binds (an upper bound, matched by services/suite/task-query.ts). */
export function termCost(t: QueryTerm): number {
  if (t.kind === "text") return /^[A-Za-z0-9]{1,6}-\d+$/.test(t.value) ? 8 : 2; // R34: a ref also looks up old keys and moves
  if (t.kind === "history") return historyCost(t);
  return t.values.reduce((n, v) => {
    const l = v.toLowerCase();
    switch (t.key) {
      case "assignee": return n + (l === "none" ? 0 : l === "me" || /^(member|agent):/.test(l) ? 2 : 8);
      case "project": return n + 5; // R34: plus the old keys (2)
      case "status": return n + (["todo", "doing", "done", "open"].includes(l) ? 1 : 2);
      case "sprint": return n + 2;
      case "due": case "created": case "updated": return n + 2;
      case "is": return n + 2;
      default: return n + 1;
    }
  }, 0);
}

/** SQL variables a history term binds (an upper bound, matched by services/suite/task-query.ts). */
export function historyCost(t: HistoryTerm): number {
  const per = (v: string) => {
    const l = v.toLowerCase();
    if (t.key === "assignee") return l === "none" ? 0 : l === "me" ? 2 : 6;
    if (t.key === "status") return 3;
    return 1;
  };
  const current = t.op === "was" ? termCost({ kind: "field", key: t.key, op: "=", values: t.values, negate: false, pos: t.pos }) : 0;
  const hist = [...t.values, ...(t.to ?? [])].reduce((n, v) => n + per(v), 0) + (t.from ?? []).reduce((n, v) => n + per(v), 0)
    + (t.after ? 1 : 0) + (t.before ? 1 : 0) + (t.by ? (t.by.toLowerCase() === "me" ? 2 : 6) : 0);
  return current + hist + 2;
}

export const PRIORITY_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };
export const QUERY_TYPES = ["task", "story", "bug", "epic"] as const;
export const QUERY_HAS = ["subtasks", "checklist", "due", "assignee", "labels", "points", "parent", "notes"] as const;
export const QUERY_IS = ["overdue", "open", "done", "unassigned", "subtask", "mine", "watching"] as const; // R27: is:watching

/** Keys, what they take and a hint, for autocomplete and the help popover. */
export const QUERY_KEYS: { key: QueryKey; hint: string; values?: readonly string[]; compare?: boolean }[] = [
  { key: "assignee", hint: "me, none, a name or an email", values: ["me", "none"] },
  { key: "status", hint: "todo, doing, done or a status name", values: ["todo", "doing", "done", "open"] },
  { key: "label", hint: "a label" },
  { key: "priority", hint: "urgent, high, medium, low, none; >= works", values: ["urgent", "high", "medium", "low", "none"], compare: true },
  { key: "due", hint: "today, a date, 7d (from today), -3d, none; < and > work", values: ["today", "tomorrow", "none", "<7d", "<today"], compare: true },
  { key: "sprint", hint: "current, next, none or a sprint name", values: ["current", "next", "none"] },
  { key: "type", hint: "task, story, bug or epic", values: QUERY_TYPES },
  { key: "project", hint: "a project key or name" },
  { key: "created", hint: "a date or 7d (7 days ago); < and > work", values: [">7d", "today"], compare: true },
  { key: "updated", hint: "a date or 7d (7 days ago); < and > work", values: [">7d", "today"], compare: true },
  { key: "points", hint: "a number or none; >= works", values: ["none", ">=3"], compare: true },
  { key: "has", hint: QUERY_HAS.join(", "), values: QUERY_HAS },
  { key: "is", hint: QUERY_IS.join(", "), values: QUERY_IS },
  { key: "title", hint: "words in the title only" },
];
const KEY_SET = new Set<string>(QUERY_KEYS.map((k) => k.key));
const COMPARE = new Set<string>(QUERY_KEYS.filter((k) => k.compare).map((k) => k.key));

/** Dates: YYYY-MM-DD, today, yesterday, tomorrow, or a day offset like 7d, -3d, 2w. */
export const DATE_VALUE = /^(\d{4}-\d{2}-\d{2}|today|yesterday|tomorrow|-?\d{1,4}[dw])$/i;

interface Tok { kind?: "(" | ")"; neg: boolean; key: string | null; raw: string; op: string; values: string[]; quoted: boolean; pos: number }

/** Reads `s` from i: a quoted string (with \" and \\ escapes) or a run up to whitespace (R34: or a closing bracket inside brackets). */
function readValue(s: string, i: number, stopParen = false): { value: string; end: number; quoted: boolean } {
  if (s[i] === '"') {
    let out = ""; let j = i + 1;
    while (j < s.length && s[j] !== '"') {
      if (s[j] === "\\" && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
      out += s[j++];
    }
    if (j >= s.length) throw new TaskQueryError("A quote is not closed", i + 1);
    return { value: out, end: j + 1, quoted: true };
  }
  let j = i;
  while (j < s.length && !/\s/.test(s[j]) && !(stopParen && s[j] === ")")) {
    if (s[j] === '"') { const q = readValue(s, j); return { value: s.slice(i, j) + q.value, end: q.end, quoted: true }; }
    j++;
  }
  return { value: s.slice(i, j), end: j, quoted: false };
}

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let depth = 0;
  const bare = (kind: "(" | ")", pos: number): Tok => ({ kind, neg: false, key: null, raw: kind, op: "", values: [], quoted: false, pos });
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const pos = i + 1;
    // R34: brackets group terms. "(" opens at the start of a term; ")" closes one, and inside brackets a value ends at it.
    if (s[i] === "(") { out.push(bare("(", pos)); depth++; i++; continue; }
    if (s[i] === ")") { out.push(bare(")", pos)); depth--; i++; continue; }
    let neg = false;
    if (s[i] === "-" && i + 1 < s.length && !/[\s\d]/.test(s[i + 1])) { neg = true; i++; }
    const m = /^([a-z]+):/i.exec(s.slice(i));
    if (m) {
      // Operators sit before the value: due:<"2026-10-01" or due:<7d.
      let j = i + m[0].length;
      const om = /^(<=|>=|<|>|=)/.exec(s.slice(j));
      const op = om ? om[1] : "";
      j += op.length;
      // Values: comma separated, each plain or quoted ("needs review",bug), up to the next space.
      const values: string[] = [];
      let cur = ""; let quoted = false;
      while (j < s.length && !/\s/.test(s[j]) && !(depth > 0 && s[j] === ")")) {
        if (s[j] === '"') { const v = readValue(s, j); cur += v.value; quoted = true; j = v.end; continue; }
        if (s[j] === ",") { values.push(cur); cur = ""; j++; continue; }
        cur += s[j++];
      }
      values.push(cur);
      out.push({ neg, key: m[1].toLowerCase(), raw: "", op, values, quoted, pos });
      i = j;
      continue;
    }
    const v = readValue(s, i, depth > 0);
    out.push({ neg, key: null, raw: v.value, op: "", values: [], quoted: v.quoted, pos });
    i = v.end;
  }
  return out;
}

/** True when the text names at least one known key, so it is a query rather than plain search words. */
export function looksLikeQuery(q: string) {
  return [...q.matchAll(/(?:^|[\s(-])([a-z]+):/gi)].some((m) => KEY_SET.has(m[1].toLowerCase())) || HISTORY_RE.test(q);
}
/** R34: `status WAS`, `assignee CHANGED` (the operator words are upper case, as in the docs). */
const HISTORY_RE = /(?:^|[\s(-])(status|assignee|priority)\s+(WAS|CHANGED)(?=\s|$|\))/;
const BOOL_WORDS = new Set(["OR", "AND", "NOT"]);
const HISTORY_WORDS = new Set(["FROM", "TO", "AFTER", "BEFORE", "BY"]);

function checkValue(key: QueryKey, v: string, op: QueryOp, pos: number) {
  const lower = v.toLowerCase();
  const oneOf = (list: readonly string[], what: string) => { if (!list.includes(lower)) throw new TaskQueryError(`${key} takes ${what}, not "${v}"`, pos); };
  switch (key) {
    case "priority": return oneOf(Object.keys(PRIORITY_RANK), "urgent, high, medium, low or none");
    case "type": return oneOf(QUERY_TYPES, "task, story, bug or epic");
    case "has": return oneOf(QUERY_HAS, QUERY_HAS.join(", "));
    case "is": return oneOf(QUERY_IS, QUERY_IS.join(", "));
    case "due": case "created": case "updated":
      if (lower === "none" && key === "due" && op === "=") return;
      if (!DATE_VALUE.test(v)) throw new TaskQueryError(`${key} takes a date like 2026-10-01, today or 7d, not "${v}"`, pos);
      if (/^\d{4}/.test(v)) {
        const d = new Date(`${v}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new TaskQueryError(`"${v}" is not a real date`, pos);
      }
      return;
    case "points":
      if (lower === "none" && op === "=") return;
      if (!/^\d+(\.\d+)?$/.test(v)) throw new TaskQueryError(`points takes a number or none, not "${v}"`, pos);
      return;
    default:
      if (v.length > 200) throw new TaskQueryError("A value is longer than 200 characters", pos);
  }
}

/** One term token as a term (the R26 checks). */
function termOf(t: Tok): QueryTerm {
  const pos = t.pos;
  const negate = t.neg;
  if (t.key === null) {
    if (!t.raw) throw new TaskQueryError("An empty term", pos);
    return { kind: "text", value: t.raw, negate, pos };
  }
  if (!KEY_SET.has(t.key)) throw new TaskQueryError(`Unknown key "${t.key}". Keys: ${QUERY_KEYS.map((x) => x.key).join(", ")}`, pos);
  const key = t.key as QueryKey;
  const op = (t.op || "=") as QueryOp;
  if (op !== "=" && !COMPARE.has(key)) throw new TaskQueryError(`${key} does not take ${op}`, pos);
  if (t.values.length === 1 && !t.values[0].trim()) throw new TaskQueryError(`${key} needs a value`, pos);
  const list = t.values.map((x) => x.trim());
  if (list.some((x) => !x)) throw new TaskQueryError("An empty value", pos);
  if (op !== "=" && list.length > 1) throw new TaskQueryError(`${key}${op} takes one value`, pos);
  for (const v of list) checkValue(key, v, op, pos);
  return { kind: "field", key, op, values: list, negate, pos };
}

const isWord = (t: Tok | undefined, words: Set<string>) => !!t && !t.kind && t.key === null && !t.quoted && !t.neg && words.has(t.raw);
const listOf = (t: Tok) => (t.quoted ? [t.raw] : t.raw.split(",")).map((x) => x.trim());

/**
 * R34: `status WAS doing`, `assignee WAS me`, `status CHANGED`, `status CHANGED FROM todo TO doing AFTER -7d BEFORE
 * 2026-10-01 BY me`. Reads from toks[i] (the key word); answers the term and the next index.
 */
function historyAt(toks: Tok[], i: number): { term: HistoryTerm; next: number } {
  const head = toks[i];
  const key = head.raw.toLowerCase() as HistoryKey;
  const opTok = toks[i + 1];
  const op = opTok.raw === "WAS" ? "was" : "changed";
  const term: HistoryTerm = { kind: "history", key, op, values: [], negate: head.neg, pos: head.pos };
  let j = i + 2;
  const valueAfter = (word: Tok, what: string) => {
    const v = toks[j];
    if (!v || v.kind || v.key !== null || isWord(v, BOOL_WORDS) || isWord(v, HISTORY_WORDS) || !v.raw.trim()) throw new TaskQueryError(`${what} needs a value`, word.pos + word.raw.length);
    j++;
    return v;
  };
  const checkList = (list: string[], at: number) => {
    if (list.some((x) => !x)) throw new TaskQueryError("An empty value", at);
    for (const v of list) {
      if (key === "priority") checkValue("priority", v, "=", at);
      else if (v.length > 200) throw new TaskQueryError("A value is longer than 200 characters", at);
    }
    return list;
  };
  if (op === "was") {
    const v = valueAfter(opTok, `${key} WAS`);
    term.values = checkList(listOf(v), v.pos);
  }
  const seen = new Set<string>();
  while (isWord(toks[j], HISTORY_WORDS)) {
    const w = toks[j++];
    if (op === "was") throw new TaskQueryError(`WAS takes no ${w.raw}. Use ${key} CHANGED TO`, w.pos);
    if (seen.has(w.raw)) throw new TaskQueryError(`${w.raw} is given twice`, w.pos);
    seen.add(w.raw);
    const v = valueAfter(w, w.raw);
    if (w.raw === "FROM") {
      if (key !== "status") throw new TaskQueryError(`FROM works with status only; ${key} keeps the new value. Use ${key} CHANGED TO`, w.pos);
      term.from = checkList(listOf(v), v.pos);
    } else if (w.raw === "TO") term.to = checkList(listOf(v), v.pos);
    else if (w.raw === "BY") {
      if (v.raw.includes(",")) throw new TaskQueryError("BY takes one person", v.pos);
      term.by = v.raw.trim();
    } else {
      checkValue("created", v.raw, "=", v.pos);
      if (w.raw === "AFTER") term.after = v.raw; else term.before = v.raw;
    }
  }
  return { term, next: j };
}

/** Parses a query. Throws TaskQueryError with the character position of the problem. */
export function parseTaskQuery(input: string): ParsedQuery {
  const q = input ?? "";
  if (q.length > QUERY_MAX_LENGTH) throw new TaskQueryError(`A query is at most ${QUERY_MAX_LENGTH} characters`, QUERY_MAX_LENGTH + 1);
  if (!q.trim()) return { terms: [], plain: true };
  if (!looksLikeQuery(q) && !/(^|\s)-?"/.test(q)) return { terms: [{ kind: "text", value: q.trim(), negate: false, pos: q.search(/\S/) + 1 }], plain: true };
  const toks = tokens(q);
  const terms: QueryTerm[] = [];
  let values = 0;
  let cost = 0;
  let structured = false;
  const add = (t: QueryTerm) => {
    terms.push(t);
    values += t.kind === "text" ? 1 : t.kind === "history" ? Math.max(1, t.values.length + (t.from?.length ?? 0) + (t.to?.length ?? 0)) : t.values.length;
    if (terms.length > QUERY_MAX_TERMS) throw new TaskQueryError(`A query holds at most ${QUERY_MAX_TERMS} terms`, t.pos);
    if (values > QUERY_MAX_VALUES) throw new TaskQueryError(`A query holds at most ${QUERY_MAX_VALUES} values`, t.pos);
    cost += termCost(t);
    if (cost > QUERY_MAX_COST) throw new TaskQueryError("This query has too many values to run at once. Use fewer names or values", t.pos);
    return t;
  };

  // Recursive descent: OR binds loosest, then AND (also implied between neighbours), then NOT and a leading minus.
  let i = 0;
  const end = q.length + 1;
  const where = () => toks[i]?.pos ?? end;
  const primary = (): QueryNode => {
    const t = toks[i];
    if (!t) throw new TaskQueryError("Expected a term", end);
    if (t.kind === "(") {
      structured = true;
      i++;
      if (toks[i]?.kind === ")") throw new TaskQueryError("Empty brackets", toks[i].pos);
      const inner = orExpr();
      if (toks[i]?.kind !== ")") throw new TaskQueryError("Expected )", where());
      i++;
      return inner;
    }
    if (t.kind === ")") throw new TaskQueryError("Unexpected )", t.pos);
    if (isWord(t, BOOL_WORDS)) throw new TaskQueryError(`Expected a term before ${t.raw}`, t.pos);
    if (!t.kind && t.key === null && !t.quoted && (HISTORY_KEYS as readonly string[]).includes(t.raw.toLowerCase()) && (toks[i + 1]?.raw === "WAS" || toks[i + 1]?.raw === "CHANGED") && !toks[i + 1]?.quoted) {
      const h = historyAt(toks, i);
      i = h.next;
      return { op: "term", term: add(h.term) };
    }
    i++;
    return { op: "term", term: add(termOf(t)) };
  };
  const unary = (): QueryNode => {
    if (isWord(toks[i], new Set(["NOT"]))) {
      structured = true;
      const at = toks[i].pos;
      i++;
      if (!toks[i] || toks[i].kind === ")" || isWord(toks[i], BOOL_WORDS)) throw new TaskQueryError("NOT needs a term after it", at + 3);
      return { op: "not", item: unary() };
    }
    return primary();
  };
  const andExpr = (): QueryNode => {
    const items = [unary()];
    while (i < toks.length && toks[i].kind !== ")" && !isWord(toks[i], new Set(["OR"]))) {
      if (isWord(toks[i], new Set(["AND"]))) {
        structured = true;
        const at = toks[i].pos;
        i++;
        if (!toks[i] || toks[i].kind === ")" || isWord(toks[i], BOOL_WORDS)) throw new TaskQueryError("AND needs a term after it", at + 3);
      }
      items.push(unary());
    }
    return items.length === 1 ? items[0] : { op: "and", items };
  };
  const orExpr = (): QueryNode => {
    const items = [andExpr()];
    while (isWord(toks[i], new Set(["OR"]))) {
      structured = true;
      const at = toks[i].pos;
      i++;
      if (!toks[i] || toks[i].kind === ")" || isWord(toks[i], new Set(["OR", "AND"]))) throw new TaskQueryError("OR needs a term after it", at + 2);
      items.push(andExpr());
    }
    return items.length === 1 ? items[0] : { op: "or", items };
  };
  const tree = orExpr();
  if (i < toks.length) throw new TaskQueryError(toks[i].kind === ")" ? "Unexpected )" : "Unexpected term", toks[i].pos);
  return structured ? { terms, plain: false, tree } : { terms, plain: false };
}

/** The day offset or date as a UTC instant range [from, to). Relative values count from `now`; `back` flips unsigned offsets into the past (created, updated). */
export function dateRange(v: string, now: Date, back = false): { from: Date; to: Date; instant: boolean } {
  const day = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const DAY = 86_400_000;
  const lower = v.toLowerCase();
  const today = day(now);
  if (lower === "today") return { from: today, to: new Date(today.getTime() + DAY), instant: false };
  if (lower === "yesterday") return { from: new Date(today.getTime() - DAY), to: today, instant: false };
  if (lower === "tomorrow") return { from: new Date(today.getTime() + DAY), to: new Date(today.getTime() + 2 * DAY), instant: false };
  const rel = /^(-?)(\d+)([dw])$/i.exec(v);
  if (rel) {
    let n = Number(rel[2]) * (rel[3].toLowerCase() === "w" ? 7 : 1);
    if (rel[1] === "-" || back) n = -n;
    const at = new Date(now.getTime() + n * DAY);
    return { from: at, to: at, instant: true };
  }
  const from = new Date(`${v}T00:00:00.000Z`);
  return { from, to: new Date(from.getTime() + DAY), instant: false };
}

/** R34: words after a history key (WAS, CHANGED), after CHANGED (FROM, TO, AFTER, BEFORE, BY) and their values. */
function suggestR34(head: string, w: string, open: string, extra: Partial<Record<QueryKey, string[]>>) {
  const words = head.trim().split(/\s+/);
  const prev = words[words.length - 1] ?? "";
  const clause = [...head.matchAll(/(status|assignee|priority)\s+(WAS|CHANGED)\b/g)].pop();
  const key = (clause?.[1] ?? prev.toLowerCase().replace(/^[(-]+/, "")) as HistoryKey;
  const up = w.toUpperCase();
  const pickFrom = (list: string[], hint?: string) => list.filter((x) => x.toLowerCase().startsWith(w.toLowerCase())).slice(0, 12).map((x) => ({ label: x, insert: `${open}${/[\s,"]/.test(x) ? JSON.stringify(x) : x} `, hint }));
  if ((HISTORY_KEYS as readonly string[]).includes(prev.toLowerCase().replace(/^[(-]+/, ""))) {
    return [["WAS", "now or at any time before"], ["CHANGED", "changed at some point; add FROM, TO, AFTER, BEFORE, BY"]].filter(([o]) => o.startsWith(up)).map(([o, hint]) => ({ label: o, insert: `${o} `, hint }));
  }
  const meta = QUERY_KEYS.find((k) => k.key === key);
  const values = [...(meta?.values ?? []), ...(extra[key as QueryKey] ?? [])].filter((v) => !/^[<>]/.test(v));
  if (prev === "WAS" || prev === "TO" || prev === "FROM") return pickFrom(values);
  if (prev === "BY") return pickFrom(["me", ...(extra.assignee ?? [])]);
  if (prev === "AFTER" || prev === "BEFORE") return pickFrom(["-7d", "-30d", "today", "yesterday"], "a date or days ago");
  if (clause?.[2] === "CHANGED" && /^[A-Z]*$/.test(w)) {
    const used = new Set(head.slice(clause.index).split(/\s+/));
    const hints: Record<string, string> = { FROM: "the value before (status only)", TO: "the value after", AFTER: "changed after a date", BEFORE: "changed before a date", BY: "who changed it" };
    const list = Object.keys(hints).filter((o) => !used.has(o) && (key === "status" || o !== "FROM") && o.startsWith(up));
    if (list.length) return list.map((o) => ({ label: o, insert: `${o} `, hint: hints[o] }));
  }
  return null;
}

/** Autocomplete for the token under the cursor: keys first, then that key's values (with any extra values passed in). */
export function suggest(input: string, cursor: number, extra: Partial<Record<QueryKey, string[]>> = {}): { replaceFrom: number; items: { label: string; insert: string; hint?: string }[] } {
  const before = input.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(" "), -1) + 1;
  const rawWord = before.slice(start);
  // R34: an opening bracket stays in front of what is picked.
  const open = /^\(*/.exec(rawWord)![0];
  const word = rawWord.slice(open.length);
  const neg = word.startsWith("-") ? "-" : "";
  const w = word.slice(neg.length);
  const colon = w.indexOf(":");
  if (colon < 0) {
    const r34 = suggestR34(before.slice(0, start), w, open, extra);
    if (r34) return { replaceFrom: start, items: r34 };
    const items = QUERY_KEYS.filter((k) => k.key.startsWith(w.toLowerCase())).map((k) => ({ label: `${k.key}:`, insert: `${open}${neg}${k.key}:`, hint: k.hint }));
    const ops = before.slice(0, start).trim() && w && !open && !neg ? ["OR", "AND", "NOT"].filter((o) => o.startsWith(w.toUpperCase()) && w.length >= 1).map((o) => ({ label: o, insert: `${o} `, hint: o === "OR" ? "either side matches" : o === "AND" ? "both sides match" : "leaves out what follows" })) : [];
    const hist = !neg ? HISTORY_KEYS.filter((k) => k.startsWith(w.toLowerCase()) && w.length >= 2).map((k) => ({ label: `${k} WAS`, insert: `${open}${k} WAS `, hint: "now or at any time before" })) : [];
    return { replaceFrom: start, items: [...ops, ...items, ...hist] };
  }
  const key = w.slice(0, colon).toLowerCase() as QueryKey;
  const meta = QUERY_KEYS.find((k) => k.key === key);
  if (!meta) return { replaceFrom: start, items: [] };
  const typed = w.slice(colon + 1).toLowerCase();
  const pool = [...(meta.values ?? []), ...(extra[key] ?? [])];
  const seen = new Set<string>();
  const items = pool.filter((v) => { const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return k.startsWith(typed) || (typed.length > 0 && k.includes(typed)); })
    .sort((a, b) => Number(!a.toLowerCase().startsWith(typed)) - Number(!b.toLowerCase().startsWith(typed)))
    .slice(0, 12)
    .map((v) => ({ label: v, insert: `${open}${neg}${key}:${/[\s,"]/.test(v) ? JSON.stringify(v) : v} ` }));
  return { replaceFrom: start, items };
}
