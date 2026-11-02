/**
 * TD10 (CRM_TD10): CRM suggestions read from mail, saved analyses from templates, and per person preferences.
 *
 * Suggestions are rules only (no AI, so no provider call whether AI is on or off). A scan reads the newest inbound and
 * sent mail of the last 14 days in mailboxes the viewer may read (at most 150 messages, once a minute per person) and
 * stores derived fields only: never a subject, a body or a quote. Nothing in the CRM changes until a person accepts.
 * A suggestion shows only to people who can read the mailbox it came from. Analyses always run as the viewer.
 */
import { and, desc, eq, inArray, isNull, lt, max, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import { companies, contacts, crmEntries, crmScanTd10, crmSuggestionsTd10, deals, messages, savedAnalysesTd10, userPrefsTd10 } from "../db/schema";
import { HttpError, badRequest, forbidden, notFound } from "../lib/errors";
import { inIds } from "../lib/sql-chunks";
import { assertWritable, sortableId, type SuiteActor } from "./suite/common";
import { readableMailboxes, zoneOffset } from "./suite/dashboards";
import { ANALYSIS_PERIODS, TEMPLATE_INFO, digitsOf, findNextStep, nextStepTitle, parseSignature, type AnalysisFilters, type AnalysisTemplate, ANALYSIS_TEMPLATES } from "../../shared/crm-td10";

type Actor = SuiteActor & { role?: "owner" | "admin" | "member" };
const DAY = 86_400_000;
export const SCAN_DAYS = 14;
export const SCAN_MAX = 150;
export const SCAN_EVERY_MS = 60_000;
const isAdmin = (a: Actor) => a.role === "owner" || a.role === "admin";

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const ymd = (d: Date) => new Date(d).toISOString().slice(0, 10);
const parseJson = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
const localPart = (email: string) => email.split("@")[0] ?? "";

interface Candidate { kind: "contact_details" | "new_contact" | "last_contacted" | "next_step"; targetType: "contact" | "deal" | "email"; targetId: string | null; dedupeKey: string; fields: Record<string, string>; mailboxId: string; messageId: string; at: Date }

interface ScanMessage { id: string; mailboxId: string; folder: string; fromAddress: string; fromName: string; to: string; date: Date; text: string }
interface ScanContact { id: string; email: string; name: string; title: string | null; phone: string | null; companyId: string | null; deletedAt: Date | null }

/**
 * The rules, without the database: messages newest first, the contacts their people already have, open deals with
 * their last logged activity. Returns the suggestions to offer. Exported for the unit tests.
 */
export function suggestFromMail(input: {
  messages: ScanMessage[];
  contacts: ScanContact[];
  deals: { id: string; contactId: string; createdAt: Date; lastActivity: Date | null }[];
  isOutside: (email: string) => boolean;
}): Candidate[] {
  const out: Candidate[] = [];
  const byEmail = new Map(input.contacts.map((c) => [c.email.toLowerCase(), c]));
  const seenPerson = new Set<string>();
  const lastMail = new Map<string, { at: Date; mailboxId: string; messageId: string }>();
  for (const m of input.messages) {
    const inbound = m.folder !== "sent";
    const to = parseJson<{ address?: string; name?: string }[]>(m.to, []);
    const person = inbound ? { address: m.fromAddress, name: m.fromName } : { address: to[0]?.address ?? "", name: to[0]?.name ?? "" };
    const email = (person.address ?? "").trim().toLowerCase();
    if (!email.includes("@") || !input.isOutside(email)) continue;
    const c = byEmail.get(email);
    const live = c && !c.deletedAt ? c : undefined;
    if (live && !lastMail.has(live.id)) lastMail.set(live.id, { at: m.date, mailboxId: m.mailboxId, messageId: m.id });
    if (inbound && !seenPerson.has(email)) {
      seenPerson.add(email);
      const sig = parseSignature(m.text);
      const cleanName = (person.name ?? "").replace(/^["']|["']$/g, "").trim().slice(0, 60);
      if (live) {
        const f: Record<string, string> = {};
        if (sig.name && (!live.name.trim() || live.name.trim().toLowerCase() === localPart(email).toLowerCase())) f.name = sig.name;
        if (sig.title && sig.title !== (live.title ?? "")) f.title = sig.title;
        if (sig.phone && digitsOf(sig.phone) !== digitsOf(live.phone ?? "")) f.phone = sig.phone;
        if (sig.company && !live.companyId) f.company = sig.company;
        if (Object.keys(f).length) out.push({ kind: "contact_details", targetType: "contact", targetId: live.id, dedupeKey: `det:${live.id}:${hash(JSON.stringify(f))}`, fields: f, mailboxId: m.mailboxId, messageId: m.id, at: m.date });
      } else {
        const f: Record<string, string> = { email };
        const name = sig.name || cleanName;
        if (name && name.toLowerCase() !== email) f.name = name;
        if (sig.title) f.title = sig.title;
        if (sig.phone) f.phone = sig.phone;
        if (sig.company) f.company = sig.company;
        out.push({ kind: "new_contact", targetType: "email", targetId: null, dedupeKey: `new:${email}`, fields: f, mailboxId: m.mailboxId, messageId: m.id, at: m.date });
      }
    }
    if (live) {
      const hit = findNextStep(m.text, m.date);
      if (hit) {
        const who = live.name.trim() || email;
        out.push({ kind: "next_step", targetType: "contact", targetId: live.id, dedupeKey: `next:${m.id}`, fields: { reason: hit.reason, due: hit.due, when: hit.when, title: nextStepTitle(hit.reason, who.split(" ")[0] ?? who) }, mailboxId: m.mailboxId, messageId: m.id, at: m.date });
      }
    }
  }
  for (const d of input.deals) {
    const last = lastMail.get(d.contactId);
    if (!last) continue;
    const floor = Math.max(d.createdAt.getTime(), d.lastActivity?.getTime() ?? 0);
    if (last.at.getTime() <= floor) continue;
    out.push({ kind: "last_contacted", targetType: "deal", targetId: d.id, dedupeKey: `last:${d.id}:${ymd(last.at)}`, fields: { date: ymd(last.at), contactId: d.contactId }, mailboxId: last.mailboxId, messageId: last.messageId, at: last.at });
  }
  return out;
}

async function outsideCheck(deps: Deps, orgId: string) {
  const { ROBOT, ownDomains, isOwnAddress } = await import("./suite/contacts");
  const own = await ownDomains(deps, orgId);
  const cache = new Map<string, boolean>();
  return async (email: string) => {
    if (cache.has(email)) return cache.get(email)!;
    const ok = !ROBOT.test(email) && !(await isOwnAddress(deps, orgId, email, own));
    cache.set(email, ok);
    return ok;
  };
}

/** Reads recent mail the viewer may read and stores new suggestions. 429 when the same person checked under a minute ago. */
export async function scanMail(deps: Deps, a: Actor): Promise<{ added: number; scanned: number }> {
  const now = deps.now();
  const userKey = a.userId || "system";
  const prev = await deps.db.select({ at: crmScanTd10.scannedAt }).from(crmScanTd10).where(and(eq(crmScanTd10.orgId, a.orgId), eq(crmScanTd10.userId, userKey))).get();
  if (prev && now.getTime() - new Date(prev.at).getTime() < SCAN_EVERY_MS) throw new HttpError(429, "too_soon", "Mail was checked a moment ago. Try again in a minute.");
  await deps.db.insert(crmScanTd10).values({ orgId: a.orgId, userId: userKey, scannedAt: now }).onConflictDoUpdate({ target: [crmScanTd10.orgId, crmScanTd10.userId], set: { scannedAt: now } });
  const boxes = await readableMailboxes(deps, a);
  if (!boxes.length) return { added: 0, scanned: 0 };
  const rows = await deps.db.select({ id: messages.id, mailboxId: messages.mailboxId, folder: messages.folder, fromAddress: messages.fromAddress, fromName: messages.fromName, to: messages.to, date: messages.date, text: sql<string>`substr(${messages.text}, 1, 8000)` })
    .from(messages)
    .where(and(eq(messages.orgId, a.orgId), inIds(messages.mailboxId, boxes), inArray(messages.folder, ["inbox", "archive", "sent"]), sql`${messages.date} >= ${now.getTime() - SCAN_DAYS * DAY}`, or(isNull(messages.isBulk), eq(messages.isBulk, false))))
    .orderBy(desc(messages.date)).limit(SCAN_MAX);
  if (!rows.length) return { added: 0, scanned: 0 };
  const outside = await outsideCheck(deps, a.orgId);
  const emails = new Set<string>();
  const verdict = new Map<string, boolean>();
  for (const m of rows) {
    const inbound = m.folder !== "sent";
    const e = (inbound ? m.fromAddress : parseJson<{ address?: string }[]>(m.to, [])[0]?.address ?? "").trim().toLowerCase();
    if (!e.includes("@") || verdict.has(e)) continue;
    const ok = await outside(e);
    verdict.set(e, ok);
    if (ok) emails.add(e);
  }
  const people = emails.size ? await deps.db.select({ id: contacts.id, email: contacts.email, name: contacts.name, title: contacts.title, phone: contacts.phone, companyId: contacts.companyId, deletedAt: contacts.deletedAt })
    .from(contacts).where(and(eq(contacts.orgId, a.orgId), inIds(contacts.email, [...emails]))) : [];
  const liveIds = people.filter((p) => !p.deletedAt).map((p) => p.id);
  const openDeals = liveIds.length ? await deps.db.select({ id: deals.id, contactId: deals.contactId, createdAt: deals.createdAt })
    .from(deals).where(and(eq(deals.orgId, a.orgId), inIds(deals.contactId, liveIds), notInArray(deals.stage, ["won", "lost"]), isNull(deals.deletedAt))).limit(200) : [];
  const lastRows = openDeals.length ? await deps.db.select({ id: crmEntries.entityId, at: max(crmEntries.occurredAt) }).from(crmEntries)
    .where(and(eq(crmEntries.orgId, a.orgId), eq(crmEntries.entityType, "deal"), inIds(crmEntries.entityId, openDeals.map((d) => d.id)), isNull(crmEntries.deletedAt))).groupBy(crmEntries.entityId) : [];
  const lastBy = new Map(lastRows.map((r) => [r.id, r.at ? new Date(r.at) : null]));
  const found = suggestFromMail({
    messages: rows.map((r) => ({ ...r, date: new Date(r.date), text: r.text ?? "" })),
    contacts: people,
    deals: openDeals.filter((d) => d.contactId).map((d) => ({ id: d.id, contactId: d.contactId!, createdAt: new Date(d.createdAt), lastActivity: lastBy.get(d.id) ?? null })),
    isOutside: (e) => verdict.get(e) === true,
  });
  let added = 0;
  for (const s of found) {
    const ins = await deps.db.insert(crmSuggestionsTd10).values({
      id: sortableId("sug", now.getTime()), orgId: a.orgId, mailboxId: s.mailboxId, kind: s.kind, targetType: s.targetType, targetId: s.targetId,
      dedupeKey: s.dedupeKey, fieldsJson: JSON.stringify(s.fields), messageId: s.messageId, messageAt: s.at, status: "open", createdAt: now,
    }).onConflictDoNothing().returning({ id: crmSuggestionsTd10.id });
    added += ins.length;
  }
  return { added, scanned: rows.length };
}

export interface SuggestionView { id: string; kind: Candidate["kind"]; target: { type: string; id: string | null; label: string }; fields: Record<string, string>; messageAt: string; current?: Record<string, string | null> }

/** Open suggestions from mailboxes the viewer may read, newest first; one per deal for last contacted; gone targets left out. */
export async function listSuggestions(deps: Deps, a: Actor): Promise<{ items: SuggestionView[] }> {
  const boxes = await readableMailboxes(deps, a);
  if (!boxes.length) return { items: [] };
  const rows = await deps.db.select().from(crmSuggestionsTd10)
    .where(and(eq(crmSuggestionsTd10.orgId, a.orgId), eq(crmSuggestionsTd10.status, "open"), inIds(crmSuggestionsTd10.mailboxId, boxes)))
    .orderBy(desc(crmSuggestionsTd10.messageAt)).limit(100);
  const contactIds = new Set<string>(); const dealIds = new Set<string>(); const newEmails = new Set<string>();
  for (const r of rows) {
    if (r.targetType === "email") { const e = parseJson<Record<string, string>>(r.fieldsJson, {}).email; if (e) newEmails.add(e); }
    if (r.targetType === "contact" && r.targetId) contactIds.add(r.targetId);
    if (r.targetType === "deal" && r.targetId) { dealIds.add(r.targetId); const f = parseJson<Record<string, string>>(r.fieldsJson, {}); if (f.contactId) contactIds.add(f.contactId); }
  }
  const [cs, ds, known] = await Promise.all([
    contactIds.size ? deps.db.select({ id: contacts.id, name: contacts.name, email: contacts.email, title: contacts.title, phone: contacts.phone, companyId: contacts.companyId }).from(contacts).where(and(eq(contacts.orgId, a.orgId), inIds(contacts.id, [...contactIds]), isNull(contacts.deletedAt))) : [],
    dealIds.size ? deps.db.select({ id: deals.id, title: deals.title, stage: deals.stage }).from(deals).where(and(eq(deals.orgId, a.orgId), inIds(deals.id, [...dealIds]), isNull(deals.deletedAt))) : [],
    // A new contact suggestion whose person got a contact since (mail or by hand) is no longer news.
    newEmails.size ? deps.db.select({ email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, a.orgId), inIds(contacts.email, [...newEmails]), isNull(contacts.deletedAt))) : [],
  ]);
  const knownEmails = new Set(known.map((k) => k.email));
  const cMap = new Map(cs.map((c) => [c.id, c])); const dMap = new Map(ds.map((d) => [d.id, d]));
  const seenDeal = new Set<string>();
  const items: SuggestionView[] = [];
  for (const r of rows) {
    const fields = parseJson<Record<string, string>>(r.fieldsJson, {});
    let label: string; let current: Record<string, string | null> | undefined;
    if (r.targetType === "contact") {
      const c = r.targetId ? cMap.get(r.targetId) : undefined;
      if (!c) continue;
      label = c.name || c.email;
      if (r.kind === "contact_details") current = { name: c.name || null, title: c.title, phone: c.phone };
    } else if (r.targetType === "deal") {
      const d = r.targetId ? dMap.get(r.targetId) : undefined;
      if (!d || d.stage === "won" || d.stage === "lost" || seenDeal.has(d.id)) continue;
      seenDeal.add(d.id);
      label = d.title;
      const c = fields.contactId ? cMap.get(fields.contactId) : undefined;
      fields.contactName = c ? c.name || c.email : "";
    } else {
      if (fields.email && knownEmails.has(fields.email)) continue;
      label = fields.name || fields.email || "";
    }
    items.push({ id: r.id, kind: r.kind, target: { type: r.targetType, id: r.targetId, label }, fields, messageAt: new Date(r.messageAt).toISOString(), current });
  }
  return { items };
}

async function viewerRow(deps: Deps, a: Actor, id: string) {
  const r = await deps.db.select().from(crmSuggestionsTd10).where(and(eq(crmSuggestionsTd10.orgId, a.orgId), eq(crmSuggestionsTd10.id, id))).get();
  if (!r) throw notFound("Suggestion");
  const boxes = await readableMailboxes(deps, a);
  if (!boxes.includes(r.mailboxId)) throw notFound("Suggestion");
  return r;
}

async function claim(deps: Deps, a: Actor, id: string, to: "accepted" | "discarded") {
  const got = await deps.db.update(crmSuggestionsTd10).set({ status: to, decidedBy: a.userId || null, decidedAt: deps.now() })
    .where(and(eq(crmSuggestionsTd10.orgId, a.orgId), eq(crmSuggestionsTd10.id, id), eq(crmSuggestionsTd10.status, "open"))).returning({ id: crmSuggestionsTd10.id });
  if (!got.length) throw new HttpError(409, "already_handled", "Someone already handled this suggestion.");
}

export const AcceptEdits = z.object({
  name: z.string().trim().max(60).optional(),
  title: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(24).regex(/^[+\d\s().-]*$/, "That phone number has letters in it.").optional(),
  company: z.string().trim().max(60).optional(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  stepTitle: z.string().trim().min(1).max(120).optional(),
}).strict();

async function linkCompany(deps: Deps, a: Actor, name: string, email: string) {
  const { createCompany, normaliseDomain } = await import("./suite/crm-r94");
  const { isFreeMail } = await import("./suite/contacts");
  const domainRaw = email.split("@")[1] ?? "";
  const domain = domainRaw && !isFreeMail(domainRaw) ? normaliseDomain(domainRaw) : null;
  if (domain) {
    const had = await deps.db.select({ id: companies.id, deletedAt: companies.deletedAt }).from(companies).where(and(eq(companies.orgId, a.orgId), eq(companies.domain, domain))).get();
    if (had && !had.deletedAt) return had.id;
  }
  return (await createCompany(deps, a, { name, domain })).id;
}

/** Applies one suggestion, with the person's edits, through the existing CRM writes. Only this path writes. */
export async function acceptSuggestion(deps: Deps, a: Actor, id: string, edits: z.infer<typeof AcceptEdits>) {
  assertWritable(a);
  const r = await viewerRow(deps, a, id);
  if (r.status !== "open") throw new HttpError(409, "already_handled", "Someone already handled this suggestion.");
  const f = { ...parseJson<Record<string, string>>(r.fieldsJson, {}) };
  for (const k of ["name", "title", "phone", "company"] as const) if (edits[k] !== undefined) f[k] = edits[k]!;
  await claim(deps, a, id, "accepted");
  try {
    const contactsSvc = await import("./suite/contacts");
    const crm = await import("./suite/crm-r94");
    if (r.kind === "contact_details") {
      const c = await deps.db.select({ id: contacts.id, email: contacts.email, companyId: contacts.companyId }).from(contacts).where(and(eq(contacts.orgId, a.orgId), eq(contacts.id, r.targetId ?? ""), isNull(contacts.deletedAt))).get();
      if (!c) throw notFound("Contact");
      const patch: { name?: string; title?: string | null; phone?: string | null; companyId?: string | null } = {};
      if (f.name) patch.name = f.name;
      if (f.title) patch.title = f.title;
      if (f.phone) patch.phone = f.phone;
      if (f.company && !c.companyId) patch.companyId = await linkCompany(deps, a, f.company, c.email);
      if (!Object.keys(patch).length) throw badRequest("Nothing left to change.");
      await contactsSvc.updateContact(deps, a, c.id, patch);
      return { ok: true, kind: r.kind, contactId: c.id };
    }
    if (r.kind === "new_contact") {
      const email = f.email ?? "";
      if (!email.includes("@")) throw badRequest("That suggestion has no email address.");
      const had = await deps.db.select({ id: contacts.id, name: contacts.name, title: contacts.title, phone: contacts.phone }).from(contacts).where(and(eq(contacts.orgId, a.orgId), eq(contacts.email, email), isNull(contacts.deletedAt))).get();
      if (had) {
        // The person got a contact since this was suggested: fill only what is still empty there.
        const patch: { name?: string; title?: string; phone?: string } = {};
        if (f.name && (!had.name.trim() || had.name.trim().toLowerCase() === localPart(email).toLowerCase())) patch.name = f.name;
        if (f.title && !had.title) patch.title = f.title;
        if (f.phone && !had.phone) patch.phone = f.phone;
        if (Object.keys(patch).length) await contactsSvc.updateContact(deps, a, had.id, patch);
        return { ok: true, kind: r.kind, contactId: had.id };
      }
      const made = await contactsSvc.createContact(deps, a, { email, name: f.name || undefined, title: f.title || undefined, phone: f.phone || undefined });
      return { ok: true, kind: r.kind, contactId: (made as { id: string }).id };
    }
    if (r.kind === "last_contacted") {
      const d = await deps.db.select({ id: deals.id }).from(deals).where(and(eq(deals.orgId, a.orgId), eq(deals.id, r.targetId ?? ""), isNull(deals.deletedAt))).get();
      if (!d) throw notFound("Deal");
      const who = f.contactId ? await deps.db.select({ name: contacts.name, email: contacts.email }).from(contacts).where(and(eq(contacts.orgId, a.orgId), eq(contacts.id, f.contactId))).get() : undefined;
      await crm.createEntry(deps, a, { entityType: "deal", entityId: d.id, kind: "note", body: `Emailed ${who?.name || who?.email || "the contact"} on ${f.date}.`, occurredAt: new Date(r.messageAt).toISOString() });
      await deps.db.update(crmSuggestionsTd10).set({ status: "discarded", decidedBy: a.userId || null, decidedAt: deps.now() })
        .where(and(eq(crmSuggestionsTd10.orgId, a.orgId), eq(crmSuggestionsTd10.kind, "last_contacted"), eq(crmSuggestionsTd10.targetId, d.id), eq(crmSuggestionsTd10.status, "open"), lt(crmSuggestionsTd10.messageAt, r.messageAt)));
      return { ok: true, kind: r.kind, dealId: d.id };
    }
    const c = await deps.db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.orgId, a.orgId), eq(contacts.id, r.targetId ?? ""), isNull(contacts.deletedAt))).get();
    if (!c) throw notFound("Contact");
    await crm.setNextStep(deps, a, { entityType: "contact", entityId: c.id, title: edits.stepTitle ?? f.title ?? "Follow up", due: edits.due ?? f.due });
    return { ok: true, kind: r.kind, contactId: c.id };
  } catch (err) {
    await deps.db.update(crmSuggestionsTd10).set({ status: "open", decidedBy: null, decidedAt: null }).where(eq(crmSuggestionsTd10.id, id));
    throw err;
  }
}

