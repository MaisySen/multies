/**
 * R88: file requests. An owner makes a link (/u/<token>); a client opens it and uploads files without an account.
 * Each file is reserved in the kept files ledger up front (so the plan caps hold), then arrives in 8 MB chunks
 * (KV values "kept/<file>.<n>") that can be retried and resumed: the uploader holds a per upload key whose SHA-256
 * is stored. Only the SHA-256 of the request token is stored. The request counts files and bytes as they are
 * started; an upload that is cancelled, refused or left unfinished for a day gives its room back.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, notFound, tooMany } from "../../lib/errors";
import { hashPassword, newId, randomToken, verifyPassword } from "../../lib/crypto";
import { audit } from "../audit";
import { sendSystemEmail } from "../system-mail";
import { notify } from "../suite/notify";
import { changesOf, dropKeptChunks, hashMatches, newPublicToken, readKeptChunk, putKeptChunk, reserveKept, tokenHash, tokenShapeOk } from "./kept-files";
import { cleanName } from "./share";
import { SHARE_LOCK_SECONDS, SHARE_WRONG_TRIES } from "@/shared/share-sign";
import {
  REPORTS_TO_PAUSE, REQUESTS_PER_DAY, REQUEST_CHUNK_BYTES, REQUEST_KEEP_DAYS, REQUEST_MAX_FILE_BYTES, REQUEST_MAX_UPLOADS, REQUEST_TOTAL_CAPS,
  REQUEST_TYPE_KEYS, allowedByGroups, blockedBytes, blockedName, type FileRequestInfo, type RequestFileInfo,
} from "@/shared/secure-share";

export interface RequestRow {
  id: string; org_id: string; created_by: string; token_hash: string; title: string; message: string | null; folder: string | null;
  password_hash: string | null; max_file_bytes: number; max_total_bytes: number; allowed: string; max_uploads: number | null;
  uploads: number; bytes_received: number; keep_days: number; show_brand: number; notify: number; notified_at: number | null;
  wrong_tries: number; locked_until: number | null; reports: number; last_upload_at: number | null; expires_at: number; closed_at: number | null; created_at: number;
}
export interface RequestFileRow {
  id: string; request_id: string; org_id: string; file_id: string; upload_key_hash: string; name: string; content_type: string; bytes: number;
  chunk_bytes: number; chunks: number; received: string; status: string; uploader_name: string | null; uploader_email: string | null;
  note: string | null; country: string | null; expires_at: number; deleted_at: number | null; created_at: number; completed_at: number | null;
}

export interface NewRequest {
  title: string; message?: string | null; folder?: string | null; password?: string | null; maxFileBytes: number; maxTotalBytes: number;
  allowed: string; maxUploads?: number | null; keepDays: number; expiresInDays: number; showBrand?: boolean; notify?: boolean;
}

const DAY = 86_400_000;
const iso = (n: number | null) => (n === null ? null : new Date(n).toISOString());
const oneLine = (s: string | null | undefined, max: number) => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

export function requestStatus(r: RequestRow, now: number): FileRequestInfo["status"] {
  if (r.closed_at) return "closed";
  if (r.expires_at <= now) return "expired";
  if (r.reports >= REPORTS_TO_PAUSE) return "paused";
  if ((r.max_uploads !== null && r.uploads >= r.max_uploads) || r.bytes_received >= r.max_total_bytes) return "full";
  return "open";
}

function fileInfo(f: RequestFileRow): RequestFileInfo {
  const got = [...f.received].filter((c) => c === "1").length;
  return {
    id: f.id, name: f.name, bytes: f.bytes, status: f.status as RequestFileInfo["status"], uploaderName: f.uploader_name, uploaderEmail: f.uploader_email,
    note: f.note, country: f.country, createdAt: new Date(f.created_at).toISOString(), completedAt: iso(f.completed_at), expiresAt: new Date(f.expires_at).toISOString(),
    progress: f.chunks ? got / f.chunks : 1,
  };
}

function info(r: RequestRow & { by?: string | null }, now: number): FileRequestInfo {
  return {
    id: r.id, title: r.title, message: r.message, folder: r.folder, hasPassword: !!r.password_hash, maxFileBytes: r.max_file_bytes, maxTotalBytes: r.max_total_bytes,
    allowed: r.allowed, maxUploads: r.max_uploads, uploads: r.uploads, bytesReceived: r.bytes_received, keepDays: r.keep_days, showBrand: !!r.show_brand,
    notify: !!r.notify, lastUploadAt: iso(r.last_upload_at), expiresAt: new Date(r.expires_at).toISOString(), createdAt: new Date(r.created_at).toISOString(),
    createdByName: r.by ?? null, status: requestStatus(r, now),
  };
}

export function checkAllowed(raw: string): string {
  const v = (raw || "any").trim().toLowerCase();
  if (v === "any") return "any";
  const parts = [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))];
  if (!parts.length || parts.some((p) => !(REQUEST_TYPE_KEYS as string[]).includes(p))) throw badRequest("Choose which kinds of files to accept.");
  return parts.join(",");
}

export async function createRequest(deps: Deps, auth: AuthContext, input: NewRequest, ip?: string): Promise<FileRequestInfo> {
  const title = oneLine(input.title, 120);
  if (!title) throw badRequest("Give the request a name, like Tax documents for 2026.");
  const message = (input.message ?? "").trim().slice(0, 1000) || null;
  const folder = oneLine(input.folder, 60) || null;
  if (!Number.isInteger(input.maxFileBytes) || input.maxFileBytes < 1024 * 1024 || input.maxFileBytes > REQUEST_MAX_FILE_BYTES) throw badRequest("Choose a file size limit up to 100 MB.");
  const maxTotal = REQUEST_TOTAL_CAPS.includes(input.maxTotalBytes as (typeof REQUEST_TOTAL_CAPS)[number]) ? input.maxTotalBytes : null;
  if (!maxTotal) throw badRequest("Choose a total size limit.");
  if (input.maxFileBytes > maxTotal) throw badRequest("The file size limit can't be more than the total limit.");
  const allowed = checkAllowed(input.allowed);
  const maxUploads = input.maxUploads ?? null;
  if (maxUploads !== null && (!Number.isInteger(maxUploads) || maxUploads < 1 || maxUploads > REQUEST_MAX_UPLOADS)) throw badRequest(`Choose a file limit from 1 to ${REQUEST_MAX_UPLOADS}.`);
  if (!REQUEST_KEEP_DAYS.includes(input.keepDays as (typeof REQUEST_KEEP_DAYS)[number])) throw badRequest("Choose how long to keep the files.");
  const days = Math.floor(input.expiresInDays);
  if (!Number.isFinite(days) || days < 1 || days > 90) throw badRequest("Choose when the link stops working, from 1 to 90 days.");
  const pw = input.password?.trim() ? input.password : null;
  if (pw && (pw.length < 4 || pw.length > 128)) throw badRequest("Use a password of 4 to 128 characters.");
  const now = deps.now().getTime();
  const made = await deps.db.get<{ n: number }>(sql`select count(*) as n from tool_file_requests where org_id = ${auth.orgId} and created_at > ${now - DAY}`);
  if (Number(made?.n ?? 0) >= REQUESTS_PER_DAY) throw tooMany(`Your workspace can make ${REQUESTS_PER_DAY} file requests a day. Try again tomorrow.`);
  const { token, hash } = newPublicToken();
  const row: RequestRow = {
    id: newId("frq"), org_id: auth.orgId, created_by: auth.userId, token_hash: await hash, title, message, folder, password_hash: pw ? await hashPassword(pw) : null,
    max_file_bytes: input.maxFileBytes, max_total_bytes: maxTotal, allowed, max_uploads: maxUploads, uploads: 0, bytes_received: 0, keep_days: input.keepDays,
    show_brand: input.showBrand === false ? 0 : 1, notify: input.notify === false ? 0 : 1, notified_at: null, wrong_tries: 0, locked_until: null, reports: 0,
    last_upload_at: null, expires_at: now + days * DAY, closed_at: null, created_at: now,
  };
  await deps.db.run(sql`insert into tool_file_requests (id, org_id, created_by, token_hash, title, message, folder, password_hash, max_file_bytes, max_total_bytes, allowed, max_uploads, keep_days, show_brand, notify, expires_at, created_at)
    values (${row.id}, ${row.org_id}, ${row.created_by}, ${row.token_hash}, ${row.title}, ${row.message}, ${row.folder}, ${row.password_hash}, ${row.max_file_bytes}, ${row.max_total_bytes}, ${row.allowed}, ${row.max_uploads}, ${row.keep_days}, ${row.show_brand}, ${row.notify}, ${row.expires_at}, ${row.created_at})`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.file_request_created", targetType: "tool_file_request", targetId: row.id, metadata: { password: !!pw, max_file_bytes: row.max_file_bytes, allowed, days }, ip });
  return { ...info(row, now), createdByName: null, url: `${deps.config.appUrl.replace(/\/$/, "")}/u/${token}` };
}

/** Admins see every request in the workspace; members see their own. Newest first, 200 at most. */
export async function listRequests(deps: Deps, auth: AuthContext): Promise<FileRequestInfo[]> {
  const mine = auth.role === "member";
  const rows = await deps.db.all<RequestRow & { by: string | null }>(sql`select r.*, u.name as by from tool_file_requests r left join users u on u.id = r.created_by
    where r.org_id = ${auth.orgId} ${mine ? sql`and r.created_by = ${auth.userId}` : sql``} order by r.created_at desc limit 200`);
  const now = deps.now().getTime();
  return rows.map((r) => info(r, now));
}

