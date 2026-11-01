/**
 * R120: client portals. Team side (signed in workspace members) and client side (a person on the portal's list,
 * signed in with a one time email link). Every client read is bound to one portal: the session row names the
 * portal and the person, and every item read checks the item's portal. Files live in the kept files store (plan
 * caps hold); file requests are R88 requests; docs and tasks are read live so the client sees today's state.
 */
import { and, count, eq, gt, like, sql } from "drizzle-orm";
import { auditLogs } from "../../db/schema";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, forbidden, notFound, tooMany } from "../../lib/errors";
import { decryptSecret, encryptSecret, newId, randomToken, sha256Hex } from "../../lib/crypto";
import { audit } from "../audit";
import { sendSystemEmail } from "../system-mail";
import { notify } from "../suite/notify";
import { changesOf, dropKeptFiles, keepFile, readKeptFile } from "../tools/kept-files";
import { cleanName } from "../tools/share";
import { createRequest, setRequestOpen } from "../tools/file-requests";
import {
  PORTAL_COPY_LINKS_PER_HOUR, PORTAL_FILE_KEEP_DAYS, PORTAL_LINKS_PER_HOUR, PORTAL_LINK_MINUTES, PORTAL_MAIL_EVERY_MS, PORTAL_MAX_ITEMS, PORTAL_MAX_PEOPLE, PORTAL_MESSAGE_MAX,
  PORTAL_SESSION_DAYS, cleanFolder, emailOk, type PortalDetail, type PortalItem, type PortalItemKind, type PortalMessage, type PortalPerson,
  type PortalSummary, type PortalTaskState,
} from "@/shared/client-portal";

export interface PortalRow {
  id: string; org_id: string; key: string; name: string; contact_id: string | null; company_id: string | null; welcome: string | null;
  show_brand: number; created_by: string; created_at: number; updated_at: number; last_client_at: number | null; team_seen_at: number | null;
  team_notified_at: number | null; client_notified_at: number | null; archived_at: number | null;
}
interface PersonRow { id: string; portal_id: string; org_id: string; email: string; name: string | null; contact_id: string | null; created_at: number; last_seen_at: number | null; removed_at: number | null }
interface ItemRow { id: string; portal_id: string; org_id: string; kind: PortalItemKind; ref_id: string; title: string; folder: string | null; bytes: number | null; content_type: string | null; token_enc: string | null; created_at: number; removed_at: number | null }
interface MessageRow { id: string; from_client: number; author: string; body: string; created_at: number }

const iso = (ms: number) => new Date(ms).toISOString();
// eslint-disable-next-line no-control-regex
const oneLine = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const base = (deps: Deps) => deps.config.appUrl.replace(/\/$/, "");
export const portalUrl = (deps: Deps, key: string) => `${base(deps)}/p/${key}`;
export const keyShapeOk = (k: string) => /^[A-Za-z0-9_-]{22}$/.test(k);
export const linkShapeOk = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

/** Owners and admins manage every portal; a member manages the portals they made. Everyone in the workspace can read and reply. */
export const canManage = (auth: AuthContext, p: Pick<PortalRow, "created_by">) => auth.role !== "member" || p.created_by === auth.userId;

async function portalOf(deps: Deps, auth: AuthContext, id: string): Promise<PortalRow> {
  const p = await deps.db.get<PortalRow>(sql`select * from client_portals where id = ${id} and org_id = ${auth.orgId}`);
  if (!p) throw notFound("Portal");
  return p;
}
async function managed(deps: Deps, auth: AuthContext, id: string): Promise<PortalRow> {
  const p = await portalOf(deps, auth, id);
  if (!canManage(auth, p)) throw forbidden("Only the person who made this portal or an admin can change it.");
  return p;
}
const touch = (deps: Deps, id: string) => deps.db.run(sql`update client_portals set updated_at = ${deps.now().getTime()} where id = ${id}`);

type SummaryRow = PortalRow & { contact_name: string | null; contact_email: string | null; company_name: string | null; people: number };
function summary(deps: Deps, auth: AuthContext, r: SummaryRow): PortalSummary {
  return {
    id: r.id, name: r.name, url: portalUrl(deps, r.key),
    contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || r.contact_email || "Contact" } : null,
    company: r.company_id ? { id: r.company_id, name: r.company_name || "Company" } : null,
    people: Number(r.people ?? 0), unread: !!r.last_client_at && r.last_client_at > (r.team_seen_at ?? 0),
    lastActivityAt: iso(r.updated_at), archived: !!r.archived_at, mine: r.created_by === auth.userId,
  };
}
const SUMMARY_SQL = sql`select p.*, c.name as contact_name, c.email as contact_email, co.name as company_name,
  (select count(*) from client_portal_people pp where pp.portal_id = p.id and pp.removed_at is null) as people
  from client_portals p left join contacts c on c.id = p.contact_id and c.org_id = p.org_id left join companies co on co.id = p.company_id and co.org_id = p.org_id`;

