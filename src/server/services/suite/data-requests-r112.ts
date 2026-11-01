/**
 * R112 Part B: data requests (REPORTING_R112). A person asks for an export or deletion of what this workspace holds about them in
 * Contacts, Form answers and Bookings, matched by email. Nothing is shown until they prove the email with a one time link.
 * An admin reviews the matches, then downloads a ZIP (JSON plus CSV), sends the person a download link, or deletes with a confirm
 * step. Every action writes a log row (who, when, what kinds, counts), never the data itself. Due in 30 days.
 * Only the caller's workspace is ever read or changed; the client workspace (vv8k) is refused.
 */
import { sql } from "drizzle-orm";
import { zipSync, strToU8 } from "fflate";
import type { Deps, AuthContext } from "../../context";
import type { DB } from "../../db";
import { HttpError, notFound } from "../../lib/errors";
import { newId, randomToken, sha256Hex } from "../../lib/crypto";
import { excludedOrg } from "./doc-inbox";
import { ensureChannel, isAdmin, reportingOn } from "./reporting-r112";
import { toCsv } from "../privacy";
import {
  DATA_KINDS, DATA_LIMITS as L, DATA_KIND_LABELS, dataDueAt, isEmail, maskEmail,
  type DataKind, type DataLogRow, type DataMatchCounts, type DataRequestRow, type DataRequestStatus, type DataRequestType,
} from "@/shared/reporting-r112";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role" | "name">;
interface ReqRow {
  id: string; org_id: string; email: string; type: DataRequestType; status: DataRequestStatus; source: "public" | "admin"; created_by: string | null;
  verify_hash: string | null; verify_expires_at: number | null; verified_at: number | null; due_at: number; download_hash: string | null; download_expires_at: number | null;
  done_at: number | null; created_at: number; updated_at: number;
}
const now = (deps: Pick<Deps, "now">) => deps.now().getTime();