async function ownRequest(deps: Deps, auth: AuthContext, id: string): Promise<RequestRow> {
  const r = await deps.db.get<RequestRow>(sql`select * from tool_file_requests where id = ${id} and org_id = ${auth.orgId}`);
  if (!r || (auth.role === "member" && r.created_by !== auth.userId)) throw notFound("Request");
  return r;
}

export async function requestDetail(deps: Deps, auth: AuthContext, id: string): Promise<FileRequestInfo> {
  const r = await ownRequest(deps, auth, id);
  const files = await deps.db.all<RequestFileRow>(sql`select * from tool_request_files where request_id = ${r.id} and deleted_at is null order by created_at desc limit 500`);
  const now = deps.now().getTime();
  return { ...info(r, now), files: files.filter((f) => f.status === "done" || f.expires_at > now).map(fileInfo) };
}

/** Close (no more uploads) or reopen. Reopening also clears reports, after the owner has looked. */
export async function setRequestOpen(deps: Deps, auth: AuthContext, id: string, open: boolean, ip?: string): Promise<FileRequestInfo> {
  const r = await ownRequest(deps, auth, id);
  const now = deps.now().getTime();
  if (open) {
    if (r.expires_at <= now) throw badRequest("This request has expired. Make a new one.");
    await deps.db.run(sql`update tool_file_requests set closed_at = null, reports = 0 where id = ${r.id}`);
    r.closed_at = null; r.reports = 0;
  } else if (!r.closed_at) {
    await deps.db.run(sql`update tool_file_requests set closed_at = ${now} where id = ${r.id}`);
    r.closed_at = now;
  }
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: open ? "tools.file_request_reopened" : "tools.file_request_closed", targetType: "tool_file_request", targetId: r.id, ip });
  return info(r, now);
}