export async function listPortals(deps: Deps, auth: AuthContext, q: { contactId?: string; companyId?: string } = {}): Promise<PortalSummary[]> {
  const rows = await deps.db.all<SummaryRow>(sql`${SUMMARY_SQL} where p.org_id = ${auth.orgId}
    ${q.contactId ? sql`and p.contact_id = ${q.contactId}` : sql``} ${q.companyId ? sql`and p.company_id = ${q.companyId}` : sql``}
    order by p.archived_at is not null, p.updated_at desc limit 200`);
  return rows.map((r) => summary(deps, auth, r));
}

export interface NewPortal { contactId?: string | null; companyId?: string | null; name?: string | null; welcome?: string | null }

/** One live portal per contact or company: asking again answers the one that exists. */
export async function createPortal(deps: Deps, auth: AuthContext, input: NewPortal): Promise<{ portal: PortalSummary; existing: boolean }> {
  if (!!input.contactId === !!input.companyId) throw badRequest("Choose a person or a company for the portal.");
  const now = deps.now().getTime();
  let name = oneLine(input.name, 120);
  const people: { email: string; name: string | null; contactId: string }[] = [];
  if (input.contactId) {
    const c = await deps.db.get<{ id: string; name: string | null; email: string }>(sql`select id, name, email from contacts where id = ${input.contactId} and org_id = ${auth.orgId}`);
    if (!c) throw notFound("Contact");
    const had = await deps.db.get<{ id: string }>(sql`select id from client_portals where org_id = ${auth.orgId} and contact_id = ${c.id} and archived_at is null limit 1`);
    if (had) return { portal: await one(deps, auth, had.id), existing: true };
    name ||= c.name || c.email;
    if (emailOk(c.email)) people.push({ email: c.email.toLowerCase(), name: c.name, contactId: c.id });
  } else {
    const co = await deps.db.get<{ id: string; name: string }>(sql`select id, name from companies where id = ${input.companyId!} and org_id = ${auth.orgId}`);
    if (!co) throw notFound("Company");
    const had = await deps.db.get<{ id: string }>(sql`select id from client_portals where org_id = ${auth.orgId} and company_id = ${co.id} and archived_at is null limit 1`);
    if (had) return { portal: await one(deps, auth, had.id), existing: true };
    name ||= co.name;
    const cs = await deps.db.all<{ id: string; name: string | null; email: string }>(sql`select id, name, email from contacts where org_id = ${auth.orgId} and company_id = ${co.id} order by last_contact_at desc limit 10`);
    for (const c of cs) if (emailOk(c.email)) people.push({ email: c.email.toLowerCase(), name: c.name, contactId: c.id });
  }
  const id = newId("ptl");
  await deps.db.run(sql`insert into client_portals (id, org_id, key, name, contact_id, company_id, welcome, show_brand, created_by, created_at, updated_at)
    values (${id}, ${auth.orgId}, ${randomToken(16)}, ${name.slice(0, 120)}, ${input.contactId ?? null}, ${input.companyId ?? null}, ${oneLine(input.welcome, 1000) || null}, 1, ${auth.userId}, ${now}, ${now})`);
  for (const p of people) {
    await deps.db.run(sql`insert or ignore into client_portal_people (id, portal_id, org_id, email, name, contact_id, added_by, created_at)
      values (${newId("ptp")}, ${id}, ${auth.orgId}, ${p.email}, ${p.name}, ${p.contactId}, ${auth.userId}, ${now})`);
  }
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "portal.created", targetType: "client_portal", targetId: id });
  return { portal: await one(deps, auth, id), existing: false };
}

async function one(deps: Deps, auth: AuthContext, id: string): Promise<PortalSummary> {
  const r = await deps.db.get<SummaryRow>(sql`${SUMMARY_SQL} where p.id = ${id} and p.org_id = ${auth.orgId}`);
  if (!r) throw notFound("Portal");
  return summary(deps, auth, r);
}

