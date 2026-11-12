/**
 * R109 (flag merge_plus_r109): lists with consent records, newsletters and journeys, built to the
 * Australian Spam Act 2003. Every bulk email: consent checked per person, the sender named with a contact
 * address, a one click unsubscribe (headers and footer link) applied at once across the workspace, bounces
 * and complaints honoured (suppressions), and the merge daily cap shared with mail merge. Tables: 0127.
 */
import { sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { HttpError, badRequest, forbidden, notFound } from "../../lib/errors";
import { hmacSha256Hex, newId, safeEqual } from "../../lib/crypto";
import { enqueue, registerJob } from "../jobs";
import { assertMailboxAccess } from "../team";
import { effectivePlanId } from "../plans";
import { mergeUsedToday, recordUnsubscribe, reserveMergeQuota, templateContext, toolStateOrOff } from "../tools/automation";
import { MERGE_DAILY_CAP } from "@/shared/tools-automation";
import {
  CAMPAIGN_SPACING_SECONDS, LIST_MEMBERS_IMPORT_MAX, STARTER_BLOCKS, allowedBy, blocksSchema, canSend, isEmail, isTimeZone,
  journeyStepsSchema, nextDayStart, normEmail, renderEmail, sendPlan, skipStep, startStatus, stepSendAt, unsubscribeHeaders,
  type Block, type CampaignStatus, type ConsentKind, type JourneyStep, type MemberStatus,
} from "@/shared/campaigns-r109";

// ------------------------------------------------------------------ rows

export interface ListRow {
  id: string; org_id: string; name: string; description: string; visibility: "workspace" | "private"; owner_user_id: string;
  double_opt_in: number; allow_inferred: number; signup_key: string; signup_on: number; mailbox_id: string | null;
  sender_name: string; sender_address: string; tz: string; member_count: number; archived_at: number | null; created_at: number; updated_at: number;
}
export interface MemberRow {
  id: string; org_id: string; list_id: string; email: string; name: string; fields: string; status: MemberStatus; consent_kind: ConsentKind;
  consent_source: string; consent_at: number | null; confirm_token: string | null; confirmed_at: number | null; unsubscribed_at: number | null; created_at: number; updated_at: number;
}
export interface CampaignRow {
  id: string; org_id: string; list_id: string; user_id: string; mailbox_id: string | null; kind: "newsletter" | "journey_step"; journey_id: string | null;
  name: string; subject: string; preheader: string; blocks: string; track: number; status: CampaignStatus; scheduled_at: number | null;
  total: number; sent: number; failed: number; skipped: number; opened: number; clicked: number; unsubscribed: number; bounced: number;
  error: string | null; sent_at: number | null; created_at: number; updated_at: number;
}
interface RecipientRow { campaign_id: string; idx: number; org_id: string; member_id: string | null; email: string; name: string; data: string; token: string; status: string; opened_at: number | null; clicked_at: number | null }
export interface JourneyRow {
  id: string; org_id: string; list_id: string; user_id: string; mailbox_id: string | null; name: string; status: "draft" | "active" | "paused";
  steps: string; send_hour: number; enrolled: number; created_at: number; updated_at: number;
}
interface EnrollmentRow { id: string; journey_id: string; org_id: string; member_id: string; email: string; step: number; next_at: number | null; status: string; last_token: string | null }

const changes = (r: unknown) => Number((r as { meta?: { changes?: number } })?.meta?.changes ?? (r as { changes?: number })?.changes ?? 0);
const rand = (n = 16) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
export const isAdmin = (a: Pick<AuthContext, "role">) => a.role === "owner" || a.role === "admin";

// ------------------------------------------------------------------ permissions

/** Members see workspace lists and their own private lists; admins see all. */
export function canSeeList(l: ListRow, a: Pick<AuthContext, "role" | "userId">) { return isAdmin(a) || l.visibility === "workspace" || l.owner_user_id === a.userId; }
/** The owner of a list or an admin may change it and its people. */
export function canEditList(l: ListRow, a: Pick<AuthContext, "role" | "userId">) { return isAdmin(a) || l.owner_user_id === a.userId; }
/** Sending to a whole workspace list is admin only; a member may send to a private list they own. */
export function canSendToList(l: ListRow, a: Pick<AuthContext, "role" | "userId">) { return isAdmin(a) || (l.visibility === "private" && l.owner_user_id === a.userId); }

export async function getList(deps: Deps, auth: AuthContext, id: string): Promise<ListRow> {
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where org_id = ${auth.orgId} and id = ${id} and archived_at is null`);
  if (!l || !canSeeList(l, auth)) throw notFound("List");
  return l;
}
async function editableList(deps: Deps, auth: AuthContext, id: string) {
  const l = await getList(deps, auth, id);
  if (!canEditList(l, auth)) throw forbidden("Only the person who made this list or an admin can change it.");
  return l;
}

// ------------------------------------------------------------------ lists

export interface ListInput { name: string; description?: string; visibility?: "workspace" | "private"; doubleOptIn?: boolean; allowInferred?: boolean; signupOn?: boolean; mailboxId?: string | null; senderName?: string; senderAddress?: string; tz?: string }

async function counts(deps: Deps, orgId: string, ids: string[]) {
  const out = new Map<string, Record<string, number>>();
  if (!ids.length) return out;
  const rows = await deps.db.all<{ list_id: string; status: string; n: number }>(sql`select list_id, status, count(*) as n from audience_members where org_id = ${orgId} and list_id in ${ids.length === 1 ? sql`(${ids[0]})` : sql`(${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`} group by list_id, status`);
  for (const r of rows) { const m = out.get(r.list_id) ?? {}; m[r.status] = Number(r.n); out.set(r.list_id, m); }
  return out;
}

export function listView(l: ListRow, auth: AuthContext, c: Record<string, number> = {}) {
  return {
    id: l.id, name: l.name, description: l.description, visibility: l.visibility, mine: l.owner_user_id === auth.userId,
    doubleOptIn: !!l.double_opt_in, allowInferred: !!l.allow_inferred, signupOn: !!l.signup_on, signupKey: canEditList(l, auth) ? l.signup_key : null,
    mailboxId: l.mailbox_id, senderName: l.sender_name, senderAddress: l.sender_address, tz: l.tz,
    canEdit: canEditList(l, auth), canSend: canSendToList(l, auth),
    subscribed: c.subscribed ?? 0, pending: c.pending ?? 0, unsubscribed: c.unsubscribed ?? 0, bounced: (c.bounced ?? 0) + (c.complained ?? 0),
    updatedAt: new Date(l.updated_at).toISOString(),
  };
}

export async function listLists(deps: Deps, auth: AuthContext) {
  const rows = (await deps.db.all<ListRow>(sql`select * from audience_lists where org_id = ${auth.orgId} and archived_at is null order by updated_at desc limit 200`)).filter((l) => canSeeList(l, auth));
  const c = await counts(deps, auth.orgId, rows.map((r) => r.id));
  return rows.map((l) => listView(l, auth, c.get(l.id)));
}

function checkListInput(i: Partial<ListInput>) {
  if (i.tz !== undefined && !isTimeZone(i.tz)) throw badRequest("Pick a time zone from the list.");
  if (i.senderAddress !== undefined && i.senderAddress.length > 300) throw badRequest("Keep the contact address under 300 characters.");
}

export async function createList(deps: Deps, auth: AuthContext, i: ListInput) {
  checkListInput(i);
  const visibility = i.visibility ?? (isAdmin(auth) ? "workspace" : "private");
  if (visibility === "workspace" && !isAdmin(auth)) throw forbidden("Only admins can make a list for the whole workspace. Make a private list instead.");
  if (i.mailboxId) await assertMailboxAccess(deps.db, auth, i.mailboxId);
  const ws = (await templateContext(deps, auth.orgId)).workspaceName;
  const id = newId("al"); const now = deps.now().getTime();
  await deps.db.run(sql`insert into audience_lists (id, org_id, name, description, visibility, owner_user_id, double_opt_in, allow_inferred, signup_key, signup_on, mailbox_id, sender_name, sender_address, tz, created_at, updated_at)
    values (${id}, ${auth.orgId}, ${i.name.trim()}, ${i.description ?? ""}, ${visibility}, ${auth.userId}, ${i.doubleOptIn === false ? 0 : 1}, ${i.allowInferred ? 1 : 0}, ${rand(12)}, ${i.signupOn ? 1 : 0}, ${i.mailboxId ?? null}, ${(i.senderName ?? ws).trim()}, ${(i.senderAddress ?? "").trim()}, ${i.tz ?? "Australia/Sydney"}, ${now}, ${now})`);
  return listView(await getList(deps, auth, id), auth);
}

export async function updateList(deps: Deps, auth: AuthContext, id: string, i: Partial<ListInput>) {
  const l = await editableList(deps, auth, id);
  checkListInput(i);
  if (i.visibility === "workspace" && !isAdmin(auth)) throw forbidden("Only admins can share a list with the whole workspace.");
  if (i.mailboxId) await assertMailboxAccess(deps.db, auth, i.mailboxId);
  const n = { ...l, name: i.name?.trim() ?? l.name, description: i.description ?? l.description, visibility: i.visibility ?? l.visibility,
    double_opt_in: i.doubleOptIn === undefined ? l.double_opt_in : i.doubleOptIn ? 1 : 0, allow_inferred: i.allowInferred === undefined ? l.allow_inferred : i.allowInferred ? 1 : 0,
    signup_on: i.signupOn === undefined ? l.signup_on : i.signupOn ? 1 : 0, mailbox_id: i.mailboxId === undefined ? l.mailbox_id : i.mailboxId,
    sender_name: i.senderName?.trim() ?? l.sender_name, sender_address: i.senderAddress?.trim() ?? l.sender_address, tz: i.tz ?? l.tz };
  await deps.db.run(sql`update audience_lists set name = ${n.name}, description = ${n.description}, visibility = ${n.visibility}, double_opt_in = ${n.double_opt_in}, allow_inferred = ${n.allow_inferred},
    signup_on = ${n.signup_on}, mailbox_id = ${n.mailbox_id}, sender_name = ${n.sender_name}, sender_address = ${n.sender_address}, tz = ${n.tz}, updated_at = ${deps.now().getTime()} where id = ${id}`);
  return listView(await getList(deps, auth, id), auth, (await counts(deps, auth.orgId, [id])).get(id));
}

export async function archiveList(deps: Deps, auth: AuthContext, id: string) {
  await editableList(deps, auth, id);
  await deps.db.run(sql`update audience_lists set archived_at = ${deps.now().getTime()}, signup_on = 0 where id = ${id}`);
  await deps.db.run(sql`update journeys set status = 'paused' where list_id = ${id} and status = 'active'`);
}

// ------------------------------------------------------------------ people

/** Addresses never to mail: unsubscribed (with the time) or bounced/complained/blocked (suppressions). */
async function blockedAmong(deps: Deps, orgId: string, emails: string[]) {
  const unsub = new Map<string, number>(); const supp = new Map<string, string>();
  for (let i = 0; i < emails.length; i += 80) {
    const chunk = emails.slice(i, i + 80); if (!chunk.length) continue;
    const list = sql.join(chunk.map((e) => sql`${e}`), sql`, `);
    for (const r of await deps.db.all<{ email: string; created_at: number }>(sql`select email, created_at from merge_unsubscribes where org_id = ${orgId} and email in (${list})`)) unsub.set(r.email, Number(r.created_at));
    for (const r of await deps.db.all<{ address: string; reason: string }>(sql`select address, reason from suppressions where org_id = ${orgId} and address in (${list})`)) supp.set(r.address, r.reason);
  }
  return { unsub, supp };
}

/** Unsubscribed after the person's last recorded consent: a later confirmed opt in to this list wins. */
export function unsubscribedSince(unsubAt: number | undefined, consentAt: number | null) { return unsubAt !== undefined && (consentAt === null || unsubAt >= consentAt); }

export interface PersonIn { email: string; name?: string; fields?: Record<string, string> }
export interface ConsentIn { kind: ConsentKind; source: string }

/** Adds people (by hand, import or contacts). Never re-adds anyone unsubscribed, bounced or marked as spam. */
export async function addMembers(deps: Deps, auth: AuthContext, listId: string, people: PersonIn[], consent: ConsentIn, via: "manual" | "import" = "manual") {
  const l = await editableList(deps, auth, listId);
  if (!consent.source.trim()) throw badRequest("Say where these people gave consent, for example a signup form or in person.");
  if (consent.kind === "inferred" && !l.allow_inferred) throw badRequest("This list needs express consent. Turn on inferred consent in the list settings if these people are existing customers.");
  if (people.length > LIST_MEMBERS_IMPORT_MAX) throw badRequest(`Add up to ${LIST_MEMBERS_IMPORT_MAX} people at a time.`);
  const seen = new Set<string>(); const clean: PersonIn[] = []; let invalid = 0;
  for (const p of people) {
    const e = normEmail(p.email ?? "");
    if (!isEmail(e)) { invalid++; continue; }
    if (seen.has(e)) continue; seen.add(e);
    clean.push({ email: e, name: (p.name ?? "").trim().slice(0, 200), fields: Object.fromEntries(Object.entries(p.fields ?? {}).slice(0, 30).map(([k, v]) => [k.slice(0, 40), String(v).slice(0, 500)])) });
  }
  const { unsub, supp } = await blockedAmong(deps, auth.orgId, clean.map((p) => p.email));
  const existing = new Map<string, MemberRow>();
  for (let i = 0; i < clean.length; i += 80) {
    const chunk = clean.slice(i, i + 80); if (!chunk.length) continue;
    for (const r of await deps.db.all<MemberRow>(sql`select * from audience_members where list_id = ${listId} and email in (${sql.join(chunk.map((p) => sql`${p.email}`), sql`, `)})`)) existing.set(r.email, r);
  }
  const now = deps.now().getTime(); let added = 0, updated = 0, skippedUnsub = 0, skippedBounced = 0;
  const fresh: { id: string; email: string }[] = [];
  for (const p of clean) {
    const ex = existing.get(p.email);
    if (supp.has(p.email)) { skippedBounced++; continue; }
    if (unsubscribedSince(unsub.get(p.email), ex?.consent_at ?? null) || ex?.status === "unsubscribed" || ex?.status === "bounced" || ex?.status === "complained") { skippedUnsub++; continue; }
    if (ex) {
      await deps.db.run(sql`update audience_members set name = case when ${p.name ?? ""} = '' then name else ${p.name ?? ""} end, fields = ${JSON.stringify({ ...parse(ex.fields, {}), ...p.fields })}, updated_at = ${now} where id = ${ex.id}`);
      updated++; continue;
    }
    const id = newId("am");
    await deps.db.run(sql`insert into audience_members (id, org_id, list_id, email, name, fields, status, consent_kind, consent_source, consent_at, added_by, created_at, updated_at)
      values (${id}, ${auth.orgId}, ${listId}, ${p.email}, ${p.name ?? ""}, ${JSON.stringify(p.fields ?? {})}, ${startStatus(!!l.double_opt_in, via)}, ${consent.kind}, ${consent.source.trim().slice(0, 200)}, ${now}, ${auth.userId}, ${now}, ${now}) on conflict do nothing`);
    added++; fresh.push({ id, email: p.email });
  }
  await touchList(deps, listId);
  for (const f of fresh) await enrollInJourneys(deps, auth.orgId, listId, f.id, f.email);
  return { added, updated, skippedUnsubscribed: skippedUnsub, skippedBounced, skippedInvalid: invalid };
}

async function touchList(deps: Deps, listId: string) {
  await deps.db.run(sql`update audience_lists set member_count = (select count(*) from audience_members where list_id = ${listId}), updated_at = ${deps.now().getTime()} where id = ${listId}`);
}

export async function addFromContacts(deps: Deps, auth: AuthContext, listId: string, contactIds: string[] | "all", consent: ConsentIn) {
  const rows = contactIds === "all"
    ? await deps.db.all<{ name: string; email: string }>(sql`select name, email from contacts where org_id = ${auth.orgId} and email <> '' order by last_contact_at desc limit ${LIST_MEMBERS_IMPORT_MAX}`)
    : (await Promise.all(Array.from({ length: Math.ceil(contactIds.length / 80) }, (_, i) => contactIds.slice(i * 80, i * 80 + 80)).map((ch) =>
      deps.db.all<{ name: string; email: string }>(sql`select name, email from contacts where org_id = ${auth.orgId} and id in (${sql.join(ch.map((x) => sql`${x}`), sql`, `)})`)))).flat();
  return addMembers(deps, auth, listId, rows.map((r) => ({ email: r.email, name: r.name })), consent, "import");
}

export async function listMembers(deps: Deps, auth: AuthContext, listId: string, q: { search?: string; status?: string; offset?: number }) {
  const l = await getList(deps, auth, listId);
  const s = q.search?.trim().toLowerCase() ?? "";
  const rows = await deps.db.all<MemberRow>(sql`select * from audience_members where list_id = ${listId}
    ${q.status ? sql`and status = ${q.status}` : sql``} ${s ? sql`and (instr(lower(email), lower(${s})) > 0 or instr(lower(name), lower(${s})) > 0)` : sql``}
    order by created_at desc limit 51 offset ${Math.max(0, q.offset ?? 0)}`);
  const { unsub, supp } = await blockedAmong(deps, auth.orgId, rows.map((r) => r.email));
  return {
    list: listView(l, auth, (await counts(deps, auth.orgId, [listId])).get(listId)),
    more: rows.length > 50,
    members: rows.slice(0, 50).map((m) => {
      const ok = canSend({ status: m.status, consentKind: m.consent_kind, consentAt: m.consent_at, consentSource: m.consent_source }, { allowInferred: !!l.allow_inferred }, supp.has(m.email) || unsubscribedSince(unsub.get(m.email), m.consent_at));
      return { id: m.id, email: m.email, name: m.name, fields: parse<Record<string, string>>(m.fields, {}), status: m.status, consentKind: m.consent_kind, consentSource: m.consent_source,
        consentAt: m.consent_at ? new Date(m.consent_at).toISOString() : null, canSend: ok.ok, why: ok.ok ? null : ok.reason };
    }),
  };
}

export async function removeMember(deps: Deps, auth: AuthContext, listId: string, memberId: string) {
  await editableList(deps, auth, listId);
  await deps.db.run(sql`delete from audience_members where list_id = ${listId} and id = ${memberId}`);
  await deps.db.run(sql`update journey_enrollments set status = 'stopped' where member_id = ${memberId} and status = 'active'`);
  await touchList(deps, listId);
}

/** Unsubscribes an address everywhere in the workspace at once (Spam Act: within 5 business days; we do it now). */
export async function unsubscribeEverywhere(deps: Deps, orgId: string, email: string) {
  const e = normEmail(email); const now = deps.now().getTime();
  await recordUnsubscribe(deps, orgId, e);
  await deps.db.run(sql`update merge_unsubscribes set created_at = ${now} where org_id = ${orgId} and email = ${e}`);
  await deps.db.run(sql`update audience_members set status = 'unsubscribed', unsubscribed_at = ${now}, updated_at = ${now} where org_id = ${orgId} and email = ${e} and status in ('subscribed', 'pending')`);
  await deps.db.run(sql`update journey_enrollments set status = 'stopped', updated_at = ${now} where org_id = ${orgId} and email = ${e} and status = 'active'`);
}

export async function suppressionList(deps: Deps, auth: AuthContext, search = "") {
  const s0 = search.trim();
  const u = await deps.db.all<{ email: string; created_at: number }>(sql`select email, created_at from merge_unsubscribes where org_id = ${auth.orgId} and instr(lower(email), lower(${s0})) > 0 order by created_at desc limit 200`);
  const s = await deps.db.all<{ address: string; reason: string; created_at: number }>(sql`select address, reason, created_at from suppressions where org_id = ${auth.orgId} and instr(lower(address), lower(${s0})) > 0 order by created_at desc limit 200`);
  const toIso = (n: number) => new Date(Number(n) < 1e12 ? Number(n) * 1000 : Number(n)).toISOString();
  return [...u.map((r) => ({ email: r.email, reason: "unsubscribed", at: toIso(r.created_at) })), ...s.map((r) => ({ email: r.address, reason: r.reason, at: toIso(r.created_at) }))]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300);
}

// ------------------------------------------------------------------ signup with double opt in

export async function signupList(deps: Deps, key: string) {
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where signup_key = ${key} and archived_at is null and signup_on = 1`);
  return l ?? null;
}

