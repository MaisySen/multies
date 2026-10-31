/**
 * Tools UX: how the Tools page presents the catalogue. Web only; the shared catalogue (src/shared/tools.ts) and
 * GET /api/tools are unchanged. Every tool and every Tools page (AI helpers, share links, e-sign, automation) sits
 * in one list with five sections, its own icon, a short name and a one line description, and search words.
 */
import type { ComponentType } from "react";
import {
  IconArrowRightLeft, IconCalendarClock, IconCamera, IconChatQuote, IconChecklist, IconClipboardCheck, IconColumns, IconCreditCard,
  IconDocs, IconEyeOff, IconFileCode, IconFilePlus, IconFileUp, IconFilter, IconGlobe, IconImage, IconKey, IconLayers, IconLink,
  IconLock, IconMails, IconMinimize, IconPenLine, IconReceipt, IconRefresh, IconRotate, IconRowsSplit, IconSearch, IconShapes,
  IconSheet, IconShield, IconShieldAlert, IconTable, IconTemplate, IconWorkflow, IconZap, IconVideo, IconBook, IconEdit,
} from "@/web/components/ui/icon";
import { OP_REMOVE_PASSWORD, toolOn, toolTakes, type ToolDef } from "@/shared/tools";
import { api } from "@/web/lib/api";

export const SECTIONS = ["Edit PDF", "Convert", "Secure", "Smart", "Automate"] as const;
export type Section = (typeof SECTIONS)[number];

/** One colour per section, so a glance says what kind of tool it is. */
export const SECTION_TINT: Record<Section, string> = {
  "Edit PDF": "bg-[#0A84FF]", Convert: "bg-[#5E5CE6]", Secure: "bg-[#FF9F0A]", Smart: "bg-[#BF5AF2]", Automate: "bg-[#30B0C7]",
};

type Icon = ComponentType<{ className?: string }>;
interface Look { section: Section; icon: Icon; name?: string; line: string; words: string }