function assertAdmin(a: Actor) { if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only owners and admins can handle data requests."); }
async function assertOrg(deps: Deps, orgId: string) {
  if (!reportingOn(deps)) throw notFound("Page");
  if (await excludedOrg(deps.db, orgId)) throw new HttpError(403, "not_available", "Data requests aren't available for this workspace.");
}

function statusNow(r: ReqRow, t: number): DataRequestStatus {
  return r.status === "unverified" && r.verify_expires_at != null && r.verify_expires_at < t ? "expired" : r.status;
}
function rowView(r: ReqRow, t: number): DataRequestRow {
  const status = statusNow(r, t);
  return {
    id: r.id, email: r.email, masked: maskEmail(r.email), type: r.type, status, source: r.source, createdAt: Number(r.created_at), dueAt: Number(r.due_at),
    verifiedAt: r.verified_at, doneAt: r.done_at, overdue: (status === "verified" || status === "unverified") && t > Number(r.due_at),
  };
}

async function log(db: DB, e: { orgId: string; requestId: string | null; actor: Actor | null; action: string; kinds?: DataKind[]; counts?: Partial<DataMatchCounts>; t: number }) {
  const label = e.actor ? (e.actor.name || e.actor.email) : "The person";
  await db.run(sql`insert into data_request_log (id, org_id, request_id, actor_user_id, actor_label, action, kinds, counts, created_at)
    values (${newId("drl")}, ${e.orgId}, ${e.requestId}, ${e.actor?.userId ?? null}, ${label}, ${e.action}, ${JSON.stringify(e.kinds ?? [])}, ${JSON.stringify(e.counts ?? {})}, ${e.t})`);
}

async function bumpDay(db: DB, orgId: string, t: number) {
  const day = new Date(t).toISOString().slice(0, 10);
  const r = (await db.all<{ day: string; n: number }>(sql`select day, n from report_day where org_id = ${orgId} and kind = 'datareq'`))[0];
  if (r && r.day === day && Number(r.n) >= L.requestsPerDay) throw new HttpError(429, "daily_limit", "This page has taken a lot of requests today. Please try again tomorrow.");
  await db.run(sql`insert into report_day (org_id, kind, day, n) values (${orgId}, 'datareq', ${day}, 1)
    on conflict(org_id, kind) do update set n = case when report_day.day = ${day} then report_day.n + 1 else 1 end, day = ${day}`);
}

async function sendVerify(deps: Deps, r: { orgId: string; email: string; type: DataRequestType; token: string; workspace: string }) {
  const url = `${deps.config.appUrl}/data-request/verify/${r.token}`;
  const what = r.type === "export" ? "a copy of" : "deletion of";
  const { sendSystemEmail } = await import("../system-mail");
  await sendSystemEmail(deps, {
    to: r.email, orgId: r.orgId, subject: `Confirm your data request to ${r.workspace}`,
    text: `Someone asked ${r.workspace} for ${what} the data it holds about this email address.\n\nIf that was you, confirm it here (the link works for 48 hours):\n${url}\n\nIf it wasn't you, ignore this email and nothing happens.`,
    action: { label: "Confirm my request", url },
  }).catch((err) => deps.reportError?.(err, { where: "data_request_verify_email" }));
}

async function orgName(db: DB, orgId: string) {
  return (await db.all<{ name: string }>(sql`select name from organizations where id = ${orgId} limit 1`))[0]?.name ?? "this workspace";
}

async function create(deps: Deps, orgId: string, body: { email: string; type: DataRequestType }, source: "public" | "admin", actor: Actor | null) {
  const email = body.email.trim().toLowerCase();
  if (!isEmail(email) || email.length > 254) throw new HttpError(422, "validation_failed", "Enter a valid email address.");
  const t = now(deps);
  if (source === "public") await bumpDay(deps.db, orgId, t);
  const token = randomToken(24);
  const id = newId("drq");
  await deps.db.run(sql`insert into data_requests (id, org_id, email, type, status, source, created_by, verify_hash, verify_expires_at, due_at, created_at, updated_at)
    values (${id}, ${orgId}, ${email}, ${body.type}, 'unverified', ${source}, ${actor?.userId ?? null}, ${await sha256Hex(token)}, ${t + L.verifyMs}, ${dataDueAt(t)}, ${t}, ${t})`);
  await log(deps.db, { orgId, requestId: id, actor, action: source === "public" ? "requested" : "entered", kinds: [...DATA_KINDS], t });
  await sendVerify(deps, { orgId, email, type: body.type, token, workspace: await orgName(deps.db, orgId) });
  return id;
}

// ------------------------------------------------------------------ public

async function orgByPublic(deps: Deps, publicId: string) {
  if (!reportingOn(deps) || !/^[a-z0-9]{8,40}$/.test(publicId)) throw notFound("Page");
  const r = (await deps.db.all<{ org_id: string; requests_enabled: number; name: string }>(sql`select c.org_id, c.requests_enabled, o.name as name
    from report_channels c join organizations o on o.id = c.org_id where c.public_id = ${publicId} limit 1`))[0];
  if (!r || !r.requests_enabled || (await excludedOrg(deps.db, r.org_id))) throw notFound("Page");
  return r;
}
export async function publicRequestPage(deps: Deps, publicId: string) {
  const r = await orgByPublic(deps, publicId);
  return { workspace: r.name, dueDays: L.dueDays };
}
/** Always the same answer, so the page never tells anyone whether an address is known. */
export async function publicCreate(deps: Deps, publicId: string, body: { email: string; type: DataRequestType }) {
  const r = await orgByPublic(deps, publicId);
  await create(deps, r.org_id, body, "public", null);
  return { ok: true };
}

export async function verifyRequest(deps: Deps, token: string) {
  if (!reportingOn(deps) || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) throw notFound("Request");
  const r = (await deps.db.all<ReqRow>(sql`select * from data_requests where verify_hash = ${await sha256Hex(token)} limit 1`))[0];
  const t = now(deps);
  if (!r || (await excludedOrg(deps.db, r.org_id))) throw new HttpError(404, "not_found", "This link isn't valid. It may have been used already.");
  if (r.status === "unverified" && r.verify_expires_at != null && r.verify_expires_at < t) throw new HttpError(410, "expired", "This link has expired. Please make the request again.");
  if (r.status === "unverified") {
    // One time: the hash is cleared, so the same link cannot confirm twice.
    await deps.db.run(sql`update data_requests set status = 'verified', verified_at = ${t}, verify_hash = null, updated_at = ${t} where id = ${r.id}`);
    await log(deps.db, { orgId: r.org_id, requestId: r.id, actor: null, action: "email_confirmed", t });
    const admins = await deps.db.all<{ id: string }>(sql`select user_id as id from members where organization_id = ${r.org_id} and role in ('owner', 'admin') limit 20`);
    const { notify } = await import("./notify");
    for (const m of admins) await notify(deps, r.org_id, m.id, { type: "data_request.ready", entityType: "data_request", entityId: r.id, title: `A data request is ready to review (${r.type === "export" ? "export" : "delete"})`, actorName: null }).catch(() => undefined);
  }
  return { workspace: await orgName(deps.db, r.org_id), type: r.type, dueAt: Number(r.due_at) };
}

// ------------------------------------------------------------------ admin

export async function settings(deps: Deps, a: Actor) {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  const ch = await ensureChannel(deps, a.orgId);
  const r = (await deps.db.all<{ requests_enabled: number }>(sql`select requests_enabled from report_channels where org_id = ${a.orgId}`))[0];
  return { publicEnabled: !!r?.requests_enabled, url: `${deps.config.appUrl}/data-request/${ch.public_id}`, dueDays: L.dueDays };
}
export async function setSettings(deps: Deps, a: Actor, body: { publicEnabled: boolean }) {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  await ensureChannel(deps, a.orgId);
  await deps.db.run(sql`update report_channels set requests_enabled = ${body.publicEnabled ? 1 : 0}, updated_at = ${now(deps)} where org_id = ${a.orgId}`);
  return settings(deps, a);
}

export async function adminCreate(deps: Deps, a: Actor, body: { email: string; type: DataRequestType }) {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  const id = await create(deps, a.orgId, body, "admin", a);
  return getRequest(deps, a, id);
}

export async function listRequests(deps: Deps, a: Actor) {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  const rows = await deps.db.all<ReqRow>(sql`select * from data_requests where org_id = ${a.orgId} order by created_at desc limit ${L.listMax}`);
  const t = now(deps);
  return { requests: rows.map((r) => rowView(r, t)) };
}

async function reqFor(deps: Deps, a: Actor, id: string): Promise<ReqRow> {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  const r = (await deps.db.all<ReqRow>(sql`select * from data_requests where id = ${id} and org_id = ${a.orgId} limit 1`))[0];
  if (!r) throw notFound("Request");
  return r;
}

const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);
function hasEmail(v: unknown, email: string): boolean {
  if (typeof v === "string") return v.trim().toLowerCase() === email;
  if (Array.isArray(v)) return v.some((x) => hasEmail(x, email));
  if (v && typeof v === "object") return Object.values(v).some((x) => hasEmail(x, email));
  return false;
}

