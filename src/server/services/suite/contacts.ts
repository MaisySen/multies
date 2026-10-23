/**
 * Contacts and companies built from mail, and a simple deals pipeline.
 * Every correspondent outside the workspace becomes a contact the first time mail
 * goes either way; work domains become companies. Free mail domains never do.
 */
import { and, asc, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { aliases, appSettings, companies, contacts, deals, domains, mailboxes, messages, tasks } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { assertWritable, createdBy, iso, scopeOf, parseDate, recordWrite, sortableId, timeline, type SuiteActor } from "./common";

const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.com.au", "live.com", "live.com.au", "msn.com", "yahoo.com", "yahoo.com.au", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "zoho.com", "fastmail.com", "bigpond.com", "bigpond.net.au",
  "optusnet.com.au", "iinet.net.au", "tpg.com.au", "westnet.com.au", "internode.on.net", "dodo.com.au", "outlook.com.au", "mail.com", "hey.com",
]);
const ROBOT = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notif(y|ications?)|alerts?|receipts?|calendar|dmarc(-?reports?)?|reports?|digest|updates|newsletters?|news)([+._-].*)?@/i;

export const isFreeMail = (domain: string) => FREE_MAIL.has(domain.toLowerCase());

/** "harbourcoffee.com.au" to "Harbourcoffee". */
export function companyNameFromDomain(domain: string) {
  const label = domain.toLowerCase().split(".")[0] ?? domain;
  return label.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || domain;
}

/** Addresses on the workspace's own domains are teammates and agents, not contacts. */
async function ownDomains(deps: Deps, orgId: string) {
  const rows = await deps.db.select({ name: domains.name }).from(domains).where(eq(domains.orgId, orgId));
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

async function isOwnAddress(deps: Deps, orgId: string, address: string, own?: Set<string>) {
  const domain = address.split("@")[1]?.toLowerCase() ?? "";
  if ((own ?? (await ownDomains(deps, orgId))).has(domain)) return true;
  const [mb, al] = await Promise.all([
    deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address))).get(),
    deps.db.select({ id: aliases.id }).from(aliases).where(and(eq(aliases.orgId, orgId), eq(aliases.address, address))).get(),
  ]);
  return !!mb || !!al;
}

async function ensureCompany(deps: Deps, a: SuiteActor, domain: string) {
  const d = domain.toLowerCase();
  if (!d || isFreeMail(d)) return null;
  const existing = await deps.db.select({ id: companies.id }).from(companies).where(and(eq(companies.orgId, a.orgId), eq(companies.domain, d))).get();
  if (existing) return existing.id;
  const now = deps.now();
  const id = sortableId("cmp", now.getTime());
  const inserted = await deps.db.insert(companies).values({ id, orgId: a.orgId, name: companyNameFromDomain(d), domain: d, ...createdBy(a), createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ id: companies.id });
  if (!inserted.length) return (await deps.db.select({ id: companies.id }).from(companies).where(and(eq(companies.orgId, a.orgId), eq(companies.domain, d))).get())?.id ?? null;
  await recordWrite(deps, a, { entityType: "company", entityId: id, op: "create", verb: "created_from_email", data: { domain: d } });
  return id;
}

const system = (orgId: string): SuiteActor => ({ orgId, userId: "", email: "system", name: "MyMail", system: true });

/**
 * Called whenever mail is stored: each outside correspondent gets (or updates) a contact.
 * Returns the ids touched. Never throws into mail delivery.
 */
