/**
 * TD9 (flag PORTAL_TD9, on top of R120 CLIENT_PORTAL): access per person per area, projects, invoices and forms
 * as shareable items, milestones, the live project view and comments (a thread per shared task or project, and
 * private comments to one named person).
 *
 * Every client read goes through levelsFor(person) and the item's portal; every team read is scoped to the
 * workspace. Private comments live only in item_comments, filtered in SQL per reader: the author, the one person
 * it is addressed to, and workspace owners and admins. Nothing returns a count of comments.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, forbidden, notFound } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { audit } from "../audit";
import { notify } from "../suite/notify";
import { sendSystemEmail } from "../system-mail";
import { getTask } from "../suite/tasks";
import { changesOf } from "../tools/kept-files";
import { containsAny, containsText } from "../../lib/like-search";
import { canManage, countItems, insertItem, managed, orgName, portalOf, portalUrl, type PortalRow } from "./client-portal";
import { PORTAL_MAIL_EVERY_MS } from "@/shared/client-portal";
import {
  COMMENT_TD9_MAX, DEFAULT_LEVELS, MILESTONE_MAX, PORTAL_AREAS, areaOf, canComment, canView, privateLabel,
  type PortalArea, type PortalLevel, type Td9AccessHistory, type Td9Comment, type Td9Kind, type Td9Milestone, type Td9Recipient,
} from "@/shared/portal-td9";
import { featureOn } from "../console/flags"; // OPS1 feature flags

// OPS1 feature flags: the platform wide values (client portals are a global switch).
export const td9On = (deps: Deps) => featureOn(deps, "clientPortal") && featureOn(deps, "portalTd9");
const isAdmin = (auth: Pick<AuthContext, "role">) => auth.role === "owner" || auth.role === "admin";
const iso = (ms: number) => new Date(ms).toISOString();
const inList = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

interface PersonLite { id: string; portal_id: string; email: string; name: string | null }
interface ItemLite { id: string; portal_id: string; org_id: string; kind: Td9Kind; ref_id: string; title: string; project_id: string | null }

// ---------- access levels ----------

export async function levelsFor(deps: Deps, personId: string): Promise<Record<PortalArea, PortalLevel>> {
  const rows = await deps.db.all<{ area: PortalArea; level: PortalLevel }>(sql`select area, level from client_portal_access where person_id = ${personId}`);
  const out = { ...DEFAULT_LEVELS };
  for (const r of rows) if ((PORTAL_AREAS as readonly string[]).includes(r.area)) out[r.area] = r.level;
  return out;
}

async function livePerson(deps: Deps, p: PortalRow, personId: string): Promise<PersonLite> {
  const r = await deps.db.get<PersonLite>(sql`select id, portal_id, email, name from client_portal_people where id = ${personId} and portal_id = ${p.id} and removed_at is null`);
  if (!r) throw notFound("Person");
  return r;
}

export async function getAccess(deps: Deps, auth: AuthContext, portalId: string, personId: string) {
  const p = await portalOf(deps, auth, portalId);
  await livePerson(deps, p, personId);
  const rows = await deps.db.all<{ created_at: number; actor_email: string | null; name: string | null; metadata: string | null }>(sql`select a.created_at, a.actor_email, u.name, a.metadata
    from audit_logs a left join users u on u.id = a.actor_user_id
    where a.org_id = ${auth.orgId} and a.action = 'portal.access.set' and a.target_type = 'client_portal_person' and a.target_id = ${personId}
    order by a.created_at desc limit 20`);
  const history: Td9AccessHistory[] = [];
  for (const r of rows) {
    try {
      const m = JSON.parse(r.metadata ?? "{}") as { area?: PortalArea; from?: PortalLevel; to?: PortalLevel };
      if (m.area && m.from && m.to) history.push({ at: new Date(Number(r.created_at)).toISOString(), by: r.name || r.actor_email || "Someone", area: m.area, from: m.from, to: m.to });
    } catch { /* skip a bad row */ }
  }
  return { levels: await levelsFor(deps, personId), history, canManage: canManage(auth, p) };
}

