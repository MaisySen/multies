/**
 * TD4: time to invoice (flag BILL_TD4 with INVOICES_ENABLED). A billing run takes unbilled, billable, stopped time on one
 * project in a date range, groups it by person and task at the right rate, and creates a DRAFT invoice in the existing
 * R105 invoices. The included entries are locked to that invoice (time_entries.billed_doc_id) by a conditional update, so
 * two runs at once can never bill the same time; a billed entry can not be edited or deleted. Deleting the draft or
 * voiding the invoice releases the time (src/server/services/invoices/bill-release-td4.ts), with an audit entry.
 * Owners and admins only: rates and amounts are manager data. Money is integer cents. Never touches Stripe or plans.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { billProjects, billRates, billRuns, contacts, invoiceDocs, invoiceLines, organizations, projects, tasks, timeEntries, users, agents } from "../../db/schema";
import { HttpError, notFound } from "../../lib/errors";
import { audit } from "../audit";
import { isAskExcluded } from "../ask-r110";
import { sortableId, type SuiteActor } from "../suite/common";
import { createDoc } from "./invoices";
import { zonedTime } from "@/shared/campaigns-r109";
import { CURRENCIES, divRound } from "@/shared/invoices";
import { csvCell } from "@/shared/expenses";
import {
  billTimeOn, MAX_RATE_CENTS, MAX_RUN_DAYS, MAX_RUN_ENTRIES, ROUNDINGS, groupRun, lineDescription, pickRate, roundSeconds, validDate, type RunEntry,
} from "@/shared/bill-time-td4";

export type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
const WS = ""; // the workspace default row in bill_projects and bill_rates
const CHUNK = 80; // ids per conditional update (D1 bound parameter limit is 100)

export { billTimeOn };

/** 404 when the feature is off or this is the client portal workspace; 403 for members. */
export async function guard(deps: Deps, a: Actor) {
  if (!billTimeOn(deps.config)) throw notFound("Page");
  const [o] = await deps.db.all<{ id: string; slug: string | null; name: string | null }>(sql`select id, slug, name from organizations where id = ${a.orgId} limit 1`);
  if (!o || isAskExcluded(o)) throw notFound("Page");
  if (a.role !== "owner" && a.role !== "admin") throw new HttpError(403, "billing_only", "Only owners and admins can bill time.");
}

const personKeyOf = (t: string, id: string) => `${t}:${id}`;

async function orgTz(deps: Deps, orgId: string) {
  const o = await deps.db.select({ tz: organizations.timezone }).from(organizations).where(eq(organizations.id, orgId)).get();
  return o?.tz || "Australia/Sydney";
}

/** The range [from 00:00, to + 1 day 00:00) in the workspace's time zone. */
export function rangeOf(from: string, to: string, tz: string) {
  if (!validDate(from) || !validDate(to)) throw new HttpError(422, "validation_failed", "Pick a start and end date.");
  if (to < from) throw new HttpError(422, "validation_failed", "The end date is before the start date.");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_RUN_DAYS) throw new HttpError(422, "validation_failed", "Pick a range of a year or less.");
  const [fy, fm, fd] = from.split("-").map(Number);
  const n = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1));
  return { start: new Date(zonedTime(tz, fy, fm, fd, 0)), end: new Date(zonedTime(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0)) };
}

async function projectRow(deps: Deps, orgId: string, projectId: string) {
  const p = await deps.db.select({ id: projects.id, name: projects.name, key: projects.key, color: projects.color }).from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).get();
  if (!p) throw notFound("Project");
  return p;
}

async function contactRow(deps: Deps, orgId: string, id: string | null | undefined) {
  if (!id) return null;
  const c = await deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, id), isNull(contacts.deletedAt))).get();
  return c ?? null;
}

interface RateBook { ws: { rateCents: number | null; currency: string; rounding: number; contactId: string | null } | null; proj: Map<string, { rateCents: number | null; currency: string; rounding: number; contactId: string | null }>; person: Map<string, number> }

