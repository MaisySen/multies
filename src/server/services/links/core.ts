/**
 * R87: short links in Tools > Links. A link belongs to the workspace; every member sees the list, the person who made a
 * link and the admins can change it. The public side (/l/<code>) is in public.ts and reads one row by its code.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { linkClicks, linkHosts, shortLinks, users } from "../../db/schema";
import { hashPassword, newId, randomBytes } from "../../lib/crypto";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import { AUTO_CODE_LENGTH, CODE_RE, MAX_BULK, MAX_TAGS, MAX_URL, csvCell, normCode, type LinkStats, type LinkStatus, type ShortLinkInfo, type StatRow } from "@/shared/links";
import { forgetCode } from "./public";

type Row = typeof shortLinks.$inferSelect;
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0 o 1 l, so a code read aloud is not misheard

export function autoCode(n = AUTO_CODE_LENGTH): string {
  const b = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

/** The public base for this workspace's links: its own live link domain, else <app>/l. */
export async function linkBase(deps: Deps, orgId: string): Promise<string> {
  const h = await deps.db.select({ host: linkHosts.host, status: linkHosts.status }).from(linkHosts).where(eq(linkHosts.orgId, orgId)).get();
  return h && h.status === "live" ? `https://${h.host}` : `${deps.config.appUrl.replace(/\/+$/, "")}/l`;
}

/** Destinations must be web addresses on the public internet and not another of our own short links. */
export function checkDestination(raw: string, appUrl: string): string {
  const s = raw.trim();
  if (!s) throw badRequest("Add the address the link opens.");
  if (s.length > MAX_URL) throw badRequest("That address is too long. Use one under 2,048 characters.");
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { throw badRequest("That doesn't look like a web address. Try something like https://example.com."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw badRequest("Links can open web addresses only (https or http).");
  if (u.username || u.password) throw badRequest("Leave the user name and password out of the address.");
  if (!isPublicHost(u.hostname)) throw badRequest("That address points at a private network. Use a public web address.");
  let own = "";
  try { own = new URL(appUrl).host; } catch { /* no app URL */ }
  if (own && u.host === own && /^\/l\//.test(u.pathname)) throw badRequest("A short link cannot open another short link.");
  return u.toString();
}

export function checkTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = [...new Set(tags.map((t) => String(t).trim().toLowerCase().replace(/\s+/g, " ").slice(0, 32)).filter(Boolean))];
  if (out.length > MAX_TAGS) throw badRequest(`Use ${MAX_TAGS} tags or fewer.`);
  return out;
}

export function checkCode(raw: string): string {
  const c = normCode(raw);
  if (!CODE_RE.test(c)) throw badRequest("Use letters, numbers, _ or - for the back half (up to 48).");
  return c;
}

export function statusOf(r: Pick<Row, "enabled" | "expiresAt" | "maxClicks" | "clicks">, now: Date): LinkStatus {
  if (!r.enabled) return "off";
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return "expired";
  if (r.maxClicks !== null && r.clicks >= r.maxClicks) return "used_up";
  return "active";
}

const canEdit = (auth: AuthContext, r: Pick<Row, "createdBy">) => auth.role !== "member" || r.createdBy === auth.userId;

function present(r: Row, base: string, auth: AuthContext, now: Date, names: Map<string, string>): ShortLinkInfo {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags) as string[]; } catch { /* old row */ }
  return {
    id: r.id, code: r.code, shortUrl: `${base}/${r.code}`, url: r.url, title: r.title, tags, enabled: r.enabled, status: statusOf(r, now),
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, maxClicks: r.maxClicks, hasPassword: !!r.passwordHash, clicks: r.clicks,
    lastClickAt: r.lastClickAt ? r.lastClickAt.toISOString() : null, createdBy: r.createdBy, createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
    createdAt: r.createdAt.toISOString(), canEdit: canEdit(auth, r),
  };
}

async function namesOf(deps: Deps, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))].slice(0, 90);
  if (!list.length) return new Map();
  const rows = await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function listLinks(deps: Deps, auth: AuthContext): Promise<{ links: ShortLinkInfo[]; base: string }> {
  const [rows, base] = await Promise.all([
    deps.db.select().from(shortLinks).where(eq(shortLinks.orgId, auth.orgId)).orderBy(desc(shortLinks.createdAt)).limit(1000),
    linkBase(deps, auth.orgId),
  ]);
  const names = await namesOf(deps, rows.map((r) => r.createdBy));
  const now = deps.now();
  return { links: rows.map((r) => present(r, base, auth, now, names)), base };
}

