import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
// expo-file-system is inside the store builds already (see lib/tools-files.ts for why it is imported this way).
import { Directory, File, Paths, UploadType } from "../../node_modules/expo/node_modules/expo-file-system";
import type { FileAuth, Transport } from "@/api/transport";
import { toApiError } from "@/api/errors";
import { byteFraction, toNumber } from "@/lib/native-number";
import { safeFileName, typeForName, type PickedFile } from "./tools";
import { openFile } from "./tools-files";
import { contentPath, tooBig, tooBigLine, uploadPath, versionPath, type DriveDetail, type DriveItem, type DriveSpace } from "./drive";

/**
 * M1: moving file bytes for the drive. Uploads go with the phone's own uploader as raw bytes (PUT, header
 * x-multies-upload: 1, the same as the web's Files page), so a large file never crosses the JavaScript bridge.
 * Downloads land in the phone's cache and open in Quick Look on iPhone or the matching app on Android,
 * exactly as Tools results do. In the sample workspace (browser preview, tests) the sample transport answers.
 */
export interface DriveIo { auth: FileAuth | null; transport: Transport }

/** Picks files from Files (or, with only "images", photos through the same system picker). */
export async function pickForDrive(only?: "images", multiple = true): Promise<PickedFile[]> {
  const res = await DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true, type: only === "images" ? ["image/*", "video/*"] : ["*/*"] });
  if (res.canceled) return [];
  return res.assets.map((a) => ({ uri: a.uri, name: a.name || "file", size: toNumber(a.size), type: a.mimeType || typeForName(a.name || "") }));
}

const offline = () => Object.assign(new Error("Can't reach Multies. Check your connection."), { status: 0 });

function parse(body: string): unknown { try { return body ? JSON.parse(body) : null; } catch { return null; } }

async function putFile(auth: FileAuth, path: string, f: PickedFile, onProgress?: (fraction: number) => void): Promise<{ status: number; body: string }> {
  const url = `${auth.base}${path}`;
  const headers = { ...auth.headers(), "x-multies-upload": "1", "content-type": f.type || typeForName(f.name) || "application/octet-stream", accept: "application/json" };
  if (Platform.OS === "web") {
    const bytes = new Uint8Array(await (await fetch(f.uri)).arrayBuffer());
    const r = await fetch(url, { method: "PUT", headers, body: bytes as unknown as BodyInit, credentials: "omit" });
    return { status: r.status, body: await r.text() };
  }
  const r = await new File(f.uri).upload(url, {
    httpMethod: "PUT", uploadType: UploadType.BINARY_CONTENT, headers, mimeType: headers["content-type"],
    onProgress: onProgress ? (p: { bytesSent: number | bigint; totalBytes: number | bigint }) => {
      try { const x = byteFraction(p?.bytesSent, p?.totalBytes); if (x !== null) onProgress(x); } catch { /* progress is cosmetic */ }
    } : undefined,
  });
  return { status: r.status, body: r.body };
}

/** M2: raw byte upload (PUT, x-multies-upload: 1) to any upload route, for Expenses receipts. */
export function uploadRaw<T>(io: DriveIo, path: string, f: PickedFile, onProgress?: (fraction: number) => void) { return send<T>(io, path, f, onProgress); }

async function send<T>(io: DriveIo, path: string, f: PickedFile, onProgress?: (fraction: number) => void): Promise<T> {
  if (tooBig(f.size)) throw Object.assign(new Error(tooBigLine()), { status: 413 });
  if (!io.auth) {
    // The sample workspace: no bytes leave the device.
    const r = await io.transport.request<T>("PUT", path.replace(/^\/api/, ""), { name: f.name, size: f.size ?? 0, type: f.type });
    onProgress?.(1);
    return r;
  }
  let r: { status: number; body: string };
  try { r = await putFile(io.auth, path, f, onProgress); } catch { throw offline(); }
  if (r.status === 401) {
    await io.auth.refresh().catch(() => undefined);
    try { r = await putFile(io.auth, path, f, onProgress); } catch { throw offline(); }
  }
  const json = parse(r.body);
  if (r.status < 200 || r.status >= 300) throw toApiError(r.status, json ?? { error: { code: "error", message: r.status === 413 ? tooBigLine() : `Upload failed (${r.status}).` } });
  onProgress?.(1);
  return json as T;
}

/** A new file in a space or folder. The server picks a free name ("Report (2).pdf") when the name is taken. */
export function uploadToDrive(io: DriveIo, target: { space: DriveSpace; parentId: string | null }, f: PickedFile, onProgress?: (fraction: number) => void) {
  return send<{ item: DriveItem }>(io, uploadPath(target, f.name), f, onProgress);
}

/** A new version of a file; answers the file's detail with its versions. */
export function uploadVersion(io: DriveIo, id: string, f: PickedFile, onProgress?: (fraction: number) => void) {
  return send<DriveDetail>(io, versionPath(id), f, onProgress);
}

/** The full screen image source: the content route with the session cookie on the request. */
export function imageSource(io: DriveIo, it: Pick<DriveItem, "id">, v?: string): { uri: string; headers?: Record<string, string> } | null {
  if (!io.auth) return null;
  return { uri: `${io.auth.base}${contentPath(it.id, { v, inline: true })}`, headers: io.auth.headers() };
}

/** Downloads one file (or one version) into the phone's cache. */
export async function downloadDriveFile(auth: FileAuth, it: Pick<DriveItem, "id" | "name">, v?: string): Promise<File> {
  const dir = new Directory(Paths.cache, "drive");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, safeFileName(it.name));
  const url = `${auth.base}${contentPath(it.id, { v })}`;
  try {
    return await File.downloadFileAsync(url, dest, { headers: auth.headers(), idempotent: true });
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    if (/\b404\b/.test(m)) throw new Error("This file is no longer here. It may have moved or gone to the trash.");
    if (/\b40[13]\b/.test(m)) {
      await auth.refresh().catch(() => undefined);
      try { return await File.downloadFileAsync(url, dest, { headers: auth.headers(), idempotent: true }); } catch { throw new Error("You can't open this file. It may not be shared with you."); }
    }
    throw new Error("Couldn't get the file. Check your connection and try again.");
  }
}

/** Downloads and opens: Quick Look on iPhone (with its share button), Open with on Android. */
export async function openDriveFile(io: DriveIo, it: Pick<DriveItem, "id" | "name">, v?: string): Promise<void> {
  if (!io.auth) throw new Error("Files open on a phone signed in to Multies.");
  const f = await downloadDriveFile(io.auth, it, v);
  await openFile(f);
}
