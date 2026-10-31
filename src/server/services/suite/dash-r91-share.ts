/**
 * R91 public read only dashboard links. The token (32 random bytes) is shown once as <appUrl>/dash/<token> (/d/ belongs to file share links); only
 * its SHA-256 is stored. Expiry presets, an optional password (PBKDF2 via hashPassword), the workspace name
 * when chosen, revoke. The page shows the dashboard's own numbers only: the widgets' data computed as the
 * person who made the link (never more than they see), with ids, emails and widget sources removed.
 * Numbers are cached in the row for 15 minutes, so opening a link is one read by the unique index.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../../context";
import { dashboardShares, organizations } from "../../db/schema";
import { hashPassword, hmacSha256Hex, newId, randomToken, sha256Hex, verifyPassword } from "../../lib/crypto";
import { HttpError, notFound } from "../../lib/errors";
import type { SuiteActor } from "./common";
import { assertCanChange, dashboardData, personOf, rowFor } from "./dashboards";
import { creatorActor, DAY } from "./dash-r91-common";

export const SHARE_TTL_MS = 15 * 60_000;
export const SHARE_REFRESH_GAP_MS = 60_000;
export const MAX_LINKS_PER_DASHBOARD = 10;
export const ShareCreate = z.object({
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable().default(30),
  password: z.string().min(6, "Use at least 6 characters for the password.").max(100).optional(),
  showBrand: z.boolean().default(true),
}).strict();

type Row = typeof dashboardShares.$inferSelect;
export const isActive = (r: Pick<Row, "revokedAt" | "expiresAt">, now: number) => !r.revokedAt && (!r.expiresAt || r.expiresAt.getTime() > now);
export const shareUrl = (deps: Deps, token: string) => `${deps.config.appUrl.replace(/\/$/, "")}/dash/${token}`;

function present(r: Row, now: number) {
  return { id: r.id, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt?.toISOString() ?? null, hasPassword: !!r.passwordHash, showBrand: r.showBrand, active: isActive(r, now), revoked: !!r.revokedAt };
}

export async function listShares(deps: Deps, actor: SuiteActor, dashboardId: string) {
  const d = await rowFor(deps, actor, dashboardId);
  let canManage = true;
  try { assertCanChange(d, actor, "share"); } catch { canManage = false; }
  if (!canManage) return { canManage, links: [] };
  const now = deps.now().getTime();
  const rows = await deps.db.select().from(dashboardShares).where(and(eq(dashboardShares.orgId, actor.orgId), eq(dashboardShares.dashboardId, d.id), eq(dashboardShares.purpose, "link"), isNull(dashboardShares.revokedAt))).orderBy(desc(dashboardShares.createdAt)).limit(MAX_LINKS_PER_DASHBOARD);
  return { canManage, links: rows.map((r) => present(r, now)) };
}

export async function createShare(deps: Deps, actor: SuiteActor, dashboardId: string, input: z.infer<typeof ShareCreate>) {
  const d = await rowFor(deps, actor, dashboardId);
  assertCanChange(d, actor, "share");
  const me = personOf(actor);
  if (!me) throw new HttpError(403, "forbidden", "Only a signed in member can make a public link.");
  const now = deps.now().getTime();
  const live = (await deps.db.select({ r: dashboardShares.revokedAt, e: dashboardShares.expiresAt }).from(dashboardShares).where(and(eq(dashboardShares.dashboardId, d.id), eq(dashboardShares.purpose, "link"), isNull(dashboardShares.revokedAt)))).filter((x) => isActive({ revokedAt: x.r, expiresAt: x.e }, now));
  if (live.length >= MAX_LINKS_PER_DASHBOARD) throw new HttpError(422, "too_many_links", `A dashboard can have up to ${MAX_LINKS_PER_DASHBOARD} public links. Turn one off first.`);
  const token = randomToken(32);
  const row: typeof dashboardShares.$inferInsert = {
    id: newId("dsh"), orgId: actor.orgId, dashboardId: d.id, tokenHash: await sha256Hex(token), passwordHash: input.password ? await hashPassword(input.password) : null,
    showBrand: input.showBrand, purpose: "link", createdBy: me, createdAt: new Date(now), expiresAt: input.expiresInDays ? new Date(now + input.expiresInDays * DAY) : null,
  };
  await deps.db.insert(dashboardShares).values(row);
  return { link: present(row as Row, now), url: shareUrl(deps, token) };
}

export async function revokeShare(deps: Deps, actor: SuiteActor, id: string) {
  const r = await deps.db.select().from(dashboardShares).where(and(eq(dashboardShares.orgId, actor.orgId), eq(dashboardShares.id, id))).get();
  if (!r) throw notFound("Link");
  assertCanChange(await rowFor(deps, actor, r.dashboardId), actor, "share");
  await deps.db.update(dashboardShares).set({ revokedAt: deps.now(), snapshot: null }).where(eq(dashboardShares.id, id));
  return { ok: true };
}

/** The report's own link: a token derived from the report id, so each run can rebuild the URL. */
export async function reportToken(deps: Deps, reportId: string) {
  return (await hmacSha256Hex(deps.config.appSecret, `dash-report-share:${reportId}`)).slice(0, 43);
}
export async function ensureReportShare(deps: Deps, orgId: string, dashboardId: string, reportId: string, createdBy: string) {
  const token = await reportToken(deps, reportId);
  const hash = await sha256Hex(token);
  const have = await deps.db.select({ id: dashboardShares.id }).from(dashboardShares).where(eq(dashboardShares.tokenHash, hash)).get();
  if (have) { await deps.db.update(dashboardShares).set({ revokedAt: null }).where(eq(dashboardShares.id, have.id)); return { id: have.id, token }; }
  const id = newId("dsh");
  await deps.db.insert(dashboardShares).values({ id, orgId, dashboardId, tokenHash: hash, passwordHash: null, showBrand: true, purpose: "report", createdBy, createdAt: deps.now(), expiresAt: null });
  return { id, token };
}