export async function upsertFromMail(deps: Deps, orgId: string, people: { address: string; name?: string }[], at: Date) {
  const out: string[] = [];
  try {
    const own = await ownDomains(deps, orgId);
    const seen = new Set<string>();
    for (const p of people) {
      const email = p.address?.trim().toLowerCase();
      if (!email || !email.includes("@") || seen.has(email) || ROBOT.test(email)) continue;
      seen.add(email);
      if (await isOwnAddress(deps, orgId, email, own)) continue;
      const name = (p.name ?? "").replace(/^["']|["']$/g, "").trim();
      const existing = await deps.db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.email, email))).get();
      if (existing) {
        await deps.db.update(contacts).set({
          messageCount: sql`${contacts.messageCount} + 1`,
          lastContactAt: !existing.lastContactAt || existing.lastContactAt < at ? at : existing.lastContactAt,
          firstContactAt: !existing.firstContactAt || existing.firstContactAt > at ? at : existing.firstContactAt,
          ...(name && !existing.name ? { name } : {}),
          ...(existing.deletedAt ? {} : {}),
          updatedAt: deps.now(),
        }).where(eq(contacts.id, existing.id));
        out.push(existing.id);
        continue;
      }
      const a = system(orgId);
      const companyId = await ensureCompany(deps, a, email.split("@")[1] ?? "");
      const now = deps.now();
      const id = sortableId("con", now.getTime());
      const ins = await deps.db.insert(contacts).values({ id, orgId, companyId, name, email, source: "mail", messageCount: 1, firstContactAt: at, lastContactAt: at, ...createdBy(a), createdAt: now, updatedAt: now })
        .onConflictDoNothing().returning({ id: contacts.id });
      if (!ins.length) continue;
      out.push(id);
      await recordWrite(deps, a, { entityType: "contact", entityId: id, op: "create", verb: "created_from_email", data: { email }, event: "contact.created", eventData: { id, email, name, companyId } });
    }
  } catch (err) {
    deps.reportError?.(err, { where: "contacts.upsertFromMail" });
  }
  return out;
}

/** Builds contacts from mail the workspace already has (runs once per workspace, in pages). */
/** Workspaces whose first backfill is known done, per database, so the contacts list skips the check. */
const backfilled = new WeakMap<object, Set<string>>();
const seen = (deps: Deps) => { let s = backfilled.get(deps.db); if (!s) backfilled.set(deps.db, (s = new Set())); return s; };

export async function backfillContacts(deps: Deps, orgId: string, opts: { force?: boolean; max?: number } = {}) {
  const key = `contacts_backfill:${orgId}`;
  if (!opts.force) {
    if (seen(deps).has(orgId)) return { skipped: true, created: 0 };
    const done = await deps.db.select().from(appSettings).where(eq(appSettings.key, key)).get();
    if (done) { seen(deps).add(orgId); return { skipped: true, created: 0 }; }
  }
  const rows = await deps.db.select({ folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName, to: messages.to, cc: messages.cc, date: messages.date })
    .from(messages).where(and(eq(messages.orgId, orgId), sql`${messages.folder} not in ('drafts','spam','trash')`)).orderBy(desc(messages.date)).limit(opts.max ?? 2000);
  const own = await ownDomains(deps, orgId);
  const agg = new Map<string, { name: string; count: number; first: Date; last: Date }>();
  const add = (address: string, name: string | undefined, at: Date) => {
    const email = address?.trim().toLowerCase();
    if (!email || !email.includes("@") || ROBOT.test(email) || own.has(email.split("@")[1] ?? "")) return;
    const cur = agg.get(email);
    if (cur) { cur.count++; if (at < cur.first) cur.first = at; if (at > cur.last) cur.last = at; if (!cur.name && name) cur.name = name; }
    else agg.set(email, { name: name ?? "", count: 1, first: at, last: at });
  };
  for (const r of rows) {
    if (r.folder === "sent") for (const x of [...JSON.parse(r.to), ...JSON.parse(r.cc)] as { address: string; name?: string }[]) add(x.address, x.name, r.date);
    else add(r.fromAddress, r.fromName, r.date);
  }
  let created = 0;
  const a = system(orgId);
  const existing = new Map((await deps.db.select({ id: contacts.id, email: contacts.email, name: contacts.name }).from(contacts).where(eq(contacts.orgId, orgId))).map((r) => [r.email, r]));
  for (const [email, v] of agg) {
    const had = existing.get(email);
    if (had) {
      if (!had.name && v.name) await deps.db.update(contacts).set({ name: v.name, updatedAt: deps.now() }).where(eq(contacts.id, had.id));
      continue;
    }
    if (await isOwnAddress(deps, orgId, email, own)) continue;
    const companyId = await ensureCompany(deps, a, email.split("@")[1] ?? "");
    const now = deps.now();
    const id = sortableId("con", now.getTime());
    await deps.db.insert(contacts).values({ id, orgId, companyId, name: v.name, email, source: "mail", messageCount: v.count, firstContactAt: v.first, lastContactAt: v.last, ...createdBy(a), createdAt: now, updatedAt: now }).onConflictDoNothing();
    await recordWrite(deps, a, { entityType: "contact", entityId: id, op: "create", verb: "created_from_email", data: { email } });
    created++;
  }
  await deps.db.insert(appSettings).values({ key, value: deps.now().toISOString() }).onConflictDoUpdate({ target: appSettings.key, set: { value: deps.now().toISOString() } });
  seen(deps).add(orgId);
  return { skipped: false, created };
}