export async function setAccess(deps: Deps, auth: AuthContext, portalId: string, personId: string, area: PortalArea, level: PortalLevel) {
  const p = await managed(deps, auth, portalId);
  await livePerson(deps, p, personId);
  const before = (await levelsFor(deps, personId))[area];
  if (before !== level) {
    const now = deps.now().getTime();
    await deps.db.run(sql`insert into client_portal_access (person_id, area, portal_id, org_id, level, updated_by, updated_at) values (${personId}, ${area}, ${p.id}, ${p.org_id}, ${level}, ${auth.userId}, ${now})
      on conflict(person_id, area) do update set level = excluded.level, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "portal.access.set", targetType: "client_portal_person", targetId: personId, metadata: { portalId: p.id, area, from: before, to: level } });
  }
  return getAccess(deps, auth, portalId, personId);
}

/** The items a person may see: their level for the item's area is View or Comment. */
export function filterForLevels<T extends { kind: string }>(items: T[], levels: Record<PortalArea, PortalLevel>): T[] {
  return items.filter((i) => canView(levels[areaOf(i.kind as Td9Kind)]));
}

// ---------- new shareable kinds ----------

export type NewKind = "project" | "invoice" | "form";

export async function pick(deps: Deps, auth: AuthContext, portalId: string, kind: NewKind, q: string) {
  const p = await portalOf(deps, auth, portalId);
  if (kind === "project") {
    const rows = await deps.db.all<{ id: string; name: string; key: string }>(sql`select id, name, key from projects where org_id = ${p.org_id} and deleted_at is null and archived_at is null
      ${q ? sql`and ${containsText(sql`name`, q)}` : sql``} order by name limit 50`);
    return rows.map((r) => ({ id: r.id, title: r.name, sub: r.key }));
  }
  if (kind === "invoice") {
    const rows = await deps.db.all<{ id: string; kind: string; number: string | null; buyer_name: string | null; total_cents: number; currency: string; status: string }>(sql`select id, kind, number, buyer_name, total_cents, currency, status
      from invoice_docs where org_id = ${p.org_id} and kind in ('invoice', 'quote') and status in ('issued', 'accepted') and view_token is not null
      ${q ? sql`and ${containsAny([sql`number`, sql`buyer_name`], q)}` : sql``} order by created_at desc limit 50`);
    return rows.map((r) => ({ id: r.id, title: `${r.kind === "quote" ? "Quote" : "Invoice"} ${r.number ?? ""}`.trim(), sub: `${r.buyer_name ?? ""}${r.buyer_name ? " · " : ""}${money(r.total_cents, r.currency)}` }));
  }
  const rows = await deps.db.all<{ id: string; name: string }>(sql`select id, name from forms where org_id = ${p.org_id} and enabled = 1 and deleted_at is null
    ${q ? sql`and ${containsText(sql`name`, q)}` : sql``} order by name limit 50`);
  return rows.map((r) => ({ id: r.id, title: r.name, sub: "Form" }));
}

export function money(cents: number, currency: string) {
  try { return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency || "AUD" }).format(Number(cents || 0) / 100); } catch { return `${(Number(cents || 0) / 100).toFixed(2)} ${currency}`; }
}

export async function addShared(deps: Deps, auth: AuthContext, portalId: string, kind: NewKind, refId: string) {
  const p = await managed(deps, auth, portalId);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  await countItems(deps, p.id);
  let title: string | null;
  if (kind === "project") title = (await deps.db.get<{ name: string }>(sql`select name from projects where id = ${refId} and org_id = ${p.org_id} and deleted_at is null`))?.name ?? null;
  else if (kind === "invoice") {
    const r = await deps.db.get<{ kind: string; number: string | null }>(sql`select kind, number from invoice_docs where id = ${refId} and org_id = ${p.org_id} and kind in ('invoice', 'quote') and status in ('issued', 'accepted') and view_token is not null`);
    title = r ? `${r.kind === "quote" ? "Quote" : "Invoice"} ${r.number ?? ""}`.trim() : null;
  } else title = (await deps.db.get<{ name: string }>(sql`select name from forms where id = ${refId} and org_id = ${p.org_id} and enabled = 1 and deleted_at is null`))?.name ?? null;
  if (title === null) throw notFound(kind === "project" ? "Project" : kind === "invoice" ? "Invoice" : "Form");
  const dup = await deps.db.get<{ id: string }>(sql`select id from client_portal_items where portal_id = ${p.id} and kind = ${kind} and ref_id = ${refId} and removed_at is null`);
  if (dup) throw badRequest(`That ${kind} is already shared here.`);
  return { id: await insertItem(deps, auth, p, { kind: kind as never, refId, title: title || "Untitled" }) };
}

/** Live state for the TD9 kinds, for team and client lists. */
export async function td9States(deps: Deps, orgId: string, rows: { kind: string; ref_id: string }[]) {
  const ids = (k: string) => [...new Set(rows.filter((r) => r.kind === k).map((r) => r.ref_id))];
  const pr = ids("project"), inv = ids("invoice"), fm = ids("form");
  const [projects, prog, invoices, forms] = await Promise.all([
    pr.length ? deps.db.all<{ id: string; name: string }>(sql`select id, name from projects where org_id = ${orgId} and deleted_at is null and id in (${inList(pr)})`) : [],
    pr.length ? deps.db.all<{ project_id: string; done: number; total: number }>(sql`select project_id, sum(case when status = 'done' then 1 else 0 end) as done, count(*) as total from tasks
      where org_id = ${orgId} and deleted_at is null and parent_id is null and project_id in (${inList(pr)}) group by project_id`) : [],
    inv.length ? deps.db.all<{ id: string; kind: string; number: string | null; status: string; total_cents: number; paid_cents: number; currency: string; due_date: string | null; view_token: string | null }>(sql`select id, kind, number, status, total_cents, paid_cents, currency, due_date, view_token
      from invoice_docs where org_id = ${orgId} and id in (${inList(inv)})`) : [],
    fm.length ? deps.db.all<{ id: string; name: string; slug: string; enabled: number }>(sql`select id, name, slug, enabled from forms where org_id = ${orgId} and deleted_at is null and id in (${inList(fm)})`) : [],
  ]);
  return {
    project: (refId: string) => {
      const p = projects.find((x) => x.id === refId);
      if (!p) return null;
      const g = prog.find((x) => x.project_id === refId);
      return { title: p.name, progress: { done: Number(g?.done ?? 0), total: Number(g?.total ?? 0) } };
    },
    invoice: (refId: string) => {
      const r = invoices.find((x) => x.id === refId);
      if (!r || !r.view_token || r.status === "draft" || r.status === "void") return null;
      const paid = r.kind === "invoice" && Number(r.paid_cents) >= Number(r.total_cents) && Number(r.total_cents) > 0;
      return { title: `${r.kind === "quote" ? "Quote" : "Invoice"} ${r.number ?? ""}`.trim(), amount: money(r.total_cents, r.currency), status: paid ? "Paid" : r.status === "accepted" ? "Accepted" : "Issued", due: r.due_date, url: `/i/${r.view_token}` };
    },
    form: (refId: string) => {
      const r = forms.find((x) => x.id === refId);
      if (!r || !r.enabled) return null;
      return { title: r.name, url: `/f/${r.slug}` };
    },
  };
}

/** Team: link a shared file to a shared project (or unlink), so it shows on that project's page. */
export async function linkFile(deps: Deps, auth: AuthContext, portalId: string, itemId: string, projectItemId: string | null) {
  const p = await managed(deps, auth, portalId);
  const it = await deps.db.get<ItemLite>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and kind = 'file' and removed_at is null`);
  if (!it) throw notFound("File");
  let projectId: string | null = null;
  if (projectItemId) {
    const pi = await deps.db.get<ItemLite>(sql`select * from client_portal_items where id = ${projectItemId} and portal_id = ${p.id} and kind = 'project' and removed_at is null`);
    if (!pi) throw notFound("Project");
    projectId = pi.ref_id;
  }
  await deps.db.run(sql`update client_portal_items set project_id = ${projectId} where id = ${it.id}`);
  return { ok: true, projectId };
}

// ---------- milestones ----------

async function projectItem(deps: Deps, p: PortalRow, itemId: string): Promise<ItemLite> {
  const it = await deps.db.get<ItemLite>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and kind = 'project' and removed_at is null`);
  if (!it) throw notFound("Project");
  return it;
}

export async function milestonesOf(deps: Deps, orgId: string, projectId: string): Promise<Td9Milestone[]> {
  const rows = await deps.db.all<{ id: string; title: string; due_date: string | null; done_at: number | null }>(sql`select id, title, due_date, done_at from portal_milestones
    where org_id = ${orgId} and project_id = ${projectId} and deleted_at is null order by (due_date is null), due_date, position, created_at limit ${MILESTONE_MAX}`);
  return rows.map((r) => ({ id: r.id, title: r.title, due: r.due_date, done: !!r.done_at }));
}

const cleanTitle = (v: unknown) => {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
  if (!s) throw badRequest("Give the milestone a name.");
  return s;
};
const cleanDue = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw badRequest("Use a date like 2026-12-31.");
  return s;
};

export async function teamMilestones(deps: Deps, auth: AuthContext, portalId: string, itemId: string) {
  const p = await portalOf(deps, auth, portalId);
  const it = await projectItem(deps, p, itemId);
  return { milestones: await milestonesOf(deps, p.org_id, it.ref_id), canManage: canManage(auth, p) };
}

export async function addMilestone(deps: Deps, auth: AuthContext, portalId: string, itemId: string, input: { title: string; due?: string | null }) {
  const p = await managed(deps, auth, portalId);
  const it = await projectItem(deps, p, itemId);
  const n = await deps.db.get<{ n: number }>(sql`select count(*) as n from portal_milestones where org_id = ${p.org_id} and project_id = ${it.ref_id} and deleted_at is null`);
  if (Number(n?.n ?? 0) >= MILESTONE_MAX) throw badRequest(`A project can have up to ${MILESTONE_MAX} milestones.`);
  const id = newId("pms");
  await deps.db.run(sql`insert into portal_milestones (id, org_id, project_id, title, due_date, position, created_by, created_at) values (${id}, ${p.org_id}, ${it.ref_id}, ${cleanTitle(input.title)}, ${cleanDue(input.due)}, ${Number(n?.n ?? 0)}, ${auth.userId}, ${deps.now().getTime()})`);
  return teamMilestones(deps, auth, portalId, itemId);
}

export async function updateMilestone(deps: Deps, auth: AuthContext, portalId: string, itemId: string, mid: string, patch: { title?: string; due?: string | null; done?: boolean }) {
  const p = await managed(deps, auth, portalId);
  const it = await projectItem(deps, p, itemId);
  const m = await deps.db.get<{ id: string }>(sql`select id from portal_milestones where id = ${mid} and org_id = ${p.org_id} and project_id = ${it.ref_id} and deleted_at is null`);
  if (!m) throw notFound("Milestone");
  if (patch.title !== undefined) await deps.db.run(sql`update portal_milestones set title = ${cleanTitle(patch.title)} where id = ${mid}`);
  if (patch.due !== undefined) await deps.db.run(sql`update portal_milestones set due_date = ${cleanDue(patch.due)} where id = ${mid}`);
  if (patch.done !== undefined) await deps.db.run(sql`update portal_milestones set done_at = ${patch.done ? deps.now().getTime() : null} where id = ${mid}`);
  return teamMilestones(deps, auth, portalId, itemId);
}

export async function deleteMilestone(deps: Deps, auth: AuthContext, portalId: string, itemId: string, mid: string) {
  const p = await managed(deps, auth, portalId);
  const it = await projectItem(deps, p, itemId);
  await deps.db.run(sql`update portal_milestones set deleted_at = ${deps.now().getTime()} where id = ${mid} and org_id = ${p.org_id} and project_id = ${it.ref_id} and deleted_at is null`);
  return teamMilestones(deps, auth, portalId, itemId);
}

// ---------- comments ----------

interface CommentRow {
  id: string; org_id: string; target_kind: "task" | "project"; target_id: string; portal_id: string | null;
  author_user_id: string | null; author_person_id: string | null; author_name: string; to_user_id: string | null; to_person_id: string | null;
  body: string; created_at: number;
}

const cleanBody = (v: unknown) => {
  // eslint-disable-next-line no-control-regex
  const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim();
  if (!s) throw badRequest("Write a comment first.");
  if (s.length > COMMENT_TD9_MAX) throw badRequest(`Comments can be up to ${COMMENT_TD9_MAX} characters.`);
  return s;
};

/** The SQL rule for a team reader: public thread comments, or a private one they wrote or got; admins see all. */
const teamVisible = (auth: AuthContext) => isAdmin(auth) ? sql`1 = 1`
  : sql`((c.to_user_id is null and c.to_person_id is null) or c.author_user_id = ${auth.userId} or c.to_user_id = ${auth.userId})`;

async function names(deps: Deps, rows: CommentRow[]) {
  const uids = [...new Set(rows.map((r) => r.to_user_id).filter(Boolean) as string[])];
  const pids = [...new Set(rows.map((r) => r.to_person_id).filter(Boolean) as string[])];
  const us = uids.length ? await deps.db.all<{ id: string; name: string; email: string }>(sql`select id, name, email from users where id in (${inList(uids)})`) : [];
  const ps = pids.length ? await deps.db.all<{ id: string; name: string | null; email: string }>(sql`select id, name, email from client_portal_people where id in (${inList(pids)})`) : [];
  return (r: CommentRow) => {
    if (r.to_user_id) { const u = us.find((x) => x.id === r.to_user_id); return u ? (u.name || u.email) : "a teammate"; }
    if (r.to_person_id) { const x = ps.find((y) => y.id === r.to_person_id); return x ? (x.name || x.email) : "a client"; }
    return "";
  };
}

async function presentTeam(deps: Deps, auth: AuthContext, rows: CommentRow[]): Promise<Td9Comment[]> {
  const target = await names(deps, rows);
  return rows.map((r) => {
    const priv = !!(r.to_user_id || r.to_person_id);
    const meIsAuthor = r.author_user_id === auth.userId;
    return {
      id: r.id, body: r.body, at: iso(Number(r.created_at)),
      author: { name: r.author_name, client: !!r.author_person_id, me: meIsAuthor },
      privateLabel: priv ? privateLabel({ meIsAuthor, meIsTarget: r.to_user_id === auth.userId, authorName: r.author_name, targetName: target(r) }) : null,
      canDelete: meIsAuthor || isAdmin(auth),
    };
  });
}

async function memberOf(deps: Deps, orgId: string, userId: string) {
  return deps.db.get<{ id: string; name: string; email: string }>(sql`select u.id, u.name, u.email from members m join users u on u.id = m.user_id where m.organization_id = ${orgId} and m.user_id = ${userId} and m.kind = 'human'`);
}

async function shareItem(deps: Deps, orgId: string, portalId: string, itemId: string) {
  const it = await deps.db.get<ItemLite>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${portalId} and org_id = ${orgId} and removed_at is null and kind in ('task', 'project')`);
  if (!it) throw notFound("Item");
  return it;
}

