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
  | "txt" | "md" | "html";

export type Family = "image" | "pdf" | "sheet" | "document" | "text";

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
  return BY_MIME.get(m)?.id ?? null;
}

/** "Report.final.docx" + "pdf" = "Report.final.pdf". */
export function renameTo(name: string, to: FormatId, suffix = ""): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "file";
  return `${base}${suffix}.${formatDef(to).exts[0]}`;
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
  run?: "image" | "image-pdf" | "pdf-image" | "sheet";
  /** Engine: the Tools op and its options (the same job the Tools screens run). */
  op?: string;
  options?: Record<string, string>;
  /** Engine: the Tools feature this needs (none means it ships with Tools itself). */
  feature?: string;
  /** Browser: a device ability the step needs, checked at run time (see BrowserCaps). */
  needs?: keyof BrowserCaps;
  /** The step can turn one file into many (each page of a PDF). Later steps run on each. */
  many?: boolean;
}

/** Device abilities that differ between browsers. The page measures them; tests pass them in. */
export interface BrowserCaps {
  /** Opening HEIC photos (Safari on iPhone and Mac does; most others cannot without an upload). */
  heicDecode: boolean;
  /** Writing WEBP (the canvas can in most browsers; elsewhere a small encoder loads). */
  webpEncode: boolean;
  /** Writing AVIF (a small encoder loads on demand). */
  avifEncode: boolean;
}

export const ALL_CAPS: BrowserCaps = { heicDecode: true, webpEncode: true, avifEncode: true };

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
  if (c.needs && !caps[c.needs]) return false;
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
const ORDER: FormatId[] = ["pdf", "jpg", "png", "webp", "avif", "gif", "bmp", "docx", "xlsx", "csv", "tsv", "json", "txt", "md", "heic", "svg", "pptx", "odt", "ods", "odp", "html"];

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
 * Actions on whole files (not a change of format), also as data. Each runs in the browser. `min` is how many files
 * the action needs; `family` which files it takes.
 */
export interface ActionDef {
  id: "merge" | "split" | "rotate" | "numbers" | "images-pdf";
  label: string;
  line: string;
  takes: (f: FormatId) => boolean;
  min: number;
  /** All chosen files go into one result (merge, images into one PDF). */
  combine?: boolean;
}

const isImage = (f: FormatId) => formatDef(f).family === "image";
export const ACTIONS: ActionDef[] = [
  { id: "merge", label: "Merge into one PDF", line: "Join the PDFs in the order shown", takes: (f) => f === "pdf", min: 2, combine: true },
  { id: "images-pdf", label: "Images into one PDF", line: "One image per page, in the order shown", takes: isImage, min: 2, combine: true },
  { id: "split", label: "Split pages", line: "Every page, or the ranges you type, as separate PDFs", takes: (f) => f === "pdf", min: 1 },
  { id: "rotate", label: "Rotate pages", line: "Turn every page", takes: (f) => f === "pdf", min: 1 },
  { id: "numbers", label: "Add page numbers", line: "Numbers at the foot of each page", takes: (f) => f === "pdf", min: 1 },
];

/** The actions that fit the chosen files: every file must be one the action takes. */
export function actionsFor(froms: FormatId[]): ActionDef[] {
  if (!froms.length) return [];
  return ACTIONS.filter((a) => froms.length >= a.min && froms.every(a.takes));
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
