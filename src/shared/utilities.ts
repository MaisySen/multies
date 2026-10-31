/**
 * R100 Tools C: the everyday utilities' logic, pure and shared (web pages and unit tests). Everything runs on the
 * device; nothing here touches the network. Every function either returns a value or throws an Error whose message
 * is a plain sentence fit to show under the input.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import Papa from "papaparse";

export class UtilError extends Error {}
const fail = (msg: string): never => { throw new UtilError(msg); };

/* ---------------- JSON, YAML, CSV ---------------- */

export type DataFormat = "json" | "yaml" | "csv";

/** Where a JSON parse failed, as line and column (1 based), from the engine's message or position. */
export function jsonErrorAt(text: string, err: unknown): { line: number; col: number } | null {
  const m = /position (\d+)/i.exec(String((err as Error)?.message ?? ""));
  const lc = /line (\d+) column (\d+)/i.exec(String((err as Error)?.message ?? ""));
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  if (!m) return null;
  const pos = Math.min(Number(m[1]), text.length);
  const before = text.slice(0, pos).split("\n");
  return { line: before.length, col: before[before.length - 1].length + 1 };
}

export function parseData(text: string, from: DataFormat): unknown {
  if (!text.trim()) fail("Paste or type something first.");
  if (from === "json") {
    try { return JSON.parse(text); } catch (e) {
      const at = jsonErrorAt(text, e);
      return fail(at ? `This is not valid JSON (line ${at.line}, column ${at.col}).` : "This is not valid JSON.");
    }
  }
  if (from === "yaml") {
    try { return parseYaml(text, { maxAliasCount: 100 }); } catch (e) {
      const lp = (e as { linePos?: { line: number; col: number }[] }).linePos?.[0];
      return fail(lp ? `This is not valid YAML (line ${lp.line}, column ${lp.col}).` : "This is not valid YAML.");
    }
  }
  const out = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true, dynamicTyping: false });
  const bad = out.errors.find((er) => er.type !== "Delimiter");
  if (bad) fail(`This CSV has a problem on row ${(bad.row ?? 0) + 2}: ${bad.message.replace(/[.]$/, "")}.`);
  if (!out.meta.fields?.length) fail("This CSV needs a header row.");
  return out.data;
}

function rowsForCsv(v: unknown): Record<string, unknown>[] {
  const list = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : fail("Only a list of rows can become CSV.");
  return list.map((r, i) => (r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : fail(`Row ${i + 1} is not a set of named values, so it cannot become CSV.`)));
}

export function formatData(v: unknown, to: DataFormat, indent = 2): string {
  if (to === "json") return JSON.stringify(v, null, indent);
  if (to === "yaml") return stringifyYaml(v, { indent }).trimEnd();
  const rows = rowsForCsv(v);
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return Papa.unparse(rows.map((r) => Object.fromEntries(fields.map((f) => { const x = r[f]; return [f, x === undefined || x === null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)]; }))), { columns: fields });
}

export function convertData(text: string, from: DataFormat, to: DataFormat, indent = 2): string {
  return formatData(parseData(text, from), to, indent);
}

export function minifyJson(text: string): string { return JSON.stringify(parseData(text, "json")); }

/* ---------------- Base64 ---------------- */

export function utf8ToBase64(text: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b = btoa(bin);
  return urlSafe ? b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b;
}

export function base64ToUtf8(input: string): string {
  let s = input.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!s) fail("Paste some Base64 first.");
  if (/[^A-Za-z0-9+/=]/.test(s) || s.replace(/=+$/, "").includes("=")) fail("This is not Base64: it has characters Base64 never uses.");
  s = s.replace(/=+$/, "");
  if (s.length % 4 === 1) fail("This Base64 is cut short.");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return fail("This decodes to a file, not text."); }
}

/* ---------------- Hash ---------------- */

