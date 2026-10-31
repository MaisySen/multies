/**
 * R88: secret links. The browser encrypts text or a small file with AES GCM under a fresh 256 bit key (and, when the
 * sender sets one, a passphrase through PBKDF2) and sends only the ciphertext. The key lives in the link's fragment
 * (/x/<token>#<key>), which browsers never send to a server, so Multies can't read a secret. A secret opens a set
 * number of times (1 by default) and then burns: its ciphertext is deleted in the same request that hands out the
 * last copy. Opening is a POST from the page's own button, so a link previewer that fetches the page uses no view.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { badRequest, notFound, tooMany } from "../../lib/errors";
import { fromB64, newId, toB64 } from "../../lib/crypto";
import { audit } from "../audit";
import { sendSystemEmail } from "../system-mail";
import { notify } from "../suite/notify";
import { changesOf, dropKeptFiles, hashMatches, keepFile, newPublicToken, readKeptFile, tokenHash, tokenShapeOk } from "./kept-files";
import {
  REPORTS_TO_PAUSE, SECRETS_PER_DAY, SECRET_INLINE_MAX, SECRET_MAX_CIPHER_BYTES, SECRET_MAX_SECONDS, SECRET_MIN_SECONDS, SECRET_VIEW_CHOICES,
  type SecretInfo, type SecretOpenRow,
} from "@/shared/secure-share";

export interface SecretRow {
  id: string; org_id: string; created_by: string; token_hash: string; kind: string; label: string | null; ciphertext: string | null; file_id: string | null;
  bytes: number; passphrase: number; max_views: number; views: number; notify: number; reports: number; expires_at: number; burned_at: number | null;
  revoked_at: number | null; created_at: number;
}

export interface NewSecret { kind: "text" | "file"; ciphertext: string; label?: string | null; passphrase?: boolean; maxViews: number; expiresInSeconds: number; notify?: boolean }

const DAY = 86_400_000;

export function secretStatus(r: SecretRow, now: number): SecretInfo["status"] {
  if (r.revoked_at) return "revoked";
  if (r.burned_at) return "burned";
  if (r.expires_at <= now) return "expired";
  if (r.reports >= REPORTS_TO_PAUSE) return "paused";
  return r.views > 0 ? "opened" : "waiting";
}

function info(r: SecretRow, now: number): SecretInfo {
  return {
    id: r.id, kind: r.kind as SecretInfo["kind"], label: r.label, bytes: r.bytes, hasPassphrase: !!r.passphrase, maxViews: r.max_views, views: r.views,
    notify: !!r.notify, expiresAt: new Date(r.expires_at).toISOString(), createdAt: new Date(r.created_at).toISOString(), status: secretStatus(r, now),
  };
}

/** base64url (the browser's form) to bytes; null when it isn't base64. */
export function cipherBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
  try { return fromB64(s.replace(/-/g, "+").replace(/_/g, "/")); } catch { return null; }
}

