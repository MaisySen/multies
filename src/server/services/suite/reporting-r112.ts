/**
 * R112 Part A: anonymous reporting channel (REPORTING_R112).
 *
 * An admin turns on the workspace's channel and gets a public page (/report/<public id>). A reporter writes without an account;
 * the case keeps only what they type, the times the deadlines need and a PBKDF2 hash of a passphrase shown once. With the case
 * number and passphrase they can come back, read replies and write again (two way). Wrong passphrases lock that case number for
 * a while (no IP is used). Owners and admins see every case; a member sees only the cases they are the handler of; project guests
 * and the client portal have their own sessions and never reach these routes. The client workspace (vv8k) cannot turn it on.
 */
import { sql } from "drizzle-orm";
import type { Deps, AuthContext } from "../../context";
import type { DB } from "../../db";
import { HttpError, notFound } from "../../lib/errors";
import { hashPassword, newId, randomBytes, randomToken, safeEqual, sha256Hex, verifyPassword } from "../../lib/crypto";
import { excludedOrg } from "./doc-inbox";
import { blobsFor } from "./drive-r101";
import {
  CODE_ALPHABET, REPORT_LIMITS as L, caseFlags, formatCaseNo, formatPassphrase, isReportStatus, lockMsFor, normaliseCaseNo, normalisePassphrase, reportDeadlines,
  type ReportCaseDetail, type ReportCaseRow, type ReportChannelView, type ReportFileView, type ReportMessageView, type ReportStatus, type ReporterThread,
} from "@/shared/reporting-r112";

type Actor = Pick<AuthContext, "orgId" | "userId" | "email" | "role" | "name">;
export const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";
export const reportingOn = (deps: Pick<Deps, "config">) => !!deps.config.reporting;

export interface UploadFile { name: string; type: string; bytes: Uint8Array }

interface CaseRow {
  id: string; org_id: string; case_no: string; pass_hash: string; status: ReportStatus; handler_id: string | null; summary: string; outcome: string;
  ack_due_at: number; outcome_due_at: number; acknowledged_at: number | null; closed_at: number | null; fail_count: number; locked_until: number | null;
  reader_hash: string | null; reader_expires_at: number | null; last_reporter_at: number | null; last_handler_at: number | null; handler_seen_at: number | null;
  created_at: number; updated_at: number;
}
interface MsgRow { id: string; author: "reporter" | "handler" | "system"; user_id: string | null; internal: number; body: string; files: string; created_at: number }
interface ChannelRow { org_id: string; public_id: string; enabled: number; intro: string; default_handler_id: string | null }

/** Random characters from the code alphabet without modulo bias (bytes at or above 248 are skipped). */
export function randomCode(n: number): Uint8Array {
  const out: number[] = [];
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < n) for (const b of randomBytes(n * 2)) { if (b < max && out.length < n) out.push(b); }
  return Uint8Array.from(out);
}

const now = (deps: Pick<Deps, "now">) => deps.now().getTime();
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

// ------------------------------------------------------------------ channel

async function channelRow(db: DB, orgId: string): Promise<ChannelRow | null> {
  return (await db.all<ChannelRow>(sql`select org_id, public_id, enabled, intro, default_handler_id from report_channels where org_id = ${orgId} limit 1`))[0] ?? null;
}
async function channelByPublic(deps: Deps, publicId: string): Promise<ChannelRow & { name: string }> {
  if (!reportingOn(deps) || !/^[a-z0-9]{8,40}$/.test(publicId)) throw notFound("Page");
  const r = (await deps.db.all<ChannelRow & { name: string }>(sql`select c.org_id, c.public_id, c.enabled, c.intro, c.default_handler_id, o.name as name
    from report_channels c join organizations o on o.id = c.org_id where c.public_id = ${publicId} limit 1`))[0];
  if (!r || !r.enabled || (await excludedOrg(deps.db, r.org_id))) throw notFound("Page");
  return r;
}
const urls = (deps: Pick<Deps, "config">, publicId: string | null) => ({
  url: publicId ? `${deps.config.appUrl}/report/${publicId}` : null,
  dataRequestUrl: publicId ? `${deps.config.appUrl}/data-request/${publicId}` : null,
});