/** Items with their live state: tasks and requests are read now, deleted sources show as no longer available. */
async function itemsOf(deps: Deps, p: PortalRow): Promise<PortalItem[]> {
  const rows = await deps.db.all<ItemRow>(sql`select * from client_portal_items where portal_id = ${p.id} and removed_at is null order by created_at desc limit ${PORTAL_MAX_ITEMS}`);
  const ids = (k: PortalItemKind) => rows.filter((r) => r.kind === k).map((r) => r.ref_id);
  const now = deps.now().getTime();
  const inList = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);
  const tasks = ids("task").length ? await deps.db.all<{ id: string; status: PortalTaskState; due_at: number | null; title: string }>(sql`select id, status, due_at, title from tasks where org_id = ${p.org_id} and deleted_at is null and id in (${inList(ids("task"))})`) : [];
  const docs = ids("doc").length ? await deps.db.all<{ id: string; title: string }>(sql`select id, title from docs where org_id = ${p.org_id} and deleted_at is null and id in (${inList(ids("doc"))})`) : [];
  const reqs = ids("request").length ? await deps.db.all<{ id: string; uploads: number; closed_at: number | null; expires_at: number }>(sql`select id, uploads, closed_at, expires_at from tool_file_requests where org_id = ${p.org_id} and id in (${inList(ids("request"))})`) : [];
  const files = ids("file").length ? await deps.db.all<{ id: string }>(sql`select id from tool_files where org_id = ${p.org_id} and deleted_at is null and expires_at > ${now} and id in (${inList(ids("file"))})`) : [];
  return rows.map((r) => {
    const base = { id: r.id, kind: r.kind, refId: r.ref_id, title: r.title, folder: r.folder, bytes: r.bytes, addedAt: iso(r.created_at) };
    if (r.kind === "task") { const t = tasks.find((x) => x.id === r.ref_id); return { ...base, title: t?.title ?? r.title, state: t?.status ?? null, due: t?.due_at ? iso(t.due_at) : null, live: !!t }; }
    if (r.kind === "doc") { const d = docs.find((x) => x.id === r.ref_id); return { ...base, title: d?.title || r.title, live: !!d }; }
    if (r.kind === "request") { const q = reqs.find((x) => x.id === r.ref_id); return { ...base, open: !!q && !q.closed_at && q.expires_at > now, received: q?.uploads ?? 0, live: !!q }; }
    return { ...base, live: files.some((x) => x.id === r.ref_id) };
  });
}

async function messagesOf(deps: Deps, portalId: string, limit = 200): Promise<PortalMessage[]> {
  const rows = await deps.db.all<MessageRow>(sql`select id, from_client, author, body, created_at from client_portal_messages where portal_id = ${portalId} order by created_at desc limit ${limit}`);
  return rows.reverse().map((m) => ({ id: m.id, fromClient: !!m.from_client, author: m.author, body: m.body, at: iso(m.created_at) }));
}

const personOut = (r: PersonRow): PortalPerson => ({ id: r.id, email: r.email, name: r.name, lastSeenAt: r.last_seen_at ? iso(r.last_seen_at) : null, addedAt: iso(r.created_at) });

export async function portalDetail(deps: Deps, auth: AuthContext, id: string, requestsOn: boolean): Promise<PortalDetail> {
  const p = await portalOf(deps, auth, id);
  // Reading the portal marks the client's newest message as seen (one write, only when something is new).
  if (p.last_client_at && p.last_client_at > (p.team_seen_at ?? 0)) {
    await deps.db.run(sql`update client_portals set team_seen_at = ${deps.now().getTime()} where id = ${p.id}`);
  }
  const [s, people, items, messages] = await Promise.all([
    one(deps, auth, id),
    deps.db.all<PersonRow>(sql`select * from client_portal_people where portal_id = ${p.id} and removed_at is null order by created_at limit ${PORTAL_MAX_PEOPLE}`),
    itemsOf(deps, p), messagesOf(deps, p.id),
  ]);
  return { portal: { ...s, unread: false, welcome: p.welcome, showBrand: !!p.show_brand }, people: people.map(personOut), items, messages, canManage: canManage(auth, p), requestsOn };
}

