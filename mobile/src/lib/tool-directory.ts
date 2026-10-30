/**
 * Tools P2 on the phone: how the Tools screen presents the catalogue, the same five sections, short names, one
 * line descriptions and search words as the web Tools page (src/web/components/tools/tool-directory.ts in the web
 * app). The catalogue still comes from GET /api/tools, and every page that is not a catalogue tool sits behind the
 * feature flag the server lists, so nothing that is off on the server shows here.
 */
import type { IconName } from "@/components/icons";
import type { TileColor } from "@/components/ui";
import { runsOnPhone, toolTakes, type ToolDef, type ToolJob, type ToolsInfo } from "./tools";

export const SECTIONS = ["Edit PDF", "Convert", "Secure", "Smart", "Automate"] as const;
export type Section = (typeof SECTIONS)[number];

/** One tile colour per section, the same family as the web page. */
export const SECTION_TILE: Record<Section, TileColor> = { "Edit PDF": "blue", Convert: "indigo", Secure: "orange", Smart: "purple", Automate: "teal" };

interface Look { section: Section; icon: IconName; name?: string; line: string; words: string }

/** How each catalogue tool shows (a shorter name only where the catalogue's reads long). Same words as the web. */
const LOOK: Record<string, Look> = {
  compress: { section: "Edit PDF", icon: "hard-drive", line: "Make a PDF smaller to send", words: "shrink smaller size reduce email" },
  merge: { section: "Edit PDF", icon: "layers", line: "Join PDFs into one", words: "combine join append" },
  organize: { section: "Edit PDF", icon: "columns", line: "Reorder, turn or delete pages", words: "page editor reorder delete rotate thumbnails" },
  split: { section: "Edit PDF", icon: "copy", line: "Pull pages out into separate PDFs", words: "extract pages separate" },
  rotate: { section: "Edit PDF", icon: "refresh-cw", line: "Turn pages the right way up", words: "turn landscape upside" },
  stamp: { section: "Edit PDF", icon: "check-square", name: "Stamp and number pages", line: "Add PAID, page numbers or a header", words: "stamp paid approved page numbers header footer bates" },
  watermark: { section: "Edit PDF", icon: "tag", line: "DRAFT or CONFIDENTIAL across pages", words: "draft confidential" },
  "form-fill": { section: "Edit PDF", icon: "edit-3", line: "Type into a PDF form", words: "form fill fields" },
  compare: { section: "Edit PDF", icon: "eye", line: "What changed between two versions", words: "diff difference versions contract" },
  ocr: { section: "Edit PDF", icon: "search", name: "Make searchable", line: "Read the text in a scanned PDF", words: "ocr scan text recognise nepali hindi" },
  convert: { section: "Convert", icon: "file-text", line: "Word, Excel or PowerPoint to PDF", words: "word docx excel xlsx powerpoint pptx office" },
  "pdf-to-docx": { section: "Convert", icon: "edit", line: "Edit a PDF's text in Word", words: "word docx edit" },
  "images-to-pdf": { section: "Convert", icon: "doc", line: "Put images into one PDF", words: "jpg jpeg png photos pictures" },
  "to-jpeg": { section: "Convert", icon: "copy", line: "Save each page as an image", words: "jpg jpeg png images pictures" },
  "scan-clean": { section: "Convert", icon: "smartphone", line: "Photos of paper to a clean PDF", words: "camera photo scan scanner receipt" },
  "to-pdf": { section: "Convert", icon: "doc", line: "HTML, Markdown, CSV or images to PDF", words: "html markdown csv txt svg webp" },
  "pdf-to": { section: "Convert", icon: "list", name: "PDF to text or CSV", line: "Get a PDF's text, tables or page images", words: "text txt markdown csv excel png" },
  "pdf-tables": { section: "Convert", icon: "hash", line: "Put a PDF's tables into Excel", words: "excel xlsx tables spreadsheet" },
  "excel-merge": { section: "Convert", icon: "layers", line: "Join spreadsheets into one", words: "excel csv combine sheets" },
  "excel-clean": { section: "Convert", icon: "filter", line: "Tidy spaces, duplicates and dates", words: "excel csv duplicates clean trim" },
  protect: { section: "Secure", icon: "lock", line: "Lock a PDF with a password", words: "password encrypt lock" },
  unlock: { section: "Secure", icon: "key", line: "Take off a password you know", words: "password decrypt remove" },
  redact: { section: "Secure", icon: "minus", line: "Black out words for good", words: "redact black out hide" },
  "pii-find": { section: "Secure", icon: "shield", name: "Hide sensitive info", line: "Find and black out tax and bank numbers", words: "redact tfn abn bank card medicare phone email privacy" },
  scrub: { section: "Secure", icon: "sliders", line: "Strip the author and hidden details", words: "metadata privacy author" },
};