async function insertComment(deps: Deps, c: Omit<CommentRow, "id" | "created_at">) {
  const id = newId("icm");
  await deps.db.run(sql`insert into item_comments (id, org_id, target_kind, target_id, portal_id, author_user_id, author_person_id, author_name, to_user_id, to_person_id, body, created_at)
    values (${id}, ${c.org_id}, ${c.target_kind}, ${c.target_id}, ${c.portal_id}, ${c.author_user_id}, ${c.author_person_id}, ${c.author_name.slice(0, 120)}, ${c.to_user_id}, ${c.to_person_id}, ${c.body}, ${deps.now().getTime()})`);
  return id;
}

/** After a private comment: an in app notice for a teammate, or one email (no comment text) to a client, at most every 15 minutes per portal. */
async function tellTarget(deps: Deps, auth: AuthContext, c: { org_id: string; target_kind: string; target_id: string; to_user_id: string | null; to_person_id: string | null; portal_id: string | null }) {
  try {
    if (c.to_user_id) {
      await notify(deps, c.org_id, c.to_user_id, { type: "comment.private", entityType: c.target_kind, entityId: c.target_id, title: `${auth.name || "A teammate"} sent you a private comment`, actorName: auth.name || null });
    } else if (c.to_person_id && c.portal_id) {
      const now = deps.now().getTime();
      const p = await deps.db.get<PortalRow>(sql`select * from client_portals where id = ${c.portal_id} and org_id = ${c.org_id}`);
      const person = await deps.db.get<PersonLite>(sql`select id, portal_id, email, name from client_portal_people where id = ${c.to_person_id} and removed_at is null`);
      if (!p || !person) return;
      const due = await deps.db.run(sql`update client_portals set client_notified_at = ${now} where id = ${p.id} and (client_notified_at is null or client_notified_at < ${now - PORTAL_MAIL_EVERY_MS})`);
      if (!changesOf(due)) return;
      const ws = (await orgName(deps, p.org_id)) || "Your team";
      await sendSystemEmail(deps, { to: person.email, orgId: p.org_id, subject: `${ws} left you a private comment`, text: `${auth.name || ws} left a comment only you can see in ${p.name}.\n\nOpen your space: ${portalUrl(deps, p.key)}` });
    }
  } catch { /* a notice that fails never undoes the comment */ }
}