export async function createSecret(deps: Deps, auth: AuthContext, input: NewSecret, ip?: string): Promise<SecretInfo> {
  if (input.kind !== "text" && input.kind !== "file") throw badRequest("Choose text or a file.");
  const bytes = cipherBytes(input.ciphertext ?? "");
  // 12 byte nonce plus the 16 byte tag at least.
  if (!bytes || bytes.byteLength < 29) throw badRequest("That secret didn't encrypt properly. Try again.");
  if (bytes.byteLength > SECRET_MAX_CIPHER_BYTES) throw badRequest("Secrets can be up to 5 MB.");
  if (!SECRET_VIEW_CHOICES.includes(input.maxViews as (typeof SECRET_VIEW_CHOICES)[number])) throw badRequest("Choose how many times it can be opened.");
  const secs = Math.floor(input.expiresInSeconds);
  if (!Number.isFinite(secs) || secs < SECRET_MIN_SECONDS || secs > SECRET_MAX_SECONDS) throw badRequest("Choose an expiry from 5 minutes to 30 days.");
  // eslint-disable-next-line no-control-regex -- strips control characters from names and notes
  const label = (input.label ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80) || null;
  const now = deps.now().getTime();
  const made = await deps.db.get<{ n: number }>(sql`select count(*) as n from tool_secrets where org_id = ${auth.orgId} and created_at > ${now - DAY}`);
  if (Number(made?.n ?? 0) >= SECRETS_PER_DAY) throw tooMany(`Your workspace can make ${SECRETS_PER_DAY} secret links a day. Try again tomorrow.`);
  const inline = bytes.byteLength <= SECRET_INLINE_MAX;
  const fileId = inline ? null : await keepFile(deps, auth.orgId, "secret", bytes, secs);
  const { token, hash } = newPublicToken();
  const row: SecretRow = {
    id: newId("sec"), org_id: auth.orgId, created_by: auth.userId, token_hash: await hash, kind: input.kind, label, ciphertext: inline ? toB64(bytes) : null, file_id: fileId,
    bytes: bytes.byteLength, passphrase: input.passphrase ? 1 : 0, max_views: input.maxViews, views: 0, notify: input.notify === false ? 0 : 1, reports: 0,
    expires_at: now + secs * 1000, burned_at: null, revoked_at: null, created_at: now,
  };
  await deps.db.run(sql`insert into tool_secrets (id, org_id, created_by, token_hash, kind, label, ciphertext, file_id, bytes, passphrase, max_views, notify, expires_at, created_at)
    values (${row.id}, ${row.org_id}, ${row.created_by}, ${row.token_hash}, ${row.kind}, ${row.label}, ${row.ciphertext}, ${row.file_id}, ${row.bytes}, ${row.passphrase}, ${row.max_views}, ${row.notify}, ${row.expires_at}, ${row.created_at})`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.secret_created", targetType: "tool_secret", targetId: row.id, metadata: { kind: row.kind, bytes: row.bytes, views: row.max_views, passphrase: !!row.passphrase, seconds: secs }, ip });
  return { ...info(row, now), url: `${deps.config.appUrl.replace(/\/$/, "")}/x/${token}` };
}

/** Admins see every secret in the workspace (never its contents: the server has none); members see their own. */
export async function listSecrets(deps: Deps, auth: AuthContext): Promise<SecretInfo[]> {
  const mine = auth.role === "member";
  const rows = await deps.db.all<SecretRow>(sql`select id, org_id, created_by, token_hash, kind, label, null as ciphertext, file_id, bytes, passphrase, max_views, views, notify, reports, expires_at, burned_at, revoked_at, created_at
    from tool_secrets where org_id = ${auth.orgId} ${mine ? sql`and created_by = ${auth.userId}` : sql``} order by created_at desc limit 200`);
  const now = deps.now().getTime();
  return rows.map((r) => info(r, now));
}

async function ownSecret(deps: Deps, auth: AuthContext, id: string): Promise<SecretRow> {
  const r = await deps.db.get<SecretRow>(sql`select * from tool_secrets where id = ${id} and org_id = ${auth.orgId}`);
  if (!r || (auth.role === "member" && r.created_by !== auth.userId)) throw notFound("Secret");
  return r;
}

export async function secretDetail(deps: Deps, auth: AuthContext, id: string): Promise<SecretInfo> {
  const r = await ownSecret(deps, auth, id);
  const opens = await deps.db.all<{ at: number; country: string | null; region: string | null; agent: string | null }>(sql`select at, country, region, agent from tool_secret_opens where secret_id = ${r.id} order by at desc limit 50`);
  return { ...info(r, deps.now().getTime()), opens: opens.map((o): SecretOpenRow => ({ at: new Date(o.at).toISOString(), country: o.country, region: o.region, agent: o.agent })) };
}

async function burn(deps: Deps, r: SecretRow, field: "burned_at" | "revoked_at") {
  const now = deps.now().getTime();
  if (field === "burned_at") await deps.db.run(sql`update tool_secrets set burned_at = ${now}, ciphertext = null where id = ${r.id}`);
  else await deps.db.run(sql`update tool_secrets set revoked_at = ${now}, ciphertext = null where id = ${r.id}`);
  if (r.file_id) await dropKeptFiles(deps, r.org_id, [r.file_id]);
}

export async function revokeSecret(deps: Deps, auth: AuthContext, id: string, ip?: string): Promise<SecretInfo> {
  const r = await ownSecret(deps, auth, id);
  const now = deps.now().getTime();
  if (!r.revoked_at && !r.burned_at) {
    await burn(deps, r, "revoked_at");
    r.revoked_at = now;
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.secret_revoked", targetType: "tool_secret", targetId: r.id, ip });
  }
  return info({ ...r, ciphertext: null }, now);
}

// ---------------------------------------------------------------------------
// The public side
// ---------------------------------------------------------------------------
export interface PublicSecretView { row: SecretRow; workspace: string; state: SecretInfo["status"] }

export async function findPublicSecret(deps: Deps, token: string): Promise<PublicSecretView | null> {
  if (!tokenShapeOk(token)) return null;
  const h = await tokenHash(token);
  const r = await deps.db.get<SecretRow & { ws: string | null; tools_mode: string | null }>(sql`select s.*, o.name as ws, o.tools_mode as tools_mode from tool_secrets s left join organizations o on o.id = s.org_id where s.token_hash = ${h}`);
  if (!r || !hashMatches(r.token_hash, h)) return null;
  const now = deps.now().getTime();
  return { row: r, workspace: r.ws ?? "", state: r.tools_mode === "off" ? "revoked" : secretStatus(r, now) };
}

export type OpenResult = { ok: true; kind: string; ciphertext: string; passphrase: boolean; viewsLeft: number } | { ok: false; reason: "gone" | "missing" | "paused" };

/** Takes one view (one statement, so two opens at once can't both take the last one), hands out the ciphertext, burns on the last. */
export async function openSecret(deps: Deps, v: PublicSecretView, req: { country: string | null; region: string | null; agent: string | null }): Promise<OpenResult> {
  const r = v.row;
  if (v.state === "paused") return { ok: false, reason: "paused" };
  if (v.state !== "waiting" && v.state !== "opened") return { ok: false, reason: "gone" };
  const now = deps.now().getTime();
  const took = await deps.db.run(sql`update tool_secrets set views = views + 1
    where id = ${r.id} and views < max_views and burned_at is null and revoked_at is null and expires_at > ${now}`);
  if (!changesOf(took)) return { ok: false, reason: "gone" };
  const bytes = r.ciphertext ? fromB64(r.ciphertext) : r.file_id ? await readKeptFile(deps, r.file_id) : null;
  const views = r.views + 1;
  if (views >= r.max_views) await burn(deps, r, "burned_at");
  await deps.db.run(sql`insert into tool_secret_opens (id, secret_id, org_id, at, country, region, agent) values (${newId("sop")}, ${r.id}, ${r.org_id}, ${now}, ${req.country}, ${req.region}, ${req.agent})`);
  if (!bytes) return { ok: false, reason: "missing" };
  await receipt(deps, r, views, req).catch((err) => deps.log?.warn("tools.secret_receipt_failed", { error: String(err) }));
  const b64 = toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { ok: true, kind: r.kind, ciphertext: b64, passphrase: !!r.passphrase, viewsLeft: Math.max(0, r.max_views - views) };
}

/** "This secret was opened": in the app each time, and by email when the sender asked for it. */
async function receipt(deps: Deps, r: SecretRow, views: number, req: { country: string | null; region: string | null; agent: string | null }) {
  const name = r.label ? `Your secret "${r.label}"` : "Your secret link";
  const where = [req.region && req.country ? `${req.region}, ${req.country}` : req.country ? `from ${req.country}` : "", req.agent ? `using ${req.agent}` : ""].filter(Boolean).join(", ");
  const burned = views >= r.max_views;
  const title = `${name} was opened${burned ? " and is now gone" : ""}`;
  await notify(deps, r.org_id, r.created_by, { type: "tools.secret_opened", entityType: "secret", entityId: r.id, title });
  if (!r.notify) return;
  const u = await deps.db.get<{ email: string }>(sql`select email from users where id = ${r.created_by}`);
  if (!u?.email) return;
  await sendSystemEmail(deps, {
    to: u.email, orgId: r.org_id, subject: title,
    text: `${name} was opened just now${where ? ` (${where})` : ""}. ${burned ? "It has been deleted, so the link no longer works." : `It can be opened ${r.max_views - views} more ${r.max_views - views === 1 ? "time" : "times"}.`} If you didn't expect this, change anything the secret protected.`,
    action: { label: "See secret links", url: `${deps.config.appUrl.replace(/\/$/, "")}/app/tools/share?tab=secrets` },
  });
}