async function rateBook(deps: Deps, orgId: string, projectIds: string[]): Promise<RateBook> {
  const ids = [...new Set([WS, ...projectIds])].slice(0, 90);
  const [ps, rs] = await Promise.all([
    deps.db.select().from(billProjects).where(and(eq(billProjects.orgId, orgId), inArray(billProjects.projectId, ids))).all(),
    deps.db.select().from(billRates).where(and(eq(billRates.orgId, orgId), inArray(billRates.projectId, ids))).limit(2000).all(),
  ]);
  const proj = new Map(ps.map((p) => [p.projectId, { rateCents: p.rateCents, currency: p.currency, rounding: p.rounding, contactId: p.contactId }]));
  return { ws: proj.get(WS) ?? null, proj, person: new Map(rs.map((r) => [`${r.projectId}|${r.personId}`, r.rateCents])) };
}

function rateFor(b: RateBook, projectId: string, personKey: string): number | null {
  return pickRate({ personProject: b.person.get(`${projectId}|${personKey}`), person: b.person.get(`${WS}|${personKey}`), project: b.proj.get(projectId)?.rateCents, workspace: b.ws?.rateCents });
}

const live = (orgId: string) => and(eq(timeEntries.orgId, orgId), eq(timeEntries.billable, true), isNull(timeEntries.billedDocId), isNull(timeEntries.deletedAt), isNotNull(timeEntries.endedAt));

async function names(deps: Deps, rows: { personType: string; personId: string; taskId: string | null }[], orgId: string) {
  const mids = [...new Set(rows.filter((r) => r.personType === "member").map((r) => r.personId))].slice(0, 90);
  const aids = [...new Set(rows.filter((r) => r.personType === "agent").map((r) => r.personId))].slice(0, 90);
  const tids = [...new Set(rows.map((r) => r.taskId).filter(Boolean) as string[])];
  const tchunks: string[][] = [];
  for (let i = 0; i < tids.length; i += 90) tchunks.push(tids.slice(i, i + 90));
  const [us, ags, ...ts] = await Promise.all([
    mids.length ? deps.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, mids)).all() : [],
    aids.length ? deps.db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.orgId, orgId), inArray(agents.id, aids))).all() : [],
    ...tchunks.map((c) => deps.db.select({ id: tasks.id, number: tasks.number, title: tasks.title, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, c))).all()),
  ]);
  const person = new Map<string, string>([...us.map((u) => [personKeyOf("member", u.id), u.name || u.email] as [string, string]), ...ags.map((g) => [personKeyOf("agent", g.id), g.name] as [string, string])]);
  const task = new Map<string, { number: number; title: string }>(ts.flat().map((t) => [t.id, { number: t.number, title: t.title }]));
  return { person, task };
}

export interface PreviewQuery { projectId: string; from: string; to: string; rounding?: number }

