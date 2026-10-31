/**
 * R88: secure share, the parts the server, the web app and the public pages share. Limits live here, in one place.
 * File requests: a client uploads files to a workspace without an account (chunked, resumable). Secret links: text or
 * a small file encrypted in the browser with AES GCM; the key lives only in the link's fragment, so the server never
 * sees it. Files are kept in the same KV kept files store (and under the same plan caps) as share links.
 */
const MB = 1024 * 1024;

/** One chunk of a resumable upload. Under the Worker request body limit, and one KV value per chunk. */
export const REQUEST_CHUNK_BYTES = 8 * MB;
/** The per file caps an owner can pick. */
export const REQUEST_FILE_CAPS = [10 * MB, 25 * MB, 50 * MB, 100 * MB] as const;
export const REQUEST_MAX_FILE_BYTES = 100 * MB;
/** The total caps an owner can pick for one request. */
export const REQUEST_TOTAL_CAPS = [50 * MB, 100 * MB, 250 * MB, 500 * MB] as const;
export const REQUEST_MAX_UPLOADS = 500;
export const REQUEST_KEEP_DAYS = [7, 30, 90] as const;
export const REQUEST_EXPIRY_CHOICES: { label: string; days: number }[] = [
  { label: "1 day", days: 1 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];
/** New requests and secrets a workspace may make in a day (abuse guard). */
export const REQUESTS_PER_DAY = 50;
export const SECRETS_PER_DAY = 200;
/** Reports from public pages that pause a link until someone in the workspace looks. */
export const REPORTS_TO_PAUSE = 3;

/** Groups of file types an owner can allow. "any" still blocks programs. */
export const REQUEST_TYPE_GROUPS = {
  documents: { label: "Documents", ext: ["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "pages", "key", "ppt", "pptx", "odp"] },
  images: { label: "Images", ext: ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "svg"] },
  spreadsheets: { label: "Spreadsheets", ext: ["xls", "xlsx", "csv", "ods", "numbers", "tsv"] },
  archives: { label: "Zip files", ext: ["zip", "7z", "rar", "tar", "gz"] },
  media: { label: "Video and audio", ext: ["mp4", "mov", "m4v", "webm", "mp3", "m4a", "wav", "aac", "ogg"] },
} as const;
export type RequestTypeGroup = keyof typeof REQUEST_TYPE_GROUPS;
export const REQUEST_TYPE_KEYS = Object.keys(REQUEST_TYPE_GROUPS) as RequestTypeGroup[];

/** Names that run as programs on a computer or phone. Never taken on a public upload. */
export const BLOCKED_EXTENSIONS = [
  "exe", "msi", "msp", "com", "scr", "pif", "cpl", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta",
  "jar", "apk", "aab", "ipa", "app", "dmg", "pkg", "deb", "rpm", "sh", "bash", "run", "bin", "dll", "sys", "lnk", "reg", "inf",
  "iso", "img", "vhd", "vhdx", "appx", "msix", "xll", "gadget", "application", "command", "workflow",
] as const;

export const extOf = (name: string) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(name.trim()); return m ? m[1].toLowerCase() : ""; };

/** True when the name ends in a program extension (also "invoice.pdf.exe"). */
export const blockedName = (name: string) => (BLOCKED_EXTENSIONS as readonly string[]).includes(extOf(name));

/** True when the first bytes are a program: Windows (MZ), Linux (ELF), Mac (Mach O, both ends, fat) or a script line. */
export function blockedBytes(b: Uint8Array): boolean {
  if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true;
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true;
  if (b.length >= 4) {
    const w = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(w)) return true;
  }
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return true; // "#!" script
  return false;
}

/** Whether a name passes a request's allowed groups ("any" or a comma list of groups). */
export function allowedByGroups(name: string, allowed: string): boolean {
  if (blockedName(name)) return false;
  if (!allowed || allowed === "any") return true;
  const ext = extOf(name);
  return allowed.split(",").some((g) => (REQUEST_TYPE_GROUPS as Record<string, { ext: readonly string[] }>)[g]?.ext.includes(ext));
}

export function allowedLabel(allowed: string): string {
  if (!allowed || allowed === "any") return "Any file except programs";
  return allowed.split(",").map((g) => (REQUEST_TYPE_GROUPS as Record<string, { label: string }>)[g]?.label).filter(Boolean).join(", ");
}

export interface RequestFileInfo {
  id: string;
  name: string;
  bytes: number;
  status: "uploading" | "done" | "failed";
  uploaderName: string | null;
  uploaderEmail: string | null;
  note: string | null;
  country: string | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
  /** Chunks received of all, while uploading. */
  progress: number;
}

export interface FileRequestInfo {
  id: string;
  title: string;
  message: string | null;
  folder: string | null;
  hasPassword: boolean;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowed: string;
  maxUploads: number | null;
  uploads: number;
  bytesReceived: number;
  keepDays: number;
  showBrand: boolean;
  notify: boolean;
  lastUploadAt: string | null;
  expiresAt: string;
  createdAt: string;
  createdByName: string | null;
  status: "open" | "closed" | "expired" | "full" | "paused";
  /** Only in the answer that creates the request: the token is never stored. */
  url?: string;
  files?: RequestFileInfo[];
}

// ---------------------------------------------------------------------------
// Secret links
// ---------------------------------------------------------------------------
/** Plain text before encryption. */
export const SECRET_MAX_TEXT = 10_000;
/** A small file, before encryption. */
export const SECRET_MAX_FILE_BYTES = 5 * MB;
/** Ciphertext the server takes: the file plus its name, type, the AES GCM tag and base64 overhead. */
export const SECRET_MAX_CIPHER_BYTES = Math.ceil(SECRET_MAX_FILE_BYTES * 1.4) + 4096;
/** Text ciphertext is kept in the database up to this size; bigger goes to file storage. */
export const SECRET_INLINE_MAX = 64 * 1024;
export const SECRET_VIEW_CHOICES = [1, 2, 3, 5, 10] as const;
export const SECRET_EXPIRY_CHOICES: { label: string; seconds: number }[] = [
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
];
export const SECRET_MIN_SECONDS = 5 * 60;
export const SECRET_MAX_SECONDS = 30 * 86_400;
/** PBKDF2 rounds when a passphrase is set (done in the browser of both sides). */
export const SECRET_KDF_ROUNDS = 210_000;

export interface SecretOpenRow { at: string; country: string | null; region: string | null; agent: string | null }

export interface SecretInfo {
  id: string;
  kind: "text" | "file";
  label: string | null;
  bytes: number;
  hasPassphrase: boolean;
  maxViews: number;
  views: number;
  notify: boolean;
  expiresAt: string;
  createdAt: string;
  status: "waiting" | "opened" | "burned" | "expired" | "revoked" | "paused";
  /** Only in the answer that creates it: the link without the key (the browser adds "#key"). */
  url?: string;
  opens?: SecretOpenRow[];
}

export const REPORT_REASONS: { value: string; label: string }[] = [
  { value: "malware", label: "It has a virus or harmful file" },
  { value: "phishing", label: "It tries to steal passwords or money" },
  { value: "illegal", label: "It is illegal or abusive" },
  { value: "other", label: "Something else" },
];