async function ownFile(deps: Deps, auth: AuthContext, fileId: string): Promise<{ f: RequestFileRow; r: RequestRow }> {
  const f = await deps.db.get<RequestFileRow>(sql`select * from tool_request_files where id = ${fileId} and org_id = ${auth.orgId} and deleted_at is null`);
  if (!f) throw notFound("File");
  const r = await ownRequest(deps, auth, f.request_id);
  return { f, r };
}

/** Deletes a received file now. Its room goes back to the request and the workspace. */
export async function deleteRequestFile(deps: Deps, auth: AuthContext, fileId: string, ip?: string): Promise<{ ok: true }> {
  const { f, r } = await ownFile(deps, auth, fileId);
  await dropUpload(deps, r, f);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.file_request_file_deleted", targetType: "tool_request_file", targetId: f.id, ip });
  return { ok: true };
}

/** The file's bytes, chunk by chunk, as one stream. */
export async function requestFileStream(deps: Deps, auth: AuthContext, fileId: string): Promise<{ stream: ReadableStream<Uint8Array>; name: string; bytes: number }> {
  const { f } = await ownFile(deps, auth, fileId);
  if (f.status !== "done") throw new HttpError(409, "not_ready", "This file is still uploading.");
  if (f.expires_at <= deps.now().getTime()) throw new HttpError(410, "gone", "This file was kept for its full time and has been deleted.");
  const first = await readKeptChunk(deps, f.file_id, 0);
  if (!first) throw new HttpError(410, "gone", "This file is no longer stored.");
  let n = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (n === 0) { n = 1; ctrl.enqueue(first); if (f.chunks === 1) ctrl.close(); return; }
      if (n >= f.chunks) { ctrl.close(); return; }
      const b = await readKeptChunk(deps, f.file_id, n++);
      if (!b) { ctrl.error(new Error("chunk_missing")); return; }
      ctrl.enqueue(b);
      if (n >= f.chunks) ctrl.close();
    },
  });
  return { stream, name: f.name, bytes: f.bytes };
}

