/**
 * R113 Office files: the sheet model and its formula engine (our own code). A workbook is a list of sheets; a cell
 * keeps what the person typed (a value, or a formula without its "=") and the engine works out what it shows.
 * Formulas: SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, IF, ROUND, ABS, AND, OR, NOT, CONCAT, cell refs ($ allowed),
 * ranges (A1:B3, A:A), other sheets (Sheet2!A1, 'My sheet'!A1:B2), + - * / ^ & % and = <> < > <= >=.
 */
export type CellValue = string | number | boolean | null;
export interface Cell { v?: CellValue; f?: string; date?: boolean }
export interface Sheet { name: string; cells: Map<string, Cell>; rowCount: number; colCount: number; colWidths?: Record<number, number> }
export interface Workbook { sheets: Sheet[] }

/** Caps, said plainly in the editor. */
export const SHEET_CAPS = { rows: 5000, cols: 100, cells: 200_000, sheets: 20, rangeCells: 100_000, depth: 64 } as const;

export class FErr { constructor(public readonly code: "#DIV/0!" | "#REF!" | "#NAME?" | "#VALUE!" | "#CYCLE!" | "#N/A" | "#NUM!") {} }
export type Val = number | string | boolean | null | FErr;

export function colName(c: number): string {
  let s = ""; let n = c + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export const addr = (r: number, c: number) => `${colName(c)}${r + 1}`;
export function parseAddr(a: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(a.trim());
  if (!m) return null;
  const r = Number(m[2]) - 1; const c = colIndex(m[1]);
  return r >= 0 && c >= 0 && c < 16384 ? { r, c } : null;
}

/** What a typed entry means: "=..." a formula, a number, TRUE/FALSE, or text ("'" keeps it text). */
export function parseInput(raw: string): Cell {
  const s = String(raw ?? "");
  if (s.startsWith("=") && s.length > 1) return { f: s.slice(1) };
  if (s.startsWith("'")) return { v: s.slice(1) };
  const t = s.trim();
  if (t === "") return {};
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return { v: Number(t) };
  if (/^(true|false)$/i.test(t)) return { v: t.toLowerCase() === "true" };
  return { v: s };
}
/** What the formula bar shows for a cell. */
export function inputOf(cell: Cell | undefined): string {
  if (!cell) return "";
  if (cell.f != null) return `=${cell.f}`;
  if (cell.date && typeof cell.v === "number") return serialToIso(cell.v);
  if (typeof cell.v === "boolean") return cell.v ? "TRUE" : "FALSE";
  return cell.v == null ? "" : String(cell.v);
}
export function serialToIso(n: number): string {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(n);
  const iso = d.toISOString();
  return d.getUTCHours() || d.getUTCMinutes() ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}
export function display(v: Val, date?: boolean): string {
  if (v instanceof FErr) return v.code;
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (date) return serialToIso(v);
    if (!Number.isFinite(v)) return "#NUM!";
    return String(Number(v.toPrecision(15)));
  }
  return v;
}

// ---------- parser ----------
type Ref = { sheet?: string; r: number; c: number };
type Node =
  | { t: "num"; v: number } | { t: "str"; v: string } | { t: "bool"; v: boolean } | { t: "err"; v: FErr }
  | { t: "ref"; ref: Ref } | { t: "range"; sheet?: string; r1: number; c1: number; r2: number; c2: number; cols?: boolean }
  | { t: "un"; op: string; a: Node } | { t: "bin"; op: string; a: Node; b: Node } | { t: "pct"; a: Node }
  | { t: "call"; name: string; args: Node[] };