/** Unbilled billable time for one project in a range, grouped by person and task with rates. Max 500 entries. */
export async function preview(deps: Deps, a: Actor, q: PreviewQuery) {
  await guard(deps, a);
  const p = await projectRow(deps, a.orgId, q.projectId);
  const tz = await orgTz(deps, a.orgId);
  const { start, end } = rangeOf(q.from, q.to, tz);
  const book = await rateBook(deps, a.orgId, [p.id]);
  const setup = book.proj.get(p.id);
  const rounding = q.rounding != null && (ROUNDINGS as readonly number[]).includes(q.rounding) ? q.rounding : setup?.rounding ?? book.ws?.rounding ?? 0;
  const rows = await deps.db.select({ id: timeEntries.id, taskId: timeEntries.taskId, personType: timeEntries.personType, personId: timeEntries.personId, startedAt: timeEntries.startedAt, seconds: timeEntries.seconds, note: timeEntries.note })
    .from(timeEntries).where(and(live(a.orgId), eq(timeEntries.projectId, p.id), gte(timeEntries.startedAt, start), lt(timeEntries.startedAt, end)))
    .orderBy(timeEntries.startedAt).limit(MAX_RUN_ENTRIES + 1).all();
  const tooMany = rows.length > MAX_RUN_ENTRIES;
  const use = rows.slice(0, MAX_RUN_ENTRIES);
  const nm = await names(deps, use, a.orgId);
  const entries = use.map((r) => {
    const pk = personKeyOf(r.personType, r.personId);
    const t = r.taskId ? nm.task.get(r.taskId) : undefined;
    return {
      id: r.id, date: r.startedAt.toISOString(), seconds: r.seconds, billedSeconds: roundSeconds(r.seconds, rounding), note: r.note,
      personKey: pk, personName: nm.person.get(pk) ?? (r.personType === "agent" ? "Removed agent" : "Former member"),
      taskKey: r.taskId ?? "", taskLabel: t ? `${p.key}-${t.number} ${t.title}`.slice(0, 200) : "General time", rateCents: rateFor(book, p.id, pk),
    };
  });
  const totals = groupRun(entries, rounding);
  const contactId = setup?.contactId ?? null;
  const contact = await contactRow(deps, a.orgId, contactId);
  const people = [...new Map(entries.map((e) => [e.personKey, e.personName])).entries()].map(([key, name]) => ({
    key, name, rateCents: rateFor(book, p.id, key), projectRateCents: book.person.get(`${p.id}|${key}`) ?? null, defaultRateCents: book.person.get(`${WS}|${key}`) ?? null,
  }));
  return {
    project: p, from: q.from, to: q.to, timeZone: tz, rounding, tooMany, max: MAX_RUN_ENTRIES,
    client: contact, currency: setup?.currency ?? book.ws?.currency ?? "AUD",
    projectRateCents: setup?.rateCents ?? null, workspaceRateCents: book.ws?.rateCents ?? null,
    people, entries, lines: totals.lines, totals: { seconds: totals.seconds, qtyMilli: totals.qtyMilli, amountCents: totals.amountCents, entryCount: totals.entryCount, missingRate: totals.missingRate },
  };
}

export interface SetupInput {
  projectId: string; contactId?: string | null; currency?: string; rateCents?: number | null; rounding?: number; workspaceRateCents?: number | null;
  personRates?: { personKey: string; rateCents: number | null; scope: "project" | "all" }[];
}

const okRate = (v: number | null | undefined) => v == null || (Number.isSafeInteger(v) && v >= 0 && v <= MAX_RATE_CENTS);

