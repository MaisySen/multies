/**
 * Tools (document tools inside Multies). The catalogue the web app and the server share.
 * The work runs on the private document engine; people only ever talk to Multies.
 * Each tool's options mirror what the engine publishes at GET /internal/v1/operations
 * (tests/tools-catalogue.test.ts holds the two together); this copy adds the words people see.
 */
import type { ToolFeature } from "./tool-features";
import { TOOLS_EDITORS } from "./tools-editors";

export type ToolOp =
  | "compress" | "merge" | "convert" | "to-jpeg" | "images-to-pdf" | "split" | "rotate"
  | "scrub" | "ocr" | "redact" | "watermark" | "unlock" | "pdf-to-docx"
  // Tools P2 (contract E1 and E2). Not every op has a card: some only run inside a flow
  // (pii-find under auto redact, thumbnails under the page editor, extract-text under search and AI).
  | "protect" | "stamp" | "to-pdf" | "pdf-to" | "pdf-tables" | "excel-merge" | "excel-clean" | "scan-clean" | "pii-find"
  | "thumbnails" | "organize" | "form-fields" | "form-fill" | "compare" | "sign"
  | "extract-text" | "segments" | "translate-apply" | "render" | "render-batch" | "chain"
  // R86 (Tools round B): video and audio, HEIC photos, e-books.
  | "media-convert" | "media-compress" | "photo-convert" | "ebook-to-pdf";

export type ToolGroup = "Organise" | "Convert" | "Protect" | "Scans";

/** Result types a tool can hand back. */
export type ToolExt = "pdf" | "zip" | "docx" | "json" | "xlsx" | "csv" | "txt" | "md" | "png"
  | "mp4" | "mov" | "webm" | "mp3" | "wav" | "m4a" | "gif" | "jpg";
export const EXT_TYPES: Record<ToolExt, string> = {
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  json: "application/json",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  // R86: video, audio and photo results.
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  gif: "image/gif",
  jpg: "image/jpeg",
};
/** The result type for an engine content type, or null when it is not one Tools hands out. */
export function extForType(contentType: string | null | undefined): ToolExt | null {
  const t = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const hit = (Object.entries(EXT_TYPES) as [ToolExt, string][]).find(([, v]) => v === t);
  return hit ? hit[0] : null;
}

export interface ToolOption {
  name: string;
  /** "json" is never typed by people: the page's own code fills it (a page plan, the kinds to look for). */
  kind: "choice" | "int" | "text" | "password" | "ranges" | "phrases" | "json";
  label: string;
  required?: boolean;
  /** The engine's default when the field is left out. */
  default?: string | number;
  /** R70: a choice can carry one plain line shown while it is picked (what to expect from it). */
  choices?: { value: string; label: string; hint?: string }[];
  min?: number;
  max?: number;
  maxLen?: number;
  placeholder?: string;
  help?: string;
  /** Tools P2: the shortest value the page accepts (a new password). */
  minLen?: number;
  /** Tools P2: shown only while another option has one of these values (stamp words when the stamp is custom). */
  when?: { option: string; is?: string[]; not?: string[] };
}

export interface ToolDef {
  op: ToolOp;
  label: string;
  group: ToolGroup;
  /** One plain line under the title. */
  blurb: string;
  /** What the drop zone takes (an accept attribute) and the words for it. */
  accept: string;
  acceptLabel: string;
  minFiles: number;
  /** The most files a run takes; merge is capped by the plan instead. */
  maxFiles: number | "plan";
  /** Added to the first file's name for the result, e.g. "invoice-compressed.pdf". */
  suffix: string;
  /** The result's extension and type. */
  ext: ToolExt;
  contentType: string;
  /** Tools P2: the result type follows one option (PDF to: txt, md, csv, xlsx, or png pages in a ZIP). */
  extBy?: { option: string; exts: Record<string, ToolExt> };
  options: ToolOption[];
  /** A tighter page or size cap than the plan's (OCR on the shared server). */
  maxPages?: number;
  maxBytes?: number;
  /** Slow tools report page by page progress and say how long to expect. */
  slow?: { secondsPerPage: number };
  /** A plain caveat shown beside the tool. */
  note?: string;
  /** Files are listed in order and the order matters (merge, images to PDF). */
  ordered?: boolean;
  /** Tools P2: the feature flag the tool sits behind. Hidden (and refused) when it is not in GET /api/tools features. */
  feature?: ToolFeature;
  /** Tools P2: needs a desktop style screen (page editor, compare, signature placement); the phone app hides it. */
  webOnly?: boolean;
  /** Tools P2: a second slot of files sent under their own form field (signature images beside the PDF). */
  extra?: { field: string; label: string; accept: string; min: number; max: number; maxBytesEach?: number };
  /** Tools P2: phones can take the files with the camera (scan to PDF). */
  camera?: boolean;
  /** Tools P2: runs only inside another flow, so it gets no card of its own. */
  hidden?: boolean;
  /** Tools P2: the card opens this page instead of the form (the editors: /app/tools/pages and so on). */
  path?: string;
  /** Tools P2: the card opens its own screen instead of the plain options form ("autoredact"). */
  flow?: "autoredact";
}

