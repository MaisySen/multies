/**
 * R87: the public side of Links. /l/<code> sends a visitor on (302) after one keyed read, kept in this isolate for 30
 * seconds and at the edge for 60; links with a click limit or a password are read fresh each time. Clicks are counted
 * after the response: bots and link preview fetchers are sent on and not written, and no address is stored (a visitor
 * hash with a salt for the day). Written in batches per isolate (one insert for every few clicks, one counter update per
 * link), so a busy link costs little of the daily write allowance.
 */
import { eq, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { runBatch } from "../../db";
import { linkBioPages, linkClicks, linkHosts, shortLinks } from "../../db/schema";
import { hmacSha256Hex } from "../../lib/crypto";
import { IsolateCache } from "../../lib/isolate-cache";
import { browserOf, deviceOf, isBotAgent, osOf, referrerOf, type BioItem, type BioSocial } from "@/shared/links";
import { countryOf } from "../tools/kept-files";

export interface ResolvedLink {
  id: string; orgId: string; url: string; enabled: boolean; expiresAt: number | null; maxClicks: number | null; clicks: number; hasPassword: boolean;
}
export interface ResolvedBio {
  id: string; orgId: string; slug: string; title: string; bio: string | null; avatar: string; avatarUrl: string | null; theme: string; brandColor: string | null;
  items: BioItem[]; socials: BioSocial[]; published: boolean;
}

const localLinks = new IsolateCache<ResolvedLink | null>(30_000, 5_000);
const localBios = new IsolateCache<ResolvedBio | null>(30_000, 2_000);
const localHosts = new IsolateCache<string | null>(60_000, 1_000);
const EDGE_TTL = 60;

interface EdgeCache { match(k: Request): Promise<Response | undefined>; put(k: Request, r: Response): Promise<void>; delete(k: Request): Promise<boolean> }
function edge(): EdgeCache | null {
  const c = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches;
  return c?.default ?? null;
}
const edgeKey = (kind: string, key: string) => new Request(`https://links-cache.multies.internal/${kind}/${encodeURIComponent(key)}`);

async function cached<T>(local: IsolateCache<T | null>, kind: string, key: string, load: () => Promise<T | null>, keep: (v: T) => boolean): Promise<T | null> {
  const hit = local.get(key);
  if (hit !== undefined) return hit;
  const e = edge();
  if (e) {
    try {
      const r = await e.match(edgeKey(kind, key));
      if (r) { const v = (await r.json()) as T | null; local.set(key, v); return v; }
    } catch { /* the edge cache is a speed up only */ }
  }
  const v = await load();
  if (v === null || keep(v)) {
    local.set(key, v);
    if (e) { try { await e.put(edgeKey(kind, key), new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `max-age=${EDGE_TTL}` } })); } catch { /* ignore */ } }
  }
  return v;
}

/** Drops a code from this isolate and this colo's edge cache (other colos let it go within a minute). */
export async function forgetCode(code: string) {
  localLinks.forgetPrefix(code); // codes are unique; forgetPrefix with the full code drops it (and nothing that only shares a prefix matters: 30 s)
  try { await edge()?.delete(edgeKey("l", code)); } catch { /* ignore */ }
}
export async function forgetBio(slug: string) {
  localBios.forgetPrefix(slug);
  try { await edge()?.delete(edgeKey("bio", slug)); } catch { /* ignore */ }
}
export async function forgetHost(host: string) {
  localHosts.forgetPrefix(host);
  try { await edge()?.delete(edgeKey("host", host)); } catch { /* ignore */ }
}

/** One keyed read by code (unique index). Password and click limited links are never kept in a cache. */
export async function resolveCode(deps: Deps, code: string, fresh = false): Promise<ResolvedLink | null> {
  const load = async () => {
    const r = await deps.db.select({ id: shortLinks.id, orgId: shortLinks.orgId, url: shortLinks.url, enabled: shortLinks.enabled, expiresAt: shortLinks.expiresAt, maxClicks: shortLinks.maxClicks, clicks: shortLinks.clicks, passwordHash: shortLinks.passwordHash })
      .from(shortLinks).where(eq(shortLinks.code, code)).get();
    if (!r) return null;
    return { id: r.id, orgId: r.orgId, url: r.url, enabled: r.enabled, expiresAt: r.expiresAt ? r.expiresAt.getTime() : null, maxClicks: r.maxClicks, clicks: r.clicks, hasPassword: !!r.passwordHash };
  };
  if (fresh) return load();
  return cached(localLinks, "l", code, load, (v) => !v.hasPassword && v.maxClicks === null);
}

export async function passwordHashOf(deps: Deps, id: string): Promise<string | null> {
  const r = await deps.db.select({ h: shortLinks.passwordHash }).from(shortLinks).where(eq(shortLinks.id, id)).get();
  return r?.h ?? null;
}

/** A click limited link: one conditional update takes a click, so two visitors at once cannot both pass the limit. */
export async function takeLimitedClick(deps: Deps, id: string): Promise<boolean> {
  const r = await deps.db.run(sql`update short_links set clicks = clicks + 1, last_click_at = ${deps.now().getTime()} where id = ${id} and max_clicks is not null and clicks < max_clicks`);
  const changes = (r as { meta?: { changes?: number }; changes?: number }).meta?.changes ?? (r as { changes?: number }).changes ?? 0;
  return changes > 0;
}