/** Client, currency, rounding and rates for a project (and the workspace default rate). */
export async function saveSetup(deps: Deps, a: Actor, s: SetupInput) {
  await guard(deps, a);
  const p = await projectRow(deps, a.orgId, s.projectId);
  if (!okRate(s.rateCents) || !okRate(s.workspaceRateCents) || !(s.personRates ?? []).every((r) => okRate(r.rateCents))) throw new HttpError(422, "validation_failed", "Rates must be between 0 and 100,000 an hour.");
  if (s.currency !== undefined && !(CURRENCIES as readonly string[]).includes(s.currency)) throw new HttpError(422, "validation_failed", "Pick a currency from the list.");
  if (s.rounding !== undefined && !(ROUNDINGS as readonly number[]).includes(s.rounding)) throw new HttpError(422, "validation_failed", "Pick a rounding from the list.");
  if (s.contactId && !(await contactRow(deps, a.orgId, s.contactId))) throw notFound("Client");
  const now = deps.now();
  const cur = await deps.db.select().from(billProjects).where(and(eq(billProjects.orgId, a.orgId), eq(billProjects.projectId, p.id))).get();
  const next = {
    orgId: a.orgId, projectId: p.id, contactId: s.contactId !== undefined ? s.contactId : cur?.contactId ?? null, currency: s.currency ?? cur?.currency ?? "AUD",
    rateCents: s.rateCents !== undefined ? s.rateCents : cur?.rateCents ?? null, rounding: s.rounding ?? cur?.rounding ?? 0, updatedBy: a.userId, updatedAt: now,
  };
  await deps.db.insert(billProjects).values(next).onConflictDoUpdate({ target: [billProjects.orgId, billProjects.projectId], set: { contactId: next.contactId, currency: next.currency, rateCents: next.rateCents, rounding: next.rounding, updatedBy: a.userId, updatedAt: now } });
  if (s.workspaceRateCents !== undefined) {
    await deps.db.insert(billProjects).values({ orgId: a.orgId, projectId: WS, rateCents: s.workspaceRateCents, currency: "AUD", rounding: 0, updatedBy: a.userId, updatedAt: now })
      .onConflictDoUpdate({ target: [billProjects.orgId, billProjects.projectId], set: { rateCents: s.workspaceRateCents, updatedBy: a.userId, updatedAt: now } });
  }
  for (const r of (s.personRates ?? []).slice(0, 100)) {
    if (!/^(member|agent):[A-Za-z0-9_-]{1,80}$/.test(r.personKey)) throw new HttpError(422, "validation_failed", "Unknown person.");
    const pid = r.scope === "all" ? WS : p.id;
    if (r.rateCents == null) await deps.db.delete(billRates).where(and(eq(billRates.orgId, a.orgId), eq(billRates.projectId, pid), eq(billRates.personId, r.personKey)));
    else await deps.db.insert(billRates).values({ orgId: a.orgId, projectId: pid, personId: r.personKey, rateCents: r.rateCents, updatedAt: now })
      .onConflictDoUpdate({ target: [billRates.orgId, billRates.projectId, billRates.personId], set: { rateCents: r.rateCents, updatedAt: now } });
  }
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "bill_time.rates_changed", targetType: "project", targetId: p.id, metadata: { people: (s.personRates ?? []).length } });
  return { ok: true };
}

export interface RunInput { projectId: string; from: string; to: string; rounding: number; entryIds: string[]; contactId?: string | null }