export type HashAlgo = "MD5" | "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
export const HASH_ALGOS: HashAlgo[] = ["MD5", "SHA-1", "SHA-256", "SHA-384", "SHA-512"];

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** MD5 (RFC 1321). Only for checksums: shown with a note that it is not safe for passwords or signatures. */
export function md5(data: Uint8Array): string {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6 << 6) + 64);
  padded.set(data); padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const s = S[(i >> 4) * 4 + (i % 4)];
      const t = d; d = c; c = b;
      const x = (a + f + K[i] + view.getUint32(off + g * 4, true)) >>> 0;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = t;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16); const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return toHex(out);
}

export async function hash(algo: HashAlgo, data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (algo === "MD5") return md5(bytes);
  return toHex(new Uint8Array(await crypto.subtle.digest(algo, bytes as BufferSource)));
}

/* ---------------- UUID ---------------- */

export function uuidV4(rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID v7 (RFC 9562): time ordered, so new ids sort after old ones. */
export function uuidV7(now = Date.now(), rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rand(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidInfo(id: string): { version: number; time?: Date } {
  const m = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id.trim());
  if (!m) return fail("This is not a UUID.");
  const version = parseInt(m[1], 16);
  if (version === 7) return { version, time: new Date(parseInt(id.replace(/-/g, "").slice(0, 12), 16)) };
  return { version };
}

/* ---------------- Colour ---------------- */

export interface Rgb { r: number; g: number; b: number; a: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", green: "#008000", blue: "#0000ff", yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", pink: "#ffc0cb", teal: "#008080", navy: "#000080", transparent: "#00000000" };

export function parseColour(input: string): Rgb {
  const s = input.trim().toLowerCase();
  if (!s) return fail("Type a colour, like #1a73e8 or rgb(26, 115, 232).");
  const hex = NAMED[s] ?? s;
  let m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(hex);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? Math.round((parseInt(h.slice(6, 8), 16) / 255) * 100) / 100 : 1 };
  }
  const num = String.raw`(-?\d*\.?\d+)(%?)`;
  m = new RegExp(String.raw`^rgba?\(\s*${num}[\s,]+${num}[\s,]+${num}(?:[\s,/]+${num})?\s*\)$`).exec(s);
  if (m) {
    const ch = (v: string, p: string) => clamp(Math.round(p ? (Number(v) / 100) * 255 : Number(v)), 0, 255);
    return { r: ch(m[1], m[2]), g: ch(m[3], m[4]), b: ch(m[5], m[6]), a: m[7] ? clamp(m[8] ? Number(m[7]) / 100 : Number(m[7]), 0, 1) : 1 };
  }
  m = new RegExp(String.raw`^hsla?\(\s*(-?\d*\.?\d+)(?:deg)?[\s,]+(\d*\.?\d+)%[\s,]+(\d*\.?\d+)%(?:[\s,/]+${num})?\s*\)$`).exec(s);
  if (m) {
    const { r, g, b } = hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
    return { r, g, b, a: m[4] ? clamp(m[5] ? Number(m[4]) / 100 : Number(m[4]), 0, 1) : 1 };
  }
  return fail("That colour was not understood. Try #1a73e8, rgb(26, 115, 232) or hsl(214, 82%, 51%).");
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hh = ((h % 360) + 360) % 360; const ss = clamp(s, 0, 100) / 100; const ll = clamp(l, 0, 100) / 100;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = ss * Math.min(ll, 1 - ll);
  const f = (n: number) => ll - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
}

export function colourFormats(c: Rgb): { hex: string; rgb: string; hsl: string } {
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  const { h, s, l } = rgbToHsl(c);
  const alpha = c.a < 1;
  return {
    hex: `#${hx(c.r)}${hx(c.g)}${hx(c.b)}${alpha ? hx(Math.round(c.a * 255)) : ""}`,
    rgb: alpha ? `rgb(${c.r} ${c.g} ${c.b} / ${c.a})` : `rgb(${c.r}, ${c.g}, ${c.b})`,
    hsl: alpha ? `hsl(${h} ${s}% ${l}% / ${c.a})` : `hsl(${h}, ${s}%, ${l}%)`,
  };
}

/** WCAG 2 contrast ratio between two opaque colours, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------------- Units ---------------- */

export interface UnitDef { id: string; label: string; factor: number; offset?: number }
export const UNIT_GROUPS: Record<string, { label: string; units: UnitDef[] }> = {
  length: { label: "Length", units: [
    { id: "mm", label: "Millimetres", factor: 0.001 }, { id: "cm", label: "Centimetres", factor: 0.01 }, { id: "m", label: "Metres", factor: 1 }, { id: "km", label: "Kilometres", factor: 1000 },
    { id: "in", label: "Inches", factor: 0.0254 }, { id: "ft", label: "Feet", factor: 0.3048 }, { id: "yd", label: "Yards", factor: 0.9144 }, { id: "mi", label: "Miles", factor: 1609.344 } ] },
  weight: { label: "Weight", units: [
    { id: "g", label: "Grams", factor: 0.001 }, { id: "kg", label: "Kilograms", factor: 1 }, { id: "t", label: "Tonnes", factor: 1000 }, { id: "oz", label: "Ounces", factor: 0.028349523125 }, { id: "lb", label: "Pounds", factor: 0.45359237 } ] },
  temperature: { label: "Temperature", units: [
    { id: "c", label: "Celsius", factor: 1, offset: 0 }, { id: "f", label: "Fahrenheit", factor: 5 / 9, offset: -32 }, { id: "k", label: "Kelvin", factor: 1, offset: -273.15 } ] },
  area: { label: "Area", units: [
    { id: "m2", label: "Square metres", factor: 1 }, { id: "ha", label: "Hectares", factor: 10000 }, { id: "km2", label: "Square kilometres", factor: 1e6 }, { id: "ft2", label: "Square feet", factor: 0.09290304 }, { id: "acre", label: "Acres", factor: 4046.8564224 } ] },
  volume: { label: "Volume", units: [
    { id: "ml", label: "Millilitres", factor: 0.001 }, { id: "l", label: "Litres", factor: 1 }, { id: "m3", label: "Cubic metres", factor: 1000 }, { id: "gal", label: "US gallons", factor: 3.785411784 }, { id: "cup", label: "US cups", factor: 0.2365882365 } ] },
  data: { label: "Data", units: [
    { id: "b", label: "Bytes", factor: 1 }, { id: "kb", label: "Kilobytes", factor: 1000 }, { id: "mb", label: "Megabytes", factor: 1e6 }, { id: "gb", label: "Gigabytes", factor: 1e9 }, { id: "kib", label: "Kibibytes", factor: 1024 }, { id: "mib", label: "Mebibytes", factor: 1024 ** 2 }, { id: "gib", label: "Gibibytes", factor: 1024 ** 3 } ] },
  speed: { label: "Speed", units: [
    { id: "kmh", label: "Kilometres an hour", factor: 1 / 3.6 }, { id: "ms", label: "Metres a second", factor: 1 }, { id: "mph", label: "Miles an hour", factor: 0.44704 }, { id: "kn", label: "Knots", factor: 0.514444 } ] },
};

export function convertUnit(value: number, group: string, from: string, to: string): number {
  const g = UNIT_GROUPS[group] ?? fail("Pick what to convert.");
  const a = g.units.find((u) => u.id === from), b = g.units.find((u) => u.id === to);
  if (!a || !b) fail("Pick both units.");
  if (!Number.isFinite(value)) fail("Type a number.");
  const base = (value + (a!.offset ?? 0)) * a!.factor;
  if (group === "temperature" && base < -273.15 - 1e-9) fail("That is colder than absolute zero.");
  return base / b!.factor - (b!.offset ?? 0);
}

/** A tidy number for display: up to 10 significant digits, no float noise. */
export function tidy(n: number): string {
  if (!Number.isFinite(n)) return "";
  const r = Number(n.toPrecision(10));
  return Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6) ? r.toExponential() : String(r);
}

