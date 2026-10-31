/**
 * R78 Convert hub: the formats Multies can read and write, and the converters between them, as data. A new format or a
 * new converter is a row in these tables, not new screen code. planRoutes() finds, for one input format, every format
 * it can become, chaining up to three converters (for example Word to PDF on the engine, then PDF to PNG in the
 * browser, then PNG to WEBP in the browser). Browser steps cost far less than engine steps, so a route that stays on
 * the device always wins over one that uploads.
 *
 * Pure data and maths: no DOM, no network. The browser side (src/web/lib/convert/*) runs each converter id.
 */

export type FormatId =
  | "jpg" | "png" | "webp" | "avif" | "gif" | "bmp" | "heic" | "svg"
  | "pdf"
  | "csv" | "tsv" | "xlsx" | "json"
  | "docx" | "pptx" | "odt" | "ods" | "odp"
  | "txt" | "md" | "html"
  // R86 (round B): video, audio, e-books, archives.
  | "mp4" | "mov" | "webm" | "mkv" | "avi"
  | "mp3" | "wav" | "m4a" | "ogg" | "flac" | "aac"
  | "epub" | "mobi"
  | "zip" | "7z" | "tar" | "tgz" | "rar";

export type Family = "image" | "pdf" | "sheet" | "document" | "text" | "video" | "audio" | "ebook" | "archive";

export interface FormatDef {
  id: FormatId;
  label: string;
  family: Family;
  exts: string[];
  mime: string;
  /** Words for search ("photo", "iphone"). */
  words?: string;
}