export async function getChannel(deps: Deps, a: Actor): Promise<ReportChannelView> {
  const excluded = await excludedOrg(deps.db, a.orgId);
  const r = await channelRow(deps.db, a.orgId);
  return { enabled: !!r?.enabled && !excluded, publicId: r?.public_id ?? null, ...urls(deps, r?.public_id ?? null), intro: r?.intro ?? "", defaultHandlerId: r?.default_handler_id ?? null, excluded };
}

/** The workspace's public id, made the first time either page is used (Part B reuses it). */
export async function ensureChannel(deps: Deps, orgId: string): Promise<ChannelRow> {
  const have = await channelRow(deps.db, orgId);
  if (have) return have;
  const t = now(deps);
  const publicId = randomToken(12).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(12, "x");
  await deps.db.run(sql`insert into report_channels (org_id, public_id, enabled, intro, default_handler_id, created_at, updated_at)
    values (${orgId}, ${publicId}, 0, '', null, ${t}, ${t}) on conflict(org_id) do nothing`);
  return (await channelRow(deps.db, orgId))!;
}

export async function setChannel(deps: Deps, a: Actor, body: { enabled?: boolean; intro?: string; defaultHandlerId?: string | null }): Promise<ReportChannelView> {
  if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only owners and admins can change the reporting channel.");
  if (await excludedOrg(deps.db, a.orgId)) throw new HttpError(403, "not_available", "The reporting channel isn't available for this workspace.");
  const ch = await ensureChannel(deps, a.orgId);
  if (body.defaultHandlerId) await assertMember(deps.db, a.orgId, body.defaultHandlerId);
  const t = now(deps);
  await deps.db.run(sql`update report_channels set
      enabled = ${body.enabled === undefined ? ch.enabled : body.enabled ? 1 : 0},
      intro = ${body.intro === undefined ? ch.intro : body.intro.trim().slice(0, 2000)},
      default_handler_id = ${body.defaultHandlerId === undefined ? ch.default_handler_id : body.defaultHandlerId},
      updated_at = ${t}
    where org_id = ${a.orgId}`);
  return getChannel(deps, a);
}

async function members(db: DB, orgId: string) {
  return db.all<{ id: string; name: string; email: string; role: string }>(sql`select u.id as id, u.name as name, u.email as email, m.role as role
    from members m join users u on u.id = m.user_id where m.organization_id = ${orgId} order by u.name limit 500`);
}
async function assertMember(db: DB, orgId: string, userId: string) {
  const r = await db.all<{ n: number }>(sql`select count(*) as n from members where organization_id = ${orgId} and user_id = ${userId}`);
  if (!Number(r[0]?.n)) throw new HttpError(422, "validation_failed", "Pick someone in this workspace.");
}
export async function handlerChoices(deps: Deps, a: Actor) {
  if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only owners and admins can assign handlers.");
  return (await members(deps.db, a.orgId)).map((m) => ({ id: m.id, name: m.name || m.email, role: m.role }));
}

/** What the Forms page needs to decide whether to show the Reports tab. Never throws for a member. */
export async function access(deps: Deps, a: Actor) {
  if (!reportingOn(deps) || (await excludedOrg(deps.db, a.orgId))) return { canSee: false, isAdmin: false, assigned: 0 };
  if (isAdmin(a)) return { canSee: true, isAdmin: true, assigned: 0 };
  const r = await deps.db.all<{ n: number }>(sql`select count(*) as n from report_cases where org_id = ${a.orgId} and handler_id = ${a.userId}`);
  const n = Number(r[0]?.n ?? 0);
  return { canSee: n > 0, isAdmin: false, assigned: n };
}

// ------------------------------------------------------------------ public side (no session, no IP, no user agent)