/* ---------------- Timestamps ---------------- */

/** Reads a Unix time (seconds or milliseconds, guessed by size) or a date string. */
export function parseTime(input: string): Date {
  const s = input.trim();
  if (!s) return fail("Type a Unix time or a date.");
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const ms = Math.abs(n) >= 1e14 ? n / 1000 : Math.abs(n) >= 1e11 ? n : n * 1000; // micro, milli, seconds
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) fail("That number is too big to be a date.");
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) fail("That date was not understood. Try 2026-11-01 09:30 or a Unix time.");
  return d;
}

export function timeFormats(d: Date, timeZone?: string): { unix: string; ms: string; iso: string; local: string; relative: string } {
  const rel = relative(d.getTime() - Date.now());
  const local = new Intl.DateTimeFormat("en-AU", { dateStyle: "full", timeStyle: "long", timeZone }).format(d);
  return { unix: String(Math.floor(d.getTime() / 1000)), ms: String(d.getTime()), iso: d.toISOString(), local, relative: rel };
}

export function relative(diffMs: number): string {
  const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536e6], ["month", 2592e6], ["week", 6048e5], ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1e3]];
  const f = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [u, ms] of units) if (Math.abs(diffMs) >= ms || u === "second") return f.format(Math.round(diffMs / ms), u);
  return "";
}