export async function discardSuggestion(deps: Deps, a: Actor, id: string) {
  await viewerRow(deps, a, id);
  await claim(deps, a, id, "discarded");
  return { ok: true };
}

/** Brings a discarded suggestion back (the toast's Undo): the person who discarded it, or an admin, within a day. */
export async function undoDiscard(deps: Deps, a: Actor, id: string) {
  const r = await viewerRow(deps, a, id);
  if (r.status !== "discarded") throw new HttpError(409, "not_discarded", "Only a discarded suggestion can come back.");
  if (r.decidedBy !== a.userId && !isAdmin(a)) throw forbidden("Only the person who discarded it or an admin can bring it back.");
  if (!r.decidedAt || deps.now().getTime() - new Date(r.decidedAt).getTime() > DAY) throw new HttpError(409, "too_late", "That was discarded more than a day ago.");
  await deps.db.update(crmSuggestionsTd10).set({ status: "open", decidedBy: null, decidedAt: null }).where(and(eq(crmSuggestionsTd10.id, id), eq(crmSuggestionsTd10.status, "discarded")));
  return { ok: true };
}

/* Saved analyses */

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const FiltersInput = z.object({
  days: z.number().int().refine((n) => (ANALYSIS_PERIODS as readonly number[]).includes(n), "Pick a period from the list.").optional(),
  owner: Id.optional(), person: Id.optional(), project: Id.optional(),
  stage: z.enum(["lead", "qualified", "proposal", "won", "lost"]).optional(),
  billable: z.enum(["yes", "no"]).optional(),
}).strict();
export const TemplateName = z.enum(ANALYSIS_TEMPLATES);