export interface Entry {
  key: string;
  name: string;
  line: string;
  section: Section;
  icon: IconName;
  words: string;
  /** A catalogue tool that runs on its own phone screen. */
  tool?: ToolDef;
  /** A page on the web (an editor, share links, workflows, templates): opens in the in app browser. */
  web?: string;
  /** For a web page that is not a catalogue tool: which files it takes. */
  takes?: RegExp;
}

/** Pages that are not catalogue tools, each behind its own feature flag (the same list as the web page). */
const PAGES: (Omit<Entry, "section" | "icon"> & { feature: string; section: Section; icon: IconName })[] = [
  { key: "esign", feature: "esign", section: "Secure", icon: "edit-3", name: "Sign", line: "Sign a PDF or ask others to sign it", words: "sign signature esign request", web: "/app/tools/sign", takes: /\.pdf$/i },
  { key: "share", feature: "share", section: "Secure", icon: "link", name: "Share as a link", line: "Send a big file as a link with expiry", words: "share link expiry password large file send", web: "/app/tools/share", takes: /./ },
  { key: "ask", feature: "ask", section: "Smart", icon: "sparkle", name: "Ask a document", line: "A summary and answers from any document", words: "ai summary question answer chat", web: "/app/tools/ai?feature=ask" },
  { key: "translate", feature: "translate", section: "Smart", icon: "globe", name: "Translate", line: "Translate a document and keep its layout", words: "ai translate language nepali hindi chinese", web: "/app/tools/ai?feature=translate" },
  { key: "extract", feature: "extract", section: "Smart", icon: "dollar-sign", name: "Invoices to a sheet", line: "Read invoices and receipts into a spreadsheet", words: "ai invoice receipt abn gst spreadsheet excel", web: "/app/tools/ai?feature=extract" },
  { key: "expenses", feature: "expenses", section: "Smart", icon: "dollar-sign", name: "Expense report", line: "Turn receipts into an expense report", words: "ai expenses receipts report gst", web: "/app/tools/ai?feature=expenses" },
  { key: "contracts", feature: "contracts", section: "Smart", icon: "calendar", name: "Contract dates", line: "Key dates and renewal reminders", words: "ai contract renewal notice dates reminder", web: "/app/tools/ai?feature=contracts" },
  { key: "workflows", feature: "workflows", section: "Automate", icon: "zap", name: "Workflows", line: "Chain tools into one step", words: "chain automate steps", web: "/app/tools/workflows" },
  { key: "templates", feature: "templates", section: "Automate", icon: "doc", name: "Document templates", line: "Invoices, quotes and letters from a form", words: "invoice quote letter template", web: "/app/tools/templates" },
  { key: "merge_mail", feature: "merge_mail", section: "Automate", icon: "mail", name: "Mail merge", line: "A personal PDF and email for each person", words: "mail merge bulk csv contacts", web: "/app/tools/merge" },
  { key: "rules", feature: "rules", section: "Automate", icon: "send", name: "Before sending", line: "Compress and convert files as you attach them", words: "rules auto compress convert attach send", web: "/app/settings#send-rules" },
];

/** The order tools sit in, most used first inside each section. */
const ORDER = Object.keys(LOOK);

/**
 * Every entry the phone shows: catalogue tools (on the phone, or on the web when they need a big screen) and the
 * pages whose feature the server lists. A server without `features` (before Tools P2) shows only its catalogue.
 */