/** Every format the hub knows. The first extension is the one an output file gets. */
export const FORMATS: FormatDef[] = [
  { id: "jpg", label: "JPG", family: "image", exts: ["jpg", "jpeg", "jfif"], mime: "image/jpeg", words: "photo picture" },
  { id: "png", label: "PNG", family: "image", exts: ["png"], mime: "image/png", words: "picture screenshot" },
  { id: "webp", label: "WEBP", family: "image", exts: ["webp"], mime: "image/webp", words: "web picture" },
  { id: "avif", label: "AVIF", family: "image", exts: ["avif"], mime: "image/avif", words: "web picture small" },
  { id: "gif", label: "GIF", family: "image", exts: ["gif"], mime: "image/gif", words: "animation" },
  { id: "bmp", label: "BMP", family: "image", exts: ["bmp"], mime: "image/bmp", words: "bitmap" },
  { id: "heic", label: "HEIC", family: "image", exts: ["heic", "heif"], mime: "image/heic", words: "iphone photo apple" },
  { id: "svg", label: "SVG", family: "image", exts: ["svg"], mime: "image/svg+xml", words: "vector logo" },
  { id: "pdf", label: "PDF", family: "pdf", exts: ["pdf"], mime: "application/pdf" },
  { id: "csv", label: "CSV", family: "sheet", exts: ["csv"], mime: "text/csv", words: "comma spreadsheet" },
  { id: "tsv", label: "TSV", family: "sheet", exts: ["tsv"], mime: "text/tab-separated-values", words: "tab spreadsheet" },
  { id: "xlsx", label: "Excel", family: "sheet", exts: ["xlsx"], mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", words: "excel spreadsheet workbook" },
  { id: "json", label: "JSON", family: "sheet", exts: ["json"], mime: "application/json", words: "data rows" },
  { id: "docx", label: "Word", family: "document", exts: ["docx"], mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", words: "word document" },
  { id: "pptx", label: "PowerPoint", family: "document", exts: ["pptx"], mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", words: "slides deck" },
  { id: "odt", label: "ODT", family: "document", exts: ["odt"], mime: "application/vnd.oasis.opendocument.text", words: "opendocument text" },
  { id: "ods", label: "ODS", family: "sheet", exts: ["ods"], mime: "application/vnd.oasis.opendocument.spreadsheet", words: "opendocument spreadsheet" },
  { id: "odp", label: "ODP", family: "document", exts: ["odp"], mime: "application/vnd.oasis.opendocument.presentation", words: "opendocument slides" },
  { id: "txt", label: "Text", family: "text", exts: ["txt"], mime: "text/plain", words: "plain text" },
  { id: "md", label: "Markdown", family: "text", exts: ["md", "markdown"], mime: "text/markdown" },
  { id: "html", label: "HTML", family: "text", exts: ["html", "htm"], mime: "text/html", words: "web page" },
  // R86: video and audio run on the engine (one run each); archives run on the device.
  { id: "mp4", label: "MP4", family: "video", exts: ["mp4", "m4v"], mime: "video/mp4", words: "video movie" },
  { id: "mov", label: "MOV", family: "video", exts: ["mov"], mime: "video/quicktime", words: "video iphone movie" },
  { id: "webm", label: "WEBM", family: "video", exts: ["webm"], mime: "video/webm", words: "video web" },
  { id: "mkv", label: "MKV", family: "video", exts: ["mkv"], mime: "video/x-matroska", words: "video" },
  { id: "avi", label: "AVI", family: "video", exts: ["avi"], mime: "video/x-msvideo", words: "video" },
  { id: "mp3", label: "MP3", family: "audio", exts: ["mp3"], mime: "audio/mpeg", words: "sound music audio song" },
  { id: "wav", label: "WAV", family: "audio", exts: ["wav"], mime: "audio/wav", words: "sound audio" },
  { id: "m4a", label: "M4A", family: "audio", exts: ["m4a"], mime: "audio/mp4", words: "sound audio voice memo" },
  { id: "ogg", label: "OGG", family: "audio", exts: ["ogg", "oga", "opus"], mime: "audio/ogg", words: "sound audio voice note" },
  { id: "flac", label: "FLAC", family: "audio", exts: ["flac"], mime: "audio/flac", words: "sound audio music" },
  { id: "aac", label: "AAC", family: "audio", exts: ["aac"], mime: "audio/aac", words: "sound audio" },
  { id: "epub", label: "EPUB", family: "ebook", exts: ["epub"], mime: "application/epub+zip", words: "ebook book" },
  { id: "mobi", label: "MOBI", family: "ebook", exts: ["mobi", "azw", "prc"], mime: "application/x-mobipocket-ebook", words: "ebook kindle book" },
  { id: "zip", label: "ZIP", family: "archive", exts: ["zip"], mime: "application/zip", words: "archive folder compressed" },
  { id: "7z", label: "7Z", family: "archive", exts: ["7z"], mime: "application/x-7z-compressed", words: "archive seven zip" },
  { id: "tar", label: "TAR", family: "archive", exts: ["tar"], mime: "application/x-tar", words: "archive" },
  { id: "tgz", label: "TAR.GZ", family: "archive", exts: ["tgz", "gz"], mime: "application/gzip", words: "archive tarball gzip" },
  { id: "rar", label: "RAR", family: "archive", exts: ["rar"], mime: "application/vnd.rar", words: "archive winrar" },
];

const BY_ID = new Map(FORMATS.map((f) => [f.id, f]));
const BY_EXT = new Map(FORMATS.flatMap((f) => f.exts.map((e) => [e, f] as const)));
const BY_MIME = new Map(FORMATS.map((f) => [f.mime, f]));

export const formatDef = (id: FormatId): FormatDef => BY_ID.get(id)!;

/** The format of a file, by its extension first, then its type. Null when the hub does not know it. */
export function formatOf(name: string, mime?: string | null): FormatId | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && BY_EXT.has(ext)) return BY_EXT.get(ext)!.id;
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m === "image/jpg") return "jpg";
  if (m === "image/heif") return "heic";
  if (m === "application/x-zip-compressed") return "zip";
  if (m === "audio/x-wav" || m === "audio/wave") return "wav";
  if (m === "audio/x-m4a") return "m4a";
  return BY_MIME.get(m)?.id ?? null;
}

/** "photos.tar.gz" keeps both parts of its extension when renamed. */
const DOUBLE_EXT = /\.tar\.(gz|bz2|xz)$/i;

/** "Report.final.docx" + "pdf" = "Report.final.pdf". */
export function renameTo(name: string, to: FormatId, suffix = ""): string {
  const base = (DOUBLE_EXT.test(name) ? name.replace(DOUBLE_EXT, "") : name.replace(/\.[^./\\]+$/, "")) || "file";
  return `${base}${suffix}.${to === "tgz" ? "tar.gz" : formatDef(to).exts[0]}`;
}

/**
 * Where a converter runs. "browser": on the person's device, nothing uploaded, no run counted. "engine": Multies'
 * own document engine through the existing Tools job (one run each).
 */
export type Where = "browser" | "engine";