/** Create a draft invoice from the chosen entries and lock them to it. 409 when any of them was billed or changed meanwhile. */
export async function createRun(deps: Deps, a: Actor, r: RunInput) {
  await guard(deps, a);
  if (!(ROUNDINGS as readonly number[]).includes(r.rounding)) throw new HttpError(422, "validation_failed", "Pick a rounding from the list.");
  const ids = [...new Set(r.entryIds)].sort();
  if (!ids.length) throw new HttpError(422, "nothing_to_bill", "Tick at least one time entry.");
  if (ids.length > MAX_RUN_ENTRIES) throw new HttpError(422, "too_many", `Bill up to ${MAX_RUN_ENTRIES} entries at a time.`);
  const view = await preview(deps, a, { projectId: r.projectId, from: r.from, to: r.to, rounding: r.rounding });
  const byId = new Map(view.entries.map((e) => [e.id, e]));
  const picked = ids.map((id) => byId.get(id));
  if (picked.some((e) => !e)) throw new HttpError(409, "stale", "Some of this time was billed or changed just now. Refresh and try again.");
  const chosen = picked as RunEntry[];
  const totals = groupRun(chosen, r.rounding);
  if (totals.missingRate) throw new HttpError(422, "missing_rate", "Set a rate for everyone in this run first.");
  const contactId = r.contactId !== undefined ? r.contactId : view.client?.id ?? null;
  const contact = await contactRow(deps, a.orgId, contactId);
  if (contactId && !contact) throw notFound("Client");
  if (!contact) throw new HttpError(422, "no_client", "Pick the client to bill.");

  const lines = totals.lines.map((l) => ({ description: lineDescription(l.personName, l.taskLabel, r.from, r.to, r.rounding), quantityMilli: l.qtyMilli, unitCents: l.rateCents }));
  const doc = await createDoc(deps, a, "invoice", { contactId: contact.id, currency: view.currency, lines, reference: `${view.project.name} time ${r.from} to ${r.to}`.slice(0, 200) });
  const docId = doc.id;
  const now = deps.now();
  let claimed = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const got = await deps.db.update(timeEntries).set({ billedDocId: docId, billedAt: now })
      .where(and(live(a.orgId), eq(timeEntries.projectId, view.project.id), inArray(timeEntries.id, part))).returning({ id: timeEntries.id });
    claimed += got.length;
    if (got.length !== part.length) break;
  }
  if (claimed !== ids.length) {
    // Another run got some of this time first: give back what this run took and remove its draft.
    await deps.db.update(timeEntries).set({ billedDocId: null, billedAt: null }).where(and(eq(timeEntries.orgId, a.orgId), eq(timeEntries.billedDocId, docId)));
    await deps.db.delete(invoiceLines).where(and(eq(invoiceLines.orgId, a.orgId), eq(invoiceLines.docId, docId)));
    await deps.db.delete(invoiceDocs).where(and(eq(invoiceDocs.orgId, a.orgId), eq(invoiceDocs.id, docId), eq(invoiceDocs.status, "draft")));
    throw new HttpError(409, "stale", "Some of this time was billed or changed just now. Refresh and try again.");
  }
  const run = {
    id: sortableId("brun", now.getTime()), orgId: a.orgId, projectId: view.project.id, contactId: contact.id, docId, dateFrom: r.from, dateTo: r.to, rounding: r.rounding,
    entryCount: ids.length, seconds: totals.seconds, amountCents: totals.amountCents, currency: view.currency, status: "open" as const, createdBy: a.userId, createdAt: now,
  };
  await deps.db.insert(billRuns).values(run);
  if (!view.client || view.client.id !== contact.id) {
    await deps.db.insert(billProjects).values({ orgId: a.orgId, projectId: view.project.id, contactId: contact.id, currency: view.currency, updatedBy: a.userId, updatedAt: now })
      .onConflictDoUpdate({ target: [billProjects.orgId, billProjects.projectId], set: { contactId: contact.id, updatedAt: now } });
  }
  await audit(deps.db, { orgId: a.orgId, actorUserId: a.userId, actorEmail: a.email, action: "bill_time.run_created", targetType: "invoice", targetId: docId, metadata: { runId: run.id, entries: ids.length, seconds: totals.seconds } });
  return { run: presentRun(run, null, null), docId };
}

function presentRun(r: typeof billRuns.$inferSelect | (Omit<typeof billRuns.$inferSelect, "releasedAt" | "releasedBy" | "releaseReason">), docNumber: string | null, docStatus: string | null, projectName?: string | null, clientName?: string | null) {
  const rr = r as typeof billRuns.$inferSelect;
  return {
    id: rr.id, projectId: rr.projectId, projectName: projectName ?? null, clientName: clientName ?? null, docId: rr.docId, docNumber, docStatus, from: rr.dateFrom, to: rr.dateTo, rounding: rr.rounding,
    entryCount: rr.entryCount, seconds: rr.seconds, amountCents: rr.amountCents, currency: rr.currency, status: rr.status, createdAt: rr.createdAt.toISOString(),
    releasedAt: rr.releasedAt ? rr.releasedAt.toISOString() : null, releaseReason: rr.releaseReason ?? null,
  };
}