/** How each catalogue tool shows on the page (a shorter name only where the catalogue's reads long). */
const LOOK: Record<string, Look> = {
  compress: { section: "Edit PDF", icon: IconMinimize, line: "Make a PDF smaller to send", words: "shrink smaller size reduce email" },
  merge: { section: "Edit PDF", icon: IconLayers, line: "Join PDFs into one", words: "combine join append" },
  organize: { section: "Edit PDF", icon: IconColumns, line: "Reorder, turn or delete pages", words: "page editor reorder delete rotate thumbnails" },
  split: { section: "Edit PDF", icon: IconRowsSplit, line: "Pull pages out into separate PDFs", words: "extract pages separate" },
  rotate: { section: "Edit PDF", icon: IconRotate, line: "Turn pages the right way up", words: "turn landscape upside" },
  stamp: { section: "Edit PDF", icon: IconClipboardCheck, name: "Stamp and number pages", line: "Add PAID, page numbers or a header", words: "stamp paid approved page numbers header footer bates nepali hindi devanagari" },
  watermark: { section: "Edit PDF", icon: IconShapes, line: "DRAFT or CONFIDENTIAL across pages", words: "draft confidential nepali hindi devanagari" },
  "form-fill": { section: "Edit PDF", icon: IconChecklist, line: "Type into a PDF form", words: "form fill fields nepali hindi devanagari" },
  compare: { section: "Edit PDF", icon: IconArrowRightLeft, line: "What changed between two versions", words: "diff difference versions contract" },
  ocr: { section: "Edit PDF", icon: IconSearch, name: "Make searchable", line: "Read the text in a scanned PDF", words: "ocr scan text recognise nepali hindi" },
  convert: { section: "Convert", icon: IconRefresh, line: "Word, Excel or PowerPoint to PDF", words: "word docx excel xlsx powerpoint pptx office" },
  "pdf-to-docx": { section: "Convert", icon: IconDocs, line: "Edit a PDF's text in Word", words: "word docx edit" },
  "images-to-pdf": { section: "Convert", icon: IconFilePlus, line: "Put images into one PDF", words: "jpg jpeg png photos pictures" },
  "to-jpeg": { section: "Convert", icon: IconImage, line: "Save each page as an image", words: "jpg jpeg png images pictures" },
  "scan-clean": { section: "Convert", icon: IconCamera, line: "Photos of paper to a clean PDF", words: "camera photo scan scanner receipt" },
  "to-pdf": { section: "Convert", icon: IconFileUp, line: "HTML, Markdown, CSV or images to PDF", words: "html markdown csv txt svg webp" },
  "pdf-to": { section: "Convert", icon: IconFileCode, name: "PDF to text or CSV", line: "Get a PDF's text, tables or page images", words: "text txt markdown csv excel png" },
  "pdf-tables": { section: "Convert", icon: IconTable, line: "Put a PDF's tables into Excel", words: "excel xlsx tables spreadsheet" },
  "excel-merge": { section: "Convert", icon: IconSheet, line: "Join spreadsheets into one", words: "excel csv combine sheets" },
  "excel-clean": { section: "Convert", icon: IconFilter, line: "Tidy spaces, duplicates and dates", words: "excel csv duplicates clean trim" },
  // R86: video and audio, HEIC photos, e-books.
  "media-convert": { section: "Convert", icon: IconVideo, name: "Convert video or audio", line: "MP4, MOV, WEBM, MP3, WAV, M4A or a GIF", words: "video audio sound music movie mp4 mov webm mkv avi mp3 wav m4a aac ogg flac gif extract audio" },
  "media-compress": { section: "Convert", icon: IconMinimize, name: "Compress video", line: "Make a video or recording smaller", words: "compress shrink smaller video audio mp4 email size reduce" },
  "photo-convert": { section: "Convert", icon: IconImage, name: "HEIC to JPG", line: "iPhone photos that open anywhere", words: "heic heif iphone apple photo jpg jpeg png" },
  "ebook-to-pdf": { section: "Convert", icon: IconBook, name: "E-book to PDF", line: "EPUB or MOBI to a PDF", words: "ebook e-book epub mobi kindle azw book read print" },
  protect: { section: "Secure", icon: IconLock, line: "Lock a PDF with a password", words: "password encrypt lock" },
  [OP_REMOVE_PASSWORD]: { section: "Secure", icon: IconKey, line: "Take off a password you know", words: "password decrypt remove" },
  redact: { section: "Secure", icon: IconEyeOff, line: "Black out words for good", words: "redact black out hide" },
  "pii-find": { section: "Secure", icon: IconShieldAlert, name: "Hide sensitive info", line: "Find and black out tax and bank numbers", words: "redact tfn abn bank card medicare phone email privacy" },
  scrub: { section: "Secure", icon: IconShield, line: "Strip the author and hidden details", words: "metadata privacy author" },
};

export interface Entry {
  key: string;
  name: string;
  line: string;
  section: Section;
  icon: Icon;
  words: string;
  /** A catalogue tool that runs on the Tools page itself. */
  tool?: ToolDef;
  /** A page of its own (an editor, an AI helper, share, sign, automation). */
  to?: string;
  /** Takes a mail attachment by ?attachment= (editors, AI helpers, share, sign). */
  takesAttachment?: boolean;
  /** For a page that is not a catalogue tool: which files it takes. */
  takes?: RegExp;
}