export interface ConverterDef {
  id: string;
  from: FormatId;
  to: FormatId;
  where: Where;
  /** Browser: the implementation key in src/web/lib/convert/browser-ops.ts. */
  run?: "image" | "image-pdf" | "pdf-image" | "sheet" | "archive";
  /** Engine: the Tools op and its options (the same job the Tools screens run). */
  op?: string;
  options?: Record<string, string>;
  /** Engine: the Tools feature this needs (none means it ships with Tools itself). */
  feature?: string;
  /** Browser: a device ability the step needs, checked at run time (see BrowserCaps). */
  needs?: keyof BrowserCaps;
  /** The step can turn one file into many (each page of a PDF). Later steps run on each. */
  many?: boolean;
  /** R86: nothing chains after this step (a video's sound is not a starting point for more steps). */
  final?: boolean;
}

/** Device abilities that differ between browsers. The page measures them; tests pass them in. */
export interface BrowserCaps {
  /** Opening HEIC photos (Safari on iPhone and Mac does; most others cannot without an upload). */
  heicDecode: boolean;
  /** Writing WEBP (the canvas can in most browsers; elsewhere a small encoder loads). */
  webpEncode: boolean;
  /** Writing AVIF (a small encoder loads on demand). */
  avifEncode: boolean;
  /** R86: opening ZIP, 7Z, TAR and RAR archives (a small WebAssembly reader loads on demand). */
  archive?: boolean;
}

export const ALL_CAPS: BrowserCaps = { heicDecode: true, webpEncode: true, avifEncode: true, archive: true };

const READ_IMAGES: FormatId[] = ["jpg", "png", "webp", "avif", "gif", "bmp", "heic", "svg"];
const WRITE_IMAGES: FormatId[] = ["jpg", "png", "webp", "avif", "gif", "bmp"];
const encNeeds = (to: FormatId): keyof BrowserCaps | undefined => (to === "webp" ? "webpEncode" : to === "avif" ? "avifEncode" : undefined);

function imageConverters(): ConverterDef[] {
  const out: ConverterDef[] = [];
  for (const from of READ_IMAGES) {
    for (const to of WRITE_IMAGES) {
      if (from === to) continue;
      // HEIC needs the decoder; the encoder need of the target is checked separately when the route runs.
      out.push({ id: `img:${from}:${to}`, from, to, where: "browser", run: "image", needs: from === "heic" ? "heicDecode" : encNeeds(to) });
    }
    out.push({ id: `img:${from}:pdf`, from, to: "pdf", where: "browser", run: "image-pdf", needs: from === "heic" ? "heicDecode" : undefined });
  }
  return out;
}

export const VIDEO_FORMATS: FormatId[] = ["mp4", "mov", "webm", "mkv", "avi"];
export const AUDIO_FORMATS: FormatId[] = ["mp3", "wav", "m4a", "ogg", "flac", "aac"];
export const ARCHIVE_READ: FormatId[] = ["zip", "7z", "tar", "tgz", "rar"];
export const ARCHIVE_WRITE: FormatId[] = ["zip", "tgz", "tar"];
const VIDEO_TO: FormatId[] = ["mp4", "mov", "webm", "gif", "mp3", "m4a", "wav"];
const AUDIO_TO: FormatId[] = ["mp3", "m4a", "wav"];

/** R86: video and audio on the engine (media-convert, one run each). Nothing chains after them. */
function mediaConverters(): ConverterDef[] {
  const out: ConverterDef[] = [];
  for (const from of VIDEO_FORMATS) for (const to of VIDEO_TO) if (from !== to) out.push({ id: `eng:media:${from}:${to}`, from, to, where: "engine", op: "media-convert", options: { to }, final: true });
  for (const from of AUDIO_FORMATS) for (const to of AUDIO_TO) if (from !== to) out.push({ id: `eng:media:${from}:${to}`, from, to, where: "engine", op: "media-convert", options: { to }, final: true });
  return out;
}

/** R86: one archive kind to another on the device (unpack, then pack again). 7Z and RAR are read only. */
function archiveConverters(): ConverterDef[] {
  const out: ConverterDef[] = [];
  for (const from of ARCHIVE_READ) for (const to of ARCHIVE_WRITE) if (from !== to) out.push({ id: `arc:${from}:${to}`, from, to, where: "browser", run: "archive", needs: "archive", final: true });
  return out;
}