export async function updatePortal(deps: Deps, auth: AuthContext, id: string, patch: { name?: string; welcome?: string | null; showBrand?: boolean; archived?: boolean }) {
  const p = await managed(deps, auth, id);
  const now = deps.now().getTime();
  const name = patch.name !== undefined ? oneLine(patch.name, 120) : p.name;
  if (!name) throw badRequest("Give the portal a name.");
  const welcome = patch.welcome !== undefined ? String(patch.welcome ?? "").trim().slice(0, 1000) || null : p.welcome;
  const brand = patch.showBrand !== undefined ? (patch.showBrand ? 1 : 0) : p.show_brand;
  const archived = patch.archived === undefined ? p.archived_at : patch.archived ? (p.archived_at ?? now) : null;
  if (patch.archived === false && p.archived_at) {
    const other = await deps.db.get<{ id: string }>(sql`select id from client_portals where org_id = ${p.org_id} and archived_at is null and id != ${p.id}
      and ((contact_id is not null and contact_id = ${p.contact_id}) or (company_id is not null and company_id = ${p.company_id})) limit 1`);
    if (other) throw badRequest("This contact already has a live portal. Archive that one first.");
  }
  await deps.db.run(sql`update client_portals set name = ${name}, welcome = ${welcome}, show_brand = ${brand}, archived_at = ${archived}, updated_at = ${now} where id = ${p.id}`);
  // Archiving signs every client out.
  if (archived && !p.archived_at) await deps.db.run(sql`update client_portal_sessions set revoked_at = ${now} where portal_id = ${p.id} and revoked_at is null`);
  if (patch.archived !== undefined && !!archived !== !!p.archived_at) {
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: archived ? "portal.archived" : "portal.restored", targetType: "client_portal", targetId: p.id });
  }
  return one(deps, auth, id);
}

export async function addPerson(deps: Deps, auth: AuthContext, id: string, input: { email: string; name?: string | null }): Promise<PortalPerson> {
  const p = await managed(deps, auth, id);
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!emailOk(email)) throw badRequest("Enter an email address, like sam@example.com.");
  const now = deps.now().getTime();
  const had = await deps.db.get<PersonRow>(sql`select * from client_portal_people where portal_id = ${p.id} and email = ${email}`);
  if (had && !had.removed_at) throw badRequest("That person can already open this portal.");
  const count = await deps.db.get<{ n: number }>(sql`select count(*) as n from client_portal_people where portal_id = ${p.id} and removed_at is null`);
  if (Number(count?.n ?? 0) >= PORTAL_MAX_PEOPLE) throw badRequest(`A portal can have up to ${PORTAL_MAX_PEOPLE} people.`);
  const contact = await deps.db.get<{ id: string; name: string | null }>(sql`select id, name from contacts where org_id = ${p.org_id} and lower(email) = ${email} limit 1`);
  const name = oneLine(input.name, 120) || contact?.name || null;
  if (had) await deps.db.run(sql`update client_portal_people set removed_at = null, name = ${name}, created_at = ${now}, added_by = ${auth.userId} where id = ${had.id}`);
  else await deps.db.run(sql`insert into client_portal_people (id, portal_id, org_id, email, name, contact_id, added_by, created_at) values (${newId("ptp")}, ${p.id}, ${p.org_id}, ${email}, ${name}, ${contact?.id ?? null}, ${auth.userId}, ${now})`);
  await touch(deps, p.id);
  const row = await deps.db.get<PersonRow>(sql`select * from client_portal_people where portal_id = ${p.id} and email = ${email}`);
  return personOut(row!);
}

export async function removePerson(deps: Deps, auth: AuthContext, id: string, personId: string) {
  const p = await managed(deps, auth, id);
  const now = deps.now().getTime();
  const r = await deps.db.run(sql`update client_portal_people set removed_at = ${now} where id = ${personId} and portal_id = ${p.id} and removed_at is null`);
  if (!changesOf(r)) throw notFound("Person");
  await deps.db.run(sql`update client_portal_sessions set revoked_at = ${now} where person_id = ${personId} and revoked_at is null`);
  await deps.db.run(sql`update client_portal_links set used_at = ${now} where person_id = ${personId} and used_at is null`);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "portal.person_removed", targetType: "client_portal", targetId: p.id });
  return { ok: true };
}

/** R100b: Copy link minted for this person in the last hour (from the audit rows Copy link writes). */
async function copiedSince(deps: Deps, p: PortalRow, personId: string, since: number): Promise<number> {
  const r = await deps.db.select({ n: count() }).from(auditLogs).where(and(
    eq(auditLogs.orgId, p.org_id), eq(auditLogs.action, "portal.link_copied"), eq(auditLogs.targetId, p.id),
    gt(auditLogs.createdAt, new Date(since)), like(auditLogs.metadata, `%"personId":"${personId}"%`)));
  return Number(r[0]?.n ?? 0);
}

/**
 * A one time sign in link for one person (15 minutes). The token is kept only as its SHA-256.
 * R100b: emailed links are capped at PORTAL_LINKS_PER_HOUR per person and Copy link does not count toward that cap
 * (it has its own PORTAL_COPY_LINKS_PER_HOUR). A held back link logs a portal.link_throttled line.
 */