/** Pages that are not catalogue tools, each behind its feature. */
const PAGES: (Omit<Entry, "section" | "icon"> & { feature: string; section: Section; icon: Icon })[] = [
  // R78: the Convert hub ships with Tools itself (no feature): drop any file, see what it can become.
  // R86: Edit PDF sits with the editors (feature editor): pages, text, signature, black out, watermark and numbers on the device.
  { key: "edit-pdf", feature: "editor", section: "Edit PDF", icon: IconEdit, name: "Edit a PDF", line: "Add text, sign, black out, move pages", words: "edit pdf add text type write sign signature redact black out hide box watermark page numbers reorder rotate delete pages annotate", to: "/app/tools/edit-pdf", takes: /\.pdf$/i },
  { key: "convert-any", feature: "", section: "Convert", icon: IconArrowRightLeft, name: "Convert any file", line: "Drop files, pick what they become", words: "convert change format heic webp avif png jpg gif bmp image photo csv excel xlsx json tsv pdf batch many zip 7z tar rar extract archive video audio mp4 mov mp3 wav epub mobi ebook compress ocr", to: "/app/tools/convert", takes: /./ },
  { key: "esign", feature: "esign", section: "Secure", icon: IconPenLine, name: "Sign", line: "Sign a PDF or ask others to sign it", words: "sign signature esign request", to: "/app/tools/sign", takesAttachment: true, takes: /\.pdf$/i },
  { key: "share", feature: "share", section: "Secure", icon: IconLink, name: "Share as a link", line: "Send a big file as a link with expiry", words: "share link expiry password large file send file request upload link secret one time password send securely", to: "/app/tools/share", takesAttachment: true, takes: /./ },
  { key: "links", feature: "links", section: "Secure", icon: IconLink, name: "Links", line: "Short links, QR codes, click stats and a bio page", words: "short link url shortener qr code bio page link in bio go links utm click stats", to: "/app/tools/links" }, // R87
  { key: "ask", feature: "ask", section: "Smart", icon: IconChatQuote, name: "Ask a document", line: "A summary and answers from any document", words: "ai summary question answer chat", to: "/app/tools/ai?feature=ask", takesAttachment: true, takes: /\.(pdf|docx|png|jpe?g)$/i },
  { key: "translate", feature: "translate", section: "Smart", icon: IconGlobe, name: "Translate", line: "Translate a document and keep its layout", words: "ai translate language nepali hindi chinese", to: "/app/tools/ai?feature=translate", takesAttachment: true, takes: /\.(pdf|docx)$/i },
  { key: "extract", feature: "extract", section: "Smart", icon: IconReceipt, name: "Invoices to a sheet", line: "Read invoices and receipts into a spreadsheet", words: "ai invoice receipt abn gst spreadsheet excel", to: "/app/tools/ai?feature=extract", takesAttachment: true, takes: /\.(pdf|png|jpe?g)$/i },
  { key: "expenses", feature: "expenses", section: "Smart", icon: IconCreditCard, name: "Expense report", line: "Turn receipts into an expense report", words: "ai expenses receipts report gst", to: "/app/tools/ai?feature=expenses" },
  { key: "contracts", feature: "contracts", section: "Smart", icon: IconCalendarClock, name: "Contract dates", line: "Key dates and renewal reminders", words: "ai contract renewal notice dates reminder", to: "/app/tools/ai?feature=contracts", takesAttachment: true, takes: /\.(pdf|docx)$/i },
  { key: "workflows", feature: "workflows", section: "Automate", icon: IconWorkflow, name: "Workflows", line: "Chain tools into one step", words: "chain automate steps", to: "/app/tools/workflows" },
  { key: "templates", feature: "templates", section: "Automate", icon: IconTemplate, name: "Document templates", line: "Invoices, quotes and letters as a PDF", words: "invoice quote letter template document", to: "/app/tools/templates" },
  { key: "merge_mail", feature: "merge_mail", section: "Automate", icon: IconMails, name: "Mail merge", line: "A personal PDF and email for each person", words: "mail merge bulk csv contacts", to: "/app/tools/merge" },
  { key: "rules", feature: "rules", section: "Automate", icon: IconZap, name: "Before sending", line: "Compress and convert files as you attach them", words: "rules auto compress convert attach send", to: "/app/settings#send-rules" },
];