export async function publicChannel(deps: Deps, publicId: string) {
  const ch = await channelByPublic(deps, publicId);
  return { workspace: ch.name, intro: ch.intro, limits: { files: L.filesPerMessage, fileBytes: L.fileBytes, chars: L.bodyChars } };
}

async function bumpDay(db: DB, orgId: string, kind: string, t: number, cap: number) {
  const day = dayOf(t);
  const r = (await db.all<{ day: string; n: number }>(sql`select day, n from report_day where org_id = ${orgId} and kind = ${kind}`))[0];
  const n = r && r.day === day ? Number(r.n) : 0;
  if (n >= cap) throw new HttpError(429, "daily_limit", "This page has taken a lot of reports today. Please try again tomorrow.");
  await db.run(sql`insert into report_day (org_id, kind, day, n) values (${orgId}, ${kind}, ${day}, 1)
    on conflict(org_id, kind) do update set n = case when report_day.day = ${day} then report_day.n + 1 else 1 end, day = ${day}`);
}

function checkFiles(files: UploadFile[], already: number) {
  if (files.length > L.filesPerMessage) throw new HttpError(422, "too_many_files", `You can attach up to ${L.filesPerMessage} files at a time.`);
  if (already + files.length > L.filesPerCase) throw new HttpError(422, "too_many_files", `A report can hold up to ${L.filesPerCase} files.`);
  for (const f of files) if (f.bytes.length > L.fileBytes) throw new HttpError(413, "file_too_large", `Files can be up to ${Math.round(L.fileBytes / (1024 * 1024))} MB here.`);
}
const cleanName = (n: string) => n.replace(/[\\/\u0000-\u001f]/g, "").trim().slice(0, 160) || "file";

async function saveFiles(deps: Deps, orgId: string, caseId: string, files: UploadFile[], t: number): Promise<ReportFileView[]> {
  const out: ReportFileView[] = [];
  for (const f of files) {
    const id = newId("rpf");
    const key = `report/${orgId}/${id}`;
    const type = (f.type || "application/octet-stream").slice(0, 120);
    const parts = await blobsFor(deps).put(key, f.bytes, type);
    const name = cleanName(f.name);
    await deps.db.run(sql`insert into report_files (id, case_id, org_id, blob_key, parts, name, content_type, size, created_at)
      values (${id}, ${caseId}, ${orgId}, ${key}, ${parts}, ${name}, ${type}, ${f.bytes.length}, ${t})`);
    out.push({ id, name, size: f.bytes.length, type });
  }
  return out;
}

async function addMessage(db: DB, m: { caseId: string; orgId: string; author: "reporter" | "handler" | "system"; userId: string | null; internal: boolean; body: string; files: ReportFileView[]; t: number }) {
  await db.run(sql`insert into report_messages (id, case_id, org_id, author, user_id, internal, body, files, created_at)
    values (${newId("rpm")}, ${m.caseId}, ${m.orgId}, ${m.author}, ${m.userId}, ${m.internal ? 1 : 0}, ${m.body}, ${JSON.stringify(m.files)}, ${m.t})`);
}

export function composeReport(b: { what: string; when?: string; where?: string; who?: string }): string {
  const parts = [b.what.trim()];
  if (b.when?.trim()) parts.push(`When: ${b.when.trim()}`);
  if (b.where?.trim()) parts.push(`Where: ${b.where.trim()}`);
  if (b.who?.trim()) parts.push(`Who was involved: ${b.who.trim()}`);
  return parts.join("\n\n").slice(0, L.bodyChars + 1200);
}

async function notifyHandlers(deps: Deps, orgId: string, handlerId: string | null, caseId: string, title: string) {
  const ids = new Set<string>();
  if (handlerId) ids.add(handlerId);
  else for (const m of await members(deps.db, orgId)) if (m.role === "owner" || m.role === "admin") ids.add(m.id);
  const { notify } = await import("./notify");
  for (const id of [...ids].slice(0, 20)) await notify(deps, orgId, id, { type: "report.case", entityType: "report_case", entityId: caseId, title, actorName: null }).catch(() => undefined);
}