export function buildEntries(info: Pick<ToolsInfo, "tools" | "features">): Entry[] {
  const features = info.features ?? [];
  const fromTools: Entry[] = info.tools.filter((t) => !t.hidden && (!t.feature || features.includes(t.feature))).map((t) => {
    const look = LOOK[t.op] ?? { section: "Edit PDF" as Section, icon: "wrench" as IconName, line: t.blurb, words: "" };
    const phone = runsOnPhone(t);
    return { key: t.op, name: look.name ?? t.label, line: look.line, section: look.section, icon: look.icon, words: `${t.label} ${t.blurb} ${look.words}`, tool: phone ? t : undefined, web: phone ? undefined : t.path ?? "/app/tools" };
  }).sort((a, b) => (ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99));
  const pages: Entry[] = PAGES.filter((p) => features.includes(p.feature)).map(({ feature: _f, ...p }) => p);
  return [...fromTools, ...pages];
}

/** The entries in their sections, in section order; empty sections are left out. */
export function sectionsOf(entries: Entry[]): { section: Section; entries: Entry[] }[] {
  return SECTIONS.map((section) => ({ section, entries: entries.filter((e) => e.section === section) })).filter((s) => s.entries.length);
}

/** Phone tools that can take this file right away (one file in hand; tools that need more files take it as the first). */
export function entriesForFile(entries: Entry[], name: string, type?: string): Entry[] {
  return entries.filter((e) => e.tool && e.tool.maxFiles !== 0 && toolTakes(e.tool, name, type));
}

const STOP_WORDS = new Set(["a", "an", "the", "to", "and", "or", "of", "for", "with", "my", "into", "in", "on", "from", "as", "file", "files"]);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Search: every word typed must start a word in the name, line or search words; name matches come first. Same rules as the web. */
export function searchEntries(entries: Entry[], query: string): Entry[] {
  const words = tokens(query).filter((w) => !STOP_WORDS.has(w));
  if (!words.length) return entries;
  const scored: { e: Entry; score: number; i: number }[] = [];
  entries.forEach((e, i) => {
    const hay = tokens(`${e.name} ${e.line} ${e.words}`);
    if (!words.every((w) => hay.some((t) => t.startsWith(w)))) return;
    const name = tokens(e.name);
    scored.push({ e, i, score: words.filter((w) => name.some((t) => t.startsWith(w))).length });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.e);
}

/** Shown in Recent before anything has been used (whichever of these the server has on). */
export const STARTERS = ["compress", "merge", "convert", "scan-clean", "pdf-to-docx", "protect"];

/** Recent entries: the ones used last, then starters, at most six. */
export function recentEntries(entries: Entry[], used: string[]): Entry[] {
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const keys = [...used, ...STARTERS].filter((k, i, a) => a.indexOf(k) === i && byKey.has(k));
  return keys.slice(0, 6).map((k) => byKey.get(k)!);
}

// ---------------------------------------------------------------- runs left (R66, same API and words as the web)

export interface RunsLeft { left: number; per: "day" | "month"; perDay: number; resetsAt: Date }

/** The tighter of today's and this month's runs left. The meter counts by UTC day and month, so runs come back at UTC midnight. */
export function runsLeft(usage: { month: number; day: number }, limits: { runsMonthly: number; runsDaily: number }, now = new Date()): RunsLeft {
  const day = Math.max(0, limits.runsDaily - usage.day);
  const month = Math.max(0, limits.runsMonthly - usage.month);
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  if (day <= month) return { left: day, per: "day", perDay: limits.runsDaily, resetsAt: new Date(Date.UTC(y, m, d + 1)) };
  return { left: month, per: "month", perDay: limits.runsDaily, resetsAt: new Date(Date.UTC(y, m + 1, 1)) };
}

/** "12 runs left today", "1 run left this month", "No runs left today". */
export function runsLeftLabel(r: RunsLeft): string {
  const when = r.per === "day" ? "today" : "this month";
  if (r.left === 0) return `No runs left ${when}`;
  return `${r.left} ${r.left === 1 ? "run" : "runs"} left ${when}`;
}

/** The phone's own time zone (where the person is), or UTC when the phone does not say. */
export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** When runs come back, in the given time zone: "at 11 am tomorrow", "on Sun 1 Nov at 11 am". */
export function resetWhen(r: RunsLeft, timeZone: string = localZone(), now = new Date()): string {
  let tz = timeZone;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: tz }); } catch { tz = "UTC"; }
  const key = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });
  const time = r.resetsAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", timeZone: tz }).replace(":00", "").replace(/\s+/g, " ").toLowerCase();
  const today = key(now);
  const tomorrow = key(new Date(now.getTime() + 86_400_000));
  const day = key(r.resetsAt);
  if (day === today) return `at ${time} today`;
  if (day === tomorrow) return `at ${time} tomorrow`;
  return `on ${r.resetsAt.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: tz }).replace(",", "")} at ${time}`;
}