const PRIVATE_KEYS = new Set(["id", "email", "userId", "assigneeId", "assigneeType", "projectId", "mailboxId", "ownerUserId", "owner", "createdById", "taskId", "threadId", "messageId", "savedViewId", "personId", "avatarUrl"]);
/** Removes ids, emails and other private keys from widget data, keeping names and numbers. */
export function scrub(v: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (PRIVATE_KEYS.has(k)) continue;
      if (typeof x === "string" && /@[^\s@]+\.[a-z]{2,}/i.test(x)) { out[k] = x.split("@")[0]; continue; }
      out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  return v;
}


// R91 verifier fix: the public page is numbers only. Lists (task titles, refs, dates) become counts, and widgets
// grouped by people show "Person 1", "Person 2" instead of names. Done here, server side, before anything is cached.
const PERSON_RE = /assignee|person|owner|creator|createdby|member|user|from|sender|recipient|host|guest|attendee|workload/i;
const LIST_ITEM_KEYS = ["title", "subject", "ref", "snippet", "body"];
const isListOfRecords = (x: unknown): x is Record<string, unknown>[] =>
  Array.isArray(x) && x.some((e) => e && typeof e === "object" && !Array.isArray(e) && LIST_ITEM_KEYS.some((k) => typeof (e as Record<string, unknown>)[k] === "string"));
export function numbersOnly(w: { type: string; groupBy: string | null; settings?: Record<string, unknown>; question?: { groupBy?: string | null } | null }, data: unknown): unknown {
  const s = w.settings ?? {};
  const personish = w.type === "workload" || [w.groupBy, w.question?.groupBy, s.rowBy, s.colBy, s.groupBy, s.by].some((v) => typeof v === "string" && PERSON_RE.test(v));
  const people = new Map<string, string>();
  const alias = (name: string) => { if (!people.has(name)) people.set(name, `Person ${people.size + 1}`); return people.get(name)!; };
  const keys = new Map<string, string>();
  const keyAlias = (k: string) => { if (!keys.has(k)) keys.set(k, `p${keys.size + 1}`); return keys.get(k)!; };
  let listed = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return null;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === "assignee" || k === "assignees" || k === "people" && !personish) continue;
      if (isListOfRecords(x)) { out[k] = []; out[`${k}Count`] = x.length; listed = true; continue; }
      if (personish && typeof x === "string" && k === "key" && x) { out[k] = keyAlias(x); continue; }
      if (personish && typeof x === "string" && ["label", "name", "person", "row", "col"].includes(k) && x && !/^(nobody|unassigned|no one|none|other|others)$/i.test(x)) { out[k] = alias(x); continue; }
      out[k] = walk(x, depth + 1);
    }
    return out;
  };
  const out = walk(data, 0);
  if (isListOfRecords(data)) return { publicList: true, itemsCount: (data as unknown[]).length };
  if (listed && out && typeof out === "object" && !Array.isArray(out)) (out as Record<string, unknown>).publicList = true;
  return out;
}