export async function submitReport(deps: Deps, publicId: string, body: { what: string; when?: string; where?: string; who?: string }, files: UploadFile[]) {
  const ch = await channelByPublic(deps, publicId);
  const what = body.what.trim();
  if (what.length < 10) throw new HttpError(422, "validation_failed", "Tell us a little more about what happened.");
  if (what.length > L.bodyChars) throw new HttpError(422, "validation_failed", `Please keep it under ${L.bodyChars.toLocaleString("en-AU")} characters.`);
  checkFiles(files, 0);
  const t = now(deps);
  await bumpDay(deps.db, ch.org_id, "report", t, L.reportsPerDay);
  const passphrase = formatPassphrase(randomCode(20));
  const passHash = await hashPassword(passphrase);
  const id = newId("rpc");
  const { ackDueAt, outcomeDueAt } = reportDeadlines(t);
  let caseNo = "";
  for (let i = 0; i < 5 && !caseNo; i++) {
    const tryNo = formatCaseNo(randomCode(8));
    const taken = await deps.db.all<{ n: number }>(sql`select count(*) as n from report_cases where case_no = ${tryNo}`);
    if (!Number(taken[0]?.n)) caseNo = tryNo;
  }
  if (!caseNo) throw new HttpError(503, "busy", "Please try again.");
  const summary = what.replace(/\s+/g, " ").slice(0, 140);
  await deps.db.run(sql`insert into report_cases (id, org_id, case_no, pass_hash, status, handler_id, summary, outcome, ack_due_at, outcome_due_at, fail_count, last_reporter_at, created_at, updated_at)
    values (${id}, ${ch.org_id}, ${caseNo}, ${passHash}, 'new', ${ch.default_handler_id}, ${summary}, '', ${ackDueAt}, ${outcomeDueAt}, 0, ${t}, ${t}, ${t})`);
  const saved = await saveFiles(deps, ch.org_id, id, files, t);
  await addMessage(deps.db, { caseId: id, orgId: ch.org_id, author: "reporter", userId: null, internal: false, body: composeReport(body), files: saved, t });
  // The notice says a report arrived and its number, never what it says.
  await notifyHandlers(deps, ch.org_id, ch.default_handler_id, id, `New anonymous report ${caseNo}`);
  return { caseNo, passphrase };
}

let dummyHash: Promise<string> | null = null;
/** Signs a reporter in with the case number and passphrase. The same answer and about the same time for an unknown number. */
export async function reporterLogin(deps: Deps, publicId: string, caseNoIn: string, passIn: string) {
  const ch = await channelByPublic(deps, publicId);
  const caseNo = normaliseCaseNo(caseNoIn);
  const pass = normalisePassphrase(passIn);
  const wrong = () => new HttpError(401, "wrong_details", "That case number and passphrase don't match. Check both and try again.");
  const t = now(deps);
  const c = caseNo ? (await deps.db.all<CaseRow>(sql`select * from report_cases where case_no = ${caseNo} and org_id = ${ch.org_id} limit 1`))[0] : undefined;
  if (!c) {
    dummyHash ??= hashPassword("not a real passphrase");
    await verifyPassword(pass, await dummyHash);
    throw wrong();
  }
  if (c.locked_until && c.locked_until > t) {
    const mins = Math.max(1, Math.ceil((c.locked_until - t) / 60_000));
    throw new HttpError(429, "locked", `Too many tries. Try again in ${mins} ${mins === 1 ? "minute" : "minutes"}.`);
  }
  if (!(await verifyPassword(pass, c.pass_hash))) {
    const fails = Number(c.fail_count) + 1;
    const lock = lockMsFor(fails);
    await deps.db.run(sql`update report_cases set fail_count = ${fails}, locked_until = ${lock && fails % L.maxTries === 0 ? t + lock : c.locked_until} where id = ${c.id}`);
    throw wrong();
  }
  const token = randomToken(24);
  await deps.db.run(sql`update report_cases set fail_count = 0, locked_until = null, reader_hash = ${await sha256Hex(token)}, reader_expires_at = ${t + L.readerMs} where id = ${c.id}`);
  return { token, caseNo: c.case_no, thread: await threadFor(deps, c, ch.name) };
}