export interface Matches {
  contacts: { id: string; name: string; email: string; phone: string | null; title: string | null; notes: string; createdAt: number }[];
  forms: { id: string; form: string; answers: Record<string, unknown>; createdAt: number }[];
  bookings: { id: string; page: string; name: string; email: string; note: string; startsAt: number; status: string; createdAt: number }[];
}
/** Every row in this workspace that carries the email, bounded per kind. */
export async function findMatches(db: DB, orgId: string, emailIn: string): Promise<Matches> {
  const email = emailIn.trim().toLowerCase();
  const contacts = await db.all<{ id: string; name: string; email: string; phone: string | null; title: string | null; notes: string; created_at: number }>(sql`select id, name, email, phone, title, notes, created_at
    from contacts where org_id = ${orgId} and lower(email) = ${email} limit ${L.maxRows}`);
  const subs = await db.all<{ id: string; data: string; created_at: number; form: string }>(sql`select s.id, s.data, s.created_at, f.name as form
    from form_submissions s join forms f on f.id = s.form_id where s.org_id = ${orgId} and lower(s.data) like ${`%${likeEsc(email)}%`} escape '\\' order by s.created_at desc limit ${L.maxRows}`);
  const forms = subs.flatMap((s) => { try { const d = JSON.parse(s.data) as Record<string, unknown>; return hasEmail(d, email) ? [{ id: s.id, form: s.form, answers: d, createdAt: Number(s.created_at) }] : []; } catch { return []; } });
  const books = await db.all<{ id: string; page: string; name: string; email: string; note: string; starts_at: number; status: string; created_at: number }>(sql`select b.id, p.title as page, b.name, b.email, b.note, b.starts_at, b.status, b.created_at
    from bookings b join scheduling_pages p on p.id = b.page_id where b.org_id = ${orgId} and lower(b.email) = ${email} order by b.starts_at desc limit ${L.maxRows}`);
  return {
    contacts: contacts.map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, title: c.title, notes: c.notes, createdAt: Number(c.created_at) })),
    forms,
    bookings: books.map((b) => ({ id: b.id, page: b.page, name: b.name, email: b.email, note: b.note, startsAt: Number(b.starts_at), status: b.status, createdAt: Number(b.created_at) })),
  };
}
const countsOf = (m: Matches): DataMatchCounts => ({ contacts: m.contacts.length, forms: m.forms.length, bookings: m.bookings.length });