async function own(deps: Deps, auth: AuthContext, id: string, write = false): Promise<Row> {
  const r = await deps.db.select().from(shortLinks).where(and(eq(shortLinks.id, id), eq(shortLinks.orgId, auth.orgId))).get();
  if (!r) throw notFound("Link");
  if (write && !canEdit(auth, r)) throw forbidden("Only the person who made this link or an admin can change it.");
  return r;
}

export async function getLink(deps: Deps, auth: AuthContext, id: string): Promise<ShortLinkInfo> {
  const r = await own(deps, auth, id);
  return present(r, await linkBase(deps, auth.orgId), auth, deps.now(), await namesOf(deps, [r.createdBy]));
}

export async function codeFree(deps: Deps, code: string): Promise<boolean> {
  const r = await deps.db.select({ id: shortLinks.id }).from(shortLinks).where(eq(shortLinks.code, code)).get();
  return !r;
}

export interface LinkInput {
  url: string; code?: string | null; title?: string | null; tags?: unknown; expiresAt?: string | null;
  maxClicks?: number | null; password?: string | null; enabled?: boolean;
}

function checkExpiry(v: string | null | undefined, now: Date): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw badRequest("Pick a valid end date.");
  if (d.getTime() <= now.getTime()) throw badRequest("Pick an end date in the future.");
  return d;
}

function checkMax(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 1 || v > 10_000_000) throw badRequest("Use a click limit between 1 and 10,000,000.");
  return v;
}

async function checkPassword(v: string | null | undefined): Promise<string | null> {
  if (!v) return null;
  if (v.length < 4 || v.length > 128) throw badRequest("Use a password of 4 to 128 characters.");
  return hashPassword(v);
}

const isUnique = (e: unknown) => /UNIQUE|constraint/i.test(String((e as Error)?.message ?? e)) || /UNIQUE/i.test(String((e as { cause?: Error })?.cause?.message ?? ""));

export async function createLink(deps: Deps, auth: AuthContext, input: LinkInput): Promise<ShortLinkInfo> {
  const now = deps.now();
  const url = checkDestination(input.url, deps.config.appUrl);
  const tags = checkTags(input.tags);
  const title = input.title?.trim().slice(0, 200) || null;
  const row = {
    id: newId("lnk"), orgId: auth.orgId, url, title, tags: JSON.stringify(tags), enabled: input.enabled ?? true,
    expiresAt: checkExpiry(input.expiresAt, now), maxClicks: checkMax(input.maxClicks), passwordHash: await checkPassword(input.password),
    clicks: 0, botClicks: 0, createdBy: auth.userId, createdAt: now, updatedAt: now,
  };
  const custom = input.code?.trim() ? checkCode(input.code) : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = custom ?? autoCode(attempt < 3 ? AUTO_CODE_LENGTH : AUTO_CODE_LENGTH + 2);
    try {
      await deps.db.insert(shortLinks).values({ ...row, code });
      return getLink(deps, auth, row.id);
    } catch (e) {
      if (!isUnique(e)) throw e;
      if (custom) throw conflict(`The back half “${custom}” is taken. Try another.`);
    }
  }
  throw conflict("Couldn't make a free back half. Try again.");
}

export async function updateLink(deps: Deps, auth: AuthContext, id: string, input: Partial<LinkInput> & { clearPassword?: boolean }): Promise<ShortLinkInfo> {
  const r = await own(deps, auth, id, true);
  const now = deps.now();
  const set: Partial<typeof shortLinks.$inferInsert> = { updatedAt: now };
  if (input.url !== undefined) set.url = checkDestination(input.url, deps.config.appUrl);
  if (input.title !== undefined) set.title = input.title?.trim().slice(0, 200) || null;
  if (input.tags !== undefined) set.tags = JSON.stringify(checkTags(input.tags));
  if (input.enabled !== undefined) set.enabled = !!input.enabled;
  if (input.expiresAt !== undefined) set.expiresAt = checkExpiry(input.expiresAt, now);
  if (input.maxClicks !== undefined) set.maxClicks = checkMax(input.maxClicks);
  if (input.password) set.passwordHash = await checkPassword(input.password);
  else if (input.clearPassword) set.passwordHash = null;
  let newCode: string | null = null;
  if (input.code !== undefined && input.code !== null && normCode(input.code) !== r.code) { newCode = checkCode(input.code); set.code = newCode; }
  try {
    await deps.db.update(shortLinks).set(set).where(eq(shortLinks.id, r.id));
  } catch (e) {
    if (newCode && isUnique(e)) throw conflict(`The back half “${newCode}” is taken. Try another.`);
    throw e;
  }
  await forgetCode(r.code);
  return getLink(deps, auth, r.id);
}

