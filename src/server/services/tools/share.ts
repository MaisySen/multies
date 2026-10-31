/**
 * Tools P2 (H5): secure share links (/d/<token>). A file from an upload, a Tools result or a mail attachment is
 * kept in KV until the link expires (1 hour to 30 days); the link can carry a password (PBKDF2, the repo's
 * password helper; 5 wrong tries pause it for 15 minutes), a download limit, "email me on first download" and
 * be revoked. Only the SHA-256 of the 32 byte token is stored. A download is a POST (link scanners that open
 * the page do not use up a download) and writes one log row: time, country from the edge, browser family.
 * No address is stored.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { hashPassword, newId, verifyPassword } from "../../lib/crypto";
import { audit } from "../audit";
import { sendSystemEmail } from "../system-mail";
import { changesOf, dropKeptFiles, hashMatches, keepFile, newPublicToken, readKeptFile, tokenHash, tokenShapeOk } from "./kept-files";
import { REPORTS_TO_PAUSE } from "@/shared/secure-share";
import { SHARE_LOCK_SECONDS, SHARE_MAX_DOWNLOADS, SHARE_MAX_SECONDS, SHARE_MIN_SECONDS, SHARE_WRONG_TRIES, type ShareDownloadRow, type ShareLinkInfo } from "@/shared/share-sign";

export interface ShareRow {
  id: string; org_id: string; created_by: string; token_hash: string; file_id: string; name: string; content_type: string; bytes: number; source: string;
  password_hash: string | null; max_downloads: number | null; downloads: number; wrong_tries: number; locked_until: number | null;
  notify_first: number; notified_at: number | null; expires_at: number; revoked_at: number | null; created_at: number;
  /** R88: page opens and reports (absent on rows read before migration 0107 ran). */
  views?: number; reports?: number;
}

export interface NewShare {
  bytes: Uint8Array; name: string; contentType: string; source: "upload" | "result" | "attachment";
  expiresInSeconds: number; password?: string | null; maxDownloads?: number | null; notifyFirst?: boolean;
}

export const cleanName = (n: string) => ([...n].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 || ch === "/" || ch === "\\" ? "_" : ch)).join("").trim().slice(0, 160) || "file");

function statusOf(r: ShareRow, now: number): ShareLinkInfo["status"] {
  if (r.revoked_at) return "revoked";
  if (r.expires_at <= now) return "expired";
  if (r.max_downloads !== null && r.downloads >= r.max_downloads) return "used_up";
  if ((r.reports ?? 0) >= REPORTS_TO_PAUSE) return "paused";
  return "active";
}

function infoOf(r: ShareRow, now: number): ShareLinkInfo {
  return {
    id: r.id, name: r.name, bytes: r.bytes, source: r.source as ShareLinkInfo["source"], hasPassword: !!r.password_hash,
    maxDownloads: r.max_downloads, downloads: r.downloads, views: r.views ?? 0, notifyFirst: !!r.notify_first,
    expiresAt: new Date(r.expires_at).toISOString(), createdAt: new Date(r.created_at).toISOString(), status: statusOf(r, now),
  };
}

