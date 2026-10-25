/**
 * R24.1 Formula fields: a small, safe expression language, read by hand (tokenizer, recursive
 * descent parser and a tree walking evaluator). There is no eval, no Function constructor and no
 * property access syntax, so a formula can only reach the values and functions listed here. There
 * are no loops, so every formula ends. Limits: 500 characters, 300 tokens, a tree depth of 32.
 *
 * Type rules in plain words:
 *   - Values are numbers, text, true or false, or empty (null). Dates are text like 2026-11-02.
 *   - + adds numbers; when either side is text it joins them as text (empty joins as nothing).
 *   - - * / % need numbers. An empty side makes the answer empty. Dividing by 0 is an error.
 *   - = == != <> compare any two values. < > <= >= compare two numbers or two texts; with an
 *     empty side the answer is false.
 *   - and, or, not (also &&, ||, !) treat empty, 0, "" and false as false, anything else as true.
 *   - {Name} reads a custom field by name (any case) or a built in: points, due, start, created,
 *     completed, status, priority, title, assignee. Built ins can also be written bare: points * 2.
 */

export type FValue = number | string | boolean | null;

export const MAX_LENGTH = 500;
export const MAX_DEPTH = 32;
export const MAX_TOKENS = 300;
const MAX_TEXT = 2000;
const DAY = 86_400_000;

export class FormulaError extends Error {
  constructor(message: string) { super(message); this.name = "FormulaError"; }
}

type Tok =
  | { k: "num"; v: number; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "ref"; v: string; at: number }
  | { k: "id"; v: string; at: number }
  | { k: "op"; v: string; at: number };

export type Node =
  | { t: "lit"; v: FValue }
  | { t: "ref"; name: string; braced: boolean }
  | { t: "call"; name: string; args: Node[] }
  | { t: "un"; op: "-" | "not"; x: Node }
  | { t: "bin"; op: string; l: Node; r: Node };

const OPS = ["==", "!=", "<>", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "(", ")", ",", "<", ">", "=", "!"];

export function tokenize(src: string): Tok[] {
  if (typeof src !== "string") throw new FormulaError("A formula is text.");
  if (src.length > MAX_LENGTH) throw new FormulaError(`A formula can be up to ${MAX_LENGTH} characters.`);
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if ((c >= "0" && c <= "9") || (c === "." && src[i + 1] >= "0" && src[i + 1] <= "9")) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ k: "num", v: Number(m[0]), at: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let s = "";
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new FormulaError(`Text starting at ${i + 1} is not closed.`);
        const d = src[j];
        if (d === c) break;
        if (d === "\\") {
          const e = src[j + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : (e ?? "");
          j += 2;
        } else { s += d; j++; }
      }
      out.push({ k: "str", v: s, at: i });
      i = j + 1;
    } else if (c === "{") {
      const j = src.indexOf("}", i);
      if (j < 0) throw new FormulaError(`A field name starting at ${i + 1} has no closing }.`);
      const name = src.slice(i + 1, j).trim();
      if (!name) throw new FormulaError("Empty field name {}.");
      out.push({ k: "ref", v: name, at: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ k: "id", v: m[0], at: i });
      i += m[0].length;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) throw new FormulaError(`Unexpected "${c}" at ${i + 1}.`);
      out.push({ k: "op", v: op, at: i });
      i += op.length;
    }
    if (out.length > MAX_TOKENS) throw new FormulaError("This formula is too long.");
  }
  return out;
}

