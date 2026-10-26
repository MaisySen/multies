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

export type QueryTerm =
  | { kind: "text"; value: string; negate: boolean; pos: number }
  | { kind: "field"; key: QueryKey; op: QueryOp; values: string[]; negate: boolean; pos: number };

export interface ParsedQuery { terms: QueryTerm[]; plain: boolean }

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
  if (t.kind === "text") return 2;
  return t.values.reduce((n, v) => {
    const l = v.toLowerCase();
    switch (t.key) {
      case "assignee": return n + (l === "none" ? 0 : l === "me" || /^(member|agent):/.test(l) ? 2 : 8);
      case "project": return n + 3;
      case "status": return n + (["todo", "doing", "done", "open"].includes(l) ? 1 : 2);
      case "sprint": return n + 2;
      case "due": case "created": case "updated": return n + 2;
      case "is": return n + 2;
      default: return n + 1;
    }
  }, 0);
}

export const PRIORITY_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };
export const QUERY_TYPES = ["task", "story", "bug", "epic"] as const;
export const QUERY_HAS = ["subtasks", "checklist", "due", "assignee", "labels", "points", "parent", "notes"] as const;
export const QUERY_IS = ["overdue", "open", "done", "unassigned", "subtask", "mine"] as const;

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

interface Tok { neg: boolean; key: string | null; raw: string; op: string; values: string[]; quoted: boolean; pos: number }

/** Reads `s` from i: a quoted string (with \" and \\ escapes) or a run up to whitespace. */
function readValue(s: string, i: number): { value: string; end: number; quoted: boolean } {
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
  while (j < s.length && !/\s/.test(s[j])) {
    if (s[j] === '"') { const q = readValue(s, j); return { value: s.slice(i, j) + q.value, end: q.end, quoted: true }; }
    j++;
  }
  return { value: s.slice(i, j), end: j, quoted: false };
}

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    const pos = i + 1;
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
      while (j < s.length && !/\s/.test(s[j])) {
        if (s[j] === '"') { const v = readValue(s, j); cur += v.value; quoted = true; j = v.end; continue; }
        if (s[j] === ",") { values.push(cur); cur = ""; j++; continue; }
        cur += s[j++];
      }
      values.push(cur);
      out.push({ neg, key: m[1].toLowerCase(), raw: "", op, values, quoted, pos });
      i = j;
      continue;
    }
    const v = readValue(s, i);
    out.push({ neg, key: null, raw: v.value, op: "", values: [], quoted: v.quoted, pos });
    i = v.end;
  }
  return out;
}

/** True when the text names at least one known key, so it is a query rather than plain search words. */
export function looksLikeQuery(q: string) {
  return [...q.matchAll(/(?:^|[\s-])([a-z]+):/gi)].some((m) => KEY_SET.has(m[1].toLowerCase()));
}

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

/** Parses a query. Throws TaskQueryError with the character position of the problem. */
export function parseTaskQuery(input: string): ParsedQuery {
  const q = input ?? "";
  if (q.length > QUERY_MAX_LENGTH) throw new TaskQueryError(`A query is at most ${QUERY_MAX_LENGTH} characters`, QUERY_MAX_LENGTH + 1);
  if (!q.trim()) return { terms: [], plain: true };
  if (!looksLikeQuery(q) && !/(^|\s)-?"/.test(q)) return { terms: [{ kind: "text", value: q.trim(), negate: false, pos: q.search(/\S/) + 1 }], plain: true };
  const terms: QueryTerm[] = [];
  let values = 0;
  let cost = 0;
  for (const t of tokens(q)) {
    const pos = t.pos;
    const negate = t.neg;
    if (t.key === null) {
      if (!t.raw) throw new TaskQueryError("An empty term", pos);
      terms.push({ kind: "text", value: t.raw, negate, pos });
      values++;
    } else {
      if (!KEY_SET.has(t.key)) throw new TaskQueryError(`Unknown key "${t.key}". Keys: ${QUERY_KEYS.map((x) => x.key).join(", ")}`, pos);
      const key = t.key as QueryKey;
      const op = (t.op || "=") as QueryOp;
      if (op !== "=" && !COMPARE.has(key)) throw new TaskQueryError(`${key} does not take ${op}`, pos);
      if (t.values.length === 1 && !t.values[0].trim()) throw new TaskQueryError(`${key} needs a value`, pos);
      const list = t.values.map((x) => x.trim());
      if (list.some((x) => !x)) throw new TaskQueryError("An empty value", pos);
      if (op !== "=" && list.length > 1) throw new TaskQueryError(`${key}${op} takes one value`, pos);
      for (const v of list) checkValue(key, v, op, pos);
      terms.push({ kind: "field", key, op, values: list, negate, pos });
      values += list.length;
    }
    if (terms.length > QUERY_MAX_TERMS) throw new TaskQueryError(`A query holds at most ${QUERY_MAX_TERMS} terms`, pos);
    if (values > QUERY_MAX_VALUES) throw new TaskQueryError(`A query holds at most ${QUERY_MAX_VALUES} values`, pos);
    cost += termCost(terms[terms.length - 1]);
    if (cost > QUERY_MAX_COST) throw new TaskQueryError("This query has too many values to run at once. Use fewer names or values", pos);
  }
  return { terms, plain: false };
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

/** Autocomplete for the token under the cursor: keys first, then that key's values (with any extra values passed in). */
export function suggest(input: string, cursor: number, extra: Partial<Record<QueryKey, string[]>> = {}): { replaceFrom: number; items: { label: string; insert: string; hint?: string }[] } {
  const before = input.slice(0, cursor);
  const start = Math.max(before.lastIndexOf(" "), -1) + 1;
  const word = before.slice(start);
  const neg = word.startsWith("-") ? "-" : "";
  const w = word.slice(neg.length);
  const colon = w.indexOf(":");
  if (colon < 0) {
    const items = QUERY_KEYS.filter((k) => k.key.startsWith(w.toLowerCase())).map((k) => ({ label: `${k.key}:`, insert: `${neg}${k.key}:`, hint: k.hint }));
    return { replaceFrom: start, items };
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
    .map((v) => ({ label: v, insert: `${neg}${key}:${/[\s,"]/.test(v) ? JSON.stringify(v) : v} ` }));
  return { replaceFrom: start, items };
}