const SHEET_PAIRS: [FormatId, FormatId][] = [
  ["csv", "xlsx"], ["csv", "json"], ["csv", "tsv"],
  ["tsv", "csv"], ["tsv", "xlsx"], ["tsv", "json"],
  ["xlsx", "csv"], ["xlsx", "json"], ["xlsx", "tsv"],
  ["json", "csv"], ["json", "xlsx"], ["json", "tsv"],
];

/** The converter table. Engine rows mirror the Tools catalogue (src/shared/tools.ts) and the features they need. */
export const CONVERTERS: ConverterDef[] = [
  ...imageConverters(),
  { id: "pdf:png", from: "pdf", to: "png", where: "browser", run: "pdf-image", many: true },
  { id: "pdf:jpg", from: "pdf", to: "jpg", where: "browser", run: "pdf-image", many: true },
  ...SHEET_PAIRS.map(([from, to]): ConverterDef => ({ id: `sheet:${from}:${to}`, from, to, where: "browser", run: "sheet" })),
  ...(["docx", "xlsx", "pptx", "odt", "ods", "odp"] as FormatId[]).map((from): ConverterDef => ({ id: `eng:convert:${from}`, from, to: "pdf", where: "engine", op: "convert" })),
  { id: "eng:pdf-to-docx", from: "pdf", to: "docx", where: "engine", op: "pdf-to-docx" },
  ...(["html", "md", "txt", "csv"] as FormatId[]).map((from): ConverterDef => ({ id: `eng:to-pdf:${from}`, from, to: "pdf", where: "engine", op: "to-pdf", feature: "convert_plus" })),
  ...(["txt", "md", "csv", "xlsx"] as FormatId[]).map((to): ConverterDef => ({ id: `eng:pdf-to:${to}`, from: "pdf", to, where: "engine", op: "pdf-to", options: { target: to }, feature: "convert_plus" })),
  ...mediaConverters(),
  // R86: HEIC on the engine for browsers that cannot open it (Chrome, Edge, Firefox). The device route wins where it works.
  ...(["jpg", "png"] as FormatId[]).map((to): ConverterDef => ({ id: `eng:photo:heic:${to}`, from: "heic", to, where: "engine", op: "photo-convert", options: { to } })),
  ...(["epub", "mobi"] as FormatId[]).map((from): ConverterDef => ({ id: `eng:ebook:${from}`, from, to: "pdf", where: "engine", op: "ebook-to-pdf" })),
  ...archiveConverters(),
];

/** What a step costs when planning: staying on the device is cheap, an upload is dear, every step adds a little. */
export const STEP_COST: Record<Where, number> = { browser: 1, engine: 12 };
export const MAX_STEPS = 3;

export interface Route {
  from: FormatId;
  to: FormatId;
  steps: ConverterDef[];
  cost: number;
  /** True when every step runs on the device: nothing is uploaded and no run is counted. */
  local: boolean;
  /** How many engine runs the route uses per file. */
  engineRuns: number;
}

export interface PlanOptions {
  /** Tools features switched on for this workspace (GET /api/tools features). */
  features?: readonly string[];
  /** False when Tools engine runs are not available (Tools off, or no runs left): only browser routes are planned. */
  engine?: boolean;
  caps?: BrowserCaps;
  maxSteps?: number;
  /** At most this many engine steps in one route (default 1): one upload per file, never a ping pong. */
  maxEngineSteps?: number;
}

/** Whether a converter can be used under these options. */
export function converterUsable(c: ConverterDef, opts: PlanOptions = {}): boolean {
  if (c.where === "engine") {
    if (opts.engine === false) return false;
    if (c.feature && !(opts.features ?? []).includes(c.feature)) return false;
    return true;
  }
  const caps = opts.caps ?? ALL_CAPS;
  // R86: an ability the caller did not measure (archive, added later) counts as there.
  if (c.needs && caps[c.needs] === false) return false;
  if (c.run === "image" && c.from === "heic") {
    const n = encNeeds(c.to);
    if (n && !caps[n]) return false;
  }
  return true;
}

/**
 * Every format `from` can become, with the cheapest route to each (at most maxSteps converters, no format visited
 * twice). A plain best-first search over a small graph: about 90 edges, so this is instant.
 */