export async function getRequest(deps: Deps, a: Actor, id: string) {
  const r = await reqFor(deps, a, id);
  const t = now(deps);
  const view = rowView(r, t);
  const ready = view.status === "verified";
  // Nothing about the person is shown until they have confirmed the email.
  const matches = ready ? await findMatches(deps.db, a.orgId, r.email) : null;
  const logRows = await deps.db.all<{ id: string; request_id: string | null; actor_label: string; action: string; kinds: string; counts: string; created_at: number }>(sql`select id, request_id, actor_label, action, kinds, counts, created_at
    from data_request_log where org_id = ${a.orgId} and request_id = ${id} order by created_at, rowid limit 200`);
  return { request: view, matches, counts: matches ? countsOf(matches) : null, log: logRows.map(logView) };
}

const logView = (r: { id: string; request_id: string | null; actor_label: string; action: string; kinds: string; counts: string; created_at: number }): DataLogRow => {
  const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
  return { id: r.id, requestId: r.request_id, actor: r.actor_label, action: r.action, kinds: parse(r.kinds, []), counts: parse(r.counts, {}), createdAt: Number(r.created_at) };
};
export async function workspaceLog(deps: Deps, a: Actor) {
  assertAdmin(a); await assertOrg(deps, a.orgId);
  const rows = await deps.db.all<{ id: string; request_id: string | null; actor_label: string; action: string; kinds: string; counts: string; created_at: number }>(sql`select id, request_id, actor_label, action, kinds, counts, created_at
    from data_request_log where org_id = ${a.orgId} order by created_at desc, rowid desc limit 200`);
  return { log: rows.map(logView) };
}