/** Team: the thread on a shared task or project in one portal. */
export async function teamItemComments(deps: Deps, auth: AuthContext, portalId: string, itemId: string) {
  const p = await portalOf(deps, auth, portalId);
  const it = await shareItem(deps, p.org_id, p.id, itemId);
  const rows = await deps.db.all<CommentRow>(sql`select c.* from item_comments c where c.org_id = ${p.org_id} and c.portal_id = ${p.id} and c.target_kind = ${it.kind} and c.target_id = ${it.ref_id} and c.deleted_at is null and ${teamVisible(auth)} order by c.created_at limit 500`);
  return { comments: await presentTeam(deps, auth, rows) };
}

export async function teamItemComment(deps: Deps, auth: AuthContext, portalId: string, itemId: string, input: { body: string; toUserId?: string | null; toPersonId?: string | null }) {
  const p = await portalOf(deps, auth, portalId);
  if (p.archived_at) throw badRequest("Restore the portal first.");
  const it = await shareItem(deps, p.org_id, p.id, itemId);
  const body = cleanBody(input.body);
  if (input.toUserId && input.toPersonId) throw badRequest("Pick one person.");
  if (input.toUserId && !(await memberOf(deps, p.org_id, input.toUserId))) throw notFound("Person");
  if (input.toPersonId) {
    const person = await livePerson(deps, p, input.toPersonId);
    if (!canView((await levelsFor(deps, person.id))[areaOf(it.kind)])) throw new HttpError(409, "no_access", `${person.name || person.email} can't see this in the portal. Give them View first.`);
  }
  const row = { org_id: p.org_id, target_kind: it.kind as "task" | "project", target_id: it.ref_id, portal_id: p.id, author_user_id: auth.userId, author_person_id: null, author_name: auth.name || auth.email, to_user_id: input.toUserId || null, to_person_id: input.toPersonId || null, body };
  await insertComment(deps, row);
  if (row.to_user_id || row.to_person_id) await tellTarget(deps, auth, row);
  return teamItemComments(deps, auth, portalId, itemId);
}