type ContactRow = typeof contacts.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

function presentContact(c: ContactRow, company?: Pick<CompanyRow, "id" | "name" | "domain"> | null) {
  return {
    id: c.id, name: c.name, email: c.email, phone: c.phone, title: c.title, notes: c.notes, source: c.source,
    company: company ? { id: company.id, name: company.name, domain: company.domain } : null, companyId: c.companyId,
    messageCount: c.messageCount, firstContactAt: iso(c.firstContactAt), lastContactAt: iso(c.lastContactAt),
    createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), version: c.version,
  };
}
export type Contact = ReturnType<typeof presentContact>;

async function companyMap(deps: Deps, ids: (string | null)[]) {
  const list = [...new Set(ids.filter(Boolean) as string[])];
  if (!list.length) return new Map<string, CompanyRow>();
  return new Map((await deps.db.select().from(companies).where(inArray(companies.id, list))).map((c) => [c.id, c]));
}

export async function listContacts(deps: Deps, orgId: string, q: { q?: string; companyId?: string; limit?: number; offset?: number } = {}) {
  await backfillContacts(deps, orgId);
  const conds = [eq(contacts.orgId, orgId), isNull(contacts.deletedAt)];
  if (q.companyId) conds.push(eq(contacts.companyId, q.companyId));
  if (q.q) conds.push(or(like(contacts.name, `%${q.q}%`), like(contacts.email, `%${q.q}%`))!);
  // One round trip for the page with its companies, and the count beside it.
  const [rows, total] = await Promise.all([
    deps.db.select({ c: contacts, co: companies }).from(contacts).leftJoin(companies, eq(companies.id, contacts.companyId)).where(and(...conds))
      .orderBy(sql`${contacts.lastContactAt} desc nulls last`, asc(contacts.email)).limit(Math.min(q.limit ?? 100, 500)).offset(q.offset ?? 0),
    deps.db.select({ n: sql<number>`count(*)` }).from(contacts).where(and(...conds)).get(),
  ]);
  return { contacts: rows.map((r) => presentContact(r.c, r.co)), total: Number(total?.n ?? rows.length) };
}

export async function contactsByIds(deps: Deps, orgId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await deps.db.select().from(contacts).where(and(eq(contacts.orgId, orgId), inArray(contacts.id, ids), isNull(contacts.deletedAt)));
  const cm = await companyMap(deps, rows.map((r) => r.companyId));
  return rows.map((r) => presentContact(r, r.companyId ? cm.get(r.companyId) : null));
}

export async function contactIdFor(deps: Deps, orgId: string, address: string) {
  const r = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.email, address.toLowerCase()), isNull(contacts.deletedAt))).get();
  return r?.id ?? null;
}