/** A public signup. Express consent (the tick) with source and time; confirmed by email when the list asks. */
export async function signupSubmit(deps: Deps, l: ListRow, input: { email: string; name: string }, source = "Signup form") { // R124: the blog passes its own source
  const email = normEmail(input.email);
  if (!isEmail(email)) throw badRequest("Enter a valid email address.");
  const now = deps.now().getTime();
  const ex = await deps.db.get<MemberRow>(sql`select * from audience_members where list_id = ${l.id} and email = ${email}`);
  const { unsub, supp } = await blockedAmong(deps, l.org_id, [email]);
  if (supp.has(email)) return { status: "blocked" as const };
  if (ex?.status === "subscribed" && !unsubscribedSince(unsub.get(email), ex.consent_at)) return { status: "already" as const };
  // Someone who unsubscribed before always confirms by email, even when the list does not ask for it.
  const confirm = !!l.double_opt_in || unsub.has(email) || ex?.status === "unsubscribed";
  const token = confirm ? rand(16) : null;
  const status: MemberStatus = confirm ? "pending" : "subscribed";
  let memberId = ex?.id;
  if (ex) await deps.db.run(sql`update audience_members set name = case when ${input.name.trim()} = '' then name else ${input.name.trim().slice(0, 200)} end, status = ${status}, consent_kind = 'express', consent_source = ${source}, consent_at = ${confirm ? ex.consent_at : now}, confirm_token = ${token}, updated_at = ${now} where id = ${ex.id}`);
  else {
    memberId = newId("am");
    await deps.db.run(sql`insert into audience_members (id, org_id, list_id, email, name, fields, status, consent_kind, consent_source, consent_at, confirm_token, created_at, updated_at)
      values (${memberId}, ${l.org_id}, ${l.id}, ${email}, ${input.name.trim().slice(0, 200)}, '{}', ${status}, 'express', ${source}, ${confirm ? null : now}, ${token}, ${now}, ${now})`);
  }
  await touchList(deps, l.id);
  if (!confirm) { await enrollInJourneys(deps, l.org_id, l.id, memberId!, email); return { status: "subscribed" as const }; }
  await sendSystemish(deps, l, email, `Confirm you want emails from ${l.sender_name || l.name}`,
    `Hi,\n\nPlease confirm you want to get emails from ${l.sender_name || l.name} (${l.name}).\n\nConfirm: ${deps.config.appUrl}/api/campaign-public/confirm/${token}\n\nIf this wasn't you, ignore this email and you won't hear from us.\n\n${l.sender_name}, ${l.sender_address}`);
  return { status: "confirm" as const };
}

