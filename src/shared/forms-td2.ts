/**
 * TD2 (FORMS_TD2): Forms pro. Pure helpers shared by the form builder, the public form page and the server:
 * file kinds and limits, reading a file's real type from its first bytes, safe file names, form layout settings
 * and pages. No network, no storage here.
 */
import { isLayout, type LogicField } from "./form-logic";

/** Hard server cap for one uploaded file, whatever a field asks for. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** A drawn or typed signature is a small picture. */
export const SIGNATURE_MAX_BYTES = 512 * 1024;
export const MAX_FILES_PER_FIELD = 5;
/** Upload limits: per form and sender, per form, and form files kept per workspace. */
export const UPLOAD_LIMITS = { perSender: 20, senderWindowMs: 10 * 60_000, perForm: 300, formWindowMs: 60 * 60_000, workspaceBytes: 200 * 1024 * 1024, pendingMs: 24 * 60 * 60_000 } as const;

export type FileKind = "images" | "pdf" | "documents" | "spreadsheets" | "text";
export const FILE_KINDS: { id: FileKind; label: string; hint: string }[] = [
  { id: "images", label: "Images", hint: "PNG, JPEG, GIF, WebP" },
  { id: "pdf", label: "PDF", hint: "PDF" },
  { id: "documents", label: "Documents", hint: "Word, PowerPoint" },
  { id: "spreadsheets", label: "Spreadsheets", hint: "Excel, CSV" },
  { id: "text", label: "Text", hint: "TXT" },
];
const KIND_IDS = FILE_KINDS.map((k) => k.id);
/** What the file picker offers for each kind (the server reads the bytes; this only narrows the picker). */
export const KIND_ACCEPT: Record<FileKind, string> = {
  images: ".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp",
  pdf: ".pdf,application/pdf",
  documents: ".docx,.pptx",
  spreadsheets: ".xlsx,.csv",
  text: ".txt",
};

export interface Sniffed { type: string; kind: FileKind; ext: string }
const OOXML: Record<string, { type: string; kind: FileKind }> = {
  docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "documents" },
  pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "documents" },
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheets" },
};
const starts = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name)?.[1] ?? "").toLowerCase();

/** Plain text: valid UTF 8, no NUL, and nothing that a browser would read as markup at the start. */
function looksLikeText(b: Uint8Array): boolean {
  const head = b.subarray(0, Math.min(b.length, 64 * 1024));
  if (head.includes(0)) return false;
  try { const t = new TextDecoder("utf-8", { fatal: true }).decode(head.length < b.length ? head.subarray(0, lastBoundary(head)) : head); return !/^\s*</.test(t); } catch { return false; }
}
/** Cuts a sample at a UTF 8 character boundary so a cut character is not read as invalid. */
function lastBoundary(b: Uint8Array): number {
  let i = b.length;
  for (let k = 0; k < 4 && i > 0; k++) { if ((b[i - 1] & 0xc0) !== 0x80) { const lead = b[i - 1]; const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1; return need === 1 ? i : i - 1; } i--; }
  return b.length;
}

/**
 * The file's real type from its first bytes (the browser's claimed type is ignored). Office files are zip files,
 * so they also need the matching name ending. SVG, HTML and scripts are never accepted. Null = not allowed.
 */
export function sniffType(bytes: Uint8Array, name: string): Sniffed | null {
  const ext = extOf(name);
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "image/png", kind: "images", ext: "png" };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { type: "image/jpeg", kind: "images", ext: "jpg" };
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return { type: "image/gif", kind: "images", ext: "gif" };
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { type: "image/webp", kind: "images", ext: "webp" };
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: "application/pdf", kind: "pdf", ext: "pdf" };
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) { const o = OOXML[ext]; return o ? { ...o, ext } : null; }
  if ((ext === "txt" || ext === "csv") && bytes.length && looksLikeText(bytes)) return ext === "csv" ? { type: "text/csv", kind: "spreadsheets", ext } : { type: "text/plain", kind: "text", ext };
  return null;
}

/** A file name that is safe to store and show: no folders, no control or markup characters, a sane length. */
export function cleanFileName(raw: string, ext?: string): string {
  let n = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  n = n.normalize("NFC").replace(/[\u0000-\u001f\u007f<>:"|?*`$&;{}[\]\\^%]/g, "").replace(/\s+/g, " ").replace(/^[.\s]+/, "").trim();
  const base = n.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 100).trim() || "file";
  const end = ext || extOf(n) || "bin";
  return `${base}.${end}`;
}

export const allowedKinds = (f: Pick<LogicField, "type" | "fileTypes">): FileKind[] =>
  f.type === "signature" ? ["images"] : (f.fileTypes ?? []).filter((k): k is FileKind => (KIND_IDS as string[]).includes(k)).length ? (f.fileTypes as FileKind[]).filter((k) => (KIND_IDS as string[]).includes(k)) : KIND_IDS;
/** The field's own size limit in bytes, never above the hard cap. */
export const fieldMaxBytes = (f: Pick<LogicField, "type" | "maxSizeMb">): number =>
  f.type === "signature" ? SIGNATURE_MAX_BYTES : Math.min(MAX_UPLOAD_BYTES, Math.max(1, Math.min(10, Math.round(f.maxSizeMb ?? 10))) * 1024 * 1024);
export const fieldMaxFiles = (f: Pick<LogicField, "type" | "maxFiles">): number => (f.type === "signature" ? 1 : Math.max(1, Math.min(MAX_FILES_PER_FIELD, Math.round(f.maxFiles ?? 1))));
export const acceptFor = (f: Pick<LogicField, "type" | "fileTypes">): string => allowedKinds(f).map((k) => KIND_ACCEPT[k]).join(",");
export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** Form level settings for TD2 forms. */
export interface Td2Settings { progress: boolean; oneAtATime: boolean }
export const DEFAULT_TD2: Td2Settings = { progress: true, oneAtATime: false };
export function parseTd2(raw: unknown): Td2Settings {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { v = null; } }
  const o = (v && typeof v === "object" ? v : {}) as Partial<Td2Settings>;
  return { progress: o.progress === undefined ? DEFAULT_TD2.progress : !!o.progress, oneAtATime: !!o.oneAtATime };
}

/** Splits a form at its page breaks. Each page lists its items (page break blocks themselves are left out). */
export function splitPages<F extends Pick<LogicField, "type">>(fields: F[]): F[][] {
  const pages: F[][] = [[]];
  for (const f of fields) { if (f.type === "page") { if (pages[pages.length - 1].length) pages.push([]); } else pages[pages.length - 1].push(f); }
  return pages.filter((p, i) => p.length || i === 0);
}
/** The questions one at a time mode steps through: every answer field plus each heading, paragraph or image as its own step. */
export const steps = <F extends Pick<LogicField, "type">>(fields: F[]): F[] => fields.filter((f) => f.type !== "page" && f.type !== "divider");
export const answerable = <F extends Pick<LogicField, "type">>(fields: F[]): F[] => fields.filter((f) => !isLayout(f.type));
