/**
 * R101 Files plus: the workspace drive (Team files, My files, shares, stars, versions, trash) and the brand
 * asset library, shared by the server routes and the Files page. Flag FILES_PLUS_R101.
 */
export const DRIVE_SPACES = ["team", "private", "brand"] as const;
export type DriveSpace = (typeof DRIVE_SPACES)[number];
export const DRIVE_VIEWS = ["team", "mine", "shared", "starred", "recent", "trash", "brand"] as const;
export type DriveView = (typeof DRIVE_VIEWS)[number];
export const isDriveView = (v: unknown): v is DriveView => typeof v === "string" && (DRIVE_VIEWS as readonly string[]).includes(v);

export const DRIVE_LIMITS = {
  /** One file (one version). */
  fileBytes: 20 * 1024 * 1024,
  /** Everything a workspace keeps, versions included. */
  workspaceBytes: 200 * 1024 * 1024,
  versions: 20,
  trashDays: 30,
  page: 100,
  name: 200,
  tags: 12,
  tag: 32,
  note: 500,
  /** A zip is made in the browser from at most this much. */
  zipFiles: 500,
  zipBytes: 200 * 1024 * 1024,
  /** Folder depth, and the most items one move, trash or restore touches. */
  depth: 24,
  subtree: 2000,
  bulk: 200,
} as const;

/** Raw bytes per stored chunk (base64 stays under D1's 2 MB value limit). */
export const DRIVE_CHUNK = 1_250_000;

export const VIEW_LABEL: Record<DriveView, string> = {
  team: "Team files", mine: "My files", shared: "Shared with me", starred: "Starred", recent: "Recent", trash: "Trash", brand: "Brand library",
};
export const SPACE_OF_VIEW: Partial<Record<DriveView, DriveSpace>> = { team: "team", mine: "private", brand: "brand" };
export const VIEW_OF_SPACE: Record<DriveSpace, DriveView> = { team: "team", private: "mine", brand: "brand" };

export type DriveRole = "view" | "edit";
export interface DriveItem {
  id: string;
  kind: "folder" | "file";
  space: DriveSpace;
  parentId: string | null;
  name: string;
  contentType: string | null;
  sizeBytes: number;
  versions: number;
  tags: string[];
  note: string | null;
  createdBy: { id: string; name: string };
  ownerId: string | null;
  updatedAt: string;
  createdAt: string;
  starred: boolean;
  shared: boolean;
  trashedAt: string | null;
  /** What the caller may do with it. */
  canEdit: boolean;
  canDelete: boolean;
  /** Where it sits, for starred, recent, shared and trash rows. */
  location?: string;
}
export interface DriveCrumb { id: string | null; name: string }
export interface DriveList {
  view: DriveView;
  folder: { id: string; name: string; canEdit: boolean } | null;
  path: DriveCrumb[];
  canAdd: boolean;
  items: DriveItem[];
  next: string | null;
}
export interface DriveVersion { id: string; number: number; sizeBytes: number; contentType: string; name: string; createdBy: string; createdAt: string; note: string | null; current: boolean }
export interface DriveShare { userId: string; name: string; email: string | null; role: DriveRole }
export interface DriveDetail { item: DriveItem; versions: DriveVersion[]; shares: DriveShare[]; canShare: boolean }
export interface DriveUsage { usedBytes: number; quotaBytes: number; fileBytes: number }
export interface DriveManifest { files: { id: string; path: string; sizeBytes: number }[]; totalBytes: number }

/** Cleans a file or folder name: no slashes or control characters, trimmed, bounded. */
export function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_LIMITS.name).trim();
  return s === "." || s === ".." ? "" : s;
}

/** Brand tags: lower case words, no duplicates, bounded. */
export function cleanTags(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of raw ?? []) {
    const v = String(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_LIMITS.tag).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= DRIVE_LIMITS.tags) break;
  }
  return out;
}

/** "Report.pdf" taken: "Report (2).pdf", then (3) ... */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  const low = new Set([...taken].map((n) => n.toLowerCase()));
  if (!low.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const stem = base.replace(/ \(\d+\)$/, "");
  for (let i = 2; i < 10_000; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!low.has(n.toLowerCase())) return n;
  }
  return `${stem} (${Date.now()})${ext}`;
}

export type PreviewKind = "image" | "pdf" | "video" | "audio" | "text" | "office" | "none";
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
const TEXT = /\.(txt|md|csv|tsv|json|log|xml|yml|yaml|ini|css|html?)$/i;
export function previewKind(contentType: string | null, name: string): PreviewKind {
  const t = (contentType ?? "").toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)$/.test(t)) return "image";
  if (t === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(t)) return "video";
  if (/^audio\//.test(t)) return "audio";
  if (OFFICE.test(name)) return "office";
  if (t.startsWith("text/") || t === "application/json" || TEXT.test(name)) return "text";
  return "none";
}

/** Types the server sends inline (always with a locked down policy); everything else downloads. */
export function inlineSafe(contentType: string): boolean {
  return /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/[a-z0-9.+-]+|text\/plain|application\/pdf)$/i.test(contentType);
}

/** Parses a single "bytes=a-b" range against a size; null when absent or unusable (send the whole file). */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number, end: number;
  if (!m[1]) { const n = Number(m[2]); if (!n) return "invalid"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