async function contactRow(deps: Deps, orgId: string, idOrEmail: string) {
  const c = await deps.db.select().from(contacts).where(and(eq(contacts.orgId, orgId), isNull(contacts.deletedAt), idOrEmail.includes("@") ? eq(contacts.email, idOrEmail.toLowerCase()) : eq(contacts.id, idOrEmail))).get();
  if (!c) throw notFound("Contact");
  return c;
}

/** Threads with this person, newest first, within the mailboxes the viewer can open. */
async function threadsWith(deps: Deps, orgId: string, email: string, scope: string[] | null, limit = 50) {
  const pattern = `%"address":"${email.replace(/[%_"]/g, "")}"%`;
  const rows = await deps.db.select({ threadId: messages.threadId, subject: messages.subject, date: messages.date, folder: messages.folder, mailboxId: messages.mailboxId, snippet: messages.snippet, id: messages.id })
    .from(messages).where(and(eq(messages.orgId, orgId), sql`${messages.folder} not in ('drafts','trash')`,
      or(eq(sql`lower(${messages.fromAddress})`, email), like(sql`lower(${messages.to})`, pattern), like(sql`lower(${messages.cc})`, pattern)),
      scope ? inArray(messages.mailboxId, scope.length ? scope : ["-"]) : undefined))
    .orderBy(desc(messages.date)).limit(400);
  const byThread = new Map<string, { threadId: string; subject: string; lastAt: Date; firstAt: Date; count: number; lastDirection: "inbound" | "outbound"; snippet: string; messageId: string; mailboxId: string }>();
  for (const r of rows) {
    const t = byThread.get(r.threadId);
    if (t) { t.count++; if (r.date < t.firstAt) t.firstAt = r.date; continue; }
    byThread.set(r.threadId, { threadId: r.threadId, subject: r.subject, lastAt: r.date, firstAt: r.date, count: 1, lastDirection: r.folder === "sent" ? "outbound" : "inbound", snippet: r.snippet, messageId: r.id, mailboxId: r.mailboxId });
  }
  return [...byThread.values()].slice(0, limit).map((t) => ({ ...t, lastAt: t.lastAt.toISOString(), firstAt: t.firstAt.toISOString() }));
}

export async function contactDetail(deps: Deps, actor: SuiteActor & { role?: "owner" | "admin" | "member" }, idOrEmail: string) {
  const c = await contactRow(deps, actor.orgId, idOrEmail);
  const scope = await scopeOf(deps, actor);
  const { linked, listTasks } = await import("./tasks");
  const [company, threads, linkedTaskIds, contactDeals, history] = await Promise.all([
    c.companyId ? deps.db.select().from(companies).where(eq(companies.id, c.companyId)).get() : Promise.resolve(undefined),
    threadsWith(deps, actor.orgId, c.email, scope),
    linked(deps, actor.orgId, "contact", c.id, "task"),
    deps.db.select().from(deals).where(and(eq(deals.orgId, actor.orgId), eq(deals.contactId, c.id), isNull(deals.deletedAt))),
    timeline(deps, actor.orgId, "contact", c.id, 50),
  ]);
  const threadIds = threads.map((t) => t.threadId);
  const fromThreads = threadIds.length ? await deps.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, actor.orgId), inArray(tasks.threadId, threadIds.slice(0, 200)), isNull(tasks.deletedAt))) : [];
  const taskIds = [...new Set([...linkedTaskIds, ...fromThreads.map((t) => t.id)])];
  const all = taskIds.length ? (await listTasks(deps, actor, { includeSubtasks: true, limit: 1000 })).filter((t) => taskIds.includes(t.id)) : [];
  // One merged timeline: threads, tasks and deals, newest first.
  const items = [
    ...threads.map((t) => ({ kind: "thread" as const, at: t.lastAt, thread: t })),
    ...all.map((t) => ({ kind: "task" as const, at: t.createdAt, task: t })),
    ...contactDeals.map((d) => ({ kind: "deal" as const, at: d.updatedAt.toISOString(), deal: presentDeal(d) })),
  ].sort((x, y) => (x.at < y.at ? 1 : -1));
  return { contact: presentContact(c, company ?? null), threads, tasks: all, deals: contactDeals.map(presentDeal), timeline: items, activity: history };
}