/* ---------------- Text diff ---------------- */

export type DiffLine = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };
export const DIFF_MAX_LINES = 5000;

/** Line diff by longest common subsequence (Myers would be faster; 5,000 lines a side is the cap). */
export function diffLines(left: string, right: string, opts: { ignoreSpace?: boolean; ignoreCase?: boolean } = {}): DiffLine[] {
  const A = left.split("\n"), B = right.split("\n");
  if (A.length > DIFF_MAX_LINES || B.length > DIFF_MAX_LINES) fail(`Each side can have up to ${DIFF_MAX_LINES.toLocaleString("en")} lines.`);
  const norm = (s: string) => { let x = opts.ignoreSpace ? s.replace(/\s+/g, " ").trim() : s; if (opts.ignoreCase) x = x.toLowerCase(); return x; };
  const a = A.map(norm), b = B.map(norm);
  let start = 0; while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length; while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffLine[] = [];
  for (let k = 0; k < start; k++) out.push({ kind: "same", text: A[k], a: k + 1, b: k + 1 });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { out.push({ kind: "same", text: A[start + i], a: start + i + 1, b: start + j + 1 }); i++; j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { out.push({ kind: "del", text: A[start + i], a: start + i + 1 }); i++; }
    else { out.push({ kind: "add", text: B[start + j], b: start + j + 1 }); j++; }
  }
  for (let k = endA, l = endB; k < A.length; k++, l++) out.push({ kind: "same", text: A[k], a: k + 1, b: l + 1 });
  return out;
}

export function diffStats(d: DiffLine[]): { added: number; removed: number } {
  return { added: d.filter((x) => x.kind === "add").length, removed: d.filter((x) => x.kind === "del").length };
}

/* ---------------- Regex ---------------- */

export interface RegexMatch { index: number; text: string; groups: (string | undefined)[]; named?: Record<string, string | undefined> }
export const REGEX_MAX_MATCHES = 500;

export function testRegex(pattern: string, flags: string, text: string): { matches: RegexMatch[]; capped: boolean } {
  if (!pattern) fail("Type a pattern.");
  if (/[^dgimsuyv]/.test(flags) || new Set(flags).size !== flags.length) fail("Flags can be any of g, i, m, s, u and y, once each.");
  let re: RegExp;
  try { re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g"); } catch (e) { return fail(`The pattern has a mistake: ${String((e as Error).message).replace(/^Invalid regular expression: /, "").replace(/[.]$/, "")}.`); }
  const matches: RegexMatch[] = [];
  let m: RegExpExecArray | null;
  const started = Date.now();
  while ((m = re.exec(text)) && matches.length < REGEX_MAX_MATCHES) {
    matches.push({ index: m.index, text: m[0], groups: m.slice(1), named: m.groups ? { ...m.groups } : undefined });
    if (m[0] === "") re.lastIndex++;
    if (!flags.includes("g")) break;
    if (Date.now() - started > 1500) break;
  }
  return { matches, capped: matches.length >= REGEX_MAX_MATCHES };
}

export function replaceRegex(pattern: string, flags: string, text: string, replacement: string): string {
  testRegex(pattern, flags, "");
  return text.replace(new RegExp(pattern, flags), replacement);
}