const PDF = ".pdf,application/pdf";
const PDF_TYPE = "application/pdf";
const ZIP_TYPE = "application/zip";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const RANGES_HELP = "Page numbers and ranges, like 1-3, 5.";
const SHEETS = ".xlsx,.xls,.csv";
/** R86: the video and audio types the engine reads. */
export const MEDIA_ACCEPT = ".mp4,.m4v,.mov,.webm,.mkv,.avi,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,video/*,audio/*";
export const MEDIA_QUALITY = [{ value: "high", label: "Best quality" }, { value: "balanced", label: "Balanced" }, { value: "small", label: "Smaller file" }];
export const MEDIA_LEVELS = [{ value: "light", label: "A little" }, { value: "medium", label: "Balanced" }, { value: "strong", label: "Smallest" }];
const YES_NO = (yes = "Yes", no = "No") => [{ value: "yes", label: yes }, { value: "no", label: no }];

/** OCR languages (tesseract names). English stays the default; the rest show only when ocr_langs is on. */
export const OCR_LANGUAGES: { value: string; label: string }[] = [
  { value: "eng", label: "English" }, { value: "nep", label: "Nepali" }, { value: "hin", label: "Hindi" },
  { value: "eng+nep", label: "English and Nepali" }, { value: "eng+hin", label: "English and Hindi" },
  { value: "chi_sim", label: "Chinese (simplified)" }, { value: "chi_tra", label: "Chinese (traditional)" }, { value: "ara", label: "Arabic" },
  { value: "vie", label: "Vietnamese" }, { value: "ind", label: "Indonesian" }, { value: "tha", label: "Thai" }, { value: "fil", label: "Filipino" },
  { value: "jpn", label: "Japanese" }, { value: "kor", label: "Korean" }, { value: "spa", label: "Spanish" }, { value: "fra", label: "French" }, { value: "deu", label: "German" },
];

/** R70: compress levels (the engine's light, medium, strong). Hints use what real files did on the engine: a 960 KB
 * scan went to about 280 KB on Balanced and 130 KB on Smallest; Light leaves pictures alone. */
export const COMPRESS_LEVELS: { value: string; label: string; hint: string }[] = [
  { value: "light", label: "Light", hint: "Pictures stay as they are. Removes unused data only, so scans usually stay about the same size." },
  { value: "medium", label: "Balanced", hint: "Pictures at screen quality. Scans often end up about a third of their size. Text only files change little." },
  { value: "strong", label: "Smallest", hint: "Pictures at lower quality, still easy to read. Scans often end up about a sixth of their size. Text only files change little." },
];
export const COMPRESS_LEVEL_LABEL = (v: string | undefined): string => COMPRESS_LEVELS.find((l) => l.value === v)?.label ?? "Balanced";

/** R68: the engine reads up to this many pages a run in the non Latin OCR languages (each page is slower). */
export const HEAVY_OCR_MAX_PAGES = 10;
export const HEAVY_OCR_LANGUAGES = ["nep", "hin", "eng+nep", "eng+hin", "chi_sim", "chi_tra", "jpn", "kor", "ara", "tha"] as const;
export const ocrPageCap = (language: string | undefined): number => ((HEAVY_OCR_LANGUAGES as readonly string[]).includes(language ?? "") ? HEAVY_OCR_MAX_PAGES : 30);