export async function resolveBio(deps: Deps, slug: string): Promise<ResolvedBio | null> {
  return cached(localBios, "bio", slug, async () => {
    const r = await deps.db.select().from(linkBioPages).where(eq(linkBioPages.slug, slug)).get();
    if (!r) return null;
    const parse = <T,>(s: string): T[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v as T[] : []; } catch { return []; } };
    return { id: r.id, orgId: r.orgId, slug: r.slug, title: r.title, bio: r.bio, avatar: r.avatar, avatarUrl: r.avatarUrl, theme: r.theme, brandColor: r.brandColor, items: parse<BioItem>(r.items), socials: parse<BioSocial>(r.socials), published: r.published };
  }, () => true);
}

/** The workspace a live link domain belongs to (null for every other host). */
export async function orgForHost(deps: Deps, host: string): Promise<string | null> {
  return cached(localHosts, "host", host, async () => {
    const r = await deps.db.select({ orgId: linkHosts.orgId, status: linkHosts.status }).from(linkHosts).where(eq(linkHosts.host, host)).get();
    return r && r.status === "live" ? r.orgId : null;
  }, () => true);
}

// ---------------------------------------------------------------------------------------------------------------
// Click buffer
// ---------------------------------------------------------------------------------------------------------------

interface PendingClick { orgId: string; linkId: string; day: string; at: number; country: string | null; referrer: string; device: string; browser: string; os: string; visitor: string }
const pending: PendingClick[] = [];
/** Counter bumps per row: short link clicks and bot clicks, bio page views. */
const bumps = new Map<string, { table: "short" | "short_bot" | "bio_views"; id: string; n: number; at: number }>();
let timer: Promise<void> | null = null;
const MAX_PENDING = 2_000;

export interface ClickRequest { headers: Headers; ip: string; ownHost: string }

/** What one visit counts as: null for a bot, a link preview or a prefetch. */
export async function clickOf(deps: Deps, req: ClickRequest, orgId: string, linkId: string): Promise<PendingClick | null> {
  const ua = req.headers.get("user-agent");
  const purpose = `${req.headers.get("sec-purpose") ?? ""} ${req.headers.get("purpose") ?? ""} ${req.headers.get("x-moz") ?? ""}`;
  if (isBotAgent(ua) || /prefetch|prerender|preview/i.test(purpose)) return null;
  const now = deps.now();
  const day = now.toISOString().slice(0, 10);
  // The address is only an input to a keyed hash that changes every day; it is never written anywhere.
  const visitor = (await hmacSha256Hex(deps.config.appSecret, `r87v:${day}:${req.ip}:${ua ?? ""}`)).slice(0, 16);
  return { orgId, linkId, day, at: now.getTime(), country: countryOf(req.headers), referrer: referrerOf(req.headers.get("referer"), req.ownHost), device: deviceOf(ua), browser: browserOf(ua), os: osOf(ua), visitor };
}

function bump(table: "short" | "short_bot" | "bio_views", id: string, at: number) {
  const k = `${table}:${id}`;
  const b = bumps.get(k);
  if (b) { b.n++; b.at = at; } else bumps.set(k, { table, id, n: 1, at });
}

export function flushDelayMs(deps: Deps): number {
  return deps.config.links?.flushMs ?? 4_000;
}

/**
 * Queues one click (or a bot visit, or a bio page view) and returns the flush promise for waitUntil. The first click in
 * a quiet isolate starts a short timer; clicks inside that window join the same batch.
 */
export function queue(deps: Deps, click: PendingClick | null, counter: { table: "short" | "bio_views"; id: string } | null, botOf?: string): Promise<void> {
  const at = deps.now().getTime();
  if (click && pending.length < MAX_PENDING) pending.push(click);
  if (counter && (click || counter.table === "bio_views")) bump(counter.table, counter.id, at);
  if (!click && botOf) bump("short_bot", botOf, at);
  if (!timer) {
    const wait = flushDelayMs(deps);
    timer = (wait > 0 ? new Promise<void>((r) => setTimeout(r, wait)) : Promise.resolve()).then(() => flushClicks(deps)).finally(() => { timer = null; });
  }
  return timer;
}

/** Writes what is queued in this isolate: rows in groups of 8 (D1 takes 100 bound values), one update per counter. */
export async function flushClicks(deps: Deps): Promise<void> {
  if (!pending.length && !bumps.size) return;
  const rows = pending.splice(0, pending.length);
  const counters = [...bumps.values()];
  bumps.clear();
  const stmts: PromiseLike<unknown>[] = [];
  for (let i = 0; i < rows.length; i += 8) {
    stmts.push(deps.db.insert(linkClicks).values(rows.slice(i, i + 8).map((r) => ({ ...r, at: new Date(r.at) }))));
  }
  for (const c of counters) {
    if (c.table === "short") stmts.push(deps.db.run(sql`update short_links set clicks = clicks + ${c.n}, last_click_at = ${c.at} where id = ${c.id}`));
    else if (c.table === "short_bot") stmts.push(deps.db.run(sql`update short_links set bot_clicks = bot_clicks + ${c.n} where id = ${c.id}`));
    else stmts.push(deps.db.run(sql`update link_bio_pages set views = views + ${c.n} where id = ${c.id}`));
  }
  try {
    await runBatch(deps.db, stmts);
  } catch (e) {
    // Counting is best effort: a lost batch costs a few counts, never a visitor's redirect.
    (deps.log ?? console).error?.("[links] click flush failed", { error: String((e as Error)?.message ?? e), rows: rows.length });
  }
}

/** For tests: what is waiting in this isolate. */
export const pendingClicks = () => ({ rows: pending.length, counters: bumps.size });