/** Team: private comments on a task or project the reader can open (the task panel). */
async function targetOf(deps: Deps, auth: AuthContext, kind: "task" | "project", refId: string) {
  if (kind === "task") { const t = await getTask(deps, auth, refId); return { id: t.id as string }; }
  const pr = await deps.db.get<{ id: string }>(sql`select id from projects where id = ${refId} and org_id = ${auth.orgId} and deleted_at is null`);
  if (!pr) throw notFound("Project");
  return pr;
}

export async function targetComments(deps: Deps, auth: AuthContext, kind: "task" | "project", refId: string) {
  const t = await targetOf(deps, auth, kind, refId);
  const rows = await deps.db.all<CommentRow>(sql`select c.* from item_comments c where c.org_id = ${auth.orgId} and c.target_kind = ${kind} and c.target_id = ${t.id} and c.deleted_at is null and ${teamVisible(auth)} order by c.created_at limit 500`);
  return { comments: await presentTeam(deps, auth, rows) };
}

/** Who a private comment can go to: teammates, and clients on a portal where this task or project is shared and visible to them. */
export async function recipients(deps: Deps, auth: AuthContext, kind: "task" | "project", refId: string): Promise<{ recipients: Td9Recipient[] }> {
  const t = await targetOf(deps, auth, kind, refId);
  const mem = await deps.db.all<{ id: string; name: string; email: string }>(sql`select u.id, u.name, u.email from members m join users u on u.id = m.user_id where m.organization_id = ${auth.orgId} and m.kind = 'human' and u.id <> ${auth.userId} order by u.name limit 200`);
  const people = await deps.db.all<{ id: string; name: string | null; email: string; portal: string }>(sql`select pp.id, pp.name, pp.email, p.name as portal from client_portal_items i
    join client_portals p on p.id = i.portal_id and p.archived_at is null join client_portal_people pp on pp.portal_id = p.id and pp.removed_at is null
    where i.org_id = ${auth.orgId} and i.kind = ${kind} and i.ref_id = ${t.id} and i.removed_at is null limit 200`);
  const visible: Td9Recipient[] = [];
  for (const x of people) if (canView((await levelsFor(deps, x.id))[areaOf(kind)])) visible.push({ kind: "client", id: x.id, name: x.name || x.email, sub: `Client · ${x.portal}` });
  return { recipients: [...mem.map((m) => ({ kind: "member" as const, id: m.id, name: m.name || m.email, sub: "Teammate" })), ...visible] };
}