/** A catalogue tool's look (section, icon, short name), for other Tools screens such as batch runs. */
export const lookOf = (op: string): { section: Section; icon: Icon; name?: string } | undefined => LOOK[op];

/** The order tools sit in, most used first inside each section. */
export const ORDER = Object.keys(LOOK);

export function buildEntries(tools: ToolDef[], features: readonly string[]): Entry[] {
  const fromTools: Entry[] = tools.filter((t) => !t.hidden && toolOn(t, features)).map((t) => {
    const look = LOOK[t.op] ?? { section: "Edit PDF" as Section, icon: IconDocs, line: t.blurb, words: "" };
    return { key: t.op, name: look.name ?? t.label, line: look.line, section: look.section, icon: look.icon, words: `${t.label} ${t.blurb} ${look.words}`, tool: t, to: t.path, takesAttachment: !!t.path };
  }).sort((a, b) => (ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99));
  const pages: Entry[] = PAGES.filter((p) => !p.feature || features.includes(p.feature)).map(({ feature: _f, ...p }) => p);
  // R78: the Convert hub leads the Convert section.
  const hub = pages.filter((p) => p.key === "convert-any");
  const at = fromTools.findIndex((e) => e.section === "Convert");
  if (at >= 0) return [...fromTools.slice(0, at), ...hub, ...fromTools.slice(at), ...pages.filter((p) => p.key !== "convert-any")];
  return [...fromTools, ...pages];
}

/**
 * Whether an entry can take this file name (used when a file is dropped on the list, or chosen from mail).
 * dropped: a file in hand on this device (R66): tools that need more files (Merge, Compare) are offered too, since the
 * next screen adds the rest, and pages that take a dropped file (Edit pages, Fill a form, Compare, Share) are offered.
 */
export function entryTakes(e: Entry, filename: string, dropped = false): boolean {
  if (dropped && e.to && !CARRY_PAGES.has(e.key)) return false;
  if (e.tool) return (e.tool.minFiles <= 1 || (dropped && e.tool.maxFiles !== 1)) && !e.tool.extra && toolTakes(e.tool, filename);
  return !!e.takes?.test(filename);
}

/** R66: pages that pick up a dropped file handed over from the Tools list (carryFiles). */
export const CARRY_PAGES = new Set(["organize", "form-fill", "compare", "share", "convert-any"]);

const STOP_WORDS = new Set(["a", "an", "the", "to", "and", "or", "of", "for", "with", "my", "into", "in", "on", "from", "as", "file", "files"]);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * Search (R66, tighter): every word typed must start a word in the name, line or search words ("ai" no longer finds
 * "paid", "word" no longer finds "password"); small words like "to" are skipped. Name matches come first.
 */
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

/** R66 (MB-255): the tighter of today's and this month's runs left, and when that allowance comes back. */
export interface RunsLeft { left: number; per: "day" | "month"; perDay: number; resetsAt: Date }
export function runsLeft(usage: { month: number; day: number }, limits: { runsMonthly: number; runsDaily: number }, now = new Date()): RunsLeft {
  const day = Math.max(0, limits.runsDaily - usage.day);
  const month = Math.max(0, limits.runsMonthly - usage.month);
  const y = now.getUTCFullYear(), m = now.getUTCMonth(), d = now.getUTCDate();
  // The meter counts by UTC day and month (tool_usage periods), so the allowance comes back at UTC midnight.
  if (day <= month) return { left: day, per: "day", perDay: limits.runsDaily, resetsAt: new Date(Date.UTC(y, m, d + 1)) };
  return { left: month, per: "month", perDay: limits.runsDaily, resetsAt: new Date(Date.UTC(y, m + 1, 1)) };
}

/** "12 runs left today", "1 run left this month", "No runs left today". */
export function runsLeftLabel(r: RunsLeft): string {
  const when = r.per === "day" ? "today" : "this month";
  if (r.left === 0) return `No runs left ${when}`;
  return `${r.left} ${r.left === 1 ? "run" : "runs"} left ${when}`;
}