async function mintLink(deps: Deps, p: PortalRow, personId: string, via: "mail" | "copy"): Promise<string> {
  const now = deps.now().getTime();
  const since = now - 60 * 60_000;
  const recent = Number((await deps.db.get<{ n: number }>(sql`select count(*) as n from client_portal_links where person_id = ${personId} and created_at > ${since}`))?.n ?? 0);
  const over = via === "copy" ? recent >= PORTAL_COPY_LINKS_PER_HOUR : recent - (await copiedSince(deps, p, personId, since)) >= PORTAL_LINKS_PER_HOUR;
  if (over) {
    console.warn(JSON.stringify({ event: "portal.link_throttled", portalId: p.id, personId, via }));
    throw tooMany(via === "copy" ? "Too many sign in links for this person in the last hour. Try again later." : "Not sent. This person already got the most sign in emails allowed in an hour. Try again later.");
  }
  const token = randomToken(32);
  await deps.db.run(sql`insert into client_portal_links (token_hash, portal_id, person_id, expires_at, created_at) values (${await sha256Hex(token)}, ${p.id}, ${personId}, ${now + PORTAL_LINK_MINUTES * 60_000}, ${now})`);
  return `${portalUrl(deps, p.key)}/in/${token}`;
}

async function liveTeamPerson(deps: Deps, p: PortalRow, personId: string): Promise<PersonRow> {
  const r = await deps.db.get<PersonRow>(sql`select * from client_portal_people where id = ${personId} and portal_id = ${p.id} and removed_at is null`);
  if (!r) throw notFound("Person");
  if (p.archived_at) throw badRequest("Restore the portal first.");
  return r;
}

async function orgName(deps: Deps, orgId: string) {
  return (await deps.db.get<{ name: string }>(sql`select name from organizations where id = ${orgId}`))?.name ?? "Your team";
}

