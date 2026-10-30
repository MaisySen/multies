/**
 * Tools on the phone: the same document tools as Multies on the web (compress, merge, convert and the rest).
 * The catalogue comes from the server (GET /api/tools), so a tool added on the web shows up here without an
 * app update. This file is the pure part (types, checks, the upload body); src/lib/tools-files.ts does the
 * phone's file work (pick, upload, download, open, share, save).
 * Server: src/server/routes/tools.ts and src/shared/tools.ts in the web app.
 */
import type { IconName } from "@/components/icons";

export type ToolOp = string;
export type ToolGroup = "Organise" | "Convert" | "Protect" | "Scans" | (string & {});

export interface ToolOption {
  name: string;
  kind: "choice" | "int" | "text" | "password" | "ranges" | "phrases";
  label: string;
  required?: boolean;
  default?: string | number;
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  maxLen?: number;
  placeholder?: string;
  help?: string;
}

export interface ToolDef {
  op: ToolOp;
  label: string;
  group: ToolGroup;
  blurb: string;
  accept: string;
  acceptLabel: string;
  minFiles: number;
  maxFiles: number | "plan";
  suffix: string;
  ext: string;
  contentType: string;
  options: ToolOption[];
  maxPages?: number;
  maxBytes?: number;
  slow?: { secondsPerPage: number };
  note?: string;
  ordered?: boolean;
}

export interface ToolsLimits { runsMonthly: number; runsDaily: number; maxBytes: number; maxMergeFiles: number }
export interface ToolsInfo { enabled: boolean; tools: ToolDef[]; usage: { month: number; day: number }; limits: ToolsLimits }
export type ToolJobStatus = "queued" | "running" | "done" | "failed" | "expired";
export interface ToolResultFacts { pages?: number; parts?: number; matches?: number; phrases?: number; verified?: boolean; pages_changed?: number; pages_with_text?: number }
export interface ToolJob {
  token: string; op: ToolOp; status: ToolJobStatus; name: string; error?: string; bytes?: number; downloadUrl?: string;
  progress?: { done: number; total: number };
  result?: ToolResultFacts;
}

/** A file picked on the phone (from Files or Photos) or a mail attachment, ready to send to a tool. */
export interface PickedFile { uri: string; name: string; size: number; type: string }

export const TOOL_GROUP_ORDER = ["Organise", "Convert", "Protect", "Scans"];

/** Icon tile colour per group, the same colours as the web Tools page. */
export const GROUP_TILE: Record<string, "blue" | "indigo" | "orange" | "green" | "gray"> = { Organise: "blue", Convert: "indigo", Protect: "orange", Scans: "green" };

/** An icon per tool (names from src/components/icon-paths.ts); a tool the app does not know gets the wrench. */
const TOOL_ICON: Record<string, string> = {
  merge: "layers", split: "columns", rotate: "refresh-cw", compress: "hard-drive", convert: "file-text", "to-jpeg": "copy",
  "images-to-pdf": "doc", "pdf-to-docx": "edit", redact: "minus", scrub: "shield", watermark: "tag", unlock: "key", ocr: "search",
};
export const toolIcon = (op: string): IconName => (TOOL_ICON[op] ?? "wrench") as IconName;

/** The tools in their groups, in the web page's order; groups the app does not know go last. */
export function groupTools(tools: ToolDef[]): { group: string; tools: ToolDef[] }[] {
  const names = [...TOOL_GROUP_ORDER, ...tools.map((t) => t.group).filter((g) => !TOOL_GROUP_ORDER.includes(g))];
  return [...new Set(names)].map((group) => ({ group, tools: tools.filter((t) => t.group === group) })).filter((g) => g.tools.length);
}

/** The file extensions a tool takes, from its accept list (".pdf", ".docx", ...). */
export const toolExtensions = (def: ToolDef) => def.accept.split(",").map((x) => x.trim()).filter((x) => x.startsWith("."));
/** The MIME types a tool takes, for the phone's file picker (Office files get their own types). */
export function pickerTypes(def: ToolDef): string[] {
  const out = new Set<string>();
  for (const part of def.accept.split(",").map((x) => x.trim().toLowerCase())) {
    if (part.includes("/")) out.add(part);
    else if (EXT_TYPE[part]) out.add(EXT_TYPE[part]);
  }
  return out.size ? [...out] : ["*/*"];
}

const EXT_TYPE: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".zip": "application/zip",
};

const extOf = (name: string) => /\.[A-Za-z0-9]{1,5}$/.exec(name)?.[0].toLowerCase() ?? "";
/** The MIME type for a file name, or a fallback. */
export const typeForName = (name: string, fallback = "application/octet-stream") => EXT_TYPE[extOf(name)] ?? fallback;

/** Whether a tool takes a file with this name. A photo picked without an extension counts by its type. */
export function toolTakes(def: ToolDef, name: string, type?: string): boolean {
  const ext = extOf(name);
  if (ext) return toolExtensions(def).includes(ext);
  const t = (type ?? "").toLowerCase();
  return !!t && def.accept.toLowerCase().split(",").map((x) => x.trim()).includes(t);
}

/** The tools a single mail attachment can go straight into (merge needs two files, so it is left out). */
export const toolsForFile = (tools: ToolDef[], name: string, type?: string) => tools.filter((t) => t.minFiles <= 1 && toolTakes(t, name, type));

/** The most files a run of this tool takes on this plan. */
export const maxFilesFor = (def: ToolDef, limits?: ToolsLimits | null) => (def.maxFiles === "plan" ? limits?.maxMergeFiles ?? 10 : def.maxFiles);

/** The option values a tool starts from: its defaults. */
export const defaultsFor = (def: ToolDef | undefined): Record<string, string> =>
  Object.fromEntries((def?.options ?? []).map((o) => [o.name, o.default === undefined ? "" : String(o.default)]));