/** When runs come back, in the given time zone: "at 11 am tomorrow", "on Sun 1 Nov at 11 am". */
export function resetWhen(r: RunsLeft, timeZone: string, now = new Date()): string {
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
export function noRunsLine(r: RunsLeft, timeZone: string, now = new Date()): string {
  const used = r.per === "day" ? `today's ${r.perDay} runs` : "this month's runs";
  return `You have used ${used}. More ${resetWhen(r, timeZone, now)}.`;
}

/** "Lease agreement 2026 final version.pdf" to "Lease agreem…version.pdf": the start and the end both matter. */
export function middleTruncate(name: string, max = 34): string {
  if (name.length <= max) return name;
  const keep = max - 1;
  const tail = Math.min(Math.ceil(keep * 0.45), keep - 4);
  return `${name.slice(0, keep - tail)}…${name.slice(name.length - tail)}`;
}

/** A plain size: 812 KB, 3.4 MB. */
export const sizeLabel = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/**
 * "27 KB to 3 KB, 89% smaller" for a compress result. R71 (MB-263): a level that could not shrink the file names the
 * stronger level only when it can help: Light only tidies the file, so Balanced is worth a try when there are pictures;
 * Balanced already shrinks every large picture, so Smallest would change little and is not offered.
 */
export function savedLine(before: number, after: number, level?: string): string | null {
  if (!before || !after) return null;
  const pct = Math.round((1 - after / before) * 100);
  if (pct < 2) {
    const sizes = after >= before ? `${sizeLabel(before)}, unchanged.` : `${sizeLabel(before)} to ${sizeLabel(after)}, about the same.`;
    if (level === "light") return `${sizes} Light only tidies the file. If it has photos or scans, Balanced can shrink them.`;
    return `${sizes} This file was already small.`;
  }
  return `${sizeLabel(before)} to ${sizeLabel(after)}, ${pct}% smaller`;
}

/** R71 (MB-264): why a chosen PDF is over the page limit, said before Run. */
export function pagesLine(tool: Pick<ToolDef, "op" | "label" | "maxPages" | "options">, language: string | undefined, pages: number, limit: number): string {
  if (tool.op === "ocr" && limit < (tool.maxPages ?? limit)) {
    const lang = tool.options.find((o) => o.name === "language")?.choices?.find((c) => c.value === language)?.label ?? "This language";
    return `This PDF has ${pages} pages. ${lang} reads up to ${limit} pages a run, so split it into parts of ${limit} pages first.`;
  }
  return `This PDF has ${pages} pages. ${tool.label} takes up to ${limit} pages a run, so split it into smaller parts first.`;
}

const RECENT_KEY = "multies.tools.recent";
export function recentKeys(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []; } catch { return []; }
}
export function rememberRecent(key: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recentKeys().filter((k) => k !== key)].slice(0, 6))); } catch { /* private mode */ }
}
/** Shown in Recent before anything has been used. */
export const STARTERS = ["convert-any", "compress", "merge", "convert", "organize", "esign"];

/** Files handed from one screen to the next (memory only); kept in their own small module the editors share. */
export { carryFiles, peekCarried, takeCarried } from "@/web/lib/carried-files";

/**
 * Wakes the document engine (a free host that sleeps) before the first run: one cheap GET through Multies, at most
 * every few minutes per tab. Resolves to true when the engine looked cold, null when not asked or not answered.
 */
let warmAt = 0;
let warmCold = false;
export function warmEngine(): Promise<boolean | null> {
  if (Date.now() - warmAt < 4 * 60_000) return Promise.resolve(warmAt ? warmCold : null);
  warmAt = Date.now();
  return api.get<{ ok: boolean; ms: number }>("/tools/warm")
    .then((r) => { warmCold = !r.ok || r.ms > 2500; return warmCold; })
    .catch(() => null); // an older server has no warm route
}