export async function listRuns(deps: Deps, a: Actor) {
  await guard(deps, a);
  const rows = await deps.db.select().from(billRuns).where(eq(billRuns.orgId, a.orgId)).orderBy(desc(billRuns.createdAt)).limit(50).all();
  if (!rows.length) return { runs: [] };
  const [docs, prs, cs] = await Promise.all([
    deps.db.select({ id: invoiceDocs.id, number: invoiceDocs.number, status: invoiceDocs.status }).from(invoiceDocs).where(and(eq(invoiceDocs.orgId, a.orgId), inArray(invoiceDocs.id, [...new Set(rows.map((r) => r.docId))]))).all(),
    deps.db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.orgId, a.orgId), inArray(projects.id, [...new Set(rows.map((r) => r.projectId))]))).all(),
    deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, a.orgId), inArray(contacts.id, [...new Set(rows.map((r) => r.contactId).filter(Boolean) as string[])].concat([""])))).all(),
  ]);
  const dm = new Map(docs.map((d) => [d.id, d])), pm = new Map(prs.map((p) => [p.id, p.name])), cm = new Map(cs.map((c) => [c.id, c.name || c.email]));
  return { runs: rows.map((r) => presentRun(r, dm.get(r.docId)?.number ?? null, dm.get(r.docId)?.status ?? (r.status === "released" ? null : "deleted"), pm.get(r.projectId), r.contactId ? cm.get(r.contactId) : null)) };
}

export const RUN_CSV_HEADER = ["Date", "Person", "Task", "Note", "Minutes recorded", "Minutes billed", "Rate", "Currency", "Invoice"];

/** The entries of one open run as CSV (cells that start with = + - @ are made safe). */
export async function runCsv(deps: Deps, a: Actor, id: string) {
  await guard(deps, a);
  const run = await deps.db.select().from(billRuns).where(and(eq(billRuns.orgId, a.orgId), eq(billRuns.id, id))).get();
  if (!run) throw notFound("Billing run");
  if (run.status !== "open") throw new HttpError(409, "released", "This run was released, so its time can be billed again.");
  const [doc, rows, book, p] = await Promise.all([
    deps.db.select({ number: invoiceDocs.number }).from(invoiceDocs).where(and(eq(invoiceDocs.orgId, a.orgId), eq(invoiceDocs.id, run.docId))).get(),
    deps.db.select({ id: timeEntries.id, taskId: timeEntries.taskId, personType: timeEntries.personType, personId: timeEntries.personId, startedAt: timeEntries.startedAt, seconds: timeEntries.seconds, note: timeEntries.note })
      .from(timeEntries).where(and(eq(timeEntries.orgId, a.orgId), eq(timeEntries.billedDocId, run.docId))).orderBy(timeEntries.startedAt).limit(MAX_RUN_ENTRIES).all(),
    rateBook(deps, a.orgId, [run.projectId]),
    deps.db.select({ key: projects.key }).from(projects).where(and(eq(projects.orgId, a.orgId), eq(projects.id, run.projectId))).get(),
  ]);
  const nm = await names(deps, rows, a.orgId);
  const out = [RUN_CSV_HEADER.map(csvCell).join(",")];
  for (const r of rows) {
    const pk = personKeyOf(r.personType, r.personId);
    const t = r.taskId ? nm.task.get(r.taskId) : undefined;
    const rate = rateFor(book, run.projectId, pk);
    out.push([r.startedAt.toISOString().slice(0, 10), nm.person.get(pk) ?? "Former member", t ? `${p?.key ?? "TSK"}-${t.number} ${t.title}` : "General time", r.note,
      divRound(r.seconds, 60), divRound(roundSeconds(r.seconds, run.rounding), 60), rate == null ? "" : (rate / 100).toFixed(2), run.currency, doc?.number ?? "Draft"].map(csvCell).join(","));
  }
  return { csv: `${out.join("\r\n")}\r\n`, name: `billing-run-${run.dateFrom}-to-${run.dateTo}.csv` };
}

/**
 * Home card: unbilled billable hours and their value per client (a project with no client shows as itself), last
 * 12 months, top 6 by value. One grouped read on the org project index; rates applied per person; no rounding (about).
 */