/** Keeps only the filters the template offers, with its default period. */
export function cleanFilters(t: AnalysisTemplate, f: AnalysisFilters): AnalysisFilters {
  const info = TEMPLATE_INFO[t];
  const out: AnalysisFilters = { days: f.days ?? info.defaultDays };
  for (const k of info.filters) if (k !== "days" && f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}

type Spec = import("./suite/dash-r91-question").QuestionSpec;
/** A template and its filters as an R91 question (every field from R91's allowlist, values bound there). */
export function templateSpec(t: Exclude<AnalysisTemplate, "response_rates">, f: AnalysisFilters): Spec {
  const filters: Spec["filters"] = [];
  const days = f.days ? String(f.days) : null;
  if (t === "pipeline_by_stage") {
    if (days) filters.push({ field: "created", op: "last_days", value: days });
    if (f.owner) filters.push({ field: "owner", op: "is", value: f.owner });
    return { table: "deals", filters, groupBy: "stage", bucket: null, measure: { op: "sum", field: "value" } };
  }
  if (t === "revenue_by_month") {
    filters.push({ field: "stage", op: "is", value: "won" }, { field: "closed", op: "not_empty" });
    if (days) filters.push({ field: "closed", op: "last_days", value: days });
    if (f.owner) filters.push({ field: "owner", op: "is", value: f.owner });
    return { table: "deals", filters, groupBy: "closed", bucket: "month", measure: { op: "sum", field: "value" } };
  }
  if (days) filters.push({ field: "started", op: "last_days", value: days });
  if (f.person) filters.push({ field: "person", op: "is", value: f.person });
  if (f.project) filters.push({ field: "project", op: "is", value: f.project });
  if (f.billable) filters.push({ field: "billable", op: "is", value: f.billable });
  return { table: "time", filters, groupBy: "project", bucket: null, measure: { op: "sum", field: "hours" } };
}

export interface AnalysisResult { template: AnalysisTemplate; rows: { label: string; value: number; detail?: string }[]; value: number | null; format: "money" | "hours" | "percent" | null; truncated: boolean }

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Share of incoming mail answered, by month, over the mailboxes the viewer may read. */
export async function responseRates(deps: Deps, a: Actor, f: AnalysisFilters, offsetMin: number): Promise<AnalysisResult> {
  const boxes = await readableMailboxes(deps, a);
  if (!boxes.length) return { template: "response_rates", rows: [], value: null, format: "percent", truncated: false };
  const now = deps.now().getTime();
  const since = f.days ? now - f.days * DAY : 0;
  const month = sql<string>`strftime('%Y-%m', (${messages.date} + ${offsetMin * 60_000}) / 1000, 'unixepoch')`;
  const rows = await deps.db.select({ m: month, n: sql<number>`count(*)`, a: sql<number>`sum(case when ${messages.isAnswered} then 1 else 0 end)` }).from(messages)
    .where(and(eq(messages.orgId, a.orgId), inIds(messages.mailboxId, boxes), inArray(messages.folder, ["inbox", "archive"]), or(isNull(messages.isBulk), eq(messages.isBulk, false)), sql`${messages.date} >= ${since}`))
    .groupBy(month).orderBy(desc(month)).limit(24);
  const list = rows.reverse().map((r) => {
    const [y, mo] = String(r.m).split("-");
    const n = Number(r.n) || 0; const ans = Number(r.a) || 0;
    return { label: `${MONTH[Number(mo) - 1] ?? mo} ${y}`, value: n ? Math.round((ans / n) * 1000) / 10 : 0, detail: `${ans} of ${n} answered` };
  });
  const tn = rows.reduce((s, r) => s + (Number(r.n) || 0), 0); const ta = rows.reduce((s, r) => s + (Number(r.a) || 0), 0);
  return { template: "response_rates", rows: list, value: tn ? Math.round((ta / tn) * 1000) / 10 : null, format: "percent", truncated: false };
}

export async function runAnalysis(deps: Deps, a: Actor, t: AnalysisTemplate, raw: AnalysisFilters, tz: string): Promise<AnalysisResult> {
  const f = cleanFilters(t, raw);
  const now = deps.now().getTime();
  const offsetMin = Math.round(zoneOffset(now, tz) / 60_000);
  if (t === "response_rates") return responseRates(deps, a, f, offsetMin);
  const { runQuestion } = await import("./suite/dash-r91-question");
  const r = await runQuestion(deps, a, templateSpec(t, f), { mailboxes: () => readableMailboxes(deps, a), offsetMin, now });
  return { template: t, rows: r.rows ?? [], value: r.value, format: r.format, truncated: r.truncated };
}

const present = (r: typeof savedAnalysesTd10.$inferSelect, a: Actor) => ({
  id: r.id, name: r.name, template: r.template as AnalysisTemplate, filters: parseJson<AnalysisFilters>(r.filtersJson, {}), shared: r.shared,
  mine: r.ownerUserId === a.userId, canEdit: r.ownerUserId === a.userId || isAdmin(a), updatedAt: new Date(r.updatedAt).toISOString(),
});

export async function listAnalyses(deps: Deps, a: Actor) {
  const rows = await deps.db.select().from(savedAnalysesTd10)
    .where(and(eq(savedAnalysesTd10.orgId, a.orgId), isNull(savedAnalysesTd10.deletedAt), or(eq(savedAnalysesTd10.ownerUserId, a.userId || "-"), eq(savedAnalysesTd10.shared, true))))
    .orderBy(desc(savedAnalysesTd10.updatedAt)).limit(100);
  return { items: rows.map((r) => present(r, a)) };
}

export const AnalysisCreate = z.object({ name: z.string().trim().min(1, "Give it a name.").max(80), template: TemplateName, filters: FiltersInput.default({}), shared: z.boolean().default(false) }).strict();
export const AnalysisPatch = z.object({ name: z.string().trim().min(1).max(80).optional(), filters: FiltersInput.optional(), shared: z.boolean().optional() }).strict();

export async function createAnalysis(deps: Deps, a: Actor, i: z.infer<typeof AnalysisCreate>) {
  assertWritable(a);
  if (!a.userId) throw forbidden();
  const count = await deps.db.select({ n: sql<number>`count(*)` }).from(savedAnalysesTd10).where(and(eq(savedAnalysesTd10.orgId, a.orgId), eq(savedAnalysesTd10.ownerUserId, a.userId), isNull(savedAnalysesTd10.deletedAt))).get();
  if (Number(count?.n ?? 0) >= 200) throw badRequest("You have 200 saved analyses. Delete one first.");
  const now = deps.now();
  const id = sortableId("ana", now.getTime());
  await deps.db.insert(savedAnalysesTd10).values({ id, orgId: a.orgId, ownerUserId: a.userId, name: i.name, template: i.template, filtersJson: JSON.stringify(cleanFilters(i.template, i.filters)), shared: i.shared, createdAt: now, updatedAt: now });
  return present((await deps.db.select().from(savedAnalysesTd10).where(eq(savedAnalysesTd10.id, id)).get())!, a);
}

async function visibleAnalysis(deps: Deps, a: Actor, id: string) {
  const r = await deps.db.select().from(savedAnalysesTd10).where(and(eq(savedAnalysesTd10.orgId, a.orgId), eq(savedAnalysesTd10.id, id), isNull(savedAnalysesTd10.deletedAt))).get();
  if (!r || (r.ownerUserId !== a.userId && !r.shared)) throw notFound("Analysis");
  return r;
}

export async function updateAnalysis(deps: Deps, a: Actor, id: string, p: z.infer<typeof AnalysisPatch>) {
  assertWritable(a);
  const r = await visibleAnalysis(deps, a, id);
  if (r.ownerUserId !== a.userId && !isAdmin(a)) throw forbidden("Only the person who saved it or an admin can change it.");
  const t = r.template as AnalysisTemplate;
  await deps.db.update(savedAnalysesTd10).set({
    ...(p.name !== undefined ? { name: p.name } : {}), ...(p.shared !== undefined ? { shared: p.shared } : {}),
    ...(p.filters ? { filtersJson: JSON.stringify(cleanFilters(t, p.filters)) } : {}), updatedAt: deps.now(),
  }).where(eq(savedAnalysesTd10.id, r.id));
  return present((await deps.db.select().from(savedAnalysesTd10).where(eq(savedAnalysesTd10.id, r.id)).get())!, a);
}

export async function deleteAnalysis(deps: Deps, a: Actor, id: string) {
  assertWritable(a);
  const r = await visibleAnalysis(deps, a, id);
  if (r.ownerUserId !== a.userId && !isAdmin(a)) throw forbidden("Only the person who saved it or an admin can delete it.");
  await deps.db.update(savedAnalysesTd10).set({ deletedAt: deps.now() }).where(eq(savedAnalysesTd10.id, r.id));
  return { ok: true };
}

/** A saved analysis runs as the viewer, so a shared one shows each person only what they could see anyway. */
export async function runSaved(deps: Deps, a: Actor, id: string, tz: string) {
  const r = await visibleAnalysis(deps, a, id);
  const t = TemplateName.safeParse(r.template);
  if (!t.success) throw notFound("Analysis");
  return { analysis: present(r, a), result: await runAnalysis(deps, a, t.data, parseJson<AnalysisFilters>(r.filtersJson, {}), tz) };
}

/* Preferences */

export async function getPrefs(deps: Deps, a: Actor) {
  const r = a.userId ? await deps.db.select({ off: userPrefsTd10.shortcutsOff }).from(userPrefsTd10).where(and(eq(userPrefsTd10.userId, a.userId), eq(userPrefsTd10.orgId, a.orgId))).get() : undefined;
  return { shortcutsOff: !!r?.off };
}

export async function setPrefs(deps: Deps, a: Actor, p: { shortcutsOff: boolean }) {
  if (!a.userId) throw forbidden();
  const now = deps.now();
  await deps.db.insert(userPrefsTd10).values({ userId: a.userId, orgId: a.orgId, shortcutsOff: p.shortcutsOff, updatedAt: now })
    .onConflictDoUpdate({ target: [userPrefsTd10.userId, userPrefsTd10.orgId], set: { shortcutsOff: p.shortcutsOff, updatedAt: now } });
  return { shortcutsOff: p.shortcutsOff };
}