async function mailLink(deps: Deps, p: PortalRow, person: PersonRow, url: string, invited: boolean) {
  const ws = await orgName(deps, p.org_id);
  const r = await sendSystemEmail(deps, {
    to: person.email, orgId: p.org_id,
    subject: invited ? `${ws} shared a space with you` : `Your sign in link for ${p.name}`,
    text: invited
      ? `${ws} made a space for you to share files, see updates and send messages. You don't need an account or a password.\n\nThe button works once and for ${PORTAL_LINK_MINUTES} minutes. After that, open the space and ask for a new link with this email address.`
      : `Here is your link to sign in to ${p.name}. It works once and for ${PORTAL_LINK_MINUTES} minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
    action: { label: invited ? "Open your space" : "Sign in", url },
  });
  return r.delivered;
}

/** Team: email a person their sign in link (invite). */
export async function invitePerson(deps: Deps, auth: AuthContext, id: string, personId: string) {
  const p = await managed(deps, auth, id);
  const person = await liveTeamPerson(deps, p, personId);
  let url: string;
  // R100b: at the hourly email cap the team hears plainly that nothing went out (never "sent").
  try { url = await mintLink(deps, p, person.id, "mail"); } catch (e) { if (e instanceof HttpError && e.status === 429) return { sent: false, throttled: true }; throw e; }
  const sent = await mailLink(deps, p, person, url, true);
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "portal.invited", targetType: "client_portal", targetId: p.id });
  return { sent, throttled: false };
}

/** Team: a one time sign in link to send some other way (chat, text). */
export async function copyLink(deps: Deps, auth: AuthContext, id: string, personId: string) {
  const p = await managed(deps, auth, id);
  const person = await liveTeamPerson(deps, p, personId);
  const url = await mintLink(deps, p, person.id, "copy");
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "portal.link_copied", targetType: "client_portal", targetId: p.id, metadata: { personId: person.id }, at: deps.now() });
  return { url, expiresInMinutes: PORTAL_LINK_MINUTES };
}

async function countItems(deps: Deps, portalId: string) {
  const r = await deps.db.get<{ n: number }>(sql`select count(*) as n from client_portal_items where portal_id = ${portalId} and removed_at is null`);
  if (Number(r?.n ?? 0) >= PORTAL_MAX_ITEMS) throw badRequest(`A portal can hold up to ${PORTAL_MAX_ITEMS} items. Remove some first.`);
}

async function insertItem(deps: Deps, auth: AuthContext, p: PortalRow, it: { kind: PortalItemKind; refId: string; title: string; folder?: string | null; bytes?: number | null; contentType?: string | null; tokenEnc?: string | null }) {
  const id = newId("pti");
  await deps.db.run(sql`insert into client_portal_items (id, portal_id, org_id, kind, ref_id, title, folder, bytes, content_type, token_enc, added_by, created_at)
    values (${id}, ${p.id}, ${p.org_id}, ${it.kind}, ${it.refId}, ${it.title.slice(0, 200)}, ${it.folder ?? null}, ${it.bytes ?? null}, ${it.contentType ?? null}, ${it.tokenEnc ?? null}, ${auth.userId}, ${deps.now().getTime()})`);
  await touch(deps, p.id);
  return id;
}

/** Team: share a file into the portal (kept for a year, under the workspace's file storage cap). */
export async function addFile(deps: Deps, auth: AuthContext, id: string, f: { name: string; type: string | null; folder: string | null; bytes: Uint8Array }) {
  const p = await managed(deps, auth, id);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  if (!f.bytes.byteLength) throw badRequest("That file is empty.");
  await countItems(deps, p.id);
  const name = cleanName(f.name || "file");
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(f.type ?? "") ? f.type! : "application/octet-stream";
  const fileId = await keepFile(deps, p.org_id, "portal_file", f.bytes, PORTAL_FILE_KEEP_DAYS * 86400, { name });
  const itemId = await insertItem(deps, auth, p, { kind: "file", refId: fileId, title: name, folder: cleanFolder(f.folder), bytes: f.bytes.byteLength, contentType: type });
  return { id: itemId };
}

/** Team: share a doc or a task. Only ones in this workspace; the same one twice is refused. */
export async function addShared(deps: Deps, auth: AuthContext, id: string, input: { kind: "doc" | "task"; refId: string }) {
  const p = await managed(deps, auth, id);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  await countItems(deps, p.id);
  const src = input.kind === "doc"
    ? await deps.db.get<{ title: string }>(sql`select title from docs where id = ${input.refId} and org_id = ${p.org_id} and deleted_at is null`)
    : await deps.db.get<{ title: string }>(sql`select title from tasks where id = ${input.refId} and org_id = ${p.org_id} and deleted_at is null`);
  if (!src) throw notFound(input.kind === "doc" ? "Doc" : "Task");
  const dup = await deps.db.get<{ id: string }>(sql`select id from client_portal_items where portal_id = ${p.id} and kind = ${input.kind} and ref_id = ${input.refId} and removed_at is null`);
  if (dup) throw badRequest(input.kind === "doc" ? "That doc is already shared here." : "That task is already shared here.");
  return { id: await insertItem(deps, auth, p, { kind: input.kind, refId: input.refId, title: src.title || "Untitled" }) };
}

/** Team: ask the client for files. This is an R88 file request; its link is kept encrypted so the portal can show it. */
export async function addRequest(deps: Deps, auth: AuthContext, id: string, input: { title: string; message?: string | null }) {
  const p = await managed(deps, auth, id);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  await countItems(deps, p.id);
  const MB = 1024 * 1024;
  const req = (await createRequest(deps, auth, {
    title: input.title, message: input.message ?? null, folder: p.name.slice(0, 60), maxFileBytes: 100 * MB, maxTotalBytes: 500 * MB,
    allowed: "any", keepDays: 90, expiresInDays: 90, showBrand: !!p.show_brand, notify: true,
  })) as { id: string; title: string; url?: string };
  if (!req.url) throw new HttpError(500, "request_link", "The request was made but its link was not returned.");
  const tokenEnc = await encryptSecret(deps.config.appSecret, req.url);
  return { id: await insertItem(deps, auth, p, { kind: "request", refId: req.id, title: req.title, tokenEnc }) };
}

export async function removeItem(deps: Deps, auth: AuthContext, id: string, itemId: string) {
  const p = await managed(deps, auth, id);
  const it = await deps.db.get<ItemRow>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and removed_at is null`);
  if (!it) throw notFound("Item");
  await deps.db.run(sql`update client_portal_items set removed_at = ${deps.now().getTime()} where id = ${it.id}`);
  if (it.kind === "file") await dropKeptFiles(deps, p.org_id, [it.ref_id]);
  if (it.kind === "request") await setRequestOpen(deps, auth, it.ref_id, false).catch(() => undefined); // closed so the old link stops taking files
  await touch(deps, p.id);
  return { ok: true };
}

export async function teamFile(deps: Deps, auth: AuthContext, id: string, itemId: string) {
  const p = await portalOf(deps, auth, id);
  return fileOf(deps, p, itemId);
}

async function fileOf(deps: Deps, p: PortalRow, itemId: string): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  const it = await deps.db.get<ItemRow>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and kind = 'file' and removed_at is null`);
  if (!it) throw notFound("File");
  const bytes = await readKeptFile(deps, it.ref_id);
  if (!bytes) throw notFound("File");
  return { name: it.title, type: it.content_type || "application/octet-stream", bytes };
}

function cleanBody(v: unknown) {
  // eslint-disable-next-line no-control-regex
  const body = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim();
  if (!body) throw badRequest("Write a message first.");
  if (body.length > PORTAL_MESSAGE_MAX) throw badRequest(`Messages can be up to ${PORTAL_MESSAGE_MAX} characters.`);
  return body;
}

/** Team: reply in the thread. Clients get one email per 15 minutes at most (a burst of replies is one email). */
export async function teamMessage(deps: Deps, auth: AuthContext, id: string, raw: string): Promise<PortalMessage> {
  const p = await portalOf(deps, auth, id);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  const body = cleanBody(raw);
  const now = deps.now().getTime();
  const mid = newId("ptm");
  await deps.db.run(sql`insert into client_portal_messages (id, portal_id, org_id, from_client, user_id, author, body, created_at) values (${mid}, ${p.id}, ${p.org_id}, 0, ${auth.userId}, ${auth.name || auth.email}, ${body}, ${now})`);
  await deps.db.run(sql`update client_portals set updated_at = ${now}, team_seen_at = ${now} where id = ${p.id}`);
  const due = await deps.db.run(sql`update client_portals set client_notified_at = ${now} where id = ${p.id} and (client_notified_at is null or client_notified_at < ${now - PORTAL_MAIL_EVERY_MS})`);
  if (changesOf(due)) {
    const ws = await orgName(deps, p.org_id);
    const people = await deps.db.all<PersonRow>(sql`select * from client_portal_people where portal_id = ${p.id} and removed_at is null limit ${PORTAL_MAX_PEOPLE}`);
    for (const person of people) {
      await sendSystemEmail(deps, {
        to: person.email, orgId: p.org_id, subject: `New message from ${ws}`,
        text: `${auth.name || ws} wrote in ${p.name}:\n\n${body.slice(0, 600)}${body.length > 600 ? "..." : ""}`,
        action: { label: "Open your space", url: `${portalUrl(deps, p.key)}?tab=messages` },
      }).catch(() => undefined);
    }
  }
  return { id: mid, fromClient: false, author: auth.name || auth.email, body, at: iso(now) };
}

// ---- client side ----

export interface ClientView { portal: PortalRow; person: PersonRow; workspace: string }

export async function portalByKey(deps: Deps, key: string): Promise<PortalRow | null> {
  if (!keyShapeOk(key)) return null;
  return (await deps.db.get<PortalRow>(sql`select * from client_portals where key = ${key} and archived_at is null`)) ?? null;
}

/** The client behind a session cookie, only for this portal. */
export async function clientFromSession(deps: Deps, p: PortalRow, token: string | undefined): Promise<PersonRow | null> {
  if (!token || !linkShapeOk(token)) return null;
  const now = deps.now().getTime();
  const s = await deps.db.get<{ person_id: string; portal_id: string }>(sql`select person_id, portal_id from client_portal_sessions where token_hash = ${await sha256Hex(token)} and revoked_at is null and expires_at > ${now}`);
  if (!s || s.portal_id !== p.id) return null;
  const person = await deps.db.get<PersonRow>(sql`select * from client_portal_people where id = ${s.person_id} and portal_id = ${p.id} and removed_at is null`);
  if (!person) return null;
  if (!person.last_seen_at || person.last_seen_at < now - 10 * 60_000) await deps.db.run(sql`update client_portal_people set last_seen_at = ${now} where id = ${person.id}`);
  return person;
}

/** Client asks for a sign in link. The answer never says whether the email is on the list. */
export async function requestClientLink(deps: Deps, p: PortalRow, rawEmail: string): Promise<void> {
  const email = String(rawEmail ?? "").trim().toLowerCase();
  if (!emailOk(email)) throw badRequest("Enter your email address.");
  const person = await deps.db.get<PersonRow>(sql`select * from client_portal_people where portal_id = ${p.id} and email = ${email} and removed_at is null`);
  if (!person) return;
  let url: string;
  // The public form stays neutral at the cap (no hint whether the address is on the list); the throttle is logged.
  try { url = await mintLink(deps, p, person.id, "mail"); } catch (e) { if (e instanceof HttpError && e.status === 429) return; throw e; }
  await mailLink(deps, p, person, url, false);
}

/** Uses a one time link: marks it used and opens a session for that person on that portal. Returns the session token. */
export async function useClientLink(deps: Deps, p: PortalRow, token: string): Promise<{ session: string; person: PersonRow } | null> {
  if (!linkShapeOk(token)) return null;
  const now = deps.now().getTime();
  const h = await sha256Hex(token);
  const l = await deps.db.get<{ person_id: string; portal_id: string; expires_at: number; used_at: number | null }>(sql`select person_id, portal_id, expires_at, used_at from client_portal_links where token_hash = ${h}`);
  if (!l || l.portal_id !== p.id || l.used_at || l.expires_at <= now) return null;
  const used = await deps.db.run(sql`update client_portal_links set used_at = ${now} where token_hash = ${h} and used_at is null`);
  if (!changesOf(used)) return null;
  const person = await deps.db.get<PersonRow>(sql`select * from client_portal_people where id = ${l.person_id} and portal_id = ${p.id} and removed_at is null`);
  if (!person) return null;
  const session = randomToken(32);
  await deps.db.run(sql`insert into client_portal_sessions (token_hash, portal_id, person_id, expires_at, created_at) values (${await sha256Hex(session)}, ${p.id}, ${person.id}, ${now + PORTAL_SESSION_DAYS * 86400_000}, ${now})`);
  await deps.db.run(sql`update client_portal_people set last_seen_at = ${now} where id = ${person.id}`);
  return { session, person };
}

export async function endClientSession(deps: Deps, token: string | undefined) {
  if (!token || !linkShapeOk(token)) return;
  await deps.db.run(sql`update client_portal_sessions set revoked_at = ${deps.now().getTime()} where token_hash = ${await sha256Hex(token)} and revoked_at is null`);
}

export async function clientData(deps: Deps, p: PortalRow) {
  const [items, messages, ws] = await Promise.all([itemsOf(deps, p), messagesOf(deps, p.id, 100), orgName(deps, p.org_id)]);
  const live = items.filter((i) => i.live && (i.kind !== "request" || i.open));
  const withLinks = await Promise.all(live.map(async (i) => {
    if (i.kind !== "request") return { ...i, url: null as string | null };
    const row = await deps.db.get<{ token_enc: string | null }>(sql`select token_enc from client_portal_items where id = ${i.id}`);
    let url: string | null;
    try { url = row?.token_enc ? await decryptSecret(deps.config.appSecret, row.token_enc) : null; } catch { url = null; }
    return { ...i, url };
  }));
  return { items: withLinks.filter((i) => i.kind !== "request" || i.url), messages, workspace: ws };
}

export const clientFile = (deps: Deps, p: PortalRow, itemId: string) => fileOf(deps, p, itemId);

export async function clientDoc(deps: Deps, p: PortalRow, itemId: string): Promise<{ title: string; content: unknown }> {
  const it = await deps.db.get<ItemRow>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and kind = 'doc' and removed_at is null`);
  if (!it) throw notFound("Doc");
  const d = await deps.db.get<{ title: string; content: string }>(sql`select title, content from docs where id = ${it.ref_id} and org_id = ${p.org_id} and deleted_at is null`);
  if (!d) throw notFound("Doc");
  let content: unknown;
  try { content = JSON.parse(d.content); } catch { content = null; }
  return { title: d.title || "Untitled", content };
}