/** Parses a formula into a tree. Throws FormulaError with a plain message. */
export function parse(src: string): Node {
  const toks = tokenize(src);
  if (!toks.length) throw new FormulaError("The formula is empty.");
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => { const t = toks[p]; return !!t && t.k === "op" && t.v === v; };
  const isWord = (v: string) => { const t = toks[p]; return !!t && t.k === "id" && t.v.toLowerCase() === v; };
  const enter = () => { if (++depth > MAX_DEPTH) throw new FormulaError(`This formula nests too deeply (more than ${MAX_DEPTH} levels).`); };
  const leave = () => { depth--; };
  const where = () => (peek() ? ` at ${peek().at + 1}` : " at the end");

  function orExpr(): Node {
    enter();
    let l = andExpr();
    while (isOp("||") || isWord("or")) { p++; l = { t: "bin", op: "or", l, r: andExpr() }; }
    leave();
    return l;
  }
  function andExpr(): Node {
    enter();
    let l = notExpr();
    while (isOp("&&") || isWord("and")) { p++; l = { t: "bin", op: "and", l, r: notExpr() }; }
    leave();
    return l;
  }
  function notExpr(): Node {
    enter();
    let n: Node;
    if (isOp("!") || isWord("not")) { p++; n = { t: "un", op: "not", x: notExpr() }; } else n = cmpExpr();
    leave();
    return n;
  }
  function cmpExpr(): Node {
    enter();
    let l = addExpr();
    for (;;) {
      const t = peek();
      if (t && t.k === "op" && ["=", "==", "!=", "<>", "<", ">", "<=", ">="].includes(t.v)) {
        p++;
        const op = t.v === "=" ? "==" : t.v === "<>" ? "!=" : t.v;
        l = { t: "bin", op, l, r: addExpr() };
      } else break;
    }
    leave();
    return l;
  }
  function addExpr(): Node {
    enter();
    let l = mulExpr();
    while (isOp("+") || isOp("-")) { const op = (toks[p++] as { v: string }).v; l = { t: "bin", op, l, r: mulExpr() }; }
    leave();
    return l;
  }
  function mulExpr(): Node {
    enter();
    let l = unary();
    while (isOp("*") || isOp("/") || isOp("%")) { const op = (toks[p++] as { v: string }).v; l = { t: "bin", op, l, r: unary() }; }
    leave();
    return l;
  }
  function unary(): Node {
    enter();
    let n: Node;
    if (isOp("-")) { p++; n = { t: "un", op: "-", x: unary() }; } else if (isOp("+")) { p++; n = unary(); } else n = primary();
    leave();
    return n;
  }
  function primary(): Node {
    enter();
    const t = peek();
    if (!t) throw new FormulaError("The formula ends too early.");
    let n: Node;
    if (t.k === "num") { p++; n = { t: "lit", v: t.v }; }
    else if (t.k === "str") { p++; n = { t: "lit", v: t.v }; }
    else if (t.k === "ref") { p++; n = { t: "ref", name: t.v, braced: true }; }
    else if (t.k === "op" && t.v === "(") {
      p++;
      n = orExpr();
      if (!isOp(")")) throw new FormulaError(`Missing )${where()}.`);
      p++;
    } else if (t.k === "id") {
      p++;
      const w = t.v.toLowerCase();
      if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(orExpr());
            if (args.length > 50) throw new FormulaError("Too many values in one function.");
            if (isOp(",")) { p++; continue; }
            break;
          }
        }
        if (!isOp(")")) throw new FormulaError(`Missing ) after ${t.v}(${where()}.`);
        p++;
        if (!FUNCTIONS.has(w)) throw new FormulaError(`Unknown function "${t.v}".`);
        const arity = FUNCTIONS.get(w)!.arity;
        if (args.length < arity[0] || args.length > arity[1]) {
          throw new FormulaError(arity[0] === arity[1] ? `${w} takes ${arity[0]} value${arity[0] === 1 ? "" : "s"}.` : `${w} takes ${arity[0]} to ${arity[1] === Infinity ? "any number of" : arity[1]} values.`);
        }
        n = { t: "call", name: w, args };
      } else if (w === "true" || w === "false") n = { t: "lit", v: w === "true" };
      else if (w === "null" || w === "empty") n = { t: "lit", v: null };
      else n = { t: "ref", name: t.v, braced: false };
    } else throw new FormulaError(`Unexpected "${t.v}"${where()}.`);
    leave();
    return n;
  }

  const tree = orExpr();
  if (p < toks.length) throw new FormulaError(`Unexpected "${String(toks[p].v)}" at ${toks[p].at + 1}.`);
  return tree;
}

/** The field names a formula reads, braced or bare, lower case. */
export function references(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === "ref") out.add(n.name.toLowerCase());
  else if (n.t === "call") n.args.forEach((a) => references(a, out));
  else if (n.t === "un") references(n.x, out);
  else if (n.t === "bin") { references(n.l, out); references(n.r, out); }
  return out;
}