export async function createContact(deps: Deps, actor: SuiteActor, input: { email: string; name?: string; phone?: string; title?: string; notes?: string; companyId?: string | null }) {
  assertWritable(actor);
  const email = input.email.trim().toLowerCase();
  const exists = await deps.db.select({ id: contacts.id, deletedAt: contacts.deletedAt }).from(contacts).where(and(eq(contacts.orgId, actor.orgId), eq(contacts.email, email))).get();
  if (exists && !exists.deletedAt) throw new HttpError(409, "contact_exists", "There's already a contact with that email.");
  const companyId = input.companyId !== undefined ? input.companyId : await ensureCompany(deps, actor, email.split("@")[1] ?? "");
  const now = deps.now();
  const id = exists?.id ?? sortableId("con", now.getTime());
  const values = { orgId: actor.orgId, companyId, name: input.name?.trim() ?? "", email, phone: input.phone ?? null, title: input.title ?? null, notes: input.notes ?? "", source: actor.agentId ? "agent" as const : "manual" as const, ...createdBy(actor), updatedAt: now, deletedAt: null };
  if (exists) await deps.db.update(contacts).set(values).where(eq(contacts.id, id));
  else await deps.db.insert(contacts).values({ id, ...values, createdAt: now });
  await recordWrite(deps, actor, { entityType: "contact", entityId: id, op: "create", verb: "created", data: { email }, event: "contact.created", eventData: { id, email, name: values.name, companyId } });
  return (await contactsByIds(deps, actor.orgId, [id]))[0];
}

export async function updateContact(deps: Deps, actor: SuiteActor, idOrEmail: string, patch: { name?: string; phone?: string | null; title?: string | null; notes?: string; companyId?: string | null }) {
  assertWritable(actor);
  const c = await contactRow(deps, actor.orgId, idOrEmail);
  if (patch.companyId) { const co = await deps.db.select({ id: companies.id }).from(companies).where(and(eq(companies.id, patch.companyId), eq(companies.orgId, actor.orgId))).get(); if (!co) throw notFound("Company"); }
  await deps.db.update(contacts).set({ ...patch, updatedAt: deps.now(), version: c.version + 1 }).where(eq(contacts.id, c.id));
  await recordWrite(deps, actor, { entityType: "contact", entityId: c.id, op: "update", version: c.version + 1, verb: "updated", data: { fields: Object.keys(patch) }, event: "contact.updated", eventData: { id: c.id, fields: Object.keys(patch) } });
  return (await contactsByIds(deps, actor.orgId, [c.id]))[0];
}

/** For agents: create the contact, or update it when the email is already known. */
export async function upsertContact(deps: Deps, actor: SuiteActor, input: { email: string; name?: string; phone?: string; title?: string; notes?: string }) {
  const id = await contactIdFor(deps, actor.orgId, input.email);
  if (!id) return createContact(deps, actor, input);
  const { email: _e, ...patch } = input;
  void _e;
  return updateContact(deps, actor, id, patch);
}

export async function deleteContact(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  const c = await contactRow(deps, actor.orgId, id);
  await deps.db.update(contacts).set({ deletedAt: deps.now(), updatedAt: deps.now(), version: c.version + 1 }).where(eq(contacts.id, c.id));
  await recordWrite(deps, actor, { entityType: "contact", entityId: c.id, op: "delete", verb: "deleted", data: { email: c.email } });
  return { ok: true };
}