/** The ZIP: data.json with everything, one CSV per kind, and a short read me. */
export function buildZip(workspace: string, email: string, m: Matches, t: number): Uint8Array {
  const flat = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "object" && v !== null ? JSON.stringify(v) : v]));
  const files: Record<string, Uint8Array> = {
    "README.txt": strToU8(`Data held by ${workspace} for ${email}\nMade ${new Date(t).toISOString()}\n\ndata.json has everything. contacts.csv, form_answers.csv and bookings.csv have the same rows as tables.\n`),
    "data.json": strToU8(JSON.stringify({ workspace, email, madeAt: new Date(t).toISOString(), contacts: m.contacts, formAnswers: m.forms, bookings: m.bookings }, null, 2)),
    "contacts.csv": strToU8(toCsv(m.contacts.map((c) => flat({ ...c, createdAt: new Date(c.createdAt).toISOString() })))),
    "form_answers.csv": strToU8(toCsv(m.forms.map((f) => flat({ id: f.id, form: f.form, createdAt: new Date(f.createdAt).toISOString(), answers: f.answers })))),
    "bookings.csv": strToU8(toCsv(m.bookings.map((b) => flat({ ...b, startsAt: new Date(b.startsAt).toISOString(), createdAt: new Date(b.createdAt).toISOString() })))),
  };
  return zipSync(files, { level: 6, mtime: new Date(t) });
}

function assertReady(r: ReqRow, t: number) {
  const s = statusNow(r, t);
  if (s !== "verified") throw new HttpError(409, "not_ready", s === "done" ? "This request is already done." : "The person hasn't confirmed their email yet.");
}

export async function exportZip(deps: Deps, a: Actor, id: string) {
  const r = await reqFor(deps, a, id);
  const t = now(deps);
  assertReady(r, t);
  const m = await findMatches(deps.db, a.orgId, r.email);
  const zip = buildZip(await orgName(deps.db, a.orgId), r.email, m, t);
  await log(deps.db, { orgId: a.orgId, requestId: id, actor: a, action: "export_downloaded", kinds: [...DATA_KINDS], counts: countsOf(m), t });
  return { zip, name: `data-request-${t}.zip` };
}

export async function sendDownloadLink(deps: Deps, a: Actor, id: string) {
  const r = await reqFor(deps, a, id);
  const t = now(deps);
  assertReady(r, t);
  if (r.type !== "export") throw new HttpError(409, "not_export", "Download links are for export requests.");
  const token = randomToken(24);
  await deps.db.run(sql`update data_requests set download_hash = ${await sha256Hex(token)}, download_expires_at = ${t + L.downloadMs}, status = 'done', done_at = ${t}, updated_at = ${t} where id = ${id}`);
  const m = await findMatches(deps.db, a.orgId, r.email);
  await log(deps.db, { orgId: a.orgId, requestId: id, actor: a, action: "download_link_sent", kinds: [...DATA_KINDS], counts: countsOf(m), t });
  const url = `${deps.config.appUrl}/data-request/download/${token}`;
  const ws = await orgName(deps.db, a.orgId);
  const { sendSystemEmail } = await import("../system-mail");
  await sendSystemEmail(deps, {
    to: r.email, orgId: a.orgId, subject: `Your data from ${ws}`,
    text: `Here is a copy of the data ${ws} holds about you, as a ZIP file (JSON and CSV).\n\nDownload it here (the link works for 7 days):\n${url}`,
    action: { label: "Download my data", url },
  }).catch((err) => deps.reportError?.(err, { where: "data_request_download_email" }));
  return getRequest(deps, a, id);
}

export async function publicDownload(deps: Deps, token: string) {
  if (!reportingOn(deps) || !/^[A-Za-z0-9_-]{16,80}$/.test(token)) throw notFound("Download");
  const r = (await deps.db.all<ReqRow>(sql`select * from data_requests where download_hash = ${await sha256Hex(token)} limit 1`))[0];
  const t = now(deps);
  if (!r || (await excludedOrg(deps.db, r.org_id))) throw new HttpError(404, "not_found", "This link isn't valid.");
  if (!r.download_expires_at || r.download_expires_at < t) throw new HttpError(410, "expired", "This link has expired. Ask the workspace to send a new one.");
  const m = await findMatches(deps.db, r.org_id, r.email);
  const zip = buildZip(await orgName(deps.db, r.org_id), r.email, m, t);
  await log(deps.db, { orgId: r.org_id, requestId: r.id, actor: null, action: "download_used", kinds: [...DATA_KINDS], counts: countsOf(m), t });
  return { zip, name: `my-data-${new Date(t).toISOString().slice(0, 10)}.zip` };
}