async function caseForReader(deps: Deps, publicId: string, caseNoIn: string, token: string): Promise<{ c: CaseRow; workspace: string }> {
  const ch = await channelByPublic(deps, publicId);
  const caseNo = normaliseCaseNo(caseNoIn);
  const c = caseNo ? (await deps.db.all<CaseRow>(sql`select * from report_cases where case_no = ${caseNo} and org_id = ${ch.org_id} limit 1`))[0] : undefined;
  const ok = !!c && !!c.reader_hash && !!c.reader_expires_at && c.reader_expires_at > now(deps) && safeEqual(c.reader_hash, await sha256Hex(token || "x"));
  if (!ok || !c) throw new HttpError(401, "signed_out", "You were signed out of this report. Enter your case number and passphrase again.");
  return { c, workspace: ch.name };
}

async function messagesFor(db: DB, caseId: string, includeInternal: boolean): Promise<ReportMessageView[]> {
  const rows = await db.all<MsgRow & { author_name: string | null }>(sql`select m.id, m.author, m.user_id, m.internal, m.body, m.files, m.created_at, u.name as author_name
    from report_messages m left join users u on u.id = m.user_id where m.case_id = ${caseId} ${includeInternal ? sql`` : sql`and m.internal = 0`} order by m.created_at, m.id limit 1000`);
  return rows.map((r) => ({
    id: r.id, author: r.author, internal: !!r.internal, body: r.body, createdAt: Number(r.created_at),
    // A reporter sees "Handler", not a name: the team can choose to sign their replies.
    authorName: includeInternal && r.author === "handler" ? r.author_name : null,
    files: safeFiles(r.files),
  }));
}
const safeFiles = (s: string): ReportFileView[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };

async function threadFor(deps: Deps, c: CaseRow, workspace: string): Promise<ReporterThread> {
  return {
    caseNo: c.case_no, status: c.status, createdAt: Number(c.created_at), acknowledgedAt: c.acknowledged_at, closedAt: c.closed_at, outcome: c.outcome, workspace,
    messages: await messagesFor(deps.db, c.id, false),
  };
}

export async function reporterThread(deps: Deps, publicId: string, caseNo: string, token: string) {
  const { c, workspace } = await caseForReader(deps, publicId, caseNo, token);
  return { thread: await threadFor(deps, c, workspace) };
}

export async function reporterReply(deps: Deps, publicId: string, caseNo: string, token: string, body: string, files: UploadFile[]) {
  const { c, workspace } = await caseForReader(deps, publicId, caseNo, token);
  const text = body.trim();
  if (!text && !files.length) throw new HttpError(422, "validation_failed", "Write a message or attach a file.");
  if (text.length > L.replyChars) throw new HttpError(422, "validation_failed", `Please keep it under ${L.replyChars.toLocaleString("en-AU")} characters.`);
  const have = await deps.db.all<{ n: number }>(sql`select count(*) as n from report_files where case_id = ${c.id}`);
  checkFiles(files, Number(have[0]?.n ?? 0));
  const t = now(deps);
  const saved = await saveFiles(deps, c.org_id, c.id, files, t);
  await addMessage(deps.db, { caseId: c.id, orgId: c.org_id, author: "reporter", userId: null, internal: false, body: text, files: saved, t });
  await deps.db.run(sql`update report_cases set last_reporter_at = ${t}, updated_at = ${t} where id = ${c.id}`);
  await notifyHandlers(deps, c.org_id, c.handler_id, c.id, `New message on report ${c.case_no}`);
  return { thread: await threadFor(deps, { ...c, last_reporter_at: t }, workspace) };
}

