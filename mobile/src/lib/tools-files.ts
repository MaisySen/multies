import { Alert, Platform, Share } from "react-native";
import * as DocumentPicker from "expo-document-picker";
// expo-file-system is already inside the store builds (the expo package depends on it and autolinking links
// it; check with `npx expo-modules-autolinking search`), so this update can use it without a new build. It is
// not a direct dependency yet because the OTA guard refuses any package.json dependency change; make it a
// direct dependency (same version) with the next store build and change this import to "expo-file-system".
import { Directory, File, Paths, UploadType } from "../../node_modules/expo/node_modules/expo-file-system";
import { concatBytes, makeBoundary, multipartParts, pickerTypes, safeFileName, toolErrorMessage, typeForName, uploadQuery, type PickedFile, type ToolDef, type ToolJob } from "./tools";

import type { FileAuth } from "@/api/transport";
import { byteFraction, toNumber } from "@/lib/native-number";

/** Picks files for a tool from Files (and, on Android, Photos and Drive through the same system picker). */
export async function pickFiles(def: ToolDef, multiple: boolean, only?: "images"): Promise<PickedFile[]> {
  const types = only === "images" ? pickerTypes(def).filter((t) => t.startsWith("image/")) : pickerTypes(def);
  const res = await DocumentPicker.getDocumentAsync({ multiple, copyToCacheDirectory: true, type: types.length ? types : ["image/*"] });
  if (res.canceled) return [];
  return res.assets.map((a) => ({ uri: a.uri, name: a.name || "file", size: toNumber(a.size), type: a.mimeType || typeForName(a.name || "") }));
}

async function readBytes(f: PickedFile): Promise<Uint8Array> {
  if (Platform.OS === "web") return new Uint8Array(await (await fetch(f.uri)).arrayBuffer());
  return new File(f.uri).bytes();
}

function parse(body: string): unknown {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}

/**
 * Sends the files to POST /api/tools/jobs as one form upload. The body is written to a file first and the
 * phone's own uploader sends it, so the server gets the size up front (it needs Content-Length) and large
 * files never cross the JavaScript bridge as text.
 */
export async function uploadJob(auth: FileAuth, op: string, files: PickedFile[], options: Record<string, string>, onProgress?: (fraction: number) => void, typeOption?: { name: string; value: string }): Promise<ToolJob> {
  const boundary = makeBoundary();
  const contentType = `multipart/form-data; boundary=${boundary}`;
  const parts = multipartParts(boundary, options, await Promise.all(files.map(async (f) => ({ name: f.name, type: f.type || typeForName(f.name), bytes: await readBytes(f) }))));
  const body = concatBytes(parts);
  const url = `${auth.base}/api/tools/jobs?${uploadQuery(op, files, typeOption)}`;
  const send = async (): Promise<{ status: number; body: string }> => {
    const headers = { ...auth.headers(), "x-multies-upload": "1", "content-type": contentType, accept: "application/json" };
    if (Platform.OS === "web") {
      const r = await fetch(url, { method: "POST", headers, body: body as unknown as BodyInit, credentials: "omit" });
      return { status: r.status, body: await r.text() };
    }
    const tmp = new File(Paths.cache, `tools-upload-${boundary.slice(-12)}.bin`);
    try {
      if (tmp.exists) tmp.delete();
      tmp.create();
      tmp.write(body);
      const r = await tmp.upload(url, {
        httpMethod: "POST", uploadType: UploadType.BINARY_CONTENT, headers, mimeType: contentType,
        // iPhone sends bytesSent and totalBytes as BigInt (native Int64); a progress callback must never throw.
        onProgress: onProgress ? (p: { bytesSent: number | bigint; totalBytes: number | bigint }) => {
          try { const f = byteFraction(p?.bytesSent, p?.totalBytes); if (f !== null) onProgress(f); } catch { /* progress is cosmetic */ }
        } : undefined,
      });
      return { status: r.status, body: r.body };
    } finally {
      try { if (tmp.exists) tmp.delete(); } catch { /* left for the system to clear */ }
    }
  };
  // status 0 means the phone could not reach Multies (offline): the screen keeps the files and tries again.
  const offline = () => Object.assign(new Error(toolErrorMessage(0, null)), { status: 0 });
  let r: { status: number; body: string };
  try { r = await send(); } catch { throw offline(); }
  if (r.status === 401) {
    await auth.refresh().catch(() => undefined);
    try { r = await send(); } catch { throw offline(); }
  }
  const json = parse(r.body);
  if (r.status !== 202) throw Object.assign(new Error(toolErrorMessage(r.status, json)), { status: r.status });
  onProgress?.(1);
  return json as ToolJob;
}

/** Downloads a finished result into the phone's cache (the server deletes it within an hour) and returns it. */
export async function downloadResult(auth: FileAuth, job: ToolJob): Promise<File> {
  if (!job.downloadUrl) throw new Error("This file has expired. Run the tool again.");
  const dir = new Directory(Paths.cache, "tools");
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const dest = new File(dir, safeFileName(job.name));
  try {
    return await File.downloadFileAsync(`${auth.base}${job.downloadUrl}`, dest, { headers: auth.headers(), idempotent: true });
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    if (/\b404\b/.test(m)) throw new Error("This file has expired. Run the tool again.");
    if (/\b401\b/.test(m)) {
      await auth.refresh().catch(() => undefined);
      return File.downloadFileAsync(`${auth.base}${job.downloadUrl}`, dest, { headers: auth.headers(), idempotent: true });
    }
    throw new Error("Couldn't get the file. Check your connection and try again.");
  }
}

/** Opens the result: Quick Look on iPhone (with its own share button), the matching app on Android. */
export async function openFile(file: File): Promise<void> {
  try {
    if (typeof file.preview === "function" && (await file.canPreview())) { await file.preview(); return; }
  } catch { /* fall through to share */ }
  await shareFile(file);
}

/** The share sheet with the file itself: Save to Files, Mail, WhatsApp, Print and the rest. */
export async function shareFile(file: File): Promise<void> {
  if (Platform.OS === "ios") { await Share.share({ url: file.uri }); return; }
  // Android's share sheet in React Native carries text only, so the file opens in its app, which can share it.
  try { await file.preview(); } catch { Alert.alert("No app to open this", "Save it to your phone instead, then open it from Files."); }
}

/** Android: saves a copy into a folder the person picks (Downloads, Documents, Drive). */
export async function saveToPhone(file: File, name: string, type: string): Promise<boolean> {
  const dir = await Directory.pickDirectoryAsync();
  if (!dir) return false;
  const out = dir.createFile(safeFileName(name), type);
  out.write(await file.bytes());
  return true;
}

/** A small text result (auto redact's list of what it found) read straight into memory. */
export async function readResultText(auth: FileAuth, job: ToolJob): Promise<string> {
  if (!job.downloadUrl) throw new Error("This result has expired. Run the tool again.");
  if (Platform.OS === "web") {
    const r = await fetch(`${auth.base}${job.downloadUrl}`, { headers: auth.headers(), credentials: "omit" });
    if (!r.ok) throw new Error(r.status === 404 ? "This result has expired. Run the tool again." : "Couldn't read the result. Try again.");
    return r.text();
  }
  const f = await downloadResult(auth, job);
  try { return await f.text(); } finally { try { f.delete(); } catch { /* the cache clears itself */ } }
}

/** The file as a picked file, ready for the next tool ("Use in another tool"). */
export function asPicked(file: File, name: string, type: string): PickedFile {
  return { uri: file.uri, name, size: toNumber(file.size), type };
}