export function planRoutes(from: FormatId, opts: PlanOptions = {}): Route[] {
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const maxEngine = opts.maxEngineSteps ?? 1;
  const edges = CONVERTERS.filter((c) => converterUsable(c, opts));
  const best = new Map<FormatId, Route>();
  type Item = { at: FormatId; steps: ConverterDef[]; cost: number };
  const queue: Item[] = [{ at: from, steps: [], cost: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost || a.steps.length - b.steps.length);
    const cur = queue.shift()!;
    if (cur.steps.length >= maxSteps) continue;
    if (cur.steps.length && cur.steps[cur.steps.length - 1].final) continue;
    for (const e of edges) {
      if (e.from !== cur.at || e.to === from) continue;
      if (cur.steps.some((s) => s.from === e.to)) continue; // no loops
      if (e.where === "engine" && cur.steps.filter((s) => s.where === "engine").length >= maxEngine) continue;
      const cost = cur.cost + STEP_COST[e.where] + 0.01 * (cur.steps.length + 1);
      const prev = best.get(e.to);
      if (prev && prev.cost <= cost) continue;
      const steps = [...cur.steps, e];
      best.set(e.to, { from, to: e.to, steps, cost, local: steps.every((s) => s.where === "browser"), engineRuns: steps.filter((s) => s.where === "engine").length });
      queue.push({ at: e.to, steps, cost });
    }
  }
  return [...best.values()].sort((a, b) => ORDER.indexOf(a.to) - ORDER.indexOf(b.to));
}

/** The route from one format to another, or null. */
export function routeTo(from: FormatId, to: FormatId, opts: PlanOptions = {}): Route | null {
  return planRoutes(from, opts).find((r) => r.to === to) ?? null;
}

/** The order targets show in: what people want most first. */
const ORDER: FormatId[] = [
  "pdf", "mp4", "mov", "webm", "mp3", "m4a", "wav", "jpg", "png", "webp", "avif", "gif", "bmp", "docx", "xlsx", "csv", "tsv", "json", "txt", "md",
  "zip", "7z", "tgz", "tar", "heic", "svg", "pptx", "odt", "ods", "odp", "html", "mkv", "avi", "ogg", "flac", "aac", "epub", "mobi", "rar",
];

/**
 * For several files at once: the targets every one of them can reach (so one choice converts the whole batch), each
 * with whether all of their routes stay on the device.
 */
export function commonTargets(froms: FormatId[], opts: PlanOptions = {}): { to: FormatId; local: boolean; engineRuns: number }[] {
  const uniq = [...new Set(froms)];
  if (!uniq.length) return [];
  const plans = uniq.map((f) => new Map(planRoutes(f, opts).map((r) => [r.to, r])));
  const counts = new Map(froms.map((f) => [f, froms.filter((x) => x === f).length]));
  return ORDER.filter((to) => plans.every((p, i) => p.has(to) || uniq[i] === to) && !uniq.every((f) => f === to))
    .map((to) => {
      const rs = plans.map((p) => p.get(to)).filter((r): r is Route => !!r);
      return { to, local: rs.every((r) => r.local), engineRuns: rs.reduce((n, r) => n + r.engineRuns * (counts.get(r.from) ?? 1), 0) };
    });
}

/** "On your device" or "Word to PDF on the Multies engine, then PDF to PNG on your device". */
export function routeLine(r: Route): string {
  if (r.local) return r.steps.length === 1 ? "Runs on your device" : `${r.steps.length} steps, all on your device`;
  return r.steps.map((s) => `${formatDef(s.from).label} to ${formatDef(s.to).label} ${s.where === "engine" ? "on the Multies engine" : "on your device"}`).join(", then ");
}

/**
 * Actions on whole files (not a change of format), also as data. Most run in the browser; R86 adds actions that use
 * the engine for some files (compress for PDFs and videos, OCR). `min` is how many files the action needs; `takes`
 * which files it takes; `engine` which files need an engine run (one each).
 */
export interface ActionDef {
  id: "merge" | "split" | "rotate" | "numbers" | "images-pdf" | "compress" | "ocr-pdf" | "ocr-text" | "extract" | "archive";
  label: string;
  line: string;
  takes: (f: FormatId) => boolean;
  min: number;
  /** All chosen files go into one result (merge, images into one PDF, one archive). */
  combine?: boolean;
  /** R86: the files that need one engine run each (none: the action stays on the device). */
  engine?: (f: FormatId) => boolean;
  /** R86: takes every file, even kinds Multies cannot convert (an archive holds anything). */
  anyFile?: boolean;
}