export async function confirmSignup(deps: Deps, token: string) {
  const m = await deps.db.get<MemberRow>(sql`select * from audience_members where confirm_token = ${token}`);
  if (!m || m.status !== "pending") return null;
  const now = deps.now().getTime();
  await deps.db.run(sql`update audience_members set status = 'subscribed', consent_kind = 'express', consent_source = ${`${m.consent_source || "Signup form"}, confirmed by email`.slice(0, 240)}, consent_at = ${now}, confirmed_at = ${now}, confirm_token = null, updated_at = ${now} where id = ${m.id}`);
  await enrollInJourneys(deps, m.org_id, m.list_id, m.id, m.email);
  return m;
}

/** The confirm email: from the list's mailbox, as the list owner (the normal send path and its limits). */
async function sendSystemish(deps: Deps, l: ListRow, to: string, subject: string, text: string) {
  if (!l.mailbox_id || !allowedBy((deps.config.campaignSendAllow ?? []), to)) return;
  const user = await deps.db.get<{ email: string; name: string }>(sql`select email, name from users where id = ${l.owner_user_id}`);
  const auth: AuthContext = { userId: l.owner_user_id, email: user?.email ?? "", name: user?.name ?? "", orgId: l.org_id, role: "member", sessionId: `list:${l.id}` } as AuthContext;
  const { sendMessage } = await import("../mail/send");
  await sendMessage(deps, auth, { mailboxId: l.mailbox_id, to: [to], subject, text }, { noQueue: true }).catch((err) => deps.log?.warn("campaigns.confirm_send_failed", { list: l.id, error: String(err) }));
}