export async function createShare(deps: Deps, auth: AuthContext, input: NewShare, ip?: string): Promise<ShareLinkInfo> {
  const secs = Math.floor(input.expiresInSeconds);
  if (!Number.isFinite(secs) || secs < SHARE_MIN_SECONDS || secs > SHARE_MAX_SECONDS) throw badRequest("Choose an expiry from 1 hour to 30 days.");
  const pw = input.password?.trim() ? input.password : null;
  if (pw && (pw.length < 4 || pw.length > 128)) throw badRequest("Use a password of 4 to 128 characters.");
  const max = input.maxDownloads ?? null;
  if (max !== null && (!Number.isInteger(max) || max < 1 || max > SHARE_MAX_DOWNLOADS)) throw badRequest(`Choose a download limit from 1 to ${SHARE_MAX_DOWNLOADS}.`);
  if (!input.bytes.byteLength) throw badRequest("That file is empty.");
  const name = cleanName(input.name);
  const fileId = await keepFile(deps, auth.orgId, "share", input.bytes, secs, { name });
  const { token, hash } = newPublicToken();
  const now = deps.now().getTime();
  const row: ShareRow = {
    id: newId("shr"), org_id: auth.orgId, created_by: auth.userId, token_hash: await hash, file_id: fileId, name,
    content_type: (input.contentType || "application/octet-stream").slice(0, 120), bytes: input.bytes.byteLength, source: input.source,
    password_hash: pw ? await hashPassword(pw) : null, max_downloads: max, downloads: 0, wrong_tries: 0, locked_until: null,
    notify_first: input.notifyFirst ? 1 : 0, notified_at: null, expires_at: now + secs * 1000, revoked_at: null, created_at: now,
  };
  await deps.db.run(sql`insert into tool_shares (id, org_id, created_by, token_hash, file_id, name, content_type, bytes, source, password_hash, max_downloads, notify_first, expires_at, created_at)
    values (${row.id}, ${row.org_id}, ${row.created_by}, ${row.token_hash}, ${row.file_id}, ${row.name}, ${row.content_type}, ${row.bytes}, ${row.source}, ${row.password_hash}, ${row.max_downloads}, ${row.notify_first}, ${row.expires_at}, ${row.created_at})`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.share_created", targetType: "tool_share", targetId: row.id, metadata: { source: row.source, bytes: row.bytes, password: !!pw, max_downloads: max, seconds: secs }, ip });
  return { ...infoOf(row, now), url: `${deps.config.appUrl.replace(/\/$/, "")}/d/${token}` };
}

/** Admins see every link in the workspace; others see the links they made. Newest first, 200 at most. */
export async function listShares(deps: Deps, auth: AuthContext): Promise<ShareLinkInfo[]> {
  const mine = auth.role === "member";
  const rows = await deps.db.all<ShareRow>(sql`select * from tool_shares where org_id = ${auth.orgId} ${mine ? sql`and created_by = ${auth.userId}` : sql``} order by created_at desc limit 200`);
  const now = deps.now().getTime();
  return rows.map((r) => infoOf(r, now));
}

async function ownShare(deps: Deps, auth: AuthContext, id: string): Promise<ShareRow> {
  const r = await deps.db.get<ShareRow>(sql`select * from tool_shares where id = ${id} and org_id = ${auth.orgId}`);
  if (!r || (auth.role === "member" && r.created_by !== auth.userId)) throw notFound("Link");
  return r;
}

export async function shareDetail(deps: Deps, auth: AuthContext, id: string): Promise<ShareLinkInfo> {
  const r = await ownShare(deps, auth, id);
  const log = await deps.db.all<{ at: number; country: string | null; agent: string | null; kind: string | null; region: string | null }>(sql`select at, country, agent, kind, region from tool_share_downloads where share_id = ${r.id} order by at desc limit 200`);
  return { ...infoOf(r, deps.now().getTime()), log: log.map((l): ShareDownloadRow => ({ at: new Date(l.at).toISOString(), country: l.country, agent: l.agent, kind: l.kind === "view" ? "view" : "download", region: l.region })) };
}

export async function revokeShare(deps: Deps, auth: AuthContext, id: string, ip?: string): Promise<ShareLinkInfo> {
  const r = await ownShare(deps, auth, id);
  const now = deps.now().getTime();
  if (!r.revoked_at) {
    await deps.db.run(sql`update tool_shares set revoked_at = ${now} where id = ${r.id}`);
    await dropKeptFiles(deps, auth.orgId, [r.file_id]);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.share_revoked", targetType: "tool_share", targetId: r.id, ip });
    r.revoked_at = now;
  }
  return infoOf(r, now);
}

// ---------------------------------------------------------------------------
// The public side. Nothing here reveals anything but this one file's name and size and the workspace name.
// ---------------------------------------------------------------------------
export interface PublicShareView { row: ShareRow; workspace: string; state: ShareLinkInfo["status"] | "locked" }

/** Finds a live or dead link by its token (null when no such link). */
export async function findPublicShare(deps: Deps, token: string): Promise<PublicShareView | null> {
  if (!tokenShapeOk(token)) return null;
  const h = await tokenHash(token);
  const r = await deps.db.get<ShareRow & { ws: string | null; tools_mode: string | null }>(sql`select s.*, o.name as ws, o.tools_mode as tools_mode from tool_shares s left join organizations o on o.id = s.org_id where s.token_hash = ${h}`);
  if (!r || !hashMatches(r.token_hash, h)) return null;
  const now = deps.now().getTime();
  // A workspace that turned Tools off turns its links off too.
  const st = r.tools_mode === "off" ? "revoked" : statusOf(r, now);
  return { row: r, workspace: r.ws ?? "", state: st === "active" && r.locked_until && r.locked_until > now ? "locked" : st };
}

export type DownloadAttempt =
  | { ok: true; bytes: Uint8Array; name: string; contentType: string }
  | { ok: false; reason: "gone" | "password" | "locked" | "used_up" | "missing"; triesLeft?: number };

/** Checks the password (counting wrong tries), takes one download from the limit, logs it, and reads the file. */
export async function takeDownload(deps: Deps, v: PublicShareView, password: string | null, req: { country: string | null; agent: string | null; region?: string | null }): Promise<DownloadAttempt> {
  const r = v.row;
  const now = deps.now().getTime();
  if (v.state === "locked") return { ok: false, reason: "locked" };
  if (v.state === "used_up") return { ok: false, reason: "used_up" };
  if (v.state !== "active") return { ok: false, reason: "gone" };
  if (r.password_hash) {
    const good = !!password && password.length <= 128 && (await verifyPassword(password, r.password_hash));
    if (!good) {
      // One statement: the count goes up, and at the limit the link pauses and the count starts again.
      await deps.db.run(sql`update tool_shares set
        locked_until = case when wrong_tries + 1 >= ${SHARE_WRONG_TRIES} then ${now + SHARE_LOCK_SECONDS * 1000} else locked_until end,
        wrong_tries = case when wrong_tries + 1 >= ${SHARE_WRONG_TRIES} then 0 else wrong_tries + 1 end
        where id = ${r.id}`);
      const left = SHARE_WRONG_TRIES - (r.wrong_tries + 1);
      return left <= 0 ? { ok: false, reason: "locked" } : { ok: false, reason: "password", triesLeft: left };
    }
  }
  const took = await deps.db.run(sql`update tool_shares set downloads = downloads + 1, wrong_tries = 0
    where id = ${r.id} and revoked_at is null and expires_at > ${now} and (max_downloads is null or downloads < max_downloads)
      and (locked_until is null or locked_until <= ${now})`);
  if (!changesOf(took)) return { ok: false, reason: "used_up" };
  const bytes = await readKeptFile(deps, r.file_id);
  if (!bytes) return { ok: false, reason: "missing" };
  await deps.db.run(sql`insert into tool_share_downloads (id, share_id, org_id, at, country, agent, kind, region) values (${newId("shd")}, ${r.id}, ${r.org_id}, ${now}, ${req.country}, ${req.agent}, 'download', ${req.region ?? null})`);
  if (r.notify_first && !r.notified_at) {
    const first = await deps.db.run(sql`update tool_shares set notified_at = ${now} where id = ${r.id} and notified_at is null`);
    if (changesOf(first)) await notifyFirstDownload(deps, r, req).catch((err) => deps.log?.warn("tools.share_notify_failed", { error: String(err) }));
  }
  return { ok: true, bytes, name: r.name, contentType: r.content_type };
}

async function notifyFirstDownload(deps: Deps, r: ShareRow, req: { country: string | null; agent: string | null }) {
  const u = await deps.db.get<{ email: string }>(sql`select email from users where id = ${r.created_by}`);
  if (!u?.email) return;
  const where = [req.country ? `from ${req.country}` : "", req.agent ? `using ${req.agent}` : ""].filter(Boolean).join(", ");
  await sendSystemEmail(deps, {
    to: u.email, orgId: r.org_id, subject: `${r.name} was downloaded`,
    text: `Your shared file ${r.name} was downloaded for the first time${where ? ` (${where})` : ""}. You can see every download and turn the link off in Tools, Share links.`,
    action: { label: "See share links", url: `${deps.config.appUrl.replace(/\/$/, "")}/app/tools/share` },
  });
}

export function assertBytes(b: Uint8Array | null, what = "That file"): Uint8Array {
  if (!b) throw new HttpError(422, "tool_input", `${what} is not stored, so it cannot be used here.`);
  return b;
}
