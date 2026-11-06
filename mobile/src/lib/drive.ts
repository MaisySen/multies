import type { Transport } from "@/api/transport";
import type { IconName } from "@/components/icons";
import { LOCALE } from "./format";

/**
 * M1 (1.10.9): the workspace drive on the phone (web R101 Files plus). Types, limits, labels and the
 * rules mirror the web's src/shared/drive.ts exactly; the routes are the web's own under /api/drive,
 * shown only when GET /api/config says filesPlus and the session is a workspace member.
 */
export const DRIVE_SPACES = ["team", "private", "brand"] as const;
export type DriveSpace = (typeof DRIVE_SPACES)[number];
export const DRIVE_VIEWS = ["team", "mine", "shared", "starred", "recent", "trash", "brand"] as const;
export type DriveView = (typeof DRIVE_VIEWS)[number];
export const isDriveView = (v: unknown): v is DriveView => typeof v === "string" && (DRIVE_VIEWS as readonly string[]).includes(v);

/** The web's limits (src/shared/drive.ts). The server enforces them; the phone checks first to save a wasted upload. */
export const DRIVE_LIMITS = { fileBytes: 20 * 1024 * 1024, workspaceBytes: 200 * 1024 * 1024, versions: 20, trashDays: 30, page: 100, name: 200, tags: 12, tag: 32, note: 500, bulk: 200 } as const;

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
  canEdit: boolean;
  canDelete: boolean;
  location?: string;
}
export interface DriveCrumb { id: string | null; name: string }
export interface DriveList { view: DriveView; folder: { id: string; name: string; canEdit: boolean } | null; path: DriveCrumb[]; canAdd: boolean; items: DriveItem[]; next: string | null }
export interface DriveVersion { id: string; number: number; sizeBytes: number; contentType: string; name: string; createdBy: string; createdAt: string; note: string | null; current: boolean }
export interface DriveShare { userId: string; name: string; email: string | null; role: DriveRole }
export interface DriveDetail { item: DriveItem; versions: DriveVersion[]; shares: DriveShare[]; canShare: boolean }
export interface DriveUsage { usedBytes: number; quotaBytes: number; fileBytes: number }
export interface DriveTag { tag: string; count: number }

/** The web's sizeLabel. */
export const sizeLabel = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

/** The web's cleanName: no slashes or control characters, trimmed, bounded. */
export function cleanName(raw: string): string {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_LIMITS.name).trim();
  return s === "." || s === ".." ? "" : s;
}

/** The web's cleanTags: lower case words, no duplicates, bounded. */
export function cleanTags(raw: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of raw ?? []) {
    const v = String(t).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, DRIVE_LIMITS.tag).trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= DRIVE_LIMITS.tags) break;
  }
  return out;
}

/** Splits what someone typed ("logo, dark, print") into tags. */
export const parseTags = (s: string) => cleanTags(s.split(/[,\n]+/));

export type PreviewKind = "image" | "pdf" | "video" | "audio" | "text" | "office" | "none";
const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/i;
const TEXT = /\.(txt|md|csv|tsv|json|log|xml|yml|yaml|ini|css|html?)$/i;
/** The web's previewKind. */
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

/** Images the phone can draw itself (SVG and AVIF go to the system viewer instead). */
export const phonePreviewsImage = (it: Pick<DriveItem, "kind" | "contentType" | "name">) =>
  it.kind === "file" && /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(it.contentType ?? "");

export function itemIcon(it: Pick<DriveItem, "kind" | "contentType" | "name">): IconName {
  if (it.kind === "folder") return "layers";
  switch (previewKind(it.contentType, it.name)) {
    case "image": return "eye";
    case "video": return "video";
    case "pdf": case "text": return "file-text";
    case "office": return "doc";
    default: return "paperclip";
  }
}

const sameYear = (d: Date, now: Date) => d.getFullYear() === now.getFullYear();
export function dateLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", ...(sameYear(d, now) ? {} : { year: "numeric" }) });
}

/** The second line of a row: size and date, and where it sits in Starred, Recent, Shared, Trash and search. */
export function rowSub(it: DriveItem, now = new Date()): string {
  const bits: string[] = [];
  if (it.kind === "file") bits.push(sizeLabel(it.sizeBytes));
  bits.push(dateLabel(it.trashedAt ?? it.updatedAt, now));
  if (it.location) bits.push(it.location);
  return bits.filter(Boolean).join(" · ");
}