// ------------------------------------------------------------------ newsletters

export async function brandColor(deps: Deps, orgId: string): Promise<string | null> {
  const r = await deps.db.get<{ brand: string }>(sql`select brand from workspace_branding where org_id = ${orgId}`);
  const b = r ? parse<{ primary?: string | null }>(r.brand, {}) : {};
  return b.primary ?? null;
}

export function campaignView(c: CampaignRow, list?: ListRow | null) {
  return {
    id: c.id, name: c.name, subject: c.subject, preheader: c.preheader, blocks: parse<Block[]>(c.blocks, []), track: !!c.track, status: c.status,
    listId: c.list_id, listName: list?.name ?? "", mailboxId: c.mailbox_id, scheduledAt: c.scheduled_at ? new Date(c.scheduled_at).toISOString() : null,
    sentAt: c.sent_at ? new Date(c.sent_at).toISOString() : null, error: c.error,
    stats: { total: c.total, sent: c.sent, failed: c.failed, skipped: c.skipped, opened: c.opened, clicked: c.clicked, unsubscribed: c.unsubscribed, bounced: c.bounced },
    updatedAt: new Date(c.updated_at).toISOString(),
  };
}

async function getCampaignRow(deps: Deps, auth: AuthContext, id: string) {
  const c = await deps.db.get<CampaignRow>(sql`select * from campaigns where org_id = ${auth.orgId} and id = ${id} and kind = 'newsletter'`);
  if (!c) throw notFound("Newsletter");
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where id = ${c.list_id}`);
  if (!l || !canSeeList(l, auth)) throw notFound("Newsletter");
  return { c, l };
}

export async function listCampaigns(deps: Deps, auth: AuthContext) {
  const rows = await deps.db.all<CampaignRow & { list_name: string; visibility: string; owner_user_id: string }>(sql`select c.*, l.name as list_name, l.visibility, l.owner_user_id from campaigns c join audience_lists l on l.id = c.list_id
    where c.org_id = ${auth.orgId} and c.kind = 'newsletter' order by c.updated_at desc limit 100`);
  return rows.filter((r) => isAdmin(auth) || r.visibility === "workspace" || r.owner_user_id === auth.userId).map((r) => ({ ...campaignView(r), listName: r.list_name }));
}

export async function getCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  return { ...campaignView(c, l), canSend: canSendToList(l, auth), list: listView(l, auth, (await counts(deps, auth.orgId, [l.id])).get(l.id)) };
}

export async function createCampaign(deps: Deps, auth: AuthContext, i: { listId: string; name: string }) {
  const l = await getList(deps, auth, i.listId);
  const id = newId("cmp"); const now = deps.now().getTime();
  await deps.db.run(sql`insert into campaigns (id, org_id, list_id, user_id, mailbox_id, name, subject, blocks, created_at, updated_at)
    values (${id}, ${auth.orgId}, ${l.id}, ${auth.userId}, ${l.mailbox_id}, ${i.name.trim()}, '', ${JSON.stringify(STARTER_BLOCKS)}, ${now}, ${now})`);
  return getCampaign(deps, auth, id);
}

export interface CampaignPatch { name?: string; subject?: string; preheader?: string; blocks?: Block[]; track?: boolean; listId?: string; mailboxId?: string | null }

export async function updateCampaign(deps: Deps, auth: AuthContext, id: string, p: CampaignPatch) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (c.status !== "draft") throw badRequest("This newsletter has been sent or scheduled. Unschedule it or make a copy to change it.");
  if (c.user_id !== auth.userId && !canEditList(l, auth)) throw forbidden("Only the person who wrote this newsletter or an admin can change it.");
  if (p.listId && p.listId !== c.list_id) await getList(deps, auth, p.listId);
  if (p.mailboxId) await assertMailboxAccess(deps.db, auth, p.mailboxId);
  const blocks = p.blocks ? blocksSchema.parse(p.blocks) : undefined;
  await deps.db.run(sql`update campaigns set name = ${p.name?.trim() || c.name}, subject = ${p.subject ?? c.subject}, preheader = ${p.preheader ?? c.preheader},
    blocks = ${blocks ? JSON.stringify(blocks) : c.blocks}, track = ${p.track === undefined ? c.track : p.track ? 1 : 0}, list_id = ${p.listId ?? c.list_id},
    mailbox_id = ${p.mailboxId === undefined ? c.mailbox_id : p.mailboxId}, updated_at = ${deps.now().getTime()} where id = ${id}`);
  return getCampaign(deps, auth, id);
}

export async function deleteCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (c.status === "sending") throw badRequest("Stop sending before you delete this newsletter.");
  if (c.user_id !== auth.userId && !canEditList(l, auth)) throw forbidden();
  await deps.db.run(sql`delete from campaign_recipients where campaign_id = ${id}`);
  await deps.db.run(sql`delete from campaigns where id = ${id}`);
}

export async function duplicateCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { c } = await getCampaignRow(deps, auth, id);
  const nid = newId("cmp"); const now = deps.now().getTime();
  await deps.db.run(sql`insert into campaigns (id, org_id, list_id, user_id, mailbox_id, name, subject, preheader, blocks, track, created_at, updated_at)
    values (${nid}, ${auth.orgId}, ${c.list_id}, ${auth.userId}, ${c.mailbox_id}, ${`${c.name} copy`.slice(0, 120)}, ${c.subject}, ${c.preheader}, ${c.blocks}, ${c.track}, ${now}, ${now})`);
  return getCampaign(deps, auth, nid);
}

async function renderCtx(deps: Deps, l: ListRow) {
  const ctx = await templateContext(deps, l.org_id);
  return { workspace: ctx.workspaceName, brandColor: await brandColor(deps, l.org_id), senderName: l.sender_name || ctx.workspaceName, senderAddress: l.sender_address, listName: l.name };
}

/** The email as one person would see it (the first subscribed person, or a sample). */
export async function previewCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  const m = await deps.db.get<MemberRow>(sql`select * from audience_members where list_id = ${l.id} and status = 'subscribed' order by created_at limit 1`);
  const person = m ? { email: m.email, name: m.name, fields: parse<Record<string, string>>(m.fields, {}) } : { email: "sam@example.com", name: "Sam Lee", fields: {} };
  const r = renderEmail(parse<Block[]>(c.blocks, []), person, { ...(await renderCtx(deps, l)), unsubscribeUrl: `${deps.config.appUrl}/api/campaign-public/u/preview`, preheader: c.preheader });
  return { html: r.html, text: r.text, person: { email: person.email, name: person.name }, eligible: await eligibleCount(deps, l) };
}

/** What has to be true before a send. Each problem is one plain sentence. */
export function sendProblems(c: Pick<CampaignRow, "subject" | "mailbox_id" | "blocks">, l: Pick<ListRow, "sender_name" | "sender_address">): string[] {
  const out: string[] = [];
  if (!c.subject.trim()) out.push("Add a subject.");
  if (!c.mailbox_id) out.push("Pick the mailbox it sends from.");
  if (!l.sender_name.trim() || l.sender_address.trim().length < 6) out.push("Add the sender name and a contact address in the list settings. The law asks for both in every email.");
  if (!parse<Block[]>(c.blocks, []).some((b) => b.type === "text" || b.type === "heading")) out.push("Write something in the email.");
  return out;
}

async function eligibleMembers(deps: Deps, l: ListRow, limit = 20000) {
  const rows = await deps.db.all<MemberRow>(sql`select * from audience_members where list_id = ${l.id} and status = 'subscribed' order by created_at limit ${limit}`);
  const { unsub, supp } = await blockedAmong(deps, l.org_id, rows.map((r) => r.email));
  const ok: MemberRow[] = []; let skipped = 0;
  for (const m of rows) {
    const v = canSend({ status: m.status, consentKind: m.consent_kind, consentAt: m.consent_at, consentSource: m.consent_source }, { allowInferred: !!l.allow_inferred }, supp.has(m.email) || unsubscribedSince(unsub.get(m.email), m.consent_at));
    if (v.ok) ok.push(m); else skipped++;
  }
  return { ok, skipped };
}
/** PRIV1b (CB1): the daily merge cap of the workspace's effective plan, so a comp workspace gets the plan it was granted. */
export async function mergeCap(deps: Deps, orgId: string) {
  const o = await deps.db.get<{ plan: string | null; comp_plan: number | null }>(sql`select plan, comp_plan from organizations where id = ${orgId}`);
  return MERGE_DAILY_CAP[effectivePlanId({ plan: o?.plan, compPlan: o?.comp_plan })];
}
async function eligibleCount(deps: Deps, l: ListRow) { return (await eligibleMembers(deps, l)).ok.length; }

export async function sendInfo(deps: Deps, auth: AuthContext) {
  const s = await toolStateOrOff(deps, auth.orgId);
  const cap = MERGE_DAILY_CAP[s.plan];
  return { cap, usedToday: await mergeUsedToday(deps, auth.orgId), stagingOnly: (deps.config.campaignSendAllow ?? []).length > 0 };
}

/** A test copy to the person writing it (their own address only), marked as a test. Counts nothing. */
export async function testSend(deps: Deps, auth: AuthContext, id: string) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (!c.mailbox_id) throw badRequest("Pick the mailbox it sends from.");
  await assertMailboxAccess(deps.db, auth, c.mailbox_id);
  const to = normEmail(auth.email);
  if (!allowedBy((deps.config.campaignSendAllow ?? []), to)) throw badRequest("On this test site, emails only go to the QA mailbox.");
  const r = renderEmail(parse<Block[]>(c.blocks, []), { email: to, name: auth.name }, { ...(await renderCtx(deps, l)), unsubscribeUrl: `${deps.config.appUrl}/api/campaign-public/u/test`, preheader: c.preheader });
  const { sendMessage } = await import("../mail/send");
  await sendMessage(deps, auth, { mailboxId: c.mailbox_id, to: [to], subject: `[Test] ${c.subject || c.name}`, text: r.text, html: r.html }, { noQueue: true });
  return { to };
}

/** Schedules (or sends now). Checks the law's needs and the permission first; the batch job does the rest. */
export async function scheduleCampaign(deps: Deps, auth: AuthContext, id: string, at: string | null) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (!canSendToList(l, auth)) throw forbidden("Only admins can send to a list shared with the whole workspace.");
  if (c.status !== "draft") throw badRequest("This newsletter is already scheduled or sent.");
  const problems = sendProblems(c, l);
  if (problems.length) throw badRequest(problems.join(" "));
  await assertMailboxAccess(deps.db, auth, c.mailbox_id!);
  await toolStateOrOff(deps, auth.orgId);
  if (!(await eligibleCount(deps, l))) throw badRequest("Nobody on this list can get it yet. Add people who gave consent, or wait for them to confirm.");
  const now = deps.now().getTime();
  const when = at ? Date.parse(at) : now;
  if (!Number.isFinite(when)) throw badRequest("Pick a date and time.");
  if (when < now - 60_000) throw badRequest("Pick a time in the future.");
  if (when > now + 90 * 86_400_000) throw badRequest("Schedule up to 90 days ahead.");
  await deps.db.run(sql`update campaigns set status = 'scheduled', scheduled_at = ${when}, error = null, updated_at = ${now} where id = ${id} and status = 'draft'`);
  if (when - now <= 5_000) {
    // Send now: take the list snapshot in this request so the page shows the totals at once; the sends are queued jobs.
    try { await runCampaignBatch(deps, id); } catch (err) {
      deps.log?.warn("campaigns.batch_inline_failed", { id, error: String(err) });
      await enqueue(deps, "campaign.batch", { id }, { orgId: auth.orgId, maxAttempts: 3 });
    }
  } else await enqueue(deps, "campaign.batch", { id }, { orgId: auth.orgId, delayMs: when - now, maxAttempts: 3 });
  return getCampaign(deps, auth, id);
}

export async function unscheduleCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (!canSendToList(l, auth) && c.user_id !== auth.userId) throw forbidden();
  if (c.status !== "scheduled") throw badRequest("Only a scheduled newsletter can go back to draft.");
  await deps.db.run(sql`update campaigns set status = 'draft', scheduled_at = null, updated_at = ${deps.now().getTime()} where id = ${id} and status = 'scheduled'`);
  return getCampaign(deps, auth, id);
}

export async function pauseCampaign(deps: Deps, auth: AuthContext, id: string, pause: boolean) {
  const { c, l } = await getCampaignRow(deps, auth, id);
  if (!canSendToList(l, auth)) throw forbidden();
  const now = deps.now().getTime();
  if (pause) {
    if (c.status !== "sending") throw badRequest("Only a newsletter that is sending can be paused.");
    await deps.db.run(sql`update campaigns set status = 'paused', updated_at = ${now} where id = ${id} and status = 'sending'`);
  } else {
    if (c.status !== "paused") throw badRequest("This newsletter is not paused.");
    await deps.db.run(sql`update campaigns set status = 'sending', updated_at = ${now} where id = ${id} and status = 'paused'`);
    await enqueue(deps, "campaign.batch", { id }, { orgId: auth.orgId, maxAttempts: 3 });
  }
  return getCampaign(deps, auth, id);
}

export async function stopCampaign(deps: Deps, auth: AuthContext, id: string) {
  const { l } = await getCampaignRow(deps, auth, id);
  if (!canSendToList(l, auth)) throw forbidden();
  const now = deps.now().getTime();
  await deps.db.run(sql`update campaign_recipients set status = 'skipped', error = 'Stopped' where campaign_id = ${id} and status = 'queued'`);
  await deps.db.run(sql`update campaigns set status = 'cancelled', skipped = (select count(*) from campaign_recipients where campaign_id = ${id} and status = 'skipped'), updated_at = ${now} where id = ${id} and status in ('sending', 'paused', 'scheduled')`);
  return getCampaign(deps, auth, id);
}

/** Batch job: the first run takes the list snapshot; each run sends what today's limit allows, the rest waits for tomorrow. */
export async function runCampaignBatch(deps: Deps, id: string) {
  const c = await deps.db.get<CampaignRow>(sql`select * from campaigns where id = ${id}`);
  if (!c || !["scheduled", "sending"].includes(c.status)) return;
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where id = ${c.list_id}`);
  const now = deps.now().getTime();
  const fail = (msg: string) => deps.db.run(sql`update campaigns set status = 'paused', error = ${msg}, updated_at = ${now} where id = ${id}`);
  if (!l || l.archived_at) return void (await fail("The list was archived."));
  if (c.status === "scheduled") {
    const claimed = await deps.db.run(sql`update campaigns set status = 'sending', sent_at = ${now}, updated_at = ${now} where id = ${id} and status = 'scheduled'`);
    if (!changes(claimed)) return;
    const { ok, skipped } = await eligibleMembers(deps, l);
    for (let i = 0; i < ok.length; i += 10) {
      const rows = ok.slice(i, i + 10).map((m, j) => sql`(${id}, ${i + j}, ${c.org_id}, ${m.id}, ${m.email}, ${m.name}, ${m.fields}, ${rand(16)})`);
      await deps.db.run(sql`insert into campaign_recipients (campaign_id, idx, org_id, member_id, email, name, data, token) values ${sql.join(rows, sql`, `)}`);
    }
    await deps.db.run(sql`update campaigns set total = ${ok.length}, skipped = ${skipped}, status = case when ${ok.length} = 0 then 'sent' else status end where id = ${id}`);
    if (!ok.length) return;
  }
  await deps.db.run(sql`update campaigns set error = null where id = ${id} and error like 'Today%'`);
  const queued = await deps.db.all<{ idx: number }>(sql`select idx from campaign_recipients where campaign_id = ${id} and status = 'queued' and (send_after is null or send_after <= ${now}) order by idx limit 2000`);
  if (!queued.length) return;
  const cap = await mergeCap(deps, c.org_id);
  const plan = sendPlan(queued.length, cap - (await mergeUsedToday(deps, c.org_id)));
  let today = plan.today;
  while (today > 0 && !(await reserveMergeQuota(deps, c.org_id, today, cap))) today = Math.floor(today / 2);
  for (let k = 0; k < today; k++) await enqueue(deps, "campaign.send", { id, idx: queued[k].idx }, { orgId: c.org_id, delayMs: k * CAMPAIGN_SPACING_SECONDS * 1000, maxAttempts: 3 });
  if (queued.length - today > 0 || queued.length === 2000) {
    const next = nextDayStart(now, "UTC");
    const rest = queued.slice(today).map((q) => q.idx);
    for (let i = 0; i < rest.length; i += 80) await deps.db.run(sql`update campaign_recipients set send_after = ${next} where campaign_id = ${id} and idx in (${sql.join(rest.slice(i, i + 80).map((x) => sql`${x}`), sql`, `)})`);
    await enqueue(deps, "campaign.batch", { id }, { orgId: c.org_id, delayMs: Math.max(60_000, next - now + (today * CAMPAIGN_SPACING_SECONDS * 1000)), maxAttempts: 3 });
    await deps.db.run(sql`update campaigns set error = ${"Today's sending limit is reached. The rest goes out tomorrow."} where id = ${id}`);
  }
}