export async function targetComment(deps: Deps, auth: AuthContext, kind: "task" | "project", refId: string, input: { body: string; toUserId?: string | null; toPersonId?: string | null }) {
  const t = await targetOf(deps, auth, kind, refId);
  const body = cleanBody(input.body);
  if (!!input.toUserId === !!input.toPersonId) throw badRequest("Pick the one person this is for.");
  let portalId: string | null = null;
  if (input.toUserId) {
    if (input.toUserId === auth.userId) throw badRequest("Pick someone other than you.");
    if (!(await memberOf(deps, auth.orgId, input.toUserId))) throw notFound("Person");
  } else {
    const hit = await deps.db.get<{ portal_id: string; name: string | null; email: string }>(sql`select i.portal_id, pp.name, pp.email from client_portal_items i
      join client_portals p on p.id = i.portal_id and p.archived_at is null join client_portal_people pp on pp.portal_id = p.id and pp.id = ${input.toPersonId!} and pp.removed_at is null
      where i.org_id = ${auth.orgId} and i.kind = ${kind} and i.ref_id = ${t.id} and i.removed_at is null limit 1`);
    if (!hit) throw notFound("Person");
    if (!canView((await levelsFor(deps, input.toPersonId!))[areaOf(kind)])) throw new HttpError(409, "no_access", `${hit.name || hit.email} can't see this in the portal. Give them View first.`);
    portalId = hit.portal_id;
  }
  const row = { org_id: auth.orgId, target_kind: kind, target_id: t.id, portal_id: portalId, author_user_id: auth.userId, author_person_id: null, author_name: auth.name || auth.email, to_user_id: input.toUserId || null, to_person_id: input.toPersonId || null, body };
  await insertComment(deps, row);
  await tellTarget(deps, auth, row);
  return targetComments(deps, auth, kind, refId);
}

