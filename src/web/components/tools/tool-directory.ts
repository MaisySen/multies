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
  IconSheet, IconShield, IconShieldAlert, IconTable, IconTemplate, IconWorkflow, IconZap,
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
  stamp: { section: "Edit PDF", icon: IconClipboardCheck, name: "Stamp and page numbers", line: "Add PAID, page numbers or a header", words: "stamp paid approved page numbers header footer bates" },
  watermark: { section: "Edit PDF", icon: IconShapes, line: "DRAFT or CONFIDENTIAL across pages", words: "draft confidential" },
  "form-fill": { section: "Edit PDF", icon: IconChecklist, line: "Type into a PDF form", words: "form fill fields" },
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
  { key: "esign", feature: "esign", section: "Secure", icon: IconPenLine, name: "Sign", line: "Sign a PDF or ask others to sign it", words: "sign signature esign request", to: "/app/tools/sign", takesAttachment: true, takes: /\.pdf$/i },
  { key: "share", feature: "share", section: "Secure", icon: IconLink, name: "Share as a link", line: "Send a big file as a link with expiry", words: "share link expiry password large file send", to: "/app/tools/share", takesAttachment: true, takes: /./ },
  { key: "ask", feature: "ask", section: "Smart", icon: IconChatQuote, name: "Ask a document", line: "A summary and answers from any document", words: "ai summary question answer chat", to: "/app/tools/ai?feature=ask", takesAttachment: true, takes: /\.(pdf|docx|png|jpe?g)$/i },
  { key: "translate", feature: "translate", section: "Smart", icon: IconGlobe, name: "Translate", line: "Translate a document and keep its layout", words: "ai translate language nepali hindi chinese", to: "/app/tools/ai?feature=translate", takesAttachment: true, takes: /\.(pdf|docx)$/i },
  { key: "extract", feature: "extract", section: "Smart", icon: IconReceipt, name: "Invoices to a sheet", line: "Read invoices and receipts into a spreadsheet", words: "ai invoice receipt abn gst spreadsheet excel", to: "/app/tools/ai?feature=extract", takesAttachment: true, takes: /\.(pdf|png|jpe?g)$/i },
  { key: "expenses", feature: "expenses", section: "Smart", icon: IconCreditCard, name: "Expense report", line: "Turn receipts into an expense report", words: "ai expenses receipts report gst", to: "/app/tools/ai?feature=expenses" },
  { key: "contracts", feature: "contracts", section: "Smart", icon: IconCalendarClock, name: "Contract dates", line: "Key dates and renewal reminders", words: "ai contract renewal notice dates reminder", to: "/app/tools/ai?feature=contracts", takesAttachment: true, takes: /\.(pdf|docx)$/i },
  { key: "workflows", feature: "workflows", section: "Automate", icon: IconWorkflow, name: "Workflows", line: "Chain tools into one step", words: "chain automate steps", to: "/app/tools/workflows" },
  { key: "templates", feature: "templates", section: "Automate", icon: IconTemplate, name: "Templates", line: "Invoices, quotes and letters from a form", words: "invoice quote letter template", to: "/app/tools/templates" },
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
  const pages: Entry[] = PAGES.filter((p) => features.includes(p.feature)).map(({ feature: _f, ...p }) => p);
  return [...fromTools, ...pages];
}

/** Whether an entry can take this file name (used when a file is dropped on the list, or chosen from mail). */
export function entryTakes(e: Entry, filename: string): boolean {
  if (e.tool) return e.tool.minFiles <= 1 && !e.tool.extra && toolTakes(e.tool, filename);
  return !!e.takes?.test(filename);
}

/** Search: every word typed must appear in the name, line or search words. */
export function searchEntries(entries: Entry[], query: string): Entry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return entries;
  return entries.filter((e) => { const hay = `${e.name} ${e.line} ${e.words}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
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

/** "27 KB to 3 KB, 89% smaller" for a compress result. */
export function savedLine(before: number, after: number): string | null {
  if (!before || !after) return null;
  if (after >= before) return `${sizeLabel(before)} to ${sizeLabel(after)}. This file was already small.`;
  return `${sizeLabel(before)} to ${sizeLabel(after)}, ${Math.round((1 - after / before) * 100)}% smaller`;
}

const RECENT_KEY = "multies.tools.recent";
export function recentKeys(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 6) : []; } catch { return []; }
}
export function rememberRecent(key: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...recentKeys().filter((k) => k !== key)].slice(0, 6))); } catch { /* private mode */ }
}
/** Shown in Recent before anything has been used. */
export const STARTERS = ["compress", "merge", "convert", "organize", "esign", "pdf-to-docx"];

/** Files handed from one screen to the next (a dropped file, or a result to run another tool on). Memory only. */
let carried: File[] = [];
export const carryFiles = (files: File[]) => { carried = files; };
export const takeCarried = (): File[] => { const f = carried; carried = []; return f; };
export const peekCarried = (): File[] => carried;

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