export async function listCompanies(deps: Deps, orgId: string, q: { q?: string } = {}) {
  await backfillContacts(deps, orgId);
  const rows = await deps.db.select({ c: companies, n: sql<number>`(select count(*) from contacts where contacts.company_id = ${companies.id} and contacts.deleted_at is null)`, last: sql<number | null>`(select max(last_contact_at) from contacts where contacts.company_id = ${companies.id})` })
    .from(companies).where(and(eq(companies.orgId, orgId), isNull(companies.deletedAt), q.q ? or(like(companies.name, `%${q.q}%`), like(companies.domain, `%${q.q}%`)) : undefined))
    .orderBy(sql`3 desc nulls last`).limit(500);
  return rows.map((r) => ({ id: r.c.id, name: r.c.name, domain: r.c.domain, notes: r.c.notes, contactCount: Number(r.n), lastContactAt: r.last ? new Date(Number(r.last)).toISOString() : null }));
}

export async function getCompany(deps: Deps, orgId: string, id: string) {
  const c = await deps.db.select().from(companies).where(and(eq(companies.id, id), eq(companies.orgId, orgId), isNull(companies.deletedAt))).get();
  if (!c) throw notFound("Company");
  const people = await listContacts(deps, orgId, { companyId: id, limit: 200 });
  const ds = await deps.db.select().from(deals).where(and(eq(deals.orgId, orgId), eq(deals.companyId, id), isNull(deals.deletedAt)));
  return { company: { id: c.id, name: c.name, domain: c.domain, notes: c.notes }, contacts: people.contacts, deals: ds.map(presentDeal) };
}

export async function updateCompany(deps: Deps, actor: SuiteActor, id: string, patch: { name?: string; notes?: string }) {
  assertWritable(actor);
  const c = await deps.db.select().from(companies).where(and(eq(companies.id, id), eq(companies.orgId, actor.orgId))).get();
  if (!c) throw notFound("Company");
  await deps.db.update(companies).set({ ...patch, updatedAt: deps.now(), version: c.version + 1 }).where(eq(companies.id, id));
  await recordWrite(deps, actor, { entityType: "company", entityId: id, op: "update", verb: "updated", data: { fields: Object.keys(patch) } });
  return getCompany(deps, actor.orgId, id);
}

// ---------------------------------------------------------------- deals

export const DEAL_STAGES = [
  { id: "lead", name: "Lead" },
  { id: "qualified", name: "Qualified" },
  { id: "proposal", name: "Proposal sent" },
  { id: "won", name: "Won" },
  { id: "lost", name: "Lost" },
] as const;
export type DealStage = (typeof DEAL_STAGES)[number]["id"];

type DealRow = typeof deals.$inferSelect;
function presentDeal(d: DealRow) {
  return { id: d.id, title: d.title, stage: d.stage, value: d.valueCents / 100, valueCents: d.valueCents, currency: "AUD", contactId: d.contactId, companyId: d.companyId, ownerUserId: d.ownerUserId, expectedClose: iso(d.expectedCloseAt), position: d.position, createdAt: d.createdAt.toISOString(), updatedAt: d.updatedAt.toISOString(), version: d.version };
}
export type Deal = ReturnType<typeof presentDeal>;

export async function listDeals(deps: Deps, orgId: string) {
  const rows = await deps.db.select().from(deals).where(and(eq(deals.orgId, orgId), isNull(deals.deletedAt))).orderBy(asc(deals.position));
  const people = await contactsByIds(deps, orgId, [...new Set(rows.map((r) => r.contactId).filter(Boolean) as string[])]);
  const cm = await companyMap(deps, rows.map((r) => r.companyId));
  return {
    stages: DEAL_STAGES.map((s) => ({ ...s, total: rows.filter((r) => r.stage === s.id).reduce((n, r) => n + r.valueCents, 0) / 100 })),
    deals: rows.map((r) => ({ ...presentDeal(r), contact: people.find((p) => p.id === r.contactId) ?? null, company: r.companyId && cm.get(r.companyId) ? { id: r.companyId, name: cm.get(r.companyId)!.name } : null })),
  };
}