/** The author or an owner or admin removes a comment. Someone who cannot see it gets 404, not 403. */
export async function deleteComment(deps: Deps, auth: AuthContext, id: string) {
  const r = await deps.db.get<CommentRow>(sql`select c.* from item_comments c where c.id = ${id} and c.org_id = ${auth.orgId} and c.deleted_at is null and ${teamVisible(auth)}`);
  if (!r) throw notFound("Comment");
  if (r.author_user_id !== auth.userId && !isAdmin(auth)) throw forbidden("Only the author or an admin can delete a comment.");
  await deps.db.run(sql`update item_comments set deleted_at = ${deps.now().getTime()} where id = ${r.id}`);
  return { ok: true };
}

// ---------- client side ----------

export interface ClientPerson { id: string; name: string | null; email: string }

/** The client's view of one thread: public comments in their own portal, and private ones to or from them. */
export async function clientComments(deps: Deps, p: PortalRow, person: ClientPerson, it: { kind: string; ref_id: string }): Promise<Td9Comment[]> {
  const rows = await deps.db.all<CommentRow>(sql`select c.* from item_comments c where c.org_id = ${p.org_id} and c.portal_id = ${p.id} and c.target_kind = ${it.kind} and c.target_id = ${it.ref_id} and c.deleted_at is null
    and ((c.to_user_id is null and c.to_person_id is null) or c.to_person_id = ${person.id} or c.author_person_id = ${person.id}) order by c.created_at limit 500`);
  return rows.map((r) => {
    const me = r.author_person_id === person.id;
    return {
      id: r.id, body: r.body, at: iso(Number(r.created_at)), author: { name: me ? "You" : r.author_name, client: !!r.author_person_id, me },
      privateLabel: r.to_person_id === person.id ? `Only you and ${r.author_name}` : null, canDelete: false,
    };
  });
}

/** One shared item the client may open, with their level for its area. 404 for another portal's item or an area set to None. */
export async function clientItem(deps: Deps, p: PortalRow, person: ClientPerson, itemId: string, kinds: string[]) {
  const it = await deps.db.get<ItemLite>(sql`select * from client_portal_items where id = ${itemId} and portal_id = ${p.id} and removed_at is null`);
  if (!it || !kinds.includes(it.kind)) throw notFound("Item");
  const levels = await levelsFor(deps, person.id);
  const level = levels[areaOf(it.kind)];
  if (!canView(level)) throw notFound("Item");
  return { it, level, levels };
}