/** "12.4 MB of 200 MB used". */
const roundLabel = (n: number) => sizeLabel(n).replace(/\.0 /, " ");
export const usageLine = (u: DriveUsage) => `${roundLabel(u.usedBytes)} of ${roundLabel(u.quotaBytes)} used`;
export const usageFraction = (u: DriveUsage) => (u.quotaBytes > 0 ? Math.min(1, u.usedBytes / u.quotaBytes) : 0);

/** The web's words for a file over the limit, said before the upload starts. */
export const tooBigLine = () => `Files can be up to ${Math.round(DRIVE_LIMITS.fileBytes / (1024 * 1024))} MB here.`;
export const tooBig = (size: number | undefined) => typeof size === "number" && size > DRIVE_LIMITS.fileBytes;

/** Trash keeps items 30 days; the line under the Trash list. */
export const trashFootnote = () => `Items in the trash are deleted for good after ${DRIVE_LIMITS.trashDays} days.`;
export const zipFootnote = () => "Downloading several files as a zip is on the web.";

/** Where a new upload or folder goes in this list, or null when this list takes none (Shared, Starred, Recent, Trash). */
export function addTarget(list: Pick<DriveList, "view" | "folder" | "canAdd"> | undefined): { space: DriveSpace; parentId: string | null } | null {
  if (!list || !list.canAdd) return null;
  const space = SPACE_OF_VIEW[list.view] ?? (list.view === "shared" ? "private" : null);
  if (!space) return null;
  return { space, parentId: list.folder?.id ?? null };
}

/** What select mode offers for the chosen items. The server still decides each one. */
export function selectActions(view: DriveView, items: DriveItem[]): { move: boolean; star: boolean; trash: boolean; restore: boolean } {
  if (!items.length) return { move: false, star: false, trash: false, restore: false };
  if (view === "trash") return { move: false, star: false, trash: false, restore: true };
  const editable = items.every((i) => i.canEdit);
  return { move: editable, star: true, trash: editable, restore: false };
}

/** Star on unless every chosen item is starred already. */
export const starTarget = (items: DriveItem[]) => !items.every((i) => i.starred);

export const isAdminRole = (role: string | null | undefined) => role === "owner" || role === "admin";

/** Tags edit on the Brand library only, and only for admins (the web's rule; the server checks too). */
export const canEditTags = (it: Pick<DriveItem, "space" | "canEdit">, admin: boolean) => it.space === "brand" && admin && it.canEdit;

/** The views in the order the phone shows them. Brand library is for everyone to open; only admins change it. */
export const MAIN_VIEWS: DriveView[] = ["team", "mine", "shared"];
export const MORE_VIEWS: DriveView[] = ["starred", "recent", "brand", "trash"];

export function emptyFor(view: DriveView, inFolder: boolean, q: string): { title: string; body: string } {
  if (q) return { title: "Nothing matches", body: "Try a shorter word or check the spelling." };
  if (inFolder) return { title: "This folder is empty", body: "Add files or folders with the plus button." };
  switch (view) {
    case "team": return { title: "No team files yet", body: "Files here are open to everyone in the workspace. Add one with the plus button." };
    case "mine": return { title: "No files of yours yet", body: "Files here are private to you until you share them." };
    case "shared": return { title: "Nothing shared with you", body: "When a teammate shares a file from My files, it shows here." };
    case "starred": return { title: "Nothing starred", body: "Star a file or folder to find it here quickly." };
    case "recent": return { title: "No recent files", body: "Files you and your team change show here." };
    case "trash": return { title: "Trash is empty", body: trashFootnote() };
    case "brand": return { title: "No brand files yet", body: "Admins keep logos and templates here for everyone." };
  }
}

/** Reads the server's error words (the web shows them as is); a 401 or 403 is the no access state. */
export function driveError(e: unknown): { noAccess: boolean; off: boolean; offline: boolean; message: string } {
  const status = (e as { status?: number } | null)?.status;
  const message = e instanceof Error && e.message ? e.message : "Something went wrong. Try again.";
  return { noAccess: status === 401 || status === 403, off: status === 404, offline: status === 0, message };
}

export function uploadPath(t: { space: DriveSpace; parentId: string | null }, name: string) {
  const p = new URLSearchParams({ space: t.space, name });
  if (t.parentId) p.set("parent", t.parentId);
  return `/api/drive/upload?${p.toString()}`;
}
export const versionPath = (id: string) => `/api/drive/items/${encodeURIComponent(id)}/content`;
export const contentPath = (id: string, opts: { v?: string; inline?: boolean } = {}) => {
  const p = new URLSearchParams();
  if (opts.v) p.set("v", opts.v);
  if (opts.inline) p.set("inline", "1");
  const s = p.toString();
  return `/api/drive/items/${encodeURIComponent(id)}/content${s ? `?${s}` : ""}`;
};