/** Removes an upload's bytes and gives its room back to the request. */
async function dropUpload(deps: Deps, r: Pick<RequestRow, "id" | "org_id">, f: RequestFileRow) {
  const now = deps.now().getTime();
  const took = await deps.db.run(sql`update tool_request_files set deleted_at = ${now}, status = case when status = 'uploading' then 'failed' else status end where id = ${f.id} and deleted_at is null`);
  if (!changesOf(took)) return;
  await dropKeptChunks(deps, r.org_id, f.file_id, f.chunks);
  await deps.db.run(sql`update tool_file_requests set uploads = max(0, uploads - 1), bytes_received = max(0, bytes_received - ${f.bytes}) where id = ${r.id}`);
}

/** Cron: uploads left unfinished for a day give their room back. Bounded: 100 a run. */
export async function pruneStaleUploads(deps: Deps): Promise<number> {
  const cut = deps.now().getTime() - DAY;
  const rows = await deps.db.all<RequestFileRow>(sql`select * from tool_request_files where status = 'uploading' and deleted_at is null and created_at < ${cut} limit 100`);
  for (const f of rows) await dropUpload(deps, { id: f.request_id, org_id: f.org_id }, f).catch(() => undefined);
  return rows.length;
}

// ---------------------------------------------------------------------------
// The public side: nothing here reveals more than the request's title, message, limits and the workspace's name and brand.
// ---------------------------------------------------------------------------
export interface PublicRequestView { row: RequestRow; workspace: string; state: FileRequestInfo["status"] | "locked" }

export async function findPublicRequest(deps: Deps, token: string): Promise<PublicRequestView | null> {
  if (!tokenShapeOk(token)) return null;
  const h = await tokenHash(token);
  const r = await deps.db.get<RequestRow & { ws: string | null; tools_mode: string | null }>(sql`select q.*, o.name as ws, o.tools_mode as tools_mode from tool_file_requests q left join organizations o on o.id = q.org_id where q.token_hash = ${h}`);
  if (!r || !hashMatches(r.token_hash, h)) return null;
  const now = deps.now().getTime();
  const st = r.tools_mode === "off" ? "closed" : requestStatus(r, now);
  return { row: r, workspace: r.ws ?? "", state: st === "open" && r.locked_until && r.locked_until > now ? "locked" : st };
}

export class UploadError extends HttpError {}
// Public upload answers use 415 (a type the request refuses) and 507 (no room) too, so the page can tell a refusal from a retry.
const refuse = (status: number, code: string, message: string) => new UploadError(status as 400, code, message);

export interface StartInput { name: string; size: number; type?: string | null; password?: string | null; uploaderName?: string | null; uploaderEmail?: string | null; note?: string | null }
export interface StartedUpload { uploadId: string; uploadKey: string; chunkBytes: number; chunks: number }

async function checkPassword(deps: Deps, r: RequestRow, password: string | null | undefined): Promise<void> {
  if (!r.password_hash) return;
  const good = !!password && password.length <= 128 && (await verifyPassword(password, r.password_hash));
  if (good) {
    if (r.wrong_tries) await deps.db.run(sql`update tool_file_requests set wrong_tries = 0 where id = ${r.id}`);
    return;
  }
  const now = deps.now().getTime();
  await deps.db.run(sql`update tool_file_requests set
    locked_until = case when wrong_tries + 1 >= ${SHARE_WRONG_TRIES} then ${now + SHARE_LOCK_SECONDS * 1000} else locked_until end,
    wrong_tries = case when wrong_tries + 1 >= ${SHARE_WRONG_TRIES} then 0 else wrong_tries + 1 end
    where id = ${r.id}`);
  const left = SHARE_WRONG_TRIES - (r.wrong_tries + 1);
  if (left <= 0) throw refuse(429, "locked", "Too many wrong passwords. Try again in 15 minutes.");
  throw refuse(401, "password", `That password is not right. ${left} ${left === 1 ? "try" : "tries"} left.`);
}

export function stateMessage(state: PublicRequestView["state"]): string {
  switch (state) {
    case "closed": return "This request is closed. Ask the person who sent it if they still need files.";
    case "expired": return "This request has ended. Ask the person who sent it for a new link.";
    case "full": return "This request has all the files it can take. Ask the person who sent it for more room.";
    case "paused": return "This request is paused while it is checked.";
    case "locked": return "Too many wrong passwords. Try again in 15 minutes.";
    default: return "";
  }
}