export async function trackingUrls(deps: Deps, token: string) {
  const base = `${deps.config.appUrl}/api/campaign-public`;
  return {
    unsubscribe: `${base}/u/${token}`,
    pixel: `${base}/o/${token}.gif`,
    link: async (u: string) => `${base}/c/${token}?u=${encodeURIComponent(u)}&s=${await linkSig(deps, token, u)}`,
  };
}
export async function linkSig(deps: Deps, token: string, u: string) { return (await hmacSha256Hex(deps.config.tools.tokenKey ?? deps.config.appUrl, `campaign.link.${token}.${u}`)).slice(0, 20); }
export async function checkLinkSig(deps: Deps, token: string, u: string, s: string) { return s.length === 20 && safeEqual(await linkSig(deps, token, u), s); }

/** Sends one recipient's email. Re-checks unsubscribe and bounces right before sending. */
export async function deliverOne(deps: Deps, c: CampaignRow, l: ListRow, r: RecipientRow, subject: string, blocks: Block[]): Promise<"sent" | "failed" | "skipped"> {
  const now = deps.now().getTime();
  const mark = async (status: "sent" | "failed" | "skipped", error: string | null, bounced = false) => {
    const done = await deps.db.run(sql`update campaign_recipients set status = ${status}, error = ${error}, sent_at = ${now} where campaign_id = ${r.campaign_id} and idx = ${r.idx} and status = 'queued'`);
    if (!changes(done)) return status;
    const col = status === "sent" ? sql`sent = sent + 1` : status === "failed" ? sql`failed = failed + 1` : sql`skipped = skipped + 1`;
    await deps.db.run(sql`update campaigns set ${col}, bounced = bounced + ${bounced ? 1 : 0}, updated_at = ${now},
      status = case when kind = 'newsletter' and status = 'sending' and sent + failed + skipped + 1 >= total then 'sent' else status end where id = ${c.id}`);
    return status;
  };
  const m = r.member_id ? await deps.db.get<MemberRow>(sql`select * from audience_members where id = ${r.member_id}`) : null;
  const { unsub, supp } = await blockedAmong(deps, c.org_id, [r.email]);
  if (supp.has(r.email)) {
    if (m) await deps.db.run(sql`update audience_members set status = ${supp.get(r.email) === "complaint" ? "complained" : "bounced"}, updated_at = ${now} where id = ${m.id}`);
    return mark("skipped", "Bounced or marked as spam before", true);
  }
  if (!m || m.status !== "subscribed" || unsubscribedSince(unsub.get(r.email), m.consent_at)) return mark("skipped", "Unsubscribed");
  if (!allowedBy((deps.config.campaignSendAllow ?? []), r.email)) return mark("skipped", "Not sent: on the test site emails only go to the QA mailbox.");
  const urls = await trackingUrls(deps, r.token);
  const ctx = await renderCtx(deps, l);
  const person = { email: r.email, name: r.name, fields: parse<Record<string, string>>(r.data, {}) };
  // Links are signed up front so the renderer can stay synchronous.
  const links = new Map<string, string>();
  if (c.track) {
    const raw = renderEmail(blocks, person, { ...ctx, unsubscribeUrl: urls.unsubscribe });
    for (const u of new Set([...raw.html.matchAll(/href="(https:\/\/[^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, "&")))) if (u !== urls.unsubscribe) links.set(u, await urls.link(u));
  }
  const out = renderEmail(blocks, person, { ...ctx, unsubscribeUrl: urls.unsubscribe, preheader: c.preheader, pixelUrl: c.track ? urls.pixel : null, trackLink: c.track ? (u) => links.get(u) ?? u : undefined });
  const user = await deps.db.get<{ email: string; name: string }>(sql`select email, name from users where id = ${c.user_id}`);
  const auth = { userId: c.user_id, email: user?.email ?? "", name: user?.name ?? "", orgId: c.org_id, role: "member", sessionId: `campaign:${c.id}` } as AuthContext;
  try {
    const { sendMessage } = await import("../mail/send");
    const res = await sendMessage(deps, auth, { mailboxId: c.mailbox_id ?? l.mailbox_id ?? "", to: [r.email], subject: fillSubject(subject, person, ctx.workspace), text: out.text, html: out.html },
      { noQueue: true, headers: unsubscribeHeaders(urls.unsubscribe) });
    const ext = res.external[0];
    if (ext?.status === "failed") return mark("failed", (ext.detail ?? "Not sent").slice(0, 300), /bounced|spam/i.test(ext.detail ?? ""));
    return mark("sent", null);
  } catch (err) {
    return mark("failed", (err instanceof HttpError ? err.message : "The email could not be sent.").slice(0, 300));
  }
}

function fillSubject(subject: string, p: { email: string; name: string; fields: Record<string, string> }, workspace: string) {
  return subject.replace(/\{\{\s*([a-zA-Z]\w*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_m, k: string, fb?: string) => {
    const key = k.toLowerCase();
    const v = key === "first_name" ? (p.name.trim().split(/\s+/)[0] ?? "") : key === "name" ? p.name : key === "email" ? p.email : key === "workspace" ? workspace : (p.fields[k] ?? "");
    return v || (fb ?? "");
  }).replace(/[\r\n]+/g, " ").slice(0, 300);
}

export async function runCampaignSend(deps: Deps, payload: { id: string; idx: number }) {
  const c = await deps.db.get<CampaignRow>(sql`select * from campaigns where id = ${payload.id}`);
  if (!c || c.status !== "sending") return; // paused or stopped: resume re-queues
  const r = await deps.db.get<RecipientRow>(sql`select * from campaign_recipients where campaign_id = ${c.id} and idx = ${payload.idx}`);
  if (!r || r.status !== "queued") return;
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where id = ${c.list_id}`);
  if (!l) return;
  await deliverOne(deps, c, l, r, c.subject, parse<Block[]>(c.blocks, []));
}

// ------------------------------------------------------------------ public: opens, clicks, unsubscribe

export async function recordOpen(deps: Deps, token: string) {
  const now = deps.now().getTime();
  const r = await deps.db.get<{ campaign_id: string }>(sql`update campaign_recipients set opened_at = ${now} where token = ${token} and opened_at is null returning campaign_id`);
  if (r) await deps.db.run(sql`update campaigns set opened = opened + 1 where id = ${r.campaign_id}`);
}

export async function recordClick(deps: Deps, token: string) {
  const now = deps.now().getTime();
  const r = await deps.db.get<{ campaign_id: string; opened_at: number | null }>(sql`update campaign_recipients set clicked_at = ${now} where token = ${token} and clicked_at is null returning campaign_id, opened_at`);
  if (!r) return;
  await deps.db.run(sql`update campaigns set clicked = clicked + 1 where id = ${r.campaign_id}`);
  if (!r.opened_at) await recordOpen(deps, token);
}

export async function recipientByToken(deps: Deps, token: string) {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  return (await deps.db.get<RecipientRow>(sql`select * from campaign_recipients where token = ${token}`)) ?? null;
}

export async function unsubscribeByToken(deps: Deps, token: string) {
  const r = await recipientByToken(deps, token);
  if (!r) return null;
  const before = await deps.db.get<{ n: number }>(sql`select count(*) as n from audience_members where org_id = ${r.org_id} and email = ${r.email} and status in ('subscribed', 'pending')`);
  await unsubscribeEverywhere(deps, r.org_id, r.email);
  if (Number(before?.n ?? 0) > 0) await deps.db.run(sql`update campaigns set unsubscribed = unsubscribed + 1 where id = ${r.campaign_id}`);
  return r;
}

// ------------------------------------------------------------------ journeys

export function journeyView(j: JourneyRow, l?: ListRow | null) {
  return { id: j.id, name: j.name, status: j.status, listId: j.list_id, listName: l?.name ?? "", mailboxId: j.mailbox_id, steps: parse<JourneyStep[]>(j.steps, []), sendHour: j.send_hour, enrolled: j.enrolled, tz: l?.tz ?? "Australia/Sydney", updatedAt: new Date(j.updated_at).toISOString() };
}

async function getJourneyRow(deps: Deps, auth: AuthContext, id: string) {
  const j = await deps.db.get<JourneyRow>(sql`select * from journeys where org_id = ${auth.orgId} and id = ${id}`);
  if (!j) throw notFound("Journey");
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where id = ${j.list_id}`);
  if (!l || !canSeeList(l, auth)) throw notFound("Journey");
  return { j, l };
}

export async function listJourneys(deps: Deps, auth: AuthContext) {
  const rows = await deps.db.all<JourneyRow & { list_name: string; visibility: string; owner_user_id: string; tz: string }>(sql`select j.*, l.name as list_name, l.visibility, l.owner_user_id, l.tz from journeys j join audience_lists l on l.id = j.list_id where j.org_id = ${auth.orgId} order by j.updated_at desc limit 100`);
  return rows.filter((r) => isAdmin(auth) || r.visibility === "workspace" || r.owner_user_id === auth.userId).map((r) => ({ ...journeyView(r), listName: r.list_name, tz: r.tz }));
}

export async function getJourney(deps: Deps, auth: AuthContext, id: string) {
  const { j, l } = await getJourneyRow(deps, auth, id);
  const steps = await deps.db.all<{ name: string; total: number; sent: number; opened: number; clicked: number; unsubscribed: number }>(sql`select name, total, sent, opened, clicked, unsubscribed from campaigns where journey_id = ${id} order by name`);
  const waiting = await deps.db.get<{ n: number }>(sql`select count(*) as n from journey_enrollments where journey_id = ${id} and status = 'active'`);
  return { ...journeyView(j, l), canSend: canSendToList(l, auth), active: Number(waiting?.n ?? 0), stepStats: steps };
}

export async function createJourney(deps: Deps, auth: AuthContext, i: { listId: string; name: string; starter?: JourneyStep[] }) {
  const l = await getList(deps, auth, i.listId);
  const id = newId("jr"); const now = deps.now().getTime();
  await deps.db.run(sql`insert into journeys (id, org_id, list_id, user_id, mailbox_id, name, steps, created_at, updated_at) values (${id}, ${auth.orgId}, ${l.id}, ${auth.userId}, ${l.mailbox_id}, ${i.name.trim()}, ${JSON.stringify(i.starter ?? [])}, ${now}, ${now})`);
  return getJourney(deps, auth, id);
}

export async function updateJourney(deps: Deps, auth: AuthContext, id: string, p: { name?: string; steps?: JourneyStep[]; sendHour?: number; mailboxId?: string | null }) {
  const { j, l } = await getJourneyRow(deps, auth, id);
  if (j.user_id !== auth.userId && !canEditList(l, auth)) throw forbidden("Only the person who made this journey or an admin can change it.");
  if (j.status === "active") throw badRequest("Pause the journey before you change it.");
  const steps = p.steps ? journeyStepsSchema.parse(p.steps) : undefined;
  if (p.mailboxId) await assertMailboxAccess(deps.db, auth, p.mailboxId);
  if (p.sendHour !== undefined && (p.sendHour < 0 || p.sendHour > 23)) throw badRequest("Pick an hour between 0 and 23.");
  await deps.db.run(sql`update journeys set name = ${p.name?.trim() || j.name}, steps = ${steps ? JSON.stringify(steps) : j.steps}, send_hour = ${p.sendHour ?? j.send_hour},
    mailbox_id = ${p.mailboxId === undefined ? j.mailbox_id : p.mailboxId}, updated_at = ${deps.now().getTime()} where id = ${id}`);
  return getJourney(deps, auth, id);
}

export async function deleteJourney(deps: Deps, auth: AuthContext, id: string) {
  const { j, l } = await getJourneyRow(deps, auth, id);
  if (j.user_id !== auth.userId && !canEditList(l, auth)) throw forbidden();
  await deps.db.run(sql`update journey_enrollments set status = 'stopped' where journey_id = ${id}`);
  await deps.db.run(sql`delete from journeys where id = ${id}`);
}

export async function setJourneyStatus(deps: Deps, auth: AuthContext, id: string, status: "active" | "paused") {
  const { j, l } = await getJourneyRow(deps, auth, id);
  if (!canSendToList(l, auth)) throw forbidden("Only admins can start a journey on a list shared with the whole workspace.");
  const steps = parse<JourneyStep[]>(j.steps, []);
  if (status === "active") {
    if (!steps.length) throw badRequest("Add at least one email to the journey.");
    if (!j.mailbox_id) throw badRequest("Pick the mailbox it sends from.");
    if (steps.some((s) => !s.subject.trim())) throw badRequest("Give every email a subject.");
    if (!l.sender_name.trim() || l.sender_address.trim().length < 6) throw badRequest("Add the sender name and a contact address in the list settings. The law asks for both in every email.");
    await assertMailboxAccess(deps.db, auth, j.mailbox_id);
  }
  const now = deps.now().getTime();
  await deps.db.run(sql`update journeys set status = ${status}, updated_at = ${now} where id = ${id}`);
  if (status === "active" && j.status === "paused") {
    // Resume: pick up everyone who was waiting (sends that came due while paused go now, spaced out).
    const waiting = await deps.db.all<EnrollmentRow>(sql`select * from journey_enrollments where journey_id = ${id} and status = 'active' order by next_at limit 1000`);
    let k = 0;
    for (const e of waiting) await enqueue(deps, "journey.step", { id: e.id }, { orgId: j.org_id, delayMs: Math.max(0, (e.next_at ?? now) - now) + (k++) * CAMPAIGN_SPACING_SECONDS * 1000, maxAttempts: 3 });
  }
  return getJourney(deps, auth, id);
}

/** A person who joins a list (confirmed) starts every active journey on it. */
export async function enrollInJourneys(deps: Deps, orgId: string, listId: string, memberId: string, email: string) {
  const js = await deps.db.all<JourneyRow & { tz: string }>(sql`select j.*, l.tz from journeys j join audience_lists l on l.id = j.list_id where j.list_id = ${listId} and j.status = 'active' limit 20`);
  const m = await deps.db.get<{ status: string }>(sql`select status from audience_members where id = ${memberId}`);
  if (m?.status !== "subscribed") return;
  const now = deps.now().getTime();
  for (const j of js) {
    const steps = parse<JourneyStep[]>(j.steps, []);
    if (!steps.length) continue;
    const at = stepSendAt(now, steps[0].delayDays, j.send_hour, j.tz);
    const id = newId("je");
    const ins = await deps.db.run(sql`insert into journey_enrollments (id, journey_id, org_id, member_id, email, step, next_at, status, created_at, updated_at) values (${id}, ${j.id}, ${orgId}, ${memberId}, ${email}, 0, ${at}, 'active', ${now}, ${now}) on conflict do nothing`);
    if (!changes(ins)) continue;
    await deps.db.run(sql`update journeys set enrolled = enrolled + 1 where id = ${j.id}`);
    await enqueue(deps, "journey.step", { id }, { orgId, delayMs: Math.max(0, at - now), maxAttempts: 3 });
  }
}

/** The hidden per step campaign that holds a journey email's recipients and counts. */
async function stepCampaign(deps: Deps, j: JourneyRow, stepIdx: number, step: JourneyStep): Promise<CampaignRow> {
  const id = `${j.id}_s${stepIdx}`;
  const now = deps.now().getTime();
  await deps.db.run(sql`insert into campaigns (id, org_id, list_id, user_id, mailbox_id, kind, journey_id, name, subject, blocks, status, created_at, updated_at)
    values (${id}, ${j.org_id}, ${j.list_id}, ${j.user_id}, ${j.mailbox_id}, 'journey_step', ${j.id}, ${`Email ${String(stepIdx + 1).padStart(2, "0")}`}, ${step.subject}, '[]', 'sending', ${now}, ${now}) on conflict do nothing`);
  return (await deps.db.get<CampaignRow>(sql`select * from campaigns where id = ${id}`))!;
}

export async function runJourneyStep(deps: Deps, payload: { id: string }) {
  const e = await deps.db.get<EnrollmentRow>(sql`select * from journey_enrollments where id = ${payload.id}`);
  if (!e || e.status !== "active") return;
  const j = await deps.db.get<JourneyRow>(sql`select * from journeys where id = ${e.journey_id}`);
  if (!j || j.status !== "active") return; // paused: resume re-queues
  const now = deps.now().getTime();
  if (e.next_at && e.next_at > now + 60_000) return; // an older job for a step that moved
  const l = await deps.db.get<ListRow>(sql`select * from audience_lists where id = ${j.list_id}`);
  const steps = parse<JourneyStep[]>(j.steps, []);
  const stop = () => deps.db.run(sql`update journey_enrollments set status = 'stopped', updated_at = ${now} where id = ${e.id}`);
  if (!l || l.archived_at) return void (await stop());
  const step = steps[e.step];
  if (!step) return void (await deps.db.run(sql`update journey_enrollments set status = 'done', next_at = null, updated_at = ${now} where id = ${e.id}`));
  const lastOpened = e.last_token ? !!(await deps.db.get<{ opened_at: number | null }>(sql`select opened_at from campaign_recipients where token = ${e.last_token}`))?.opened_at : false;
  let token = e.last_token;
  if (!skipStep(step, lastOpened)) {
    const cap = await mergeCap(deps, j.org_id);
    if (!(await reserveMergeQuota(deps, j.org_id, 1, cap))) {
      const next = nextDayStart(now, "UTC");
      await deps.db.run(sql`update journey_enrollments set next_at = ${next}, updated_at = ${now} where id = ${e.id}`);
      await enqueue(deps, "journey.step", { id: e.id }, { orgId: j.org_id, delayMs: next - now, maxAttempts: 3 });
      return;
    }
    const c = await stepCampaign(deps, j, e.step, step);
    const m = await deps.db.get<MemberRow>(sql`select * from audience_members where id = ${e.member_id}`);
    if (!m) return void (await stop());
    token = rand(16);
    const idx = (await deps.db.get<{ n: number }>(sql`update campaigns set total = total + 1, updated_at = ${now} where id = ${c.id} returning total as n`))!.n - 1;
    await deps.db.run(sql`insert into campaign_recipients (campaign_id, idx, org_id, member_id, email, name, data, token) values (${c.id}, ${idx}, ${j.org_id}, ${m.id}, ${m.email}, ${m.name}, ${m.fields}, ${token})`);
    const r = (await deps.db.get<RecipientRow>(sql`select * from campaign_recipients where token = ${token}`))!;
    const res = await deliverOne(deps, { ...c, mailbox_id: j.mailbox_id, track: 1 }, l, r, step.subject, step.blocks);
    if (res === "skipped") { const again = await deps.db.get<{ status: string }>(sql`select status from audience_members where id = ${m.id}`); if (again?.status !== "subscribed") return void (await stop()); }
  }
  const nextIdx = e.step + 1;
  if (nextIdx >= steps.length) return void (await deps.db.run(sql`update journey_enrollments set step = ${nextIdx}, status = 'done', next_at = null, last_token = ${token}, updated_at = ${now} where id = ${e.id}`));
  const at = stepSendAt(now, steps[nextIdx].delayDays, j.send_hour, l.tz);
  await deps.db.run(sql`update journey_enrollments set step = ${nextIdx}, next_at = ${at}, last_token = ${token}, updated_at = ${now} where id = ${e.id}`);
  await enqueue(deps, "journey.step", { id: e.id }, { orgId: j.org_id, delayMs: Math.max(0, at - now), maxAttempts: 3 });
}

registerJob("campaign.batch", async (deps, payload) => { await runCampaignBatch(deps, (payload as { id: string }).id); });
registerJob("campaign.send", async (deps, payload) => { await runCampaignSend(deps, payload as { id: string; idx: number }); });
registerJob("journey.step", async (deps, payload) => { await runJourneyStep(deps, payload as { id: string }); });