type Tok = { k: "num" | "str" | "word" | "op" | "sheet" | "lp" | "rp" | "comma" | "colon" | "err"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let s = ""; i++;
      while (i < src.length) { if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } break; } s += src[i++]; }
      if (src[i] !== '"') throw new FErr("#VALUE!");
      i++; out.push({ k: "str", v: s }); continue;
    }
    if (ch === "'") {
      let s = ""; i++;
      while (i < src.length) { if (src[i] === "'") { if (src[i + 1] === "'") { s += "'"; i += 2; continue; } break; } s += src[i++]; }
      if (src[i] !== "'" || src[i + 1] !== "!") throw new FErr("#REF!");
      i += 2; out.push({ k: "sheet", v: s }); continue;
    }
    if (ch === "#") { const m = /^#(DIV\/0!|REF!|NAME\?|VALUE!|N\/A|NUM!|CYCLE!)/i.exec(src.slice(i)); if (!m) throw new FErr("#NAME?"); out.push({ k: "err", v: m[0].toUpperCase() }); i += m[0].length; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
    if (num && !/^[A-Za-z_$]/.test(src.slice(i + num[0].length)) ) { out.push({ k: "num", v: num[0] }); i += num[0].length; continue; }
    const w = /^[A-Za-z_$][A-Za-z0-9_.$]*|^\d+[A-Za-z_][A-Za-z0-9_.$]*/.exec(src.slice(i));
    if (w) {
      i += w[0].length;
      if (src[i] === "!") { out.push({ k: "sheet", v: w[0] }); i++; continue; }
      out.push({ k: "word", v: w[0] }); continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { out.push({ k: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>%".includes(ch)) { out.push({ k: "op", v: ch }); i++; continue; }
    if (ch === "(") { out.push({ k: "lp", v: ch }); i++; continue; }
    if (ch === ")") { out.push({ k: "rp", v: ch }); i++; continue; }
    if (ch === "," || ch === ";") { out.push({ k: "comma", v: ch }); i++; continue; }
    if (ch === ":") { out.push({ k: "colon", v: ch }); i++; continue; }
    throw new FErr("#NAME?");
  }
  return out;
}

const BIN: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

export function parseFormula(src: string): Node {
  const toks = tokenize(src); let p = 0; let depth = 0;
  const peek = () => toks[p];
  const expr = (min: number): Node => {
    if (++depth > SHEET_CAPS.depth) throw new FErr("#VALUE!");
    let left = unary();
    for (;;) {
      const t = peek();
      if (!t || t.k !== "op" || !(t.v in BIN) || BIN[t.v] < min) break;
      p++;
      const prec = BIN[t.v];
      const right = expr(prec + 1);
      left = { t: "bin", op: t.v, a: left, b: right };
    }
    depth--;
    return left;
  };
  const unary = (): Node => {
    const t = peek();
    if (t && t.k === "op" && (t.v === "-" || t.v === "+")) { p++; return { t: "un", op: t.v, a: unary() }; }
    let n = primary();
    while (peek()?.k === "op" && peek().v === "%") { p++; n = { t: "pct", a: n }; }
    return n;
  };
  const refOrRange = (sheet: string | undefined, word: string): Node => {
    const a = parseAddr(word);
    const colOnly = /^\$?[A-Za-z]{1,3}$/.test(word);
    if (peek()?.k === "colon") {
      p++;
      const t2 = toks[p++];
      if (!t2 || t2.k !== "word") throw new FErr("#REF!");
      if (colOnly && /^\$?[A-Za-z]{1,3}$/.test(t2.v)) {
        const c1 = colIndex(word.replace(/\$/g, "")); const c2 = colIndex(t2.v.replace(/\$/g, ""));
        return { t: "range", sheet, r1: 0, c1: Math.min(c1, c2), r2: SHEET_CAPS.rows - 1, c2: Math.max(c1, c2), cols: true };
      }
      const b = parseAddr(t2.v);
      if (!a || !b) throw new FErr("#REF!");
      return { t: "range", sheet, r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
    }
    if (!a) throw new FErr("#NAME?");
    return { t: "ref", ref: { sheet, r: a.r, c: a.c } };
  };
  const primary = (): Node => {
    const t = toks[p++];
    if (!t) throw new FErr("#VALUE!");
    if (t.k === "num") return { t: "num", v: Number(t.v) };
    if (t.k === "str") return { t: "str", v: t.v };
    if (t.k === "err") return { t: "err", v: new FErr(t.v as FErr["code"]) };
    if (t.k === "lp") { const e = expr(0); if (toks[p++]?.k !== "rp") throw new FErr("#VALUE!"); return e; }
    if (t.k === "sheet") { const w = toks[p++]; if (!w || (w.k !== "word" && w.k !== "num")) throw new FErr("#REF!"); return refOrRange(t.v, w.v); }
    if (t.k === "word") {
      const up = t.v.toUpperCase();
      if (peek()?.k === "lp") {
        p++; const args: Node[] = [];
        if (peek()?.k !== "rp") {
          for (;;) {
            if (peek()?.k === "comma") { args.push({ t: "str", v: "" }); p++; continue; }
            args.push(expr(0));
            if (peek()?.k === "comma") { p++; continue; }
            break;
          }
        }
        if (toks[p++]?.k !== "rp") throw new FErr("#VALUE!");
        return { t: "call", name: up, args };
      }
      if (up === "TRUE" || up === "FALSE") return { t: "bool", v: up === "TRUE" };
      return refOrRange(undefined, t.v);
    }
    throw new FErr("#VALUE!");
  };
  const n = expr(0);
  if (p !== toks.length) throw new FErr("#VALUE!");
  return n;
}

// ---------- evaluation ----------
type RangeVal = { range: Val[]; };
const isRange = (x: unknown): x is RangeVal => !!x && typeof x === "object" && "range" in (x as object);

function toNum(v: Val): number | FErr {
  if (v instanceof FErr) return v;
  if (v == null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const t = v.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return Number(t);
  return new FErr("#VALUE!");
}
const toText = (v: Val): string => (v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? display(v) : (v as string));
function toBool(v: Val): boolean | FErr {
  if (v instanceof FErr) return v;
  if (typeof v === "boolean") return v;
  if (v == null) return false;
  if (typeof v === "number") return v !== 0;
  const u = v.trim().toUpperCase();
  if (u === "TRUE") return true; if (u === "FALSE") return false;
  return new FErr("#VALUE!");
}
function cmp(a: Val, b: Val): number {
  const rank = (x: Val) => (typeof x === "number" || x == null ? 0 : typeof x === "string" ? 1 : 2);
  const an = a == null ? (typeof b === "string" ? "" : typeof b === "boolean" ? false : 0) : a;
  const bn = b == null ? (typeof a === "string" ? "" : typeof a === "boolean" ? false : 0) : b;
  const ra = rank(an), rb = rank(bn);
  if (ra !== rb) return ra - rb;
  if (typeof an === "string") { const x = an.toLowerCase(), y = (bn as string).toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  const x = Number(an), y = Number(bn); return x < y ? -1 : x > y ? 1 : 0;
}

export class Calc {
  private cache = new Map<string, Val>();
  private busy = new Set<string>();
  private parsed = new Map<string, Node | FErr>();
  constructor(private wb: Workbook) {}
  /** Forget everything worked out (call after any edit). */
  reset() { this.cache.clear(); }
  sheetIndex(name: string | undefined, from: number): number {
    if (name == null) return from;
    const i = this.wb.sheets.findIndex((s) => s.name.toLowerCase() === name.toLowerCase());
    return i;
  }
  /** What a cell shows. */
  value(si: number, r: number, c: number): Val {
    const sh = this.wb.sheets[si];
    if (!sh) return new FErr("#REF!");
    const key = `${si}!${r},${c}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const cell = sh.cells.get(addr(r, c));
    if (!cell) return null;
    if (cell.f == null) return cell.v ?? null;
    if (this.busy.has(key)) return new FErr("#CYCLE!");
    this.busy.add(key);
    let out: Val;
    try {
      let node = this.parsed.get(cell.f);
      if (!node) { try { node = parseFormula(cell.f); } catch (e) { node = e instanceof FErr ? e : new FErr("#VALUE!"); } this.parsed.set(cell.f, node); }
      if (node instanceof FErr) out = node;
      else { const v = this.ev(node, si); out = isRange(v) ? (v.range.length === 1 ? v.range[0] : new FErr("#VALUE!")) : v; }
    } catch (e) { out = e instanceof FErr ? e : new FErr("#VALUE!"); }
    finally { this.busy.delete(key); }
    if (out == null) out = 0;
    this.cache.set(key, out);
    return out;
  }
  private ev(n: Node, si: number): Val | RangeVal {
    switch (n.t) {
      case "num": case "str": case "bool": return n.v;
      case "err": return n.v;
      case "ref": { const s = this.sheetIndex(n.ref.sheet, si); if (s < 0) return new FErr("#REF!"); return this.value(s, n.ref.r, n.ref.c); }
      case "range": {
        const s = this.sheetIndex(n.sheet, si); if (s < 0) return new FErr("#REF!");
        const sh = this.wb.sheets[s];
        const r2 = n.cols ? Math.min(n.r2, sh.rowCount - 1) : n.r2;
        const count = (r2 - n.r1 + 1) * (n.c2 - n.c1 + 1);
        if (count > SHEET_CAPS.rangeCells) throw new FErr("#VALUE!");
        const out: Val[] = [];
        for (let r = n.r1; r <= r2; r++) for (let c = n.c1; c <= n.c2; c++) out.push(this.value(s, r, c));
        return { range: out };
      }
      case "pct": { const v = toNum(this.scalar(n.a, si)); return v instanceof FErr ? v : v / 100; }
      case "un": { const v = toNum(this.scalar(n.a, si)); return v instanceof FErr ? v : n.op === "-" ? -v : v; }
      case "bin": {
        const a = this.scalar(n.a, si), b = this.scalar(n.b, si);
        if (a instanceof FErr) return a; if (b instanceof FErr) return b;
        if (n.op === "&") return toText(a) + toText(b);
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const d = cmp(a, b);
          return n.op === "=" ? d === 0 : n.op === "<>" ? d !== 0 : n.op === "<" ? d < 0 : n.op === ">" ? d > 0 : n.op === "<=" ? d <= 0 : d >= 0;
        }
        const x = toNum(a), y = toNum(b);
        if (x instanceof FErr) return x; if (y instanceof FErr) return y;
        if (n.op === "+") return x + y; if (n.op === "-") return x - y; if (n.op === "*") return x * y;
        if (n.op === "/") return y === 0 ? new FErr("#DIV/0!") : x / y;
        const pw = Math.pow(x, y); return Number.isFinite(pw) ? pw : new FErr("#NUM!");
      }
      case "call": return this.call(n.name, n.args, si);
    }
  }
  private scalar(n: Node, si: number): Val {
    const v = this.ev(n, si);
    if (isRange(v)) return v.range.length === 1 ? v.range[0] : new FErr("#VALUE!");
    return v;
  }
  /** Numbers for SUM and friends: a range gives its numbers (text and empty skipped), a direct value is coerced. */
  private nums(args: Node[], si: number, opts: { countAll?: boolean } = {}): number[] | FErr {
    const out: number[] = [];
    for (const a of args) {
      const raw = this.ev(a, si);
      const v = a.t === "ref" && !(raw instanceof FErr) ? { range: [raw] } : raw;
      if (isRange(v)) {
        for (const x of v.range) {
          if (x instanceof FErr) return x;
          if (typeof x === "number") out.push(x);
          else if (opts.countAll && x != null && x !== "") out.push(1);
        }
      } else {
        if (v instanceof FErr) return v;
        if (opts.countAll) { if (v != null && v !== "") out.push(1); continue; }
        const x = toNum(v as Val); if (x instanceof FErr) return x; out.push(x);
      }
    }
    return out;
  }
  private call(name: string, args: Node[], si: number): Val {
    const need = (min: number, max = Infinity) => { if (args.length < min || args.length > max) throw new FErr("#VALUE!"); };
    switch (name) {
      case "SUM": { const n = this.nums(args, si); return n instanceof FErr ? n : n.reduce((s, x) => s + x, 0); }
      case "AVERAGE": { need(1); const n = this.nums(args, si); if (n instanceof FErr) return n; return n.length ? n.reduce((s, x) => s + x, 0) / n.length : new FErr("#DIV/0!"); }
      case "MIN": { const n = this.nums(args, si); if (n instanceof FErr) return n; return n.length ? n.reduce((m, x) => Math.min(m, x), Infinity) : 0; }
      case "MAX": { const n = this.nums(args, si); if (n instanceof FErr) return n; return n.length ? n.reduce((m, x) => Math.max(m, x), -Infinity) : 0; }
      case "COUNT": {
        let c = 0;
        for (const a of args) { const v = this.ev(a, si); if (isRange(v)) { for (const x of v.range) if (typeof x === "number") c++; } else if (typeof v === "number" || (typeof v === "string" && !(toNum(v) instanceof FErr) && v.trim() !== "")) c++; }
        return c;
      }
      case "COUNTA": { const n = this.nums(args, si, { countAll: true }); return n instanceof FErr ? n : n.length; }
      case "IF": {
        need(1, 3);
        const t = toBool(this.scalar(args[0], si)); if (t instanceof FErr) return t;
        if (t) return args.length > 1 ? this.scalar(args[1], si) : true;
        return args.length > 2 ? this.scalar(args[2], si) : false;
      }
      case "ROUND": {
        need(1, 2);
        const x = toNum(this.scalar(args[0], si)); if (x instanceof FErr) return x;
        const d = args[1] ? toNum(this.scalar(args[1], si)) : 0; if (d instanceof FErr) return d;
        const f = Math.pow(10, Math.trunc(d)); return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f;
      }
      case "ABS": { need(1, 1); const x = toNum(this.scalar(args[0], si)); return x instanceof FErr ? x : Math.abs(x); }
      case "AND": case "OR": {
        need(1); const vals: boolean[] = [];
        for (const a of args) { const v = this.ev(a, si); const list = isRange(v) ? v.range.filter((x) => x != null && x !== "") : [v]; for (const x of list) { const b = toBool(x); if (b instanceof FErr) return b; vals.push(b); } }
        return name === "AND" ? vals.every(Boolean) : vals.some(Boolean);
      }
      case "NOT": { need(1, 1); const b = toBool(this.scalar(args[0], si)); return b instanceof FErr ? b : !b; }
      case "CONCAT": case "CONCATENATE": {
        let s = "";
        for (const a of args) { const v = this.ev(a, si); for (const x of isRange(v) ? v.range : [v]) { if (x instanceof FErr) return x; s += toText(x); } }
        return s;
      }
      default: return new FErr("#NAME?");
    }
  }
}

/** Moves the relative refs of a formula by a number of rows and columns (shared formulas in XLSX files). */
export function shiftFormula(f: string, dr: number, dc: number): string {
  if (!dr && !dc) return f;
  let out = ""; let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"') { const j = f.indexOf('"', i + 1); const end = j < 0 ? f.length : j + 1; out += f.slice(i, end); i = end; continue; }
    if (ch === "'") { const j = f.indexOf("'!", i + 1); const end = j < 0 ? f.length : j + 2; out += f.slice(i, end); i = end; continue; }
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(!])/.exec(f.slice(i));
    const prev = i > 0 ? f[i - 1] : "";
    if (m && !/[A-Za-z0-9_.]/.test(prev)) {
      const c = m[1] ? colIndex(m[2]) : colIndex(m[2]) + dc; const r = m[3] ? Number(m[4]) : Number(m[4]) + dr;
      out += c < 0 || r < 1 ? "#REF!" : `${m[1]}${colName(c)}${m[3]}${r}`; i += m[0].length; continue;
    }
    const w = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(f.slice(i));
    if (w) { out += w[0]; i += w[0].length; continue; }
    out += ch; i++;
  }
  return out;
}

export function emptySheet(name = "Sheet1"): Sheet { return { name, cells: new Map(), rowCount: 50, colCount: 12 }; }
export function filledCells(wb: Workbook): number { return wb.sheets.reduce((s, sh) => s + sh.cells.size, 0); }