async function fileOf(db: DB, caseId: string, fileId: string, includeInternal: boolean) {
  const f = (await db.all<{ id: string; blob_key: string; parts: number; name: string; content_type: string; size: number }>(sql`select id, blob_key, parts, name, content_type, size from report_files where id = ${fileId} and case_id = ${caseId} limit 1`))[0];
  if (!f) throw notFound("File");
  if (!includeInternal) {
    // A reporter only gets files on messages they can see.
    const seen = await db.all<{ files: string }>(sql`select files from report_messages where case_id = ${caseId} and internal = 0`);
    if (!seen.some((m) => safeFiles(m.files).some((x) => x.id === fileId))) throw notFound("File");
  }
  return f;
}
export async function reporterFile(deps: Deps, publicId: string, caseNo: string, token: string, fileId: string) {
  const { c } = await caseForReader(deps, publicId, caseNo, token);
  const f = await fileOf(deps.db, c.id, fileId, false);
  return { name: f.name, size: Number(f.size), stream: blobsFor(deps).read(f.blob_key, Number(f.parts), Number(f.size)) };
}

// ------------------------------------------------------------------ handler side

async function caseFor(deps: Deps, a: Actor, id: string): Promise<CaseRow> {
  if (await excludedOrg(deps.db, a.orgId)) throw notFound("Report");
  const c = (await deps.db.all<CaseRow>(sql`select * from report_cases where id = ${id} and org_id = ${a.orgId} limit 1`))[0];
  if (!c || (!isAdmin(a) && c.handler_id !== a.userId)) throw notFound("Report");
  return c;
}

function rowView(c: CaseRow & { handler_name?: string | null }, t: number): ReportCaseRow {
  const base = { status: c.status, ackDueAt: Number(c.ack_due_at), outcomeDueAt: Number(c.outcome_due_at), acknowledgedAt: c.acknowledged_at, closedAt: c.closed_at };
  return {
    id: c.id, caseNo: c.case_no, ...base, handlerId: c.handler_id, handlerName: c.handler_name ?? null, summary: c.summary, createdAt: Number(c.created_at),
    lastReporterAt: c.last_reporter_at, unread: !!c.last_reporter_at && (!c.handler_seen_at || c.last_reporter_at > c.handler_seen_at), ...caseFlags(base, t),
  };
}

export async function listCases(deps: Deps, a: Actor, view: "open" | "new" | "closed" | "mine" | "all") {
  if (await excludedOrg(deps.db, a.orgId)) return { cases: [] as ReportCaseRow[], counts: { open: 0, new: 0, closed: 0, mine: 0, overdue: 0 } };
  const scope = isAdmin(a) ? sql`` : sql`and c.handler_id = ${a.userId}`;
  const rows = await deps.db.all<CaseRow & { handler_name: string | null }>(sql`select c.id, c.case_no, c.status, c.handler_id, c.summary, c.ack_due_at, c.outcome_due_at, c.acknowledged_at, c.closed_at,
      c.last_reporter_at, c.handler_seen_at, c.created_at, u.name as handler_name
    from report_cases c left join users u on u.id = c.handler_id where c.org_id = ${a.orgId} ${scope} order by c.created_at desc limit ${L.listMax}`);
  const t = now(deps);
  const all = rows.map((r) => rowView(r, t));
  const counts = {
    open: all.filter((c) => c.status !== "closed").length, new: all.filter((c) => c.status === "new").length, closed: all.filter((c) => c.status === "closed").length,
    mine: all.filter((c) => c.handlerId === a.userId).length, overdue: all.filter((c) => c.ackOverdue || c.outcomeOverdue).length,
  };
  const pick = view === "new" ? all.filter((c) => c.status === "new") : view === "closed" ? all.filter((c) => c.status === "closed") : view === "mine" ? all.filter((c) => c.handlerId === a.userId) : view === "all" ? all : all.filter((c) => c.status !== "closed");
  return { cases: pick, counts };
}

export async function getCase(deps: Deps, a: Actor, id: string): Promise<ReportCaseDetail> {
  const c = await caseFor(deps, a, id);
  const t = now(deps);
  await deps.db.run(sql`update report_cases set handler_seen_at = ${t} where id = ${c.id}`);
  const hn = c.handler_id ? (await deps.db.all<{ name: string }>(sql`select name from users where id = ${c.handler_id} limit 1`))[0]?.name ?? null : null;
  return { ...rowView({ ...c, handler_seen_at: t, handler_name: hn }, t), outcome: c.outcome, messages: await messagesFor(deps.db, c.id, true) };
}

