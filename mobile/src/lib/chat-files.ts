import * as DocumentPicker from "expo-document-picker";
import { ApiError } from "@/api/errors";
import { bytes } from "@/lib/format";

/**
 * Sending files from chat. The server takes files inline with the message
 * (POST /api/chat/channels/:id/messages, attachments: [{ filename, contentType, contentBase64 }]),
 * up to 5 per message. With file storage on (production) each file can be up to 10 MB; the server
 * answers 413 file_too_large past its limit and the app shows its words.
 */
export const CHAT_FILE_MAX_BYTES = 10_000_000;
export const CHAT_FILES_PER_MESSAGE = 5;
const LIMIT_TEXT = "10 MB";

export interface PickedFile { name: string; size?: number; mimeType?: string; uri: string; base64?: string }
export interface OutgoingFile { filename: string; contentType?: string; contentBase64: string }

/** Why this file can't go with the message, or null when it can. */
export function fileProblem(f: Pick<PickedFile, "name" | "size">, alreadyPicked = 0): string | null {
  if (alreadyPicked >= CHAT_FILES_PER_MESSAGE) return `You can attach up to ${CHAT_FILES_PER_MESSAGE} files at a time.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.size !== undefined && f.size > CHAT_FILE_MAX_BYTES) return `${f.name} is ${bytes(f.size)}. Files can be up to ${LIMIT_TEXT}.`;
  return null;
}

/** Opens the system file picker. Returns the files that fit and one message about any that did not. */
export async function pickChatFiles(alreadyPicked: number): Promise<{ files: PickedFile[]; problem: string | null }> {
  const res = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
  if (res.canceled || !res.assets?.length) return { files: [], problem: null };
  const files: PickedFile[] = [];
  let problem: string | null = null;
  for (const a of res.assets) {
    const why = fileProblem(a, alreadyPicked + files.length);
    if (why) { problem = problem ?? why; continue; }
    files.push({ name: a.name, size: a.size, mimeType: a.mimeType, uri: a.uri, base64: a.base64 });
  }
  return { files, problem };
}

/** Strips a data: URL down to its base64 part. */
export function stripDataUrl(s: string): string {
  const comma = s.indexOf(",");
  return s.startsWith("data:") && comma >= 0 ? s.slice(comma + 1) : s;
}

/** Reads a picked file as base64. On the web the picker gives it; on a phone the local file is read. */
export async function readBase64(f: PickedFile, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<string> {
  if (f.base64) return stripDataUrl(f.base64);
  const blob = await (await fetchImpl(f.uri)).blob();
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error(`Couldn't read ${f.name}.`));
    r.readAsDataURL(blob);
  });
  const b64 = stripDataUrl(data);
  if (!b64) throw new Error(`Couldn't read ${f.name}.`);
  // Size is not always known before reading (some providers leave it out), so check again here.
  const size = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  const why = fileProblem({ name: f.name, size });
  if (why) throw new Error(why);
  return b64;
}

export async function toOutgoing(files: PickedFile[], fetchImpl?: typeof fetch): Promise<OutgoingFile[]> {
  const out: OutgoingFile[] = [];
  for (const f of files) out.push({ filename: f.name, contentType: f.mimeType || undefined, contentBase64: await readBase64(f, fetchImpl) });
  return out;
}

/** "Sending 42%" while the upload runs. */
export function progressLabel(fraction: number): string {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return pct >= 100 ? "Almost there" : `Sending ${pct}%`;
}

/** Plain words for a failed send with files. */
export function sendErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    // R35: the other person blocked you. The server's words; you are not told more than this.
    if (e.status === 403 && e.code === "blocked") return "You can't message this person.";
    if (e.status === 413 || e.code === "file_too_large") return e.message || `Files can be up to ${LIMIT_TEXT}.`;
    if (e.isNetwork) return "Can't reach Multies. Check your connection and try again.";
    return e.message || "Couldn't send. Try again.";
  }
  return (e as Error)?.message || "Couldn't send. Try again.";
}

/** True while a signed file link (?exp=<ms>) is still good for at least a minute. Links without exp are left alone. */
export function linkStillGood(url: string | undefined | null, now = Date.now()): boolean {
  if (!url) return false;
  const m = /[?&]exp=(\d+)/.exec(url);
  if (!m) return true;
  return Number(m[1]) - now > 60_000;
}