export async function deleteData(deps: Deps, a: Actor, id: string, body: { confirm: string; kinds?: DataKind[] }) {
  const r = await reqFor(deps, a, id);
  const t = now(deps);
  assertReady(r, t);
  if (r.type !== "delete") throw new HttpError(409, "not_delete", "This person asked for a copy, not a deletion.");
  if (body.confirm.trim().toUpperCase() !== "DELETE") throw new HttpError(422, "confirm", "Type DELETE to confirm.");
  const kinds = (body.kinds?.length ? body.kinds : [...DATA_KINDS]).filter((k) => (DATA_KINDS as readonly string[]).includes(k));
  const m = await findMatches(deps.db, a.orgId, r.email);
  const counts: Partial<DataMatchCounts> = {};
  // Every statement names this workspace, so nothing in another workspace can be touched.
  if (kinds.includes("contacts")) {
    for (const c of m.contacts) {
      await deps.db.run(sql`delete from crm_entries where org_id = ${a.orgId} and entity_type = 'contact' and entity_id = ${c.id}`);
      await deps.db.run(sql`delete from contacts where org_id = ${a.orgId} and id = ${c.id}`);
    }
    counts.contacts = m.contacts.length;
  }
  if (kinds.includes("forms")) {
    for (const f of m.forms) await deps.db.run(sql`delete from form_submissions where org_id = ${a.orgId} and id = ${f.id}`);
    counts.forms = m.forms.length;
  }
  if (kinds.includes("bookings")) {
    for (const b of m.bookings) await deps.db.run(sql`delete from bookings where org_id = ${a.orgId} and id = ${b.id}`);
    counts.bookings = m.bookings.length;
  }
  const email = r.email;
  // The request keeps a masked address once the data is gone, so the log stays useful without keeping the person's email.
  await deps.db.run(sql`update data_requests set status = 'done', done_at = ${t}, email = ${maskEmail(email)}, updated_at = ${t} where id = ${id}`);
  await log(deps.db, { orgId: a.orgId, requestId: id, actor: a, action: "deleted", kinds, counts, t });
  const ws = await orgName(deps.db, a.orgId);
  const lines = kinds.map((k) => `${DATA_KIND_LABELS[k]}: ${counts[k] ?? 0}`).join("\n");
  const { sendSystemEmail } = await import("../system-mail");
  await sendSystemEmail(deps, { to: email, orgId: a.orgId, subject: `Your data was deleted from ${ws}`, text: `As you asked, ${ws} deleted the data it held about this email address.\n\n${lines}` })
    .catch((err) => deps.reportError?.(err, { where: "data_request_deleted_email" }));
  return getRequest(deps, a, id);
}

export async function cancelRequest(deps: Deps, a: Actor, id: string) {
  const r = await reqFor(deps, a, id);
  if (r.status === "done") throw new HttpError(409, "done", "This request is already done.");
  const t = now(deps);
  await deps.db.run(sql`update data_requests set status = 'cancelled', verify_hash = null, updated_at = ${t} where id = ${id}`);
  await log(deps.db, { orgId: a.orgId, requestId: id, actor: a, action: "cancelled", t });
  return getRequest(deps, a, id);
}

export async function resendVerify(deps: Deps, a: Actor, id: string) {
  const r = await reqFor(deps, a, id);
  const t = now(deps);
  if (r.status !== "unverified") throw new HttpError(409, "not_waiting", "This request isn't waiting for an email check.");
  const token = randomToken(24);
  await deps.db.run(sql`update data_requests set verify_hash = ${await sha256Hex(token)}, verify_expires_at = ${t + L.verifyMs}, updated_at = ${t} where id = ${id}`);
  await log(deps.db, { orgId: a.orgId, requestId: id, actor: a, action: "check_resent", t });
  await sendVerify(deps, { orgId: a.orgId, email: r.email, type: r.type, token, workspace: await orgName(deps.db, a.orgId) });
  return getRequest(deps, a, id);
}
