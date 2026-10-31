/**
 * R107: e-sign v2 (flag ESIGN_V2), written to the Electronic Transactions Act 1999 (Cth) basics:
 *  - identify each signer: a 6 digit code to the signer's email before they can sign (HMAC hashed, 10 minutes,
 *    single use, 5 wrong tries, at most 1 send a minute and 5 an hour; the check is bound to the link token);
 *  - clear intent: the consent box is checked on the server too, and its words go into the record;
 *  - a reliable record: every event keeps an IP hash (never the IP), the user agent, the signer's time zone and the
 *    document's SHA-256; sign_events is append only (a D1 trigger refuses UPDATE);
 *  - tamper evidence: a per workspace ECDSA P-256 key (private half encrypted with the app secret, never logged or
 *    sent to a browser) seals request id, SHA-256 before and after, and the completion time; /sign/verify checks it;
 *  - templates (roles instead of people) and bulk send to a list (one request each, sent a few per cron pass).
 * Older requests (v2 = 0) keep their flow, so links already in people's inboxes keep working.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, notFound } from "../../lib/errors";
import { decryptSecret, encryptSecret, hmacSha256Hex, newId, randomBytes, safeEqual, sha256Hex } from "../../lib/crypto";
import { audit } from "../audit";
import { sendSystemEmail } from "../system-mail";
import { SIGN_MAX_DAYS, SIGN_MAX_SIGNERS, type SignField, type SignPage, type SignTemplateInfo, type SignVerifyResult } from "@/shared/share-sign";
import { changesOf, dropKeptFiles, keepFile, readKeptFile } from "./kept-files";
import type { RequestRow, SignerRow, SignerView } from "./esign";

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_TRIES = 5;
export const CODE_MIN_GAP_MS = 60_000;
export const CODE_MAX_PER_HOUR = 5;
export const VERIFIED_FOR_MS = 60 * 60_000;
export const TEMPLATE_TTL_SECONDS = 365 * 86_400;
export const TEMPLATE_MAX = 50;
export const BULK_MAX_ROWS = 50;
export const BULK_SEND_NOW = 5;
export const BULK_SEND_PER_PASS = 8;
/** The words the signer agrees to; kept in the record word for word. */
export const CONSENT_TEXT = "I have read this document and I agree to sign it electronically.";

// ---------------------------------------------------------------------------
// Event context (who, from where, which document) for the record
// ---------------------------------------------------------------------------
export interface EventCtx { ipHash?: string | null; userAgent?: string | null; tz?: string | null; docSha256?: string | null }

export function validTz(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(v)) return null;
  try { new Intl.DateTimeFormat("en-AU", { timeZone: v }); return v; } catch { return null; }
}

/** The IP is never stored: a keyed hash lets two events be matched without keeping the address. */
export async function ipHashOf(deps: Deps, ip: string | null | undefined): Promise<string | null> {
  return ip ? (await hmacSha256Hex(deps.config.appSecret, `esign-ip:${ip}`)).slice(0, 16) : null;
}

export async function eventCtx(deps: Deps, req: Request, ip: string | null | undefined, tz?: unknown, docSha256?: string | null): Promise<EventCtx> {
  const ua = req.headers.get("user-agent");
  return { ipHash: await ipHashOf(deps, ip), userAgent: ua ? ua.slice(0, 200) : null, tz: validTz(tz), docSha256: docSha256 ?? null };
}

/** A short device word for the record page ("Safari on iPhone"). */
export function deviceOf(ua: string | null | undefined): string {
  if (!ua) return "";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(" on ");
}