export async function handlerReply(deps: Deps, a: Actor, id: string, body: { text: string; internal?: boolean }, files: UploadFile[]) {
  const c = await caseFor(deps, a, id);
  const text = body.text.trim();
  if (!text && !files.length) throw new HttpError(422, "validation_failed", "Write a message or attach a file.");
  if (text.length > L.replyChars) throw new HttpError(422, "validation_failed", `Please keep it under ${L.replyChars.toLocaleString("en-AU")} characters.`);
  const have = await deps.db.all<{ n: number }>(sql`select count(*) as n from report_files where case_id = ${c.id}`);
  checkFiles(files, Number(have[0]?.n ?? 0));
  const t = now(deps);
  const saved = await saveFiles(deps, c.org_id, c.id, files, t);
  await addMessage(deps.db, { caseId: c.id, orgId: c.org_id, author: "handler", userId: a.userId, internal: !!body.internal, body: text, files: saved, t });
  // The first reply the reporter can see counts as the acknowledgement.
  const ack = !body.internal && c.status === "new";
  await deps.db.run(sql`update report_cases set updated_at = ${t}, handler_seen_at = ${t}
      ${body.internal ? sql`` : sql`, last_handler_at = ${t}`}
      ${ack ? sql`, status = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, ${t})` : sql``}
    where id = ${c.id}`);
  return getCase(deps, a, id);
}

export async function updateCase(deps: Deps, a: Actor, id: string, body: { status?: ReportStatus; handlerId?: string | null; outcome?: string }) {
  const c = await caseFor(deps, a, id);
  const t = now(deps);
  if (body.handlerId !== undefined) {
    if (!isAdmin(a)) throw new HttpError(403, "forbidden", "Only owners and admins can assign a handler.");
    if (body.handlerId) await assertMember(deps.db, a.orgId, body.handlerId);
    await deps.db.run(sql`update report_cases set handler_id = ${body.handlerId}, updated_at = ${t} where id = ${c.id}`);
    await addMessage(deps.db, { caseId: c.id, orgId: c.org_id, author: "system", userId: a.userId, internal: true, body: body.handlerId ? "Handler changed." : "Handler removed.", files: [], t });
    if (body.handlerId && body.handlerId !== a.userId) await notifyHandlers(deps, c.org_id, body.handlerId, c.id, `You're the handler for report ${c.case_no}`);
  }
  if (body.outcome !== undefined) {
    await deps.db.run(sql`update report_cases set outcome = ${body.outcome.trim().slice(0, 4000)}, updated_at = ${t} where id = ${c.id}`);
  }
  if (body.status !== undefined && body.status !== c.status) {
    if (!isReportStatus(body.status)) throw new HttpError(422, "validation_failed", "Unknown status.");
    const s = body.status;
    await deps.db.run(sql`update report_cases set status = ${s}, updated_at = ${t},
        acknowledged_at = ${s === "new" ? c.acknowledged_at : c.acknowledged_at ?? t},
        closed_at = ${s === "closed" ? t : null}
      where id = ${c.id}`);
    const words: Record<ReportStatus, string> = { new: "Your report is waiting to be read.", acknowledged: "Your report has been received and read.", investigating: "Your report is being looked into.", closed: "This report is closed." };
    await addMessage(deps.db, { caseId: c.id, orgId: c.org_id, author: "system", userId: a.userId, internal: false, body: words[s], files: [], t });
  }
  return getCase(deps, a, id);
}

export async function handlerFile(deps: Deps, a: Actor, id: string, fileId: string) {
  const c = await caseFor(deps, a, id);
  const f = await fileOf(deps.db, c.id, fileId, true);
  return { name: f.name, size: Number(f.size), stream: blobsFor(deps).read(f.blob_key, Number(f.parts), Number(f.size)) };
}