export const TOOLS: ToolDef[] = [
  { op: "merge", group: "Organise", label: "Merge PDFs", blurb: "Join several PDFs into one, in the order you choose.", accept: PDF, acceptLabel: "2 or more PDFs", minFiles: 2, maxFiles: "plan", suffix: "-merged", ext: "pdf", contentType: PDF_TYPE, options: [], ordered: true },
  { op: "split", group: "Organise", label: "Split PDF", blurb: "Pull out pages or ranges as separate PDFs.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-split", ext: "zip", contentType: ZIP_TYPE,
    options: [{ name: "ranges", kind: "ranges", label: "Pages for each part", required: true, maxLen: 200, placeholder: "1-3, 4, 5-9", help: "Each range becomes its own PDF. " + RANGES_HELP }] },
  { op: "rotate", group: "Organise", label: "Rotate pages", blurb: "Turn every page, or only the ones you pick.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-rotated", ext: "pdf", contentType: PDF_TYPE,
    options: [
      { name: "angle", kind: "choice", label: "Turn", default: "90", choices: [{ value: "90", label: "Right" }, { value: "180", label: "Upside down" }, { value: "270", label: "Left" }] },
      { name: "ranges", kind: "ranges", label: "Pages", maxLen: 200, placeholder: "All pages", help: "Leave empty for every page. " + RANGES_HELP },
    ] },
  { op: "compress", group: "Convert", label: "Compress PDF", blurb: "Make a PDF smaller so it is easier to send.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-compressed", ext: "pdf", contentType: PDF_TYPE,
    options: [{ name: "level", kind: "choice", label: "How small", default: "medium", choices: COMPRESS_LEVELS }] },
  { op: "convert", group: "Convert", label: "Convert to PDF", blurb: "Turn a Word, Excel, PowerPoint or OpenDocument file into a PDF.", accept: ".docx,.xlsx,.pptx,.odt,.ods,.odp", acceptLabel: "a Word, Excel, PowerPoint or OpenDocument file", minFiles: 1, maxFiles: 1, suffix: "", ext: "pdf", contentType: PDF_TYPE, options: [] },
  { op: "to-jpeg", group: "Convert", label: "PDF to images", blurb: "Save every page as a JPEG image, in one ZIP.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-pages", ext: "zip", contentType: ZIP_TYPE, maxPages: 100, slow: { secondsPerPage: 1 },
    options: [{ name: "dpi", kind: "choice", label: "Quality", default: "150", choices: [{ value: "72", label: "Small" }, { value: "150", label: "Standard" }, { value: "300", label: "Sharp" }] }] },
  { op: "images-to-pdf", group: "Convert", label: "Images to PDF", blurb: "Put JPEG or PNG images into one PDF, one per page.", accept: ".jpg,.jpeg,.png,image/jpeg,image/png", acceptLabel: "JPEG or PNG images", minFiles: 1, maxFiles: 50, suffix: "", ext: "pdf", contentType: PDF_TYPE, options: [], ordered: true },
  { op: "pdf-to-docx", group: "Convert", label: "PDF to Word", blurb: "Get the text of a PDF as a Word document you can edit.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "", ext: "docx", contentType: DOCX_TYPE, options: [], note: "Text and basic layout only. Fonts, columns, tables and images are not kept." },
  { op: "redact", group: "Protect", label: "Redact text", blurb: "Black out words or phrases everywhere they appear. It cannot be undone.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-redacted", ext: "pdf", contentType: PDF_TYPE,
    options: [{ name: "phrases", kind: "phrases", label: "Words or phrases to black out", required: true, maxLen: 2000, placeholder: "Jane Citizen\n123 456 782", help: "One per line, typed exactly as they appear. Every match is covered and the result is checked so none can be found." }],
    note: "Pages with a match become images, so their text can no longer be selected." },
  { op: "scrub", group: "Protect", label: "Remove metadata", blurb: "Strip the author, title, software and other hidden details.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-clean", ext: "pdf", contentType: PDF_TYPE, options: [] },
  { op: "watermark", group: "Protect", label: "Watermark", blurb: "Stamp text such as DRAFT or CONFIDENTIAL across every page.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-watermarked", ext: "pdf", contentType: PDF_TYPE,
    options: [
      { name: "text", kind: "text", label: "Watermark text", required: true, maxLen: 80, placeholder: "CONFIDENTIAL" },
      { name: "opacity", kind: "int", label: "Strength (percent)", default: 25, min: 10, max: 60 },
    ] },
  { op: "unlock", group: "Protect", label: "Remove password", blurb: "Save a copy without its password, when you know the password.", accept: PDF, acceptLabel: "a password protected PDF", minFiles: 1, maxFiles: 1, suffix: "-unlocked", ext: "pdf", contentType: PDF_TYPE,
    options: [{ name: "password", kind: "password", label: "Current password", required: true, maxLen: 128, help: "Used for this run only and never stored." }] },
  { op: "ocr", group: "Scans", label: "Make searchable (OCR)", blurb: "Read the text in a scanned PDF so you can search and copy it.", accept: PDF, acceptLabel: "a scanned PDF", minFiles: 1, maxFiles: 1, suffix: "-searchable", ext: "pdf", contentType: PDF_TYPE, maxPages: 30, maxBytes: 20 * 1024 * 1024, slow: { secondsPerPage: 6 },
    options: [{ name: "language", kind: "choice", label: "Language", default: "eng", choices: OCR_LANGUAGES}],
    note: "Up to 30 pages and 20 MB, or 10 pages for Nepali, Hindi, Chinese, Japanese, Korean, Arabic and Thai. It reads about one page every few seconds." },

  // Tools P2, wave 1 (engine ops E1 and E2). Each sits behind its own flag.
  { op: "protect", group: "Protect", feature: "protect", label: "Add a password", blurb: "Lock a PDF so it needs a password to open.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-protected", ext: "pdf", contentType: PDF_TYPE,
    options: [
      { name: "password", kind: "password", label: "New password", required: true, maxLen: 128, minLen: 4, help: "At least 4 characters. Used for this run only and never stored. Send it to people separately from the file." },
      { name: "allow_print", kind: "choice", label: "Printing", default: "yes", choices: YES_NO("Allowed", "Not allowed") },
      { name: "allow_copy", kind: "choice", label: "Copying text", default: "yes", choices: YES_NO("Allowed", "Not allowed") },
    ],
    note: "Uses strong AES 256 encryption. If the password is lost, the file cannot be opened." },
  { op: "stamp", group: "Organise", feature: "stamps", label: "Stamp and number pages", blurb: "Add a stamp such as PAID or APPROVED, page numbers, a header or a footer.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-stamped", ext: "pdf", contentType: PDF_TYPE, maxPages: 500,
    options: [
      { name: "stamp", kind: "choice", label: "Stamp", default: "none", choices: [
        { value: "none", label: "None" }, { value: "approved", label: "Approved" }, { value: "paid", label: "Paid" }, { value: "draft", label: "Draft" },
        { value: "confidential", label: "Confidential" }, { value: "copy", label: "Copy" }, { value: "custom", label: "Your own words" }] },
      { name: "stamp_text", kind: "text", label: "Stamp words", maxLen: 40, placeholder: "RECEIVED 30 OCT", when: { option: "stamp", is: ["custom"] } },
      { name: "position", kind: "choice", label: "Stamp position", default: "top-right", when: { option: "stamp", not: ["none"] }, choices: [
        { value: "top-left", label: "Top left" }, { value: "top-right", label: "Top right" }, { value: "center", label: "Middle" },
        { value: "bottom-left", label: "Bottom left" }, { value: "bottom-right", label: "Bottom right" }] },
      { name: "page_numbers", kind: "choice", label: "Page numbers", default: "none", choices: [{ value: "none", label: "None" }, { value: "n", label: "1, 2, 3" }, { value: "page n of N", label: "Page 1 of 9" }] },
      { name: "number_position", kind: "choice", label: "Number position", default: "bottom-center", when: { option: "page_numbers", not: ["none"] }, choices: [{ value: "bottom-center", label: "Bottom middle" }, { value: "bottom-right", label: "Bottom right" }, { value: "top-right", label: "Top right" }] },
      { name: "number_digits", kind: "choice", label: "Number digits", default: "latin", when: { option: "page_numbers", not: ["none"] }, choices: [{ value: "latin", label: "1, 2, 3" }, { value: "devanagari", label: "१, २, ३ Nepali" }, { value: "auto", label: "Match the stamp language" }] },
      { name: "header", kind: "text", label: "Header", maxLen: 120, placeholder: "Acme Pty Ltd" },
      { name: "footer", kind: "text", label: "Footer", maxLen: 120, placeholder: "Commercial in confidence" },
      { name: "ranges", kind: "ranges", label: "Pages", maxLen: 200, placeholder: "All pages", help: "Leave empty for every page. " + RANGES_HELP },
    ] },
  { op: "to-pdf", group: "Convert", feature: "convert_plus", label: "Anything to PDF", blurb: "Turn a web page file, Markdown, CSV, text or an image into a PDF.", accept: ".html,.htm,.md,.markdown,.csv,.txt,.jpg,.jpeg,.png,.webp,.svg", acceptLabel: "an HTML, Markdown, CSV, text or image file", minFiles: 1, maxFiles: 1, suffix: "", ext: "pdf", contentType: PDF_TYPE, maxBytes: 10 * 1024 * 1024, options: [],
    note: "Web page files are made without loading anything from the internet, so outside images and fonts are left out." },
  { op: "pdf-to", group: "Convert", feature: "convert_plus", label: "PDF to text, CSV or Excel", blurb: "Get a PDF's text, its tables as CSV or Excel, or its pages as PNG images.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "", ext: "txt", contentType: EXT_TYPES.txt, maxPages: 200, slow: { secondsPerPage: 1 },
    extBy: { option: "target", exts: { txt: "txt", md: "md", csv: "csv", xlsx: "xlsx", png: "zip" } },
    options: [{ name: "target", kind: "choice", label: "Turn it into", default: "txt", choices: [
      { value: "txt", label: "Plain text" }, { value: "md", label: "Markdown" }, { value: "csv", label: "CSV (tables)" }, { value: "xlsx", label: "Excel (tables)" }, { value: "png", label: "PNG images" }] }] },
  { op: "pdf-tables", group: "Convert", feature: "excel", label: "PDF tables to Excel", blurb: "Find the tables in a PDF and put each one on its own sheet.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-tables", ext: "xlsx", contentType: EXT_TYPES.xlsx, maxPages: 100, slow: { secondsPerPage: 1 }, options: [],
    note: "Works on PDFs with real text. Scans need Make searchable first." },
  { op: "excel-merge", group: "Convert", feature: "excel", label: "Merge spreadsheets", blurb: "Join Excel or CSV files into one workbook, as sheets or as one long list.", accept: SHEETS, acceptLabel: "2 or more Excel or CSV files", minFiles: 2, maxFiles: 20, suffix: "-merged", ext: "xlsx", contentType: EXT_TYPES.xlsx, maxBytes: 50 * 1024 * 1024, ordered: true,
    options: [{ name: "mode", kind: "choice", label: "How to join", default: "sheets", choices: [{ value: "sheets", label: "Each file on its own sheet" }, { value: "stack", label: "One list, columns matched by name" }] }] },
  { op: "excel-clean", group: "Convert", feature: "excel", label: "Clean up a spreadsheet", blurb: "Trim spaces, remove duplicate and empty rows, and make dates consistent.", accept: SHEETS, acceptLabel: "an Excel or CSV file", minFiles: 1, maxFiles: 1, suffix: "-clean", ext: "xlsx", contentType: EXT_TYPES.xlsx, maxBytes: 50 * 1024 * 1024,
    options: [
      { name: "trim", kind: "choice", label: "Trim extra spaces", default: "yes", choices: YES_NO() },
      { name: "dedupe", kind: "choice", label: "Remove duplicate rows", default: "yes", choices: YES_NO() },
      { name: "dates", kind: "choice", label: "Dates", default: "keep", choices: [{ value: "keep", label: "Leave as they are" }, { value: "iso", label: "2026-10-30" }, { value: "au", label: "30/10/2026" }] },
      { name: "drop_empty", kind: "choice", label: "Remove empty rows", default: "yes", choices: YES_NO() },
    ] },
  { op: "scan-clean", group: "Scans", feature: "scan", label: "Scan to PDF", blurb: "Photos of paper become a clean, straight PDF. On a phone, take the photos right here.", accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp", acceptLabel: "photos of pages", minFiles: 1, maxFiles: 20, suffix: "-scan", ext: "pdf", contentType: PDF_TYPE, maxBytes: 40 * 1024 * 1024, slow: { secondsPerPage: 6 }, ordered: true, camera: true,
    options: [
      { name: "ocr", kind: "choice", label: "Make the text searchable", default: "no", choices: YES_NO() },
      { name: "language", kind: "choice", label: "Language of the text", default: "eng", choices: OCR_LANGUAGES, when: { option: "ocr", is: ["yes"] } },
      { name: "mode", kind: "choice", label: "Colour", default: "color", choices: [{ value: "color", label: "Colour" }, { value: "gray", label: "Greyscale" }, { value: "bw", label: "Black and white" }] },
    ],
    note: "Up to 20 photos, one page each, in the order shown. Pages are cropped, straightened and evened out." },
  { op: "pii-find", group: "Protect", feature: "autoredact", flow: "autoredact", label: "Find and hide sensitive info", blurb: "Find tax file numbers, ABNs, bank details, card numbers, phones and emails, then black out the ones you tick.", accept: PDF, acceptLabel: "a PDF", minFiles: 1, maxFiles: 1, suffix: "-found", ext: "json", contentType: EXT_TYPES.json, maxPages: 200, slow: { secondsPerPage: 1 },
    options: [{ name: "kinds", kind: "json", label: "What to look for", maxLen: 300 }],
    note: "Numbers are checked with their check digits where they have one, so fewer false matches. Always review before you black out." },

  // R86 (Tools round B): video and audio on the engine (an LGPL FFmpeg), HEIC photos for browsers outside Safari, e-books.
  { op: "media-convert", group: "Convert", feature: "convert_plus", label: "Convert video or audio", blurb: "Change a video or recording to MP4, MOV, WEBM, MP3, WAV or M4A, or make a GIF from a video.", accept: MEDIA_ACCEPT, acceptLabel: "a video or audio file", minFiles: 1, maxFiles: 1, suffix: "", ext: "mp4", contentType: EXT_TYPES.mp4, maxBytes: 100 * 1024 * 1024, slow: { secondsPerPage: 1 },
    extBy: { option: "to", exts: { mp4: "mp4", mov: "mov", webm: "webm", mp3: "mp3", wav: "wav", m4a: "m4a", gif: "gif" } },
    note: "Videos up to 3 minutes can be changed to another format. MOV to MP4 keeps the picture as it is and works for any length. A GIF uses the first 15 seconds.",
    options: [
      { name: "to", kind: "choice", label: "Change to", default: "mp4", choices: [{ value: "mp4", label: "MP4 video" }, { value: "mov", label: "MOV video" }, { value: "webm", label: "WEBM video" }, { value: "gif", label: "GIF from the video" }, { value: "mp3", label: "MP3 sound" }, { value: "m4a", label: "M4A sound" }, { value: "wav", label: "WAV sound" }] },
      { name: "quality", kind: "choice", label: "Quality", default: "balanced", choices: MEDIA_QUALITY },
    ] },
  { op: "media-compress", group: "Convert", feature: "convert_plus", label: "Compress video or audio", blurb: "Make a video or recording smaller so it is easier to send.", accept: MEDIA_ACCEPT, acceptLabel: "a video or audio file", minFiles: 1, maxFiles: 1, suffix: "-smaller", ext: "mp4", contentType: EXT_TYPES.mp4, maxBytes: 100 * 1024 * 1024, slow: { secondsPerPage: 1 },
    note: "Videos come back as MP4 and recordings as M4A. Videos up to 3 minutes.",
    options: [{ name: "level", kind: "choice", label: "How small", default: "medium", choices: MEDIA_LEVELS }] },
  { op: "photo-convert", group: "Convert", feature: "convert_plus", label: "HEIC photo to JPG", blurb: "Turn an iPhone photo into a JPG or PNG that opens anywhere.", accept: ".heic,.heif,image/heic,image/heif", acceptLabel: "a HEIC photo", minFiles: 1, maxFiles: 1, suffix: "", ext: "jpg", contentType: EXT_TYPES.jpg, maxBytes: 50 * 1024 * 1024,
    extBy: { option: "to", exts: { jpg: "jpg", png: "png" } },
    options: [{ name: "to", kind: "choice", label: "Change to", default: "jpg", choices: [{ value: "jpg", label: "JPG" }, { value: "png", label: "PNG" }] }] },
  { op: "ebook-to-pdf", group: "Convert", feature: "convert_plus", label: "E-book to PDF", blurb: "Turn an EPUB or MOBI e-book into a PDF you can read, print or send.", accept: ".epub,.mobi,.azw,.prc,application/epub+zip", acceptLabel: "an EPUB or MOBI e-book", minFiles: 1, maxFiles: 1, suffix: "", ext: "pdf", contentType: PDF_TYPE, maxBytes: 30 * 1024 * 1024, slow: { secondsPerPage: 1 },
    note: "E-books protected with DRM can't be converted.", options: [] },
  // Tools P2 (H7): the editors (page editor, form filler, compare). Each card opens its own page (path) and runs
  // through /api/tools/editors, never the plain form; the phone app hides the webOnly ones.
  ...TOOLS_EDITORS,
];

export const TOOL_GROUPS: ToolGroup[] = ["Organise", "Convert", "Protect", "Scans"];
export const TOOL_OPS = TOOLS.map((t) => t.op);
/** Whether the catalogue has this op (an op only reachable inside another helper's flow is not in it). */
export const isToolOp = (v: unknown): v is ToolOp => typeof v === "string" && (TOOL_OPS as string[]).includes(v);
export const toolDef = (op: ToolOp) => TOOLS.find((t) => t.op === op)!;

/** Whether a tool is on for this deployment: P1 tools always are, P2 tools when their flag is listed. */
export const toolOn = (def: Pick<ToolDef, "feature">, features: readonly string[]) => !def.feature || features.includes(def.feature);

/**
 * The catalogue as one deployment serves it (GET /api/tools): tools whose flag is off are left out, and
 * OCR offers English only until ocr_langs is on. The phone app and the web page both read this.
 */
export function catalogueFor(features: readonly string[], tools: ToolDef[] = TOOLS): ToolDef[] {
  const langs = features.includes("ocr_langs");
  return tools.filter((t) => toolOn(t, features)).map((t) => {
    if (!t.options.some((o) => o.name === "language")) return t;
    // With more languages on, say plainly that they are slow on the document engine.
    if (langs) return { ...t, options: t.options.map((o) => (o.name === "language" && !o.help ? { ...o, help: OCR_SLOW_NOTE } : o)) };
    return { ...t, options: t.options.map((o) => (o.name === "language" ? { ...o, choices: o.choices?.filter((c) => c.value === "eng") } : o)) };
  });
}

/** Whether an option shows (and is sent) with the other values as they are. */
export function optionShown(o: Pick<ToolOption, "when">, values: Record<string, string>): boolean {
  if (!o.when) return true;
  const v = values[o.when.option] ?? "";
  if (o.when.is && !o.when.is.includes(v)) return false;
  if (o.when.not && o.when.not.includes(v)) return false;
  return true;
}

/** Shown beside the OCR language choice when languages other than English are offered. */
export const OCR_SLOW_NOTE = "English is quickest. Nepali, Hindi, Chinese, Japanese, Korean, Arabic and Thai read up to 10 pages a run.";

/** The OCR languages a deployment allows (English only while ocr_langs is off). */
export const ocrLanguagesFor = (features: readonly string[]) => (features.includes("ocr_langs") ? OCR_LANGUAGES : OCR_LANGUAGES.filter((l) => l.value === "eng"));

/** The file extensions a tool takes, from its accept list (".pdf", ".docx", ...). */
/**
 * R73 (MB-272): Split starts with a range filled in once the PDF's pages are counted: every page on its own for up to
 * 30 pages, else parts of 10 pages. Empty for a one page file (nothing to split).
 */
export function defaultSplitRanges(pages: number): string {
  if (!Number.isFinite(pages) || pages < 2) return "";
  if (pages <= 30) return Array.from({ length: pages }, (_, i) => String(i + 1)).join(", ");
  const parts: string[] = [];
  for (let a = 1; a <= pages; a += 10) { const b = Math.min(pages, a + 9); parts.push(a === b ? String(a) : `${a}-${b}`); }
  return parts.join(", ");
}

export const toolExtensions = (def: Pick<ToolDef, "accept">) => def.accept.split(",").filter((x) => x.startsWith("."));
/** Whether a tool takes a file with this name. */
export function toolTakes(def: Pick<ToolDef, "accept">, filename: string): boolean {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(filename);
  return !!m && toolExtensions(def).includes(m[0].toLowerCase());
}
/**
 * The tools a single mail attachment can go straight into: one file tools with a plain form (merge needs two files,
 * flows and desktop screens open from their own pages). Pass the deployment's features to drop tools that are off.
 */
export const toolsForFile = (filename: string, features: readonly string[] = []) =>
  TOOLS.filter((t) => t.minFiles <= 1 && !t.hidden && !t.extra && !t.path && toolOn(t, features) && toolTakes(t, filename));

/** Tools that can run on every attachment of a thread at once (batch): one job per file, or one job for all (merge). */
export const batchTools = (features: readonly string[], tools: ToolDef[] = TOOLS) =>
  tools.filter((t) => !t.hidden && !t.flow && !t.extra && !t.webOnly && !t.path && toolOn(t, features) && !t.options.some((o) => o.kind === "json" && o.required));

/** The result's type for a run with these options (most tools have one; PDF to follows its target). */
export function resultExt(def: Pick<ToolDef, "ext" | "extBy">, options?: Record<string, string> | null): ToolExt {
  if (def.extBy) {
    const v = options?.[def.extBy.option];
    if (v && def.extBy.exts[v]) return def.extBy.exts[v];
  }
  return def.ext;
}

/** The result's file name from the first input's name: letters, numbers and simple marks only. */
export function resultName(op: ToolOp, firstName: string | null | undefined, options?: Record<string, string> | null): string {
  const base = (firstName ?? "").replace(/\.[A-Za-z0-9]{1,8}$/, "").replace(/[^A-Za-z0-9 _.()+-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "document";
  const def = toolDef(op);
  // R66: running a tool on its own result does not stack the suffix ("invoice-compressed-compressed.pdf").
  const stem = def.suffix && base.toLowerCase().endsWith(def.suffix.toLowerCase()) ? base : `${base}${def.suffix}`;
  return `${stem}.${resultExt(def, options)}`;
}

/** The same name with the extension the engine actually produced (null keeps it). */
export function withExt(name: string, ext: ToolExt | null): string {
  if (!ext) return name;
  return /\.[A-Za-z0-9]{1,8}$/.test(name) ? name.replace(/\.[A-Za-z0-9]{1,8}$/, `.${ext}`) : `${name}.${ext}`;
}

/** What pii-find looks for, in the order the review screen lists it. */
export const PII_KINDS = [
  { kind: "tfn", label: "Tax file numbers" },
  { kind: "abn", label: "ABNs" },
  { kind: "acn", label: "ACNs" },
  { kind: "bsb_account", label: "Bank details (BSB and account)" },
  { kind: "card", label: "Card numbers" },
  { kind: "medicare", label: "Medicare numbers" },
  { kind: "phone", label: "Phone numbers" },
  { kind: "email", label: "Email addresses" },
] as const;
export type PiiKind = (typeof PII_KINDS)[number]["kind"];
export interface PiiMatch { kind: string; text: string; page: number; rect?: number[] }

export interface ToolsUsage { month: number; day: number }
export interface ToolsLimits { runsMonthly: number; runsDaily: number; maxBytes: number; maxMergeFiles: number }
export interface ToolsInfo { enabled: boolean; tools: ToolDef[]; usage: ToolsUsage; limits: ToolsLimits; /** Tools P2 features on for this deployment (TOOLS_FEATURES). */ features: ToolFeature[] }
export type ToolJobStatus = "queued" | "running" | "done" | "failed" | "expired" | "cancelled";
/** Small facts about a result, never file contents: pages, parts, matches covered. */
export interface ToolResultFacts {
  pages?: number; parts?: number; matches?: number; phrases?: number; verified?: boolean; pages_changed?: number; pages_with_text?: number;
  // Tools P2 facts (contract): tables found, rows kept and removed, sheets made, fields, files, words changed.
  tables?: number; rows?: number; rows_removed?: number; sheets?: number; fields?: number; fields_filled?: number; files?: number;
  words_added?: number; words_removed?: number; segments_replaced?: number; chars?: number; steps?: number;
  // R71 (MB-263): compress says what it did: sizes in and out, and true when the file came back as it was.
  in_bytes?: number; out_bytes?: number; images_changed?: number; already_optimised?: boolean;
  // R86: seconds of video or audio, streams copied as they were, a GIF cut to its first seconds, e-book chapters.
  seconds?: number; copied?: boolean; trimmed?: boolean; chapters?: number;
}
/** The fact keys the server passes through to the browser (small numbers and flags only, never file contents). */
export const TOOL_FACT_KEYS = [
  "pages", "parts", "matches", "phrases", "verified", "pages_changed", "pages_with_text",
  "tables", "rows", "rows_removed", "sheets", "fields", "fields_filled", "files", "words_added", "words_removed", "segments_replaced", "chars", "steps",
  "in_bytes", "out_bytes", "images_changed", "already_optimised",
  "seconds", "copied", "trimmed", "chapters",
] as const;
export interface ToolJob {
  token: string; op: ToolOp; status: ToolJobStatus; name: string; error?: string; bytes?: number; downloadUrl?: string;
  progress?: { done: number; total: number };
  result?: ToolResultFacts;
  /** R66 (MB-256): true when this finished run found nothing to do, so it was not counted against the plan. */
  notCounted?: boolean;
}

/**
 * R66 (MB-256): a run is counted only when it finishes with a result. A run that found nothing to work on
 * (no table in the PDF, no phrase or number matched) finishes "done" but is not counted either.
 */
export function emptyResult(op: string, r?: ToolResultFacts | null): boolean {
  if (!r) return false;
  if (op === "pdf-tables") return r.tables === 0;
  if (op === "redact" || op === "pii-find") return r.matches === 0;
  if (op === "compress" || op === "media-compress") return compressUnchanged(r.in_bytes, r.out_bytes, r.already_optimised);
  return false;
}

/**
 * R71 (MB-263): a compress run that gave the file back as it was, or less than 2% smaller (the result card says
 * "about the same" then), did nothing for the person, so it is not counted either.
 */
export function compressUnchanged(inBytes?: number, outBytes?: number, alreadyOptimised?: boolean): boolean {
  if (alreadyOptimised === true) return true;
  if (!inBytes || !outBytes || inBytes <= 0) return false;
  return outBytes >= inBytes * 0.98;
}

/** R71 (MB-263): the line a result shows when its run was not counted. */
export function notCountedLine(op: string): string {
  if (op === "compress") return "The file did not get smaller, so this run was not counted.";
  return "Nothing was found, so this run was not counted.";
}

/** Tools UX: the remove password tool's op id, for web files whose copy lint reads every word. */
export const OP_REMOVE_PASSWORD: ToolOp = "unlock";