export async function deleteLink(deps: Deps, auth: AuthContext, id: string): Promise<{ ok: true }> {
  const r = await own(deps, auth, id, true);
  await deps.db.delete(shortLinks).where(eq(shortLinks.id, r.id));
  await deps.db.delete(linkClicks).where(eq(linkClicks.linkId, r.id));
  await forgetCode(r.code);
  return { ok: true };
}

export interface BulkRow { url: string; code?: string; title?: string; tags?: string | string[] }
export async function bulkCreate(deps: Deps, auth: AuthContext, rows: BulkRow[]): Promise<{ created: ShortLinkInfo[]; failed: { line: number; message: string }[] }> {
  if (!Array.isArray(rows) || !rows.length) throw badRequest("The file has no rows to import.");
  if (rows.length > MAX_BULK) throw badRequest(`Import up to ${MAX_BULK} links at a time.`);
  const created: ShortLinkInfo[] = [];
  const failed: { line: number; message: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const tags = Array.isArray(r.tags) ? r.tags : (r.tags ?? "").split(/[;|]/);
      created.push(await createLink(deps, auth, { url: String(r.url ?? ""), code: r.code ? String(r.code) : null, title: r.title ? String(r.title) : null, tags }));
    } catch (e) {
      failed.push({ line: i + 2, message: (e as Error).message || "Couldn't import this row." });
    }
  }
  return { created, failed };
}

const DAY_MS = 86_400_000;
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Stats for one link (or bio page item ids) over the last `days` days, read with the link and day index. */
export async function statsFor(deps: Deps, orgId: string, linkIds: string[], days: number, botClicks = 0): Promise<LinkStats> {
  const since = dayOf(new Date(deps.now().getTime() - (days - 1) * DAY_MS));
  const where = and(inArray(linkClicks.linkId, linkIds), sql`${linkClicks.day} >= ${since}`, eq(linkClicks.orgId, orgId));
  type TextCol = typeof linkClicks.country | typeof linkClicks.referrer | typeof linkClicks.device | typeof linkClicks.browser | typeof linkClicks.os;
  const top = (col: TextCol) => deps.db.select({ key: sql<string>`coalesce(${col}, 'Unknown')`, n: sql<number>`count(*)` }).from(linkClicks).where(where).groupBy(col).orderBy(sql`count(*) desc`).limit(10);
  const [perDay, countries, referrers, devices, browsers, os] = await Promise.all([
    deps.db.select({ day: linkClicks.day, clicks: sql<number>`count(*)`, visitors: sql<number>`count(distinct ${linkClicks.visitor})` }).from(linkClicks).where(where).groupBy(linkClicks.day),
    top(linkClicks.country), top(linkClicks.referrer), top(linkClicks.device), top(linkClicks.browser), top(linkClicks.os),
  ]);
  const by = new Map(perDay.map((d) => [d.day, d]));
  const out: LinkStats["days"] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(new Date(deps.now().getTime() - i * DAY_MS));
    const d = by.get(day);
    out.push({ day, clicks: Number(d?.clicks ?? 0), visitors: Number(d?.visitors ?? 0) });
  }
  const norm = (rows: StatRow[]) => rows.map((r) => ({ key: String(r.key), n: Number(r.n) }));
  return {
    days: out, total: out.reduce((a, d) => a + d.clicks, 0), visitors: out.reduce((a, d) => a + d.visitors, 0),
    countries: norm(countries), referrers: norm(referrers), devices: norm(devices), browsers: norm(browsers), os: norm(os), botClicks,
  };
}

export async function linkStats(deps: Deps, auth: AuthContext, id: string, days: number): Promise<LinkStats> {
  const r = await own(deps, auth, id);
  return statsFor(deps, auth.orgId, [r.id], days, r.botClicks);
}

/** Every counted click on one link as CSV (newest first, 50,000 rows at most). No address or visitor hash. */
export async function linkCsv(deps: Deps, auth: AuthContext, id: string): Promise<{ name: string; csv: string }> {
  const r = await own(deps, auth, id);
  const rows = await deps.db.select({ at: linkClicks.at, country: linkClicks.country, referrer: linkClicks.referrer, device: linkClicks.device, browser: linkClicks.browser, os: linkClicks.os })
    .from(linkClicks).where(and(eq(linkClicks.linkId, r.id), eq(linkClicks.orgId, auth.orgId))).orderBy(desc(linkClicks.id)).limit(50_000);
  const lines = ["time_utc,country,referrer,device,browser,os", ...rows.map((x) => [x.at.toISOString(), x.country, x.referrer, x.device, x.browser, x.os].map(csvCell).join(","))];
  return { name: `clicks-${r.code}.csv`, csv: `${lines.join("\n")}\n` };
}