/** The line under a disabled Run when nothing is left: "You have used today's 30 runs. More at 11 am tomorrow." */
export function noRunsLine(r: RunsLeft, timeZone: string = localZone(), now = new Date()): string {
  const used = r.per === "day" ? `today's ${r.perDay} runs` : "this month's runs";
  return `You have used ${used}. More ${resetWhen(r, timeZone, now)}.`;
}

// ---------------------------------------------------------------- small words

/** "Lease agreement 2026 final version.pdf" to "Lease agreem…version.pdf": the start and the end both matter. */
export function middleTruncate(name: string, max = 30): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const tail = Math.min(Math.ceil(keep * 0.45), keep - 4);
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`;
}

/** A plain size: 812 KB, 3.4 MB. */
export const sizeLabel = (raw: number | bigint) => { const n = Number(raw); return (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`); };

/** "27 KB to 3 KB, 89% smaller" for a compress result. */
export function savedLine(rawBefore: number | bigint, rawAfter: number | bigint, level?: string): string | null {
  const before = Number(rawBefore), after = Number(rawAfter);
  if (!before || !after) return null;
  const pct = Math.round((1 - after / before) * 100);
  if (pct < 2) {
    // R70: the engine hands the file back unchanged (or a sliver smaller) when a level cannot shrink it; say what to try next.
    const sizes = after >= before ? `${sizeLabel(before)}, unchanged.` : `${sizeLabel(before)} to ${sizeLabel(after)}, about the same.`;
    if (level === "light" || level === "medium") return `${sizes} ${level === "light" ? "Light" : "Balanced"} could not make it smaller. Try ${level === "light" ? "Balanced or Smallest" : "Smallest"}.`;
    return after >= before ? `${sizeLabel(before)} to ${sizeLabel(after)}. This file was already small.` : `${sizes} This file was already small.`;
  }
  return `${sizeLabel(before)} to ${sizeLabel(after)}, ${pct}% smaller`;
}

/** What the progress line says while the engine works: pages and time left for slow tools. Same words as the web. */
export function waitLine(tool: Pick<ToolDef, "slow"> | undefined, job: Pick<ToolJob, "progress">, slow: boolean): string {
  const p = job.progress;
  if (tool?.slow && p && p.total > 0) {
    const left = Math.max(0, Math.round((p.total - p.done) * tool.slow.secondsPerPage));
    const eta = left >= 90 ? `about ${Math.round(left / 60)} minutes left` : left > 5 ? `about ${left} seconds left` : "almost done";
    return `Page ${Math.min(p.done + 1, p.total)} of ${p.total}, ${eta}`;
  }
  if (tool?.slow) return `Starting. This takes about ${tool.slow.secondsPerPage} ${tool.slow.secondsPerPage === 1 ? "second" : "seconds"} a page.`;
  return slow ? "Still working. Large files take a little longer." : "Working on it";
}

/** Waits before the next try after a dropped connection: 2 s, 4 s, 8 s, then every 15 s (the web's rhythm). */
export const offlineDelay = (n: number) => Math.min(15_000, 2000 * 2 ** Math.max(0, n));

/** Options folded under "More options" (only on tools with four or more options shown), the same as the web. */
export const ADVANCED: Record<string, string[]> = {
  stamp: ["header", "footer", "ranges"],
  protect: ["allow_print", "allow_copy"],
  "excel-clean": ["dates", "drop_empty"],
  "scan-clean": ["mode"],
};