// ---------------------------------------------------------------- evaluation

export interface EvalContext {
  /** The value for a name. `braced` is true for {Name}. Throw FormulaError for an unknown name. */
  resolve(name: string, braced: boolean): FValue;
  now: Date;
}

const truthy = (v: FValue) => !(v === null || v === false || v === 0 || v === "" || (typeof v === "number" && Number.isNaN(v)));
const show = (v: FValue) => (v === null ? "empty" : typeof v === "string" ? "text" : typeof v === "boolean" ? "true or false" : "a number");
const asText = (v: FValue) => (v === null ? "" : typeof v === "number" ? String(tidy(v)) : String(v));
const clampText = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s);

/** Rounds float noise away (0.1 + 0.2 shows as 0.3). */
export function tidy(n: number) { return Number.isFinite(n) ? Number(n.toPrecision(12)) : n; }

function num(v: FValue, fn: string): number | null {
  if (v === null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw new FormulaError(`${fn} needs a number, got ${show(v)}.`);
}
function needNum(v: FValue, fn: string): number {
  const n = num(v, fn);
  if (n === null) throw new FormulaError(`${fn} needs a number, got empty.`);
  return n;
}
/** A date value (YYYY-MM-DD or a full ISO time) as milliseconds, or null when empty. */
function dateMs(v: FValue, fn: string): number | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new FormulaError(`${fn} needs a date like 2026-11-02, got ${show(v)}.`);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) throw new FormulaError(`${fn} needs a date like 2026-11-02, got "${v.slice(0, 20)}".`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) throw new FormulaError(`${fn}: "${v.slice(0, 20)}" is not a date.`);
  return t;
}
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

interface Fn { arity: [number, number]; lazy?: boolean; run: (args: FValue[], ctx: EvalContext) => FValue }

const numbers = (args: FValue[], fn: string) => args.map((a) => num(a, fn)).filter((x): x is number => x !== null);

const FUNCTIONS = new Map<string, Fn>([
  ["if", { arity: [2, 3], lazy: true, run: () => null }],
  ["round", { arity: [1, 2], run: ([x, d]) => {
    const n = num(x, "round");
    if (n === null) return null;
    const places = d === undefined || d === null ? 0 : Math.max(0, Math.min(10, Math.trunc(needNum(d, "round"))));
    const f = 10 ** places;
    return Math.round((n + Number.EPSILON) * f) / f;
  } }],
  ["floor", { arity: [1, 1], run: ([x]) => { const n = num(x, "floor"); return n === null ? null : Math.floor(n); } }],
  ["ceil", { arity: [1, 1], run: ([x]) => { const n = num(x, "ceil"); return n === null ? null : Math.ceil(n); } }],
  ["abs", { arity: [1, 1], run: ([x]) => { const n = num(x, "abs"); return n === null ? null : Math.abs(n); } }],
  ["min", { arity: [1, 50], run: (a) => { const n = numbers(a, "min"); return n.length ? Math.min(...n) : null; } }],
  ["max", { arity: [1, 50], run: (a) => { const n = numbers(a, "max"); return n.length ? Math.max(...n) : null; } }],
  ["sum", { arity: [1, 50], run: (a) => numbers(a, "sum").reduce((s, x) => s + x, 0) }],
  ["concat", { arity: [1, 50], run: (a) => clampText(a.map(asText).join("")) }],
  ["len", { arity: [1, 1], run: ([x]) => asText(x).length }],
  ["upper", { arity: [1, 1], run: ([x]) => (x === null ? null : asText(x).toUpperCase()) }],
  ["lower", { arity: [1, 1], run: ([x]) => (x === null ? null : asText(x).toLowerCase()) }],
  ["days_between", { arity: [2, 2], run: ([a, b]) => {
    const x = dateMs(a, "days_between"); const y = dateMs(b, "days_between");
    return x === null || y === null ? null : Math.round((y - x) / DAY);
  } }],
  ["today", { arity: [0, 0], run: (_a, ctx) => isoDay(ctx.now.getTime()) }],
  ["now", { arity: [0, 0], run: (_a, ctx) => ctx.now.toISOString() }],
  ["date_add", { arity: [2, 2], run: ([d, n]) => {
    const t = dateMs(d, "date_add");
    const k = num(n, "date_add");
    if (t === null || k === null) return null;
    if (Math.abs(k) > 100_000) throw new FormulaError("date_add: that is too many days.");
    return isoDay(t + Math.trunc(k) * DAY);
  } }],
  ["is_empty", { arity: [1, 1], run: ([x]) => x === null || x === "" }],
  ["coalesce", { arity: [1, 50], run: (a) => a.find((x) => x !== null && x !== "") ?? null }],
]);
export const FUNCTION_NAMES = [...FUNCTIONS.keys()];