export async function clientComment(deps: Deps, p: PortalRow, person: ClientPerson, itemId: string, raw: string) {
  if (p.archived_at) throw notFound("Item");
  const { it, level } = await clientItem(deps, p, person, itemId, ["task", "project"]);
  if (!canComment(level)) throw forbidden("You can read this but not comment.");
  const body = cleanBody(raw);
  await insertComment(deps, { org_id: p.org_id, target_kind: it.kind as "task" | "project", target_id: it.ref_id, portal_id: p.id, author_user_id: null, author_person_id: person.id, author_name: person.name || person.email, to_user_id: null, to_person_id: null, body });
  await notify(deps, p.org_id, p.created_by, { type: "portal.message", entityType: "client_portal", entityId: p.id, title: `${person.name || person.email} commented in ${p.name}`, actorName: person.name || person.email }).catch(() => undefined);
  await deps.db.run(sql`update client_portals set last_client_at = ${deps.now().getTime()}, updated_at = ${deps.now().getTime()} where id = ${p.id}`);
  return it;
}

export interface ProjectView {
  title: string; description: string; progress: { done: number; total: number; pct: number };
  milestones: Td9Milestone[];
  tasks: { id: string; title: string; state: "todo" | "doing" | "done"; due: string | null }[] | null;
  files: { id: string; title: string; bytes: number | null }[] | null;
  comments: Td9Comment[]; canComment: boolean; updatedAt: string;
}

/** The live project view: read now on every request, so the page is never stale by more than one poll. */
export async function clientProject(deps: Deps, p: PortalRow, person: ClientPerson, itemId: string): Promise<ProjectView> {
  const { it, level, levels } = await clientItem(deps, p, person, itemId, ["project"]);
  const pr = await deps.db.get<{ name: string; description: string }>(sql`select name, description from projects where id = ${it.ref_id} and org_id = ${p.org_id} and deleted_at is null`);
  if (!pr) throw notFound("Item");
  const now = deps.now().getTime();
  const [prog, milestones, tasks, files, comments] = await Promise.all([
    deps.db.get<{ done: number; total: number }>(sql`select sum(case when status = 'done' then 1 else 0 end) as done, count(*) as total from tasks where org_id = ${p.org_id} and project_id = ${it.ref_id} and deleted_at is null and parent_id is null`),
    milestonesOf(deps, p.org_id, it.ref_id),
    canView(levels.tasks) ? deps.db.all<{ id: string; title: string; status: "todo" | "doing" | "done"; due_at: number | null }>(sql`select i.id, t.title, t.status, t.due_at from client_portal_items i join tasks t on t.id = i.ref_id and t.org_id = i.org_id and t.deleted_at is null
      where i.portal_id = ${p.id} and i.kind = 'task' and i.removed_at is null and t.project_id = ${it.ref_id} order by t.status = 'done', t.due_at is null, t.due_at limit 200`) : null,
    canView(levels.files) ? deps.db.all<{ id: string; title: string; bytes: number | null }>(sql`select i.id, i.title, i.bytes from client_portal_items i join tool_files f on f.id = i.ref_id and f.org_id = i.org_id and f.deleted_at is null and f.expires_at > ${now}
      where i.portal_id = ${p.id} and i.kind = 'file' and i.removed_at is null and i.project_id = ${it.ref_id} order by i.created_at desc limit 200`) : null,
    clientComments(deps, p, person, it),
  ]);
  const done = Number(prog?.done ?? 0), total = Number(prog?.total ?? 0);
  return {
    title: pr.name, description: pr.description ?? "", progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 }, milestones,
    tasks: tasks ? tasks.map((t) => ({ id: t.id, title: t.title, state: t.status, due: t.due_at ? iso(Number(t.due_at)) : null })) : null,
    files: files ?? null, comments, canComment: canComment(level), updatedAt: iso(now),
  };
}

/** A shared task's page for the client: its state and its thread. */
export async function clientTask(deps: Deps, p: PortalRow, person: ClientPerson, itemId: string) {
  const { it, level } = await clientItem(deps, p, person, itemId, ["task"]);
  const t = await deps.db.get<{ title: string; status: "todo" | "doing" | "done"; due_at: number | null }>(sql`select title, status, due_at from tasks where id = ${it.ref_id} and org_id = ${p.org_id} and deleted_at is null`);
  if (!t) throw notFound("Item");
  return { title: t.title, state: t.status, due: t.due_at ? iso(Number(t.due_at)) : null, comments: await clientComments(deps, p, person, it), canComment: canComment(level) };
}