const isImage = (f: FormatId) => formatDef(f).family === "image";
const isMedia = (f: FormatId) => VIDEO_FORMATS.includes(f) || AUDIO_FORMATS.includes(f);
/** Pictures the device can redraw smaller (compress) or put on a page (OCR). */
export const COMPRESS_IMAGES: FormatId[] = ["jpg", "png", "webp"];
export const OCR_IMAGES: FormatId[] = ["jpg", "png", "webp", "bmp", "gif"];
export const ACTIONS: ActionDef[] = [
  { id: "merge", label: "Merge into one PDF", line: "Join the PDFs in the order shown", takes: (f) => f === "pdf", min: 2, combine: true },
  { id: "images-pdf", label: "Images into one PDF", line: "One image per page, in the order shown", takes: isImage, min: 2, combine: true },
  { id: "compress", label: "Make smaller", line: "Shrink PDFs, photos and videos, and see the size before and after", takes: (f) => f === "pdf" || COMPRESS_IMAGES.includes(f) || isMedia(f), min: 1, engine: (f) => f === "pdf" || isMedia(f) },
  { id: "ocr-pdf", label: "Make searchable", line: "Read the words in scans and photos, so you can search and copy them", takes: (f) => f === "pdf" || OCR_IMAGES.includes(f), min: 1, engine: () => true },
  { id: "ocr-text", label: "Copy out the text", line: "Read the words in scans and photos into a text file", takes: (f) => f === "pdf" || OCR_IMAGES.includes(f), min: 1, engine: () => true },
  { id: "extract", label: "Unpack", line: "Take every file out of the archive", takes: (f) => ARCHIVE_READ.includes(f), min: 1 },
  { id: "archive", label: "Put in one archive", line: "Pack all the files into one ZIP or TAR.GZ", takes: () => true, min: 1, combine: true, anyFile: true },
  { id: "split", label: "Split pages", line: "Every page, or the ranges you type, as separate PDFs", takes: (f) => f === "pdf", min: 1 },
  { id: "rotate", label: "Rotate pages", line: "Turn every page", takes: (f) => f === "pdf", min: 1 },
  { id: "numbers", label: "Add page numbers", line: "Numbers at the foot of each page", takes: (f) => f === "pdf", min: 1 },
];

/** The actions that fit the chosen files: every file must be one the action takes. Pass engine: false to leave out
 * actions that need the engine for these files (Tools off, or no runs left). */
export function actionsFor(froms: FormatId[], opts: { engine?: boolean } = {}): ActionDef[] {
  if (!froms.length) return [];
  return ACTIONS.filter((a) => froms.length >= a.min && froms.every(a.takes) && (opts.engine !== false || !a.engine || !froms.some(a.engine)));
}

/** R86: how many engine runs an action uses for these files. */
export function actionEngineRuns(a: ActionDef, froms: FormatId[]): number {
  return a.engine ? froms.filter(a.engine).length : 0;
}

/** Counts for the report and the page: how many formats are read and written, and how many pairs exist. */
export function catalogueStats(opts: PlanOptions = {}): { read: number; write: number; pairs: number; localPairs: number } {
  const read = new Set<FormatId>(), write = new Set<FormatId>();
  let pairs = 0, localPairs = 0;
  for (const f of FORMATS) {
    const rs = planRoutes(f.id, opts);
    if (rs.length) read.add(f.id);
    for (const r of rs) { write.add(r.to); pairs++; if (r.local) localPairs++; }
  }
  return { read: read.size, write: write.size, pairs, localPairs };
}

/** Parses "1-3, 5, 8-" against a page count into [start, end] pairs (1 based, inclusive). Null when it does not read. */
export function parseRanges(text: string, pages: number): [number, number][] | null {
  const parts = text.replace(/\s*(?:-|\bto\b|\u2013)\s*/gi, "-").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: [number, number][] = [];
  for (const p of parts) {
    const m = p.match(/^(\d+)?(?:\s*(?:-|to|\u2013)\s*(\d+)?)?$/);
    if (!m || (!m[1] && !m[2])) return null;
    const isRange = /-|to|\u2013/.test(p);
    const a = m[1] ? Number(m[1]) : 1;
    const b = isRange ? (m[2] ? Number(m[2]) : pages) : a;
    if (a < 1 || b < a || b > pages) return null;
    out.push([a, b]);
  }
  return out;
}