export interface PublicDashboard {
  /** Shape version; cached snapshots of an older shape are rebuilt (R91 numbers only). */
  publicV?: number;
  name: string; brand: string | null; updatedAt: string; timeZone: string;
  widgets: { id: string; type: string; title: string; chart: string; size: number; groupBy: string | null; settings: Record<string, unknown> }[];
  data: { id: string; type: string; data: unknown; error: string | null }[];
}

type Open = { status: "ok"; dashboard: PublicDashboard } | { status: "password_required" | "password_wrong" | "gone" };

/** Opens a public link. Reads one row; recomputes (and writes the cache) only when it is older than 15 minutes. */
export async function openShare(deps: Deps, token: string, opts: { password?: string; refresh?: boolean } = {}): Promise<Open> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { status: "gone" };
  const r = await deps.db.select().from(dashboardShares).where(eq(dashboardShares.tokenHash, await sha256Hex(token))).get();
  const now = deps.now().getTime();
  if (!r || !isActive(r, now)) return { status: "gone" };
  if (r.passwordHash) {
    if (!opts.password) return { status: "password_required" };
    if (!(await verifyPassword(opts.password, r.passwordHash))) return { status: "password_wrong" };
  }
  const age = r.snapshotAt ? now - r.snapshotAt.getTime() : Infinity;
  if (r.snapshot && r.snapshot.includes('"publicV":2') && (age < SHARE_TTL_MS && !(opts.refresh && age > SHARE_REFRESH_GAP_MS))) {
    try { return { status: "ok", dashboard: JSON.parse(r.snapshot) as PublicDashboard }; } catch { /* rebuild */ }
  }
  const built = await buildPublic(deps, r);
  if (!built) return { status: "gone" };
  await deps.db.update(dashboardShares).set({ snapshot: JSON.stringify(built), snapshotAt: new Date(now) }).where(eq(dashboardShares.id, r.id));
  return { status: "ok", dashboard: built };
}

export async function buildPublic(deps: Deps, r: Pick<Row, "orgId" | "dashboardId" | "createdBy" | "showBrand">): Promise<PublicDashboard | null> {
  const actor = await creatorActor(deps, r.orgId, r.createdBy);
  if (!actor) return null;
  let res: Awaited<ReturnType<typeof dashboardData>>;
  try { res = await dashboardData(deps, actor, r.dashboardId); } catch (e) { if (e instanceof HttpError && e.status < 500) return null; throw e; }
  const brand = r.showBrand ? (await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, r.orgId)).get())?.name ?? null : null;
  return {
    publicV: 2, name: res.dashboard.name, brand, updatedAt: res.generatedAt, timeZone: res.timeZone,
    widgets: res.dashboard.widgets.map((w) => {
      const { id, type, title, chart, size, groupBy, source: _s, question: _q, position: _p, ...settings } = w as typeof w & { question?: unknown };
      return { id, type, title, chart, size, groupBy, settings: scrub(settings) as Record<string, unknown> };
    }),
    data: res.widgets.map((x) => {
      const w = res.dashboard.widgets.find((y) => y.id === x.id) as ({ type: string; groupBy: string | null; question?: { groupBy?: string | null } | null } & Record<string, unknown>) | undefined;
      const safe = w ? numbersOnly({ type: w.type, groupBy: w.groupBy, settings: w, question: w.question ?? null }, x.data) : numbersOnly({ type: x.type, groupBy: null }, x.data);
      return { id: x.id, type: x.type, data: scrub(safe), error: x.error };
    }),
  };
}