/** Client writes in the thread: everyone who can manage the portal hears it in app; the maker gets at most one email per 15 minutes. */
export async function clientMessage(deps: Deps, p: PortalRow, person: PersonRow, raw: string) {
  const body = cleanBody(raw);
  const now = deps.now().getTime();
  const author = person.name || person.email;
  await deps.db.run(sql`insert into client_portal_messages (id, portal_id, org_id, from_client, person_id, author, body, created_at) values (${newId("ptm")}, ${p.id}, ${p.org_id}, 1, ${person.id}, ${author}, ${body}, ${now})`);
  await deps.db.run(sql`update client_portals set updated_at = ${now}, last_client_at = ${now} where id = ${p.id}`);
  await notify(deps, p.org_id, p.created_by, { type: "portal.message", entityType: "client_portal", entityId: p.id, title: `${author} wrote in ${p.name}`, actorName: author });
  const due = await deps.db.run(sql`update client_portals set team_notified_at = ${now} where id = ${p.id} and (team_notified_at is null or team_notified_at < ${now - PORTAL_MAIL_EVERY_MS})`);
  if (!changesOf(due)) return;
  const u = await deps.db.get<{ email: string }>(sql`select email from users where id = ${p.created_by}`);
  if (!u?.email) return;
  await sendSystemEmail(deps, {
    to: u.email, orgId: p.org_id, subject: `${author} wrote in ${p.name}`,
    text: `${author} wrote in the client portal ${p.name}:\n\n${body.slice(0, 600)}${body.length > 600 ? "..." : ""}`,
    action: { label: "Reply", url: `${base(deps)}/app/contacts/portals/${encodeURIComponent(p.id)}?tab=messages` },
  }).catch(() => undefined);
}