function compare(op: string, l: FValue, r: FValue): boolean {
  if (op === "==" || op === "!=") {
    let eq: boolean;
    if (typeof l === "number" && typeof r === "string" && r.trim() !== "" && Number.isFinite(Number(r))) eq = l === Number(r);
    else if (typeof r === "number" && typeof l === "string" && l.trim() !== "" && Number.isFinite(Number(l))) eq = r === Number(l);
    else if (typeof l === "string" && typeof r === "string") eq = l.toLowerCase() === r.toLowerCase();
    else eq = l === r || (l === null && r === "") || (l === "" && r === null);
    return op === "==" ? eq : !eq;
  }
  if (l === null || r === null) return false;
  let a: number | string; let b: number | string;
  if (typeof l === "number" && typeof r === "number") { a = l; b = r; }
  else if (typeof l === "string" && typeof r === "string") { a = l; b = r; }
  else throw new FormulaError(`Can't compare ${show(l)} with ${show(r)} using ${op}.`);
  return op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
}

/** Evaluates a parsed formula. Throws FormulaError; the caller turns it into a #ERROR cell. */
export function evaluate(n: Node, ctx: EvalContext): FValue {
  switch (n.t) {
    case "lit": return n.v;
    case "ref": return ctx.resolve(n.name, n.braced);
    case "un": {
      const v = evaluate(n.x, ctx);
      if (n.op === "not") return !truthy(v);
      const x = num(v, "-");
      return x === null ? null : -x;
    }
    case "bin": {
      if (n.op === "and") return truthy(evaluate(n.l, ctx)) && truthy(evaluate(n.r, ctx));
      if (n.op === "or") return truthy(evaluate(n.l, ctx)) || truthy(evaluate(n.r, ctx));
      const l = evaluate(n.l, ctx); const r = evaluate(n.r, ctx);
      if (n.op === "+" && (typeof l === "string" || typeof r === "string")) return clampText(asText(l) + asText(r));
      if (["==", "!=", "<", ">", "<=", ">="].includes(n.op)) return compare(n.op, l, r);
      if (typeof l === "boolean" || typeof r === "boolean") throw new FormulaError(`${n.op} needs numbers, got true or false.`);
      const a = num(l, n.op); const b = num(r, n.op);
      if (a === null || b === null) return null;
      switch (n.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0) throw new FormulaError("Division by zero."); return a / b;
        case "%": if (b === 0) throw new FormulaError("Division by zero."); return a % b;
      }
      throw new FormulaError(`Unknown operator ${n.op}.`);
    }
    case "call": {
      const fn = FUNCTIONS.get(n.name)!;
      if (n.name === "if") return truthy(evaluate(n.args[0], ctx)) ? evaluate(n.args[1], ctx) : n.args[2] ? evaluate(n.args[2], ctx) : null;
      const out = fn.run(n.args.map((a) => evaluate(a, ctx)), ctx);
      if (typeof out === "number" && !Number.isFinite(out)) throw new FormulaError("The answer is not a finite number.");
      return out;
    }
  }
}

/** Parses and evaluates in one go; a result with an error never throws. */
export function run(src: string, ctx: EvalContext): { value: FValue; error?: string } {
  try {
    const v = evaluate(parse(src), ctx);
    return { value: typeof v === "number" ? tidy(v) : v };
  } catch (e) {
    if (e instanceof FormulaError) return { value: null, error: e.message };
    if (e instanceof RangeError) return { value: null, error: "This formula is too complex." };
    throw e;
  }
}