/** Checks the request, the password, the name and the size, takes room for the file and returns the upload key. */
export async function startUpload(deps: Deps, v: PublicRequestView, input: StartInput, req: { country: string | null }): Promise<StartedUpload> {
  const r = v.row;
  if (v.state !== "open") throw refuse(v.state === "locked" ? 429 : 410, v.state, stateMessage(v.state));
  await checkPassword(deps, r, input.password);
  const name = cleanName(input.name || "file");
  const size = Math.floor(Number(input.size));
  if (blockedName(name)) throw refuse(415, "blocked_type", "Programs and installers can't be sent here. Zip files, documents and pictures are fine.");
  if (!allowedByGroups(name, r.allowed)) throw refuse(415, "type_not_allowed", "This request doesn't take this kind of file.");
  if (!Number.isFinite(size) || size < 1) throw refuse(400, "empty", "That file is empty.");
  if (size > r.max_file_bytes) throw refuse(413, "too_large", `Files can be up to ${Math.round(r.max_file_bytes / (1024 * 1024))} MB here.`);
  const now = deps.now().getTime();
  // One statement takes a file and its bytes from the request, so two uploads at once can't pass a limit together.
  const took = await deps.db.run(sql`update tool_file_requests set uploads = uploads + 1, bytes_received = bytes_received + ${size}
    where id = ${r.id} and closed_at is null and expires_at > ${now} and reports < ${REPORTS_TO_PAUSE}
      and (max_uploads is null or uploads < max_uploads) and bytes_received + ${size} <= max_total_bytes`);
  if (!changesOf(took)) {
    const room = r.max_total_bytes - r.bytes_received;
    throw refuse(413, "full", room > 0 && size > room ? `This request has room for ${Math.max(1, Math.floor(room / (1024 * 1024)))} MB more.` : stateMessage("full"));
  }
  const until = now + r.keep_days * DAY + DAY;
  let fileId: string;
  try {
    fileId = await reserveKept(deps, r.org_id, "request_file", size, Math.ceil((until - now) / 1000));
  } catch {
    await deps.db.run(sql`update tool_file_requests set uploads = max(0, uploads - 1), bytes_received = max(0, bytes_received - ${size}) where id = ${r.id}`);
    throw refuse(507, "no_room", "This request can't take more files right now. Ask the person who sent it to make room.");
  }
  const chunks = Math.max(1, Math.ceil(size / REQUEST_CHUNK_BYTES));
  const uploadKey = randomToken(24);
  const id = newId("rqf");
  await deps.db.run(sql`insert into tool_request_files (id, request_id, org_id, file_id, upload_key_hash, name, content_type, bytes, chunk_bytes, chunks, received, uploader_name, uploader_email, note, country, expires_at, created_at)
    values (${id}, ${r.id}, ${r.org_id}, ${fileId}, ${await tokenHash(uploadKey)}, ${name}, ${oneLine(input.type, 120) || "application/octet-stream"}, ${size}, ${REQUEST_CHUNK_BYTES}, ${chunks}, ${"0".repeat(chunks)},
      ${oneLine(input.uploaderName, 120) || null}, ${oneLine(input.uploaderEmail, 200) || null}, ${(input.note ?? "").trim().slice(0, 1000) || null}, ${req.country}, ${until}, ${now})`);
  return { uploadId: id, uploadKey, chunkBytes: REQUEST_CHUNK_BYTES, chunks };
}

async function ownUpload(deps: Deps, v: PublicRequestView, uploadId: string, key: string | null | undefined): Promise<RequestFileRow> {
  if (!key || key.length > 64 || !/^[\w-]{6,64}$/.test(uploadId)) throw refuse(404, "no_upload", "This upload was not found. Start it again.");
  const f = await deps.db.get<RequestFileRow>(sql`select * from tool_request_files where id = ${uploadId} and request_id = ${v.row.id} and deleted_at is null`);
  if (!f || !hashMatches(f.upload_key_hash, await tokenHash(key))) throw refuse(404, "no_upload", "This upload was not found. Start it again.");
  return f;
}

/** Which chunks the server has (for a resume after a dropped connection or a reload). */
export async function uploadStatus(deps: Deps, v: PublicRequestView, uploadId: string, key: string | null): Promise<{ status: string; received: string; chunkBytes: number; chunks: number }> {
  const f = await ownUpload(deps, v, uploadId, key);
  return { status: f.status, received: f.received, chunkBytes: f.chunk_bytes, chunks: f.chunks };
}