export async function summary(deps: Deps, a: Actor) {
  await guard(deps, a);
  const since = new Date(deps.now().getTime() - 365 * 86_400_000);
  const rows = await deps.db.select({ projectId: timeEntries.projectId, personType: timeEntries.personType, personId: timeEntries.personId, seconds: sql<number>`sum(${timeEntries.seconds})`, n: sql<number>`count(*)` })
    .from(timeEntries).where(and(live(a.orgId), isNotNull(timeEntries.projectId), gte(timeEntries.startedAt, since)))
    .groupBy(timeEntries.projectId, timeEntries.personType, timeEntries.personId).limit(2000).all();
  if (!rows.length) return { clients: [], totalSeconds: 0, more: 0 };
  const pids = [...new Set(rows.map((r) => r.projectId as string))].slice(0, 80);
  const [book, prs] = await Promise.all([
    rateBook(deps, a.orgId, pids),
    deps.db.select({ id: projects.id, name: projects.name, deletedAt: projects.deletedAt }).from(projects).where(and(eq(projects.orgId, a.orgId), inArray(projects.id, pids))).all(),
  ]);
  const cids = [...new Set(pids.map((p) => book.proj.get(p)?.contactId).filter(Boolean) as string[])];
  const cs = cids.length ? await deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, a.orgId), inArray(contacts.id, cids))).all() : [];
  const pm = new Map(prs.filter((p) => !p.deletedAt).map((p) => [p.id, p.name])), cm = new Map(cs.map((c) => [c.id, c.name || c.email]));
  const groups = new Map<string, { key: string; name: string; clientId: string | null; projectId: string; projects: number; seconds: number; amountCents: number; currency: string; missingRate: boolean }>();
  for (const r of rows) {
    const pid = r.projectId as string;
    if (!pm.has(pid)) continue;
    const set = book.proj.get(pid);
    const cid = set?.contactId && cm.has(set.contactId) ? set.contactId : null;
    const currency = set?.currency ?? book.ws?.currency ?? "AUD";
    const key = cid ? `c:${cid}:${currency}` : `p:${pid}`;
    const g = groups.get(key) ?? { key, name: cid ? cm.get(cid)! : pm.get(pid)!, clientId: cid, projectId: pid, projects: 0, seconds: 0, amountCents: 0, currency, missingRate: false };
    if (!groups.has(key) || !g.projectId) g.projectId = pid;
    const rate = rateFor(book, pid, personKeyOf(r.personType, r.personId));
    g.seconds += Number(r.seconds) || 0;
    if (rate == null) g.missingRate = true; else g.amountCents += divRound(divRound((Number(r.seconds) || 0) * 1000, 3600) * rate, 1000);
    groups.set(key, g);
  }
  const projectCount = new Map<string, Set<string>>();
  for (const r of rows) { const pid = r.projectId as string; const set = book.proj.get(pid); const cid = set?.contactId && cm.has(set.contactId) ? set.contactId : null; const key = cid ? `c:${cid}:${set?.currency ?? book.ws?.currency ?? "AUD"}` : `p:${pid}`; if (groups.has(key)) projectCount.set(key, (projectCount.get(key) ?? new Set()).add(pid)); }
  const list = [...groups.values()].map((g) => ({ ...g, projects: projectCount.get(g.key)?.size ?? 1 })).sort((x, y) => y.amountCents - x.amountCents || y.seconds - x.seconds);
  return { clients: list.slice(0, 6), totalSeconds: list.reduce((s, g) => s + g.seconds, 0), more: Math.max(0, list.length - 6) };
}

/** Projects with unbilled time, for the run picker (bounded). */
export async function projectsWithTime(deps: Deps, a: Actor) {
  await guard(deps, a);
  const rows = await deps.db.select({ id: projects.id, name: projects.name, key: projects.key, color: projects.color }).from(projects)
    .where(and(eq(projects.orgId, a.orgId), isNull(projects.deletedAt), isNull(projects.archivedAt))).orderBy(projects.name).limit(200).all();
  return { projects: rows };
}