/** What is wrong with one option value, in plain words, or null. Same rules as the web page. */
export function optionProblem(o: ToolOption, v: string): string | null {
  const t = v.trim();
  if (!t) return o.required ? `${o.label} is needed.` : null;
  if (o.maxLen && v.length > o.maxLen) return `${o.label} is too long.`;
  if (o.kind === "ranges" && !/^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/.test(t)) return "Use page numbers and ranges, like 1-3, 5.";
  if (o.kind === "int") {
    const n = Number(t);
    if (!Number.isInteger(n) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) return `${o.label} goes from ${o.min} to ${o.max}.`;
  }
  if (o.kind === "choice" && o.choices && !o.choices.some((c) => c.value === t)) return `Choose a ${o.label.toLowerCase()}.`;
  return null;
}

export const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Why this set of files cannot run yet, or null when it can. Checked on the phone before anything is uploaded. */
export function filesProblem(def: ToolDef, files: PickedFile[], limits?: ToolsLimits | null): string | null {
  const max = maxFilesFor(def, limits);
  if (files.length < def.minFiles) return def.minFiles > 1 ? `Add at least ${def.minFiles} files.` : "Add a file first.";
  if (files.length > max) return max === 1 ? "This tool takes one file." : `This tool takes up to ${max} files on your plan.`;
  const wrong = files.find((f) => !toolTakes(def, f.name, f.type));
  if (wrong) return `${def.label} takes ${def.acceptLabel}, not ${wrong.name}.`;
  const total = files.reduce((n, f) => n + (f.size || 0), 0);
  const cap = Math.min(limits?.maxBytes ?? Infinity, def.maxBytes ?? Infinity);
  if (Number.isFinite(cap) && total > cap) return `Files can add up to ${mb(cap)} for this tool on your plan. These add up to ${mb(total)}.`;
  return null;
}

/** Runs left this month and today, or a plain line saying the plan's runs are used up. */
export function usageLine(info: Pick<ToolsInfo, "usage" | "limits">): { text: string; blocked: boolean } {
  const { usage, limits } = info;
  if (usage.month >= limits.runsMonthly) return { text: `All ${limits.runsMonthly} tool runs this month are used. They reset on the 1st.`, blocked: true };
  if (usage.day >= limits.runsDaily) return { text: `All ${limits.runsDaily} tool runs for today are used. Try again tomorrow.`, blocked: true };
  return { text: `${usage.month} of ${limits.runsMonthly} runs used this month. Files up to ${mb(limits.maxBytes)}.`, blocked: false };
}

/** The result's plain summary line, from the small facts the server sends back. */
export function resultLine(job: ToolJob): string {
  const r = job.result ?? {};
  const bits: string[] = [];
  if (r.pages) bits.push(r.pages === 1 ? "1 page" : `${r.pages} pages`);
  if (r.parts) bits.push(r.parts === 1 ? "1 part" : `${r.parts} parts`);
  if (r.matches !== undefined) bits.push(r.matches === 1 ? "1 match covered" : `${r.matches} matches covered`);
  if (job.bytes) bits.push(job.bytes < 1024 * 1024 ? `${Math.max(1, Math.round(job.bytes / 1024))} KB` : mb(job.bytes));
  return bits.join(", ");
}

/** How long to wait before the next status check: quick at first, then every few seconds. */
export const pollDelay = (attempt: number) => (attempt < 5 ? 1000 : attempt < 20 ? 2000 : 4000);
/** Stop checking after this long and say so (the server keeps a job for an hour). */
export const POLL_GIVE_UP_MS = 15 * 60 * 1000;

/** The query string for an upload, the same as the web page sends. */
export function uploadQuery(op: ToolOp, files: PickedFile[]): string {
  return `op=${encodeURIComponent(op)}&files=${files.length}&name=${encodeURIComponent(files[0]?.name ?? "")}`;
}

/** A multipart boundary that will not appear in the files (random, long). */
export function makeBoundary(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 24; i++) s += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rand() * 36)];
  return `----MultiesTools${s}`;
}

const enc = (s: string): Uint8Array => {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  const out: number[] = [];
  for (const ch of unescape(encodeURIComponent(s))) out.push(ch.charCodeAt(0));
  return new Uint8Array(out);
};
const quoteName = (s: string) => s.replace(/[\r\n"\\]/g, "_").slice(0, 120);

/**
 * The pieces of a multipart/form-data body: option fields first, then the files in order under "files",
 * the same shape the web page's FormData makes. Files are given as byte arrays.
 */
export function multipartParts(boundary: string, options: Record<string, string>, files: { name: string; type: string; bytes: Uint8Array }[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (const [k, v] of Object.entries(options)) {
    if (v.trim() === "") continue;
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="${quoteName(k)}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(enc(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${quoteName(f.name)}"\r\nContent-Type: ${f.type || "application/octet-stream"}\r\n\r\n`));
    parts.push(f.bytes);
    parts.push(enc("\r\n"));
  }
  parts.push(enc(`--${boundary}--\r\n`));
  return parts;
}

/** Joins byte arrays into one. */
export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** A plain message for a failed upload or run, from the server's own words where it gave some. */
export function toolErrorMessage(status: number, body: unknown): string {
  const msg = (body as { error?: { message?: string } } | null)?.error?.message;
  if (msg) return msg;
  if (status === 0) return "Couldn't reach Multies. Check your connection and try again.";
  if (status === 404) return "Tools are off for this workspace.";
  if (status === 413) return "Those files are too big for your plan.";
  if (status === 429) return "Tools are busy. Try again in a minute.";
  return "That didn't work. Try again.";
}

/** A safe file name for the result on the phone. */
export const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 120) || "result";