/** A time in the signer's own zone, for the record ("1 Nov 2026, 4:31 am AEDT"). */
export function localTime(ms: number, tz: string | null | undefined): string {
  const zone = validTz(tz);
  if (!zone) return "";
  return new Date(ms).toLocaleString("en-AU", { timeZone: zone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

// ---------------------------------------------------------------------------
// Identity: the email code
// ---------------------------------------------------------------------------
export function maskEmail(email: string): string {
  const [u, d] = email.split("@");
  if (!d) return "***";
  return `${u.slice(0, 1)}${"*".repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
}

export function newCode(): string {
  const b = randomBytes(4);
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

const codeHash = (deps: Deps, signerId: string, code: string) => hmacSha256Hex(deps.config.appSecret, `esign-code:${signerId}:${code}`);

export function recentSends(raw: string | null | undefined, now: number): number[] {
  let list: unknown;
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  return Array.isArray(list) ? list.filter((t): t is number => typeof t === "number" && t > now - 3_600_000) : [];
}

export function isVerified(s: Pick<SignerRow, "verified_at" | "verified_token" | "token_hash">, now: number): boolean {
  return !!s.verified_at && !!s.token_hash && s.verified_token === s.token_hash && now - s.verified_at < VERIFIED_FOR_MS;
}

type Result = { ok: true; message?: string } | { ok: false; message: string; status?: number; retryAfter?: number };

export async function sendCode(deps: Deps, v: SignerView, ctx: EventCtx): Promise<Result> {
  if (v.state !== "open") return { ok: false, message: "This link can no longer be used to sign.", status: 409 };
  const now = deps.now().getTime();
  const s = v.s;
  if (s.code_sent_at && now - s.code_sent_at < CODE_MIN_GAP_MS) {
    const wait = Math.ceil((CODE_MIN_GAP_MS - (now - s.code_sent_at)) / 1000);
    return { ok: false, message: `A code was just sent. You can ask for another in ${wait} seconds.`, status: 429, retryAfter: wait };
  }
  const sends = recentSends(s.code_sends, now);
  if (sends.length >= CODE_MAX_PER_HOUR) return { ok: false, message: "Too many codes were asked for. Try again in an hour.", status: 429, retryAfter: 3600 };
  const code = newCode();
  const h = await codeHash(deps, s.id, code);
  const res = await deps.db.run(sql`update sign_signers set code_hash = ${h}, code_expires_at = ${now + CODE_TTL_MS}, code_tries = 0, code_sent_at = ${now},
    code_sends = ${JSON.stringify([...sends, now])} where id = ${s.id} and token_hash = ${s.token_hash} and (code_sent_at is null or code_sent_at <= ${now - CODE_MIN_GAP_MS})`);
  if (!changesOf(res)) return { ok: false, message: "A code was just sent. Check your email.", status: 429, retryAfter: 60 };
  await sendSystemEmail(deps, {
    to: s.email, orgId: v.r.org_id, subject: `Your code to sign ${v.r.title}`,
    text: [`Your code is ${code}`, "", `Enter it on the signing page for ${v.r.title}. It works once, for 10 minutes.`, "",
      "If you did not ask for it, you can ignore this email. No one can sign as you without it."].join("\n"),
  });
  const { addEvent } = await import("./esign");
  await addEvent(deps, v.r, { signerId: s.id, name: s.name, email: s.email, action: "code_sent", detail: `Code emailed to ${maskEmail(s.email)}`, ...ctx });
  return { ok: true, message: `We emailed a code to ${maskEmail(s.email)}.` };
}

export async function checkCode(deps: Deps, v: SignerView, code: unknown, ctx: EventCtx): Promise<Result> {
  if (v.state !== "open") return { ok: false, message: "This link can no longer be used to sign.", status: 409 };
  const s = v.s;
  const now = deps.now().getTime();
  const c = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(c)) return { ok: false, message: "Enter the 6 digit code from the email.", status: 400 };
  if (!s.code_hash || !s.code_expires_at || s.code_expires_at <= now) return { ok: false, message: "This code has expired or was already used. Ask for a new one.", status: 409 };
  if (s.code_tries >= CODE_MAX_TRIES) return { ok: false, message: "Too many wrong codes. Ask for a new one.", status: 429 };
  const h = await codeHash(deps, s.id, c);
  const { addEvent } = await import("./esign");
  if (!safeEqual(h, s.code_hash)) {
    // Counted in the statement itself, so parallel guesses cannot go past the limit.
    const counted = await deps.db.run(sql`update sign_signers set code_tries = code_tries + 1 where id = ${s.id} and code_tries < ${CODE_MAX_TRIES}`);
    if (!changesOf(counted)) return { ok: false, message: "Too many wrong codes. Ask for a new one.", status: 429 };
    await addEvent(deps, v.r, { signerId: s.id, name: s.name, email: s.email, action: "code_wrong", ...ctx });
    const left = CODE_MAX_TRIES - s.code_tries - 1;
    return { ok: false, message: left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Ask for a new one.", status: 400 };
  }
  // Single use: the hash is cleared in the same statement that marks the signer checked.
  const res = await deps.db.run(sql`update sign_signers set code_hash = null, code_expires_at = null, verified_at = ${now}, verified_token = token_hash
    where id = ${s.id} and code_hash = ${h} and token_hash = ${s.token_hash}`);
  if (!changesOf(res)) return { ok: false, message: "This code has expired or was already used. Ask for a new one.", status: 409 };
  await addEvent(deps, v.r, { signerId: s.id, name: s.name, email: s.email, action: "identity_checked", detail: `Email code to ${maskEmail(s.email)}`, ...ctx });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The seal: a workspace key signs the finished copy's fingerprint
// ---------------------------------------------------------------------------
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));

interface KeyRow { org_id: string; key_id: string; public_jwk: string; private_enc: string; created_at: number }

export async function orgKeyRow(deps: Deps, orgId: string): Promise<KeyRow> {
  const have = await deps.db.get<KeyRow>(sql`select * from esign_keys where org_id = ${orgId}`);
  if (have) return have;
  const pair = (await crypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const pubJson = JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y });
  const keyId = `esk_${(await sha256Hex(pubJson)).slice(0, 16)}`;
  const privEnc = await encryptSecret(deps.config.appSecret, JSON.stringify(priv));
  await deps.db.run(sql`insert or ignore into esign_keys (org_id, key_id, public_jwk, private_enc, created_at) values (${orgId}, ${keyId}, ${pubJson}, ${privEnc}, ${deps.now().getTime()})`);
  return (await deps.db.get<KeyRow>(sql`select * from esign_keys where org_id = ${orgId}`))!;
}

export const sealPayload = (r: { id: string; source_sha256: string; final_sha256: string | null; completed_at: number | null }) =>
  `multies-esign-seal-v1|${r.id}|${r.source_sha256}|${r.final_sha256 ?? ""}|${r.completed_at ? new Date(r.completed_at).toISOString() : ""}`;

/** Seals a completed request once. Safe to call again. */
export async function sealRequest(deps: Deps, r: RequestRow & { seal?: string | null }): Promise<string | null> {
  if (r.status !== "completed" || !r.final_sha256 || r.seal) return r.seal ?? null;
  const k = await orgKeyRow(deps, r.org_id);
  const priv = await crypto.subtle.importKey("jwk", JSON.parse(await decryptSecret(deps.config.appSecret, k.private_enc)) as JsonWebKey, ALG, false, ["sign"]);
  const seal = b64u(await crypto.subtle.sign(SIG, priv, enc.encode(sealPayload(r))));
  const res = await deps.db.run(sql`update sign_requests set seal = ${seal}, seal_key_id = ${k.key_id} where id = ${r.id} and seal is null`);
  if (changesOf(res)) {
    const { addEvent } = await import("./esign");
    await addEvent(deps, r, { name: "Multies", email: "", action: "sealed", detail: `Sealed with workspace key ${k.key_id}`, docSha256: r.final_sha256 });
  }
  return seal;
}

export async function sealValid(deps: Deps, r: { org_id: string; id: string; source_sha256: string; final_sha256: string | null; completed_at: number | null; seal: string | null; seal_key_id: string | null }): Promise<boolean> {
  if (!r.seal || !r.seal_key_id) return false;
  const k = await deps.db.get<KeyRow>(sql`select * from esign_keys where org_id = ${r.org_id}`);
  if (!k || k.key_id !== r.seal_key_id) return false;
  try {
    const pub = await crypto.subtle.importKey("jwk", JSON.parse(k.public_jwk) as JsonWebKey, ALG, false, ["verify"]);
    return await crypto.subtle.verify(SIG, pub, fromB64u(r.seal), enc.encode(sealPayload(r)));
  } catch { return false; }
}

/** The public check: the browser hashes the PDF itself and sends only the hash. */
export async function verifyByHash(deps: Deps, sha: string): Promise<SignVerifyResult> {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw badRequest("That is not a document fingerprint.");
  const r = await deps.db.get<{ id: string; org_id: string; title: string; source_sha256: string; final_sha256: string | null; completed_at: number | null; seal: string | null; seal_key_id: string | null; ws: string | null; n: number }>(
    sql`select q.id, q.org_id, q.title, q.source_sha256, q.final_sha256, q.completed_at, q.seal, q.seal_key_id, o.name as ws,
      (select count(*) from sign_signers s where s.request_id = q.id) as n
    from sign_requests q left join organizations o on o.id = q.org_id where q.final_sha256 = ${sha} and q.status = 'completed' limit 1`);
  if (!r) return { found: false };
  return {
    found: true, title: r.title, workspace: r.ws ?? "", completedAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    signers: Number(r.n) || 0, sealed: !!r.seal, sealValid: r.seal ? await sealValid(deps, r) : false, keyId: r.seal_key_id,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
interface TemplateRow {
  id: string; org_id: string; created_by: string; name: string; title: string; message: string | null; order_mode: "any" | "sequence"; remind_days: number; expires_days: number;
  roles: string; fields: string; pages: string; source_file_id: string; source_sha256: string; uses: number; deleted_at: number | null; created_at: number; updated_at: number;
}

function templateInfo(t: TemplateRow, auth: AuthContext, by?: string | null): SignTemplateInfo {
  const roles = JSON.parse(t.roles) as string[];
  const fields = JSON.parse(t.fields) as SignField[];
  const pages = (JSON.parse(t.pages) as { list: SignPage[] }).list;
  return {
    id: t.id, name: t.name, title: t.title, message: t.message, orderMode: t.order_mode, remindDays: t.remind_days, expiresDays: t.expires_days, roles,
    fieldCount: fields.length, pageCount: pages.length, uses: t.uses, createdAt: new Date(t.created_at).toISOString(), updatedAt: new Date(t.updated_at).toISOString(),
    createdBy: by ?? null, canDelete: auth.role !== "member" || t.created_by === auth.userId,
  };
}

export function cleanRoles(roles: unknown): string[] {
  if (!Array.isArray(roles) || !roles.length || roles.length > SIGN_MAX_SIGNERS) throw badRequest(`Add 1 to ${SIGN_MAX_SIGNERS} roles.`);
  const out = roles.map((r, i) => (typeof r === "string" && r.trim() ? r.trim().slice(0, 40) : `Signer ${i + 1}`));
  if (new Set(out.map((r) => r.toLowerCase())).size !== out.length) throw badRequest("Give each role its own name.");
  return out;
}

export interface SaveTemplateInput { name: string; roles: string[]; fields: SignField[]; order: "any" | "sequence"; message?: string; expiresDays?: number; remindDays?: number }

export async function saveTemplate(deps: Deps, auth: AuthContext, requestId: string, input: SaveTemplateInput, ip?: string): Promise<SignTemplateInfo> {
  const { ownRequest, checkFields } = await import("./esign");
  const r = await ownRequest(deps, auth, requestId);
  const pinfo = r.pages ? (JSON.parse(r.pages) as { zip: string | null; list: SignPage[] }) : null;
  if (!pinfo) throw badRequest("The pages are still loading. Try again in a moment.");
  const name = (input.name ?? "").trim().slice(0, 80);
  if (!name) throw badRequest("Give the template a name.");
  const roles = cleanRoles(input.roles);
  const fields = checkFields(input.fields, pinfo.list, roles.length);
  for (let i = 0; i < roles.length; i++) if (!fields.some((f) => f.signer === i && f.kind === "signature")) throw badRequest(`Place a signature field for ${roles[i]}.`);
  const count = await deps.db.get<{ n: number }>(sql`select count(*) as n from sign_templates where org_id = ${auth.orgId} and deleted_at is null`);
  if (Number(count?.n ?? 0) >= TEMPLATE_MAX) throw badRequest(`A workspace can keep up to ${TEMPLATE_MAX} templates. Delete one first.`);
  const src = await readKeptFile(deps, r.source_file_id);
  if (!src) throw new HttpError(410, "gone", "This document has expired. Open it again.");
  const srcId = await keepFile(deps, auth.orgId, "sign_template", src, TEMPLATE_TTL_SECONDS, { name: r.title });
  let zipId: string | null = null;
  if (pinfo.zip) {
    const z = await readKeptFile(deps, pinfo.zip);
    zipId = z ? await keepFile(deps, auth.orgId, "sign_template", z, TEMPLATE_TTL_SECONDS).catch(() => null) : null;
  }
  const id = newId("stp");
  const now = deps.now().getTime();
  const days = clampDays(input.expiresDays ?? 14);
  await deps.db.run(sql`insert into sign_templates (id, org_id, created_by, name, title, message, order_mode, remind_days, expires_days, roles, fields, pages, source_file_id, source_sha256, uses, created_at, updated_at)
    values (${id}, ${auth.orgId}, ${auth.userId}, ${name}, ${r.title}, ${(input.message ?? "").slice(0, 2000) || null}, ${input.order === "sequence" ? "sequence" : "any"},
      ${Math.max(0, Math.min(14, Math.floor(input.remindDays ?? 0)))}, ${days}, ${JSON.stringify(roles)}, ${JSON.stringify(fields)}, ${JSON.stringify({ zip: zipId, list: pinfo.list })},
      ${srcId}, ${r.source_sha256}, 0, ${now}, ${now})`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_template_saved", targetType: "sign_template", targetId: id, ip });
  return templateInfo((await templateRow(deps, auth, id))!, auth, auth.name || auth.email);
}

const clampDays = (d: number) => {
  const n = Math.floor(Number(d));
  if (!(n >= 1 && n <= SIGN_MAX_DAYS)) throw badRequest(`Choose 1 to ${SIGN_MAX_DAYS} days for the request.`);
  return n;
};

async function templateRow(deps: Deps, auth: AuthContext, id: string): Promise<TemplateRow | null> {
  return (await deps.db.get<TemplateRow>(sql`select * from sign_templates where id = ${id} and org_id = ${auth.orgId} and deleted_at is null`)) ?? null;
}

/** Everyone in the workspace sees and uses its templates; the maker or an admin can delete one. */
export async function listTemplates(deps: Deps, auth: AuthContext): Promise<SignTemplateInfo[]> {
  const rows = await deps.db.all<TemplateRow & { by: string | null }>(sql`select t.*, u.name as by from sign_templates t left join users u on u.id = t.created_by
    where t.org_id = ${auth.orgId} and t.deleted_at is null order by t.updated_at desc limit ${TEMPLATE_MAX}`);
  return rows.map((t) => templateInfo(t, auth, t.by));
}

export async function deleteTemplate(deps: Deps, auth: AuthContext, id: string, ip?: string): Promise<{ ok: true }> {
  const t = await templateRow(deps, auth, id);
  if (!t) throw notFound("Template");
  if (auth.role === "member" && t.created_by !== auth.userId) throw new HttpError(403, "forbidden", "Only the person who made this template or an admin can delete it.");
  await deps.db.run(sql`update sign_templates set deleted_at = ${deps.now().getTime()} where id = ${id}`);
  const open = await deps.db.get<{ n: number }>(sql`select count(*) as n from sign_requests where template_id = ${id} and status in ('out', 'finishing')`);
  if (!Number(open?.n ?? 0)) await dropKeptFiles(deps, t.org_id, [t.source_file_id, (JSON.parse(t.pages) as { zip: string | null }).zip]);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_template_deleted", targetType: "sign_template", targetId: id, ip });
  return { ok: true };
}

/** Files a closing request must leave alone: a live template's, or one another open request of the same template still needs. */
export async function sharedFiles(deps: Deps, r: Pick<RequestRow, "id"> & { template_id?: string | null }): Promise<Set<string>> {
  if (!r.template_id) return new Set();
  const t = await deps.db.get<{ source_file_id: string; pages: string; deleted_at: number | null }>(sql`select source_file_id, pages, deleted_at from sign_templates where id = ${r.template_id}`);
  if (!t) return new Set();
  const ids = [t.source_file_id, (JSON.parse(t.pages) as { zip: string | null }).zip].filter((x): x is string => !!x);
  if (t.deleted_at === null) return new Set(ids);
  const others = await deps.db.get<{ n: number }>(sql`select count(*) as n from sign_requests where template_id = ${r.template_id} and id != ${r.id} and status in ('out', 'finishing')`);
  return Number(others?.n ?? 0) ? new Set(ids) : new Set();
}

export interface TemplateSendInput { signers: { name: string; email: string }[]; mailboxId?: string; message?: string; subject?: string; expiresDays?: number; remindDays?: number; order?: "any" | "sequence" }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanPeople(list: unknown, max: number): { name: string; email: string }[] {
  if (!Array.isArray(list) || !list.length || list.length > max) throw badRequest(`Add 1 to ${max} people.`);
  const out = list.map((p) => {
    const o = (p ?? {}) as { name?: unknown; email?: unknown };
    return { name: typeof o.name === "string" ? o.name.trim().slice(0, 120) : "", email: typeof o.email === "string" ? o.email.trim().toLowerCase() : "" };
  });
  out.forEach((p, i) => { if (!p.name || !EMAIL.test(p.email)) throw badRequest(`Row ${i + 1} needs a name and an email address.`); });
  if (new Set(out.map((p) => p.email)).size !== out.length) throw badRequest("Each person needs their own email address.");
  return out;
}

/** Parses a pasted list: one person a line, "Name, email" or "email" (comma, semicolon or tab). */
export function parseList(text: string): { rows: { name: string; email: string }[]; bad: number[] } {
  const rows: { name: string; email: string }[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const l = line.trim();
    if (!l || /^name\s*[,;\t]\s*email$/i.test(l)) return;
    const parts = l.split(/[,;\t]/).map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const email = parts.find((x) => EMAIL.test(x));
    if (!email) { bad.push(i + 1); return; }
    const name = parts.filter((x) => x !== email).join(" ") || email.split("@")[0];
    rows.push({ name: name.slice(0, 120), email: email.toLowerCase() });
  });
  return { rows, bad };
}

async function mailboxFor(deps: Deps, auth: AuthContext, mailboxId: string | undefined): Promise<string> {
  const { mailboxScope } = await import("../team");
  if (!mailboxId) throw badRequest("Choose the mailbox the request is sent from.");
  const scope = await mailboxScope(deps.db, auth);
  if (scope && !scope.includes(mailboxId)) throw notFound("Mailbox");
  const mb = await deps.db.get<{ id: string }>(sql`select id from mailboxes where id = ${mailboxId} and org_id = ${auth.orgId}`);
  if (!mb) throw notFound("Mailbox");
  return mb.id;
}

async function createFromTemplate(deps: Deps, auth: AuthContext, t: TemplateRow, people: { name: string; email: string }[], o: { mailboxId: string; message: string | null; subject: string; days: number; remind: number; order: "any" | "sequence"; bulkId: string | null; pending: boolean }): Promise<string> {
  const id = newId("sgn");
  const now = deps.now().getTime();
  const until = now + o.days * 86_400_000;
  await deps.db.run(sql`insert into sign_requests (id, org_id, created_by, kind, status, title, subject, message, mailbox_id, in_reply_to_id, order_mode, fields, pages, source_file_id, source_sha256,
      remind_days, expires_at, sent_at, created_at, v2, template_id, bulk_id, pending_send)
    values (${id}, ${auth.orgId}, ${auth.userId}, 'request', 'out', ${t.title}, ${o.subject}, ${o.message}, ${o.mailboxId}, null, ${o.order}, ${t.fields}, ${t.pages}, ${t.source_file_id}, ${t.source_sha256},
      ${o.remind}, ${until}, ${now}, ${now}, ${deps.config.esignV2 === false ? 0 : 1}, ${t.id}, ${o.bulkId}, ${o.pending ? 1 : 0})`);
  for (let i = 0; i < people.length; i++) {
    await deps.db.run(sql`insert into sign_signers (id, request_id, org_id, position, name, email, status) values (${newId("ssg")}, ${id}, ${auth.orgId}, ${i}, ${people[i].name}, ${people[i].email}, 'waiting')`);
  }
  const { addEvent } = await import("./esign");
  await addEvent(deps, { id, org_id: auth.orgId }, { name: auth.name || auth.email, email: auth.email, action: "created", docSha256: t.source_sha256,
    detail: `From template ${t.name}: ${people.length} ${people.length === 1 ? "signer" : "signers"}, ${o.order === "sequence" ? "in order" : "any order"}` });
  return id;
}

export async function sendFromTemplate(deps: Deps, auth: AuthContext, id: string, input: TemplateSendInput, ip?: string) {
  const t = await templateRow(deps, auth, id);
  if (!t) throw notFound("Template");
  const roles = JSON.parse(t.roles) as string[];
  const people = cleanPeople(input.signers, SIGN_MAX_SIGNERS);
  if (people.length !== roles.length) throw badRequest(`This template needs ${roles.length} ${roles.length === 1 ? "signer" : "signers"}.`);
  const mailboxId = await mailboxFor(deps, auth, input.mailboxId);
  const reqId = await createFromTemplate(deps, auth, t, people, {
    mailboxId, message: (input.message ?? t.message ?? "").slice(0, 2000) || null, subject: (input.subject?.trim() || `Please sign: ${t.title}`).slice(0, 200),
    days: clampDays(input.expiresDays ?? t.expires_days), remind: Math.max(0, Math.min(14, Math.floor(input.remindDays ?? t.remind_days))),
    order: (input.order ?? t.order_mode) === "sequence" ? "sequence" : "any", bulkId: null, pending: false,
  });
  await deps.db.run(sql`update sign_templates set uses = uses + 1, updated_at = ${deps.now().getTime()} where id = ${t.id}`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_requested", targetType: "sign_request", targetId: reqId, metadata: { template: t.id, signers: people.length }, ip });
  const { requestRow, sendDueLinks, requestDetail } = await import("./esign");
  await sendDueLinks(deps, (await requestRow(deps, reqId))!);
  return requestDetail(deps, auth, reqId);
}

export interface BulkInput { rows?: unknown; text?: string; mailboxId?: string; message?: string; subject?: string; expiresDays?: number; remindDays?: number }

/** One request per person on the list, from a one role template; the first few go now, the rest a few per cron pass. */
export async function bulkSend(deps: Deps, auth: AuthContext, id: string, input: BulkInput, ip?: string): Promise<{ bulkId: string; count: number; sentNow: number }> {
  const t = await templateRow(deps, auth, id);
  if (!t) throw notFound("Template");
  const roles = JSON.parse(t.roles) as string[];
  if (roles.length !== 1) throw badRequest("Sending to a list works with templates that have one signer.");
  let rows = input.rows;
  if (rows === undefined && typeof input.text === "string") {
    const parsed = parseList(input.text);
    if (parsed.bad.length) throw badRequest(`Line ${parsed.bad.slice(0, 5).join(", ")} has no email address.`);
    rows = parsed.rows;
  }
  const people = cleanPeople(rows, BULK_MAX_ROWS);
  const mailboxId = await mailboxFor(deps, auth, input.mailboxId);
  const bulkId = newId("sbk");
  const opts = {
    mailboxId, message: (input.message ?? t.message ?? "").slice(0, 2000) || null, subject: (input.subject?.trim() || `Please sign: ${t.title}`).slice(0, 200),
    days: clampDays(input.expiresDays ?? t.expires_days), remind: Math.max(0, Math.min(14, Math.floor(input.remindDays ?? t.remind_days))), order: "any" as const, bulkId, pending: true,
  };
  for (const p of people) await createFromTemplate(deps, auth, t, [p], opts);
  await deps.db.run(sql`update sign_templates set uses = uses + ${people.length}, updated_at = ${deps.now().getTime()} where id = ${t.id}`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.esign_bulk_sent", targetType: "sign_template", targetId: t.id, metadata: { bulk: bulkId, people: people.length }, ip });
  const sentNow = await sendPending(deps, BULK_SEND_NOW, bulkId);
  return { bulkId, count: people.length, sentNow };
}

/** Sends links for queued bulk requests (claimed one by one, so two passes never send twice). */
export async function sendPending(deps: Deps, limit = BULK_SEND_PER_PASS, bulkId?: string): Promise<number> {
  const rows = await deps.db.all<{ id: string }>(bulkId
    ? sql`select id from sign_requests where pending_send = 1 and bulk_id = ${bulkId} order by created_at limit ${limit}`
    : sql`select id from sign_requests where pending_send = 1 order by created_at limit ${limit}`);
  const { requestRow, sendDueLinks } = await import("./esign");
  let n = 0;
  for (const { id } of rows) {
    const claim = await deps.db.run(sql`update sign_requests set pending_send = 0 where id = ${id} and pending_send = 1`);
    if (!changesOf(claim)) continue;
    const r = await requestRow(deps, id);
    if (!r || r.status !== "out") continue;
    await sendDueLinks(deps, r).then((k) => { n += k; }, (err) => deps.log?.warn("tools.esign_bulk_send_failed", { error: String(err) }));
  }
  return n;
}

/** The full record for download: every event with UTC and local time, device, IP hash and fingerprints. */
export async function recordJson(deps: Deps, r: RequestRow & { seal?: string | null; seal_key_id?: string | null }, events: { at: number; name: string; email: string; action: string; ip_country: string | null; detail: string | null; ip_hash?: string | null; user_agent?: string | null; tz?: string | null; doc_sha256?: string | null }[]) {
  const { actionText } = await import("./esign");
  const k = r.seal_key_id ? await deps.db.get<{ public_jwk: string }>(sql`select public_jwk from esign_keys where org_id = ${r.org_id}`) : null;
  return {
    title: r.title, request: r.id, status: r.status, document_sha256_before: r.source_sha256, document_sha256_after: r.final_sha256,
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
    seal: r.seal ? { algorithm: "ECDSA P-256 SHA-256", key_id: r.seal_key_id, public_key: k ? JSON.parse(k.public_jwk) : null, signed_text: sealPayload(r), signature: r.seal, valid: await sealValid(deps, { ...r, seal: r.seal ?? null, seal_key_id: r.seal_key_id ?? null }) } : null,
    consent_text: CONSENT_TEXT,
    events: events.map((e) => ({
      at_utc: new Date(e.at).toISOString(), at_local: localTime(e.at, e.tz) || null, time_zone: e.tz ?? null, who: e.name, email: e.email, what: actionText(e.action),
      detail: e.detail, ip_country: e.ip_country, ip_hash: e.ip_hash ?? null, device: deviceOf(e.user_agent) || null, user_agent: e.user_agent ?? null, document_sha256: e.doc_sha256 ?? null,
    })),
  };
}