async function dealRow(deps: Deps, orgId: string, id: string) {
  const d = await deps.db.select().from(deals).where(and(eq(deals.id, id), eq(deals.orgId, orgId), isNull(deals.deletedAt))).get();
  if (!d) throw notFound("Deal");
  return d;
}

export async function createDeal(deps: Deps, actor: SuiteActor, input: { title: string; stage?: DealStage; value?: number; contactId?: string | null; companyId?: string | null; expectedClose?: string | null }) {
  assertWritable(actor);
  let companyId = input.companyId ?? null;
  if (input.contactId) { const c = await contactRow(deps, actor.orgId, input.contactId); companyId = companyId ?? c.companyId; }
  const now = deps.now();
  const id = sortableId("del", now.getTime());
  const max = await deps.db.select({ p: sql<number>`coalesce(max(${deals.position}), 0)` }).from(deals).where(and(eq(deals.orgId, actor.orgId), eq(deals.stage, input.stage ?? "lead"))).get();
  await deps.db.insert(deals).values({ id, orgId: actor.orgId, title: input.title.trim(), stage: input.stage ?? "lead", valueCents: Math.round((input.value ?? 0) * 100), contactId: input.contactId ?? null, companyId, ownerUserId: actor.userId || null, expectedCloseAt: parseDate(input.expectedClose), position: Number(max?.p ?? 0) + 1024, ...createdBy(actor), createdAt: now, updatedAt: now });
  const deal = presentDeal(await dealRow(deps, actor.orgId, id));
  await recordWrite(deps, actor, { entityType: "deal", entityId: id, op: "create", verb: "created", data: { title: deal.title }, event: "deal.created", eventData: { deal } });
  if (deal.contactId) await recordWrite(deps, actor, { entityType: "contact", entityId: deal.contactId, op: "update", verb: "deal_created", data: { dealId: id, title: deal.title } });
  return deal;
}

export async function updateDeal(deps: Deps, actor: SuiteActor, id: string, patch: { title?: string; stage?: DealStage; value?: number; contactId?: string | null; companyId?: string | null; expectedClose?: string | null; position?: number }) {
  assertWritable(actor);
  const d = await dealRow(deps, actor.orgId, id);
  await deps.db.update(deals).set({
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
    ...(patch.value !== undefined ? { valueCents: Math.round(patch.value * 100) } : {}),
    ...(patch.contactId !== undefined ? { contactId: patch.contactId } : {}),
    ...(patch.companyId !== undefined ? { companyId: patch.companyId } : {}),
    ...(patch.expectedClose !== undefined ? { expectedCloseAt: parseDate(patch.expectedClose) } : {}),
    ...(patch.position !== undefined ? { position: patch.position } : {}),
    updatedAt: deps.now(), version: d.version + 1,
  }).where(eq(deals.id, id));
  const deal = presentDeal(await dealRow(deps, actor.orgId, id));
  await recordWrite(deps, actor, { entityType: "deal", entityId: id, op: "update", version: deal.version, verb: patch.stage && patch.stage !== d.stage ? "moved" : "updated", data: patch.stage ? { from: d.stage, to: patch.stage } : { fields: Object.keys(patch) }, event: "deal.updated", eventData: { deal } });
  return deal;
}

export async function deleteDeal(deps: Deps, actor: SuiteActor, id: string) {
  assertWritable(actor);
  await dealRow(deps, actor.orgId, id);
  await deps.db.update(deals).set({ deletedAt: deps.now(), updatedAt: deps.now() }).where(eq(deals.id, id));
  await recordWrite(deps, actor, { entityType: "deal", entityId: id, op: "delete", verb: "deleted" });
  return { ok: true };
}