/**
 * The search words the drive is asked for. The server matches names with a LIKE pattern, and the database refuses a
 * pattern over 50 bytes (a long search answered 500 on staging, Nov 1), so the phone sends at most 46 bytes of words,
 * cut at a character boundary. Names are bounded to 200 characters, so a long paste still finds by its start.
 */
export const DRIVE_QUERY_BYTES = 46;
export function driveQuery(raw: string): string {
  let q = String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const bytes = (s: string) => new TextEncoder().encode(s.replace(/[%_!]/g, (c) => `!${c}`)).length;
  while (q && bytes(q) > DRIVE_QUERY_BYTES) q = Array.from(q).slice(0, -1).join("");
  return q.trim();
}

const enc = encodeURIComponent;
/** The drive's JSON routes. Uploads and downloads go through the phone's own file transfer (lib/drive-files.ts). */
export function driveApi(t: Transport) {
  return {
    list: (p: { view: DriveView; folder?: string | null; q?: string; cursor?: string | null }) => {
      const qs = new URLSearchParams({ view: p.view });
      if (p.folder) qs.set("folder", p.folder);
      const q = p.q ? driveQuery(p.q) : "";
      if (q) qs.set("q", q);
      if (p.cursor) qs.set("cursor", p.cursor);
      return t.request<DriveList>("GET", `/drive/list?${qs.toString()}`);
    },
    usage: () => t.request<DriveUsage>("GET", "/drive/usage"),
    tags: () => t.request<{ tags: DriveTag[] }>("GET", "/drive/tags"),
    detail: (id: string, trashed = false) => t.request<DriveDetail>("GET", `/drive/items/${enc(id)}${trashed ? "?trashed=1" : ""}`),
    createFolder: (b: { space: DriveSpace; parentId: string | null; name: string }) => t.request<{ item: DriveItem }>("POST", "/drive/folders", b),
    update: (id: string, b: { name?: string; tags?: string[]; note?: string | null }) => t.request<{ item: DriveItem }>("PATCH", `/drive/items/${enc(id)}`, b),
    restoreVersion: (id: string, vid: string) => t.request<DriveDetail>("POST", `/drive/items/${enc(id)}/versions/${enc(vid)}/restore`, {}),
    move: (b: { ids: string[]; parentId: string | null; space?: DriveSpace }) => t.request<{ moved: number }>("POST", "/drive/move", b),
    trash: (ids: string[]) => t.request<{ trashed: number }>("POST", "/drive/trash", { ids }),
    restore: (ids: string[]) => t.request<{ restored: number }>("POST", "/drive/restore", { ids }),
    star: (ids: string[], on: boolean) => t.request<{ ok: true }>("POST", "/drive/star", { ids, on }),
  };
}
export type DriveApi = ReturnType<typeof driveApi>;

/** Lightweight shape checks the contract smoke and tests use on real answers. */
export function isDriveList(x: unknown): x is DriveList {
  const v = x as DriveList;
  return !!v && isDriveView(v.view) && Array.isArray(v.path) && Array.isArray(v.items) && typeof v.canAdd === "boolean" && (v.next === null || typeof v.next === "string") && v.items.every(isDriveItem);
}
export function isDriveItem(x: unknown): x is DriveItem {
  const v = x as DriveItem;
  return !!v && typeof v.id === "string" && (v.kind === "file" || v.kind === "folder") && (DRIVE_SPACES as readonly string[]).includes(v.space)
    && typeof v.name === "string" && typeof v.sizeBytes === "number" && Array.isArray(v.tags) && typeof v.starred === "boolean" && typeof v.canEdit === "boolean" && typeof v.updatedAt === "string";
}
export function isDriveDetail(x: unknown): x is DriveDetail {
  const v = x as DriveDetail;
  return !!v && isDriveItem(v.item) && Array.isArray(v.versions) && v.versions.every((r) => typeof r.id === "string" && typeof r.number === "number" && typeof r.current === "boolean") && Array.isArray(v.shares);
}
export const isDriveUsage = (x: unknown): x is DriveUsage => !!x && typeof (x as DriveUsage).usedBytes === "number" && typeof (x as DriveUsage).quotaBytes === "number";