/** Stores one chunk. Sending the same chunk again is fine. The first chunk is checked for programs. */
export async function putChunk(deps: Deps, v: PublicRequestView, uploadId: string, key: string | null, n: number, bytes: Uint8Array): Promise<{ received: string }> {
  const f = await ownUpload(deps, v, uploadId, key);
  if (f.status !== "uploading") throw refuse(409, "not_uploading", f.status === "done" ? "This file is already uploaded." : "This upload was stopped. Start it again.");
  if (!Number.isInteger(n) || n < 0 || n >= f.chunks) throw refuse(400, "bad_chunk", "That part of the file doesn't fit. Start the upload again.");
  const want = n < f.chunks - 1 ? f.chunk_bytes : f.bytes - f.chunk_bytes * (f.chunks - 1);
  if (bytes.byteLength !== want) throw refuse(400, "bad_chunk", "That part of the file is the wrong size. Try again.");
  if (n === 0 && blockedBytes(bytes.subarray(0, 8))) {
    await dropUpload(deps, v.row, f);
    throw refuse(415, "blocked_type", "This file is a program, so it can't be sent here.");
  }
  await putKeptChunk(deps, f.file_id, n, bytes, f.expires_at);
  await deps.db.run(sql`update tool_request_files set received = substr(received, 1, ${n}) || '1' || substr(received, ${n + 2}) where id = ${f.id}`);
  const after = await deps.db.get<{ received: string }>(sql`select received from tool_request_files where id = ${f.id}`);
  return { received: after?.received ?? f.received };
}

/** Marks the file done when every chunk is in, and tells the owner. */
export async function finishUpload(deps: Deps, v: PublicRequestView, uploadId: string, key: string | null): Promise<RequestFileInfo> {
  const f = await ownUpload(deps, v, uploadId, key);
  if (f.status === "done") return fileInfo(f);
  if (f.status !== "uploading") throw refuse(409, "not_uploading", "This upload was stopped. Start it again.");
  if (f.received.includes("0")) throw refuse(409, "missing_chunks", "Some of the file is still missing. Keep this page open to finish.");
  const now = deps.now().getTime();
  const took = await deps.db.run(sql`update tool_request_files set status = 'done', completed_at = ${now} where id = ${f.id} and status = 'uploading'`);
  f.status = "done"; f.completed_at = now;
  if (changesOf(took)) {
    await deps.db.run(sql`update tool_file_requests set last_upload_at = ${now} where id = ${v.row.id}`);
    await tellOwner(deps, v.row, f).catch((err) => deps.log?.warn("tools.file_request_notify_failed", { error: String(err) }));
  }
  return fileInfo(f);
}

/** The uploader stops an upload: its room goes back. */
export async function cancelUpload(deps: Deps, v: PublicRequestView, uploadId: string, key: string | null): Promise<void> {
  const f = await ownUpload(deps, v, uploadId, key);
  if (f.status === "done") throw refuse(409, "done", "This file is already uploaded.");
  await dropUpload(deps, v.row, f);
}

/** An in app notification every time, and at most one email per request every 15 minutes (a batch of files is one email). */
async function tellOwner(deps: Deps, r: RequestRow, f: RequestFileRow) {
  const who = f.uploader_name || f.uploader_email || "Someone";
  await notify(deps, r.org_id, r.created_by, { type: "tools.file_request_upload", entityType: "file_request", entityId: r.id, title: `${who} sent ${f.name} to ${r.title}` });
  if (!r.notify) return;
  const now = deps.now().getTime();
  const due = await deps.db.run(sql`update tool_file_requests set notified_at = ${now} where id = ${r.id} and (notified_at is null or notified_at < ${now - 15 * 60_000})`);
  if (!changesOf(due)) return;
  const u = await deps.db.get<{ email: string }>(sql`select email from users where id = ${r.created_by}`);
  if (!u?.email) return;
  await sendSystemEmail(deps, {
    to: u.email, orgId: r.org_id, subject: `New file for ${r.title}`,
    text: `${who} sent ${f.name} through your file request ${r.title}.${f.note ? `\n\nTheir note: ${f.note}` : ""}\n\nOpen Tools, Secure share, File requests to download it.`,
    action: { label: "See received files", url: `${deps.config.appUrl.replace(/\/$/, "")}/app/tools/share?tab=requests&request=${encodeURIComponent(r.id)}` },
  });
}
