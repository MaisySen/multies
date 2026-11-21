/**
 * R90: web page and feed watches. The maintenance pass checks a few due watches at a time: public
 * addresses only (every redirect checked too), robots.txt respected, one request per site per 10 minutes,
 * at most 512 KB read, 10 seconds per request. A page compares its text (or one part picked by a simple
 * CSS selector) with the last check and starts the flow with what changed; a feed starts one run per new
 * item. The first check only learns the page or feed, so turning a watch on never floods anyone.
 */
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import type { Deps } from "../../context";
import { flows, flowWatches } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import { changeSummary, diffLines, watchBackoff } from "@/shared/flows";
import { featureOn } from "../console/flags"; // OPS1 feature flags

export const WATCH_MAX_BYTES = 512 * 1024;
export const WATCH_TIMEOUT_MS = 10_000;
export const SITE_GAP_MS = 10 * 60_000;
export const FEED_NEW_MAX = 20;
const TEXT_KEEP = 40_000;
const SEEN_KEEP = 300;
const UA = "MultiesWatch/1.0 (+page change alerts)";

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (u, i) => fetch(u, i);
/** Tests swap the network for a stub. */
export function setWatchFetch(f: Fetcher | null) { fetcher = f ?? ((u, i) => fetch(u, i)); }
const lastHit = new Map<string, number>();
const robotsCache = new Map<string, { at: number; rules: string[] }>();
export function resetWatchState() { lastHit.clear(); robotsCache.clear(); }

const allowLocal = (deps: Deps) => deps.config.mode === "development";

/** The address a person typed, checked: http or https, a public host, no user name or password in it. */
export function checkWatchUrl(deps: Deps, raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new HttpError(422, "validation_failed", "Type the full web address, starting with https://"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(422, "validation_failed", "Only web addresses (http or https) can be watched.");
  if (u.username || u.password) throw new HttpError(422, "validation_failed", "Take the user name and password out of the address.");
  if (!allowLocal(deps) && !isPublicHost(u.hostname)) throw new HttpError(422, "validation_failed", "That address points to a private network. Only public pages can be watched.");
  return u;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > WATCH_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("The page is larger than 512 KB."); }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** GET with every redirect hop checked against private addresses (at most 3 hops). */
export async function guardedGet(deps: Deps, raw: string): Promise<{ url: string; status: number; text: string; type: string }> {
  let url = checkWatchUrl(deps, raw).toString();
  for (let hop = 0; hop < 4; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WATCH_TIMEOUT_MS);
    try {
      const res = await fetcher(url, { redirect: "manual", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = checkWatchUrl(deps, new URL(res.headers.get("location")!, url).toString()).toString();
        continue;
      }
      return { url, status: res.status, text: res.status < 400 ? await readCapped(res) : "", type: res.headers.get("content-type") ?? "" };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new Error(ctrl.signal.aborted ? "The page took longer than 10 seconds." : err instanceof Error ? err.message : "The page could not be reached.", { cause: err });
    } finally { clearTimeout(timer); }
  }
  throw new Error("The page redirects too many times.");
}

/** Disallow lines for any robot ("User-agent: *") or for us; Allow lines are not needed for a yes or no on one path. */
export function robotsRules(txt: string): string[] {
  const out: string[] = [];
  let applies = false, inGroup = false;
  for (const line of txt.split(/\r?\n/)) {
    const l = line.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(l);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") { if (!inGroup) applies = false; inGroup = true; if (val === "*" || /multieswatch/i.test(val)) applies = true; }
    else { inGroup = false; if (key === "disallow" && applies && val) out.push(val); }
  }
  return out;
}
export function robotsAllows(rules: string[], path: string): boolean {
  return !rules.some((r) => { const p = r.replace(/\*$/, "").replace(/\$$/, ""); return p && path.startsWith(p); });
}

async function allowedByRobots(deps: Deps, u: URL): Promise<boolean> {
  const key = u.origin;
  const hit = robotsCache.get(key);
  let rules = hit && deps.now().getTime() - hit.at < 3_600_000 ? hit.rules : null;
  if (!rules) {
    try { const r = await guardedGet(deps, `${u.origin}/robots.txt`); rules = r.status === 200 ? robotsRules(r.text) : []; } catch { rules = []; }
    robotsCache.set(key, { at: deps.now().getTime(), rules });
  }
  return robotsAllows(rules, u.pathname + u.search);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BLOCK = /^(p|div|li|tr|h[1-6]|section|article|header|footer|br|td|th|dd|dt|blockquote|pre|table|ul|ol|main|nav|aside)$/;

/** Readable text of an HTML page, line per block. Scripts, styles and comments dropped. */
export function htmlText(html: string): string {
  const clean = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "");
  const withBreaks = clean.replace(/<\/?([a-z0-9]+)\b[^>]*>/gi, (_, tag: string) => (BLOCK.test(tag.toLowerCase()) ? "\n" : " "));
  return decode(withBreaks).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

/** A simple selector: tag, #id, .class, tag.class, tag#id, or [attr=value]. */
export function parseSelector(sel: string): { tag?: string; id?: string; cls?: string; attr?: [string, string] } | null {
  const s = sel.trim();
  const m = /^([a-z][a-z0-9-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)=["']?([^"'\]]*)["']?\])?$/i.exec(s);
  if (!s || !m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  return { tag: m[1]?.toLowerCase(), id: m[2], cls: m[3], attr: m[4] ? [m[4].toLowerCase(), m[5]] : undefined };
}

/** The HTML inside the first element matching a simple selector, or null. */
export function selectHtml(html: string, selector: string): string | null {
  const sel = parseSelector(selector);
  if (!sel) return null;
  const open = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const tag = m[1].toLowerCase(), attrs = m[2];
    const attr = (name: string) => { const a = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs); return a ? (a[2] ?? a[3] ?? a[4] ?? "") : null; };
    if (sel.tag && sel.tag !== tag) continue;
    if (sel.id && attr("id") !== sel.id) continue;
    if (sel.cls && !(attr("class") ?? "").split(/\s+/).includes(sel.cls)) continue;
    if (sel.attr && attr(sel.attr[0]) !== sel.attr[1]) continue;
    if (VOID.has(tag) || attrs.trim().endsWith("/")) return "";
    // Walk to the matching close tag, counting nested tags of the same name.
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    re.lastIndex = open.lastIndex;
    let depth = 1, r: RegExpExecArray | null;
    while ((r = re.exec(html))) { depth += r[1] ? -1 : 1; if (depth === 0) return html.slice(open.lastIndex, r.index); }
    return html.slice(open.lastIndex);
  }
  return null;
}

export interface FeedItem { id: string; title: string; link: string | null; summary: string; published: string | null }

/** RSS 2.0, RSS 1.0 and Atom items, newest first as the feed lists them. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const p = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", processEntities: true, htmlEntities: true, ignoreDeclaration: true, ignorePiTags: true });
  const doc = p.parse(xml) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const arr = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
  const text = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? text((v as Record<string, unknown>)["#text"] ?? "") : String(v));
  const clip = (s: string) => htmlText(s).replace(/\n/g, " ").slice(0, 600);
  if (doc.rss?.channel || doc["rdf:RDF"]) {
    const ch = doc.rss?.channel ?? doc["rdf:RDF"]?.channel ?? {};
    const items = arr(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
    return { title: text(ch.title).trim(), items: items.map((it: Record<string, unknown>) => {
      const link = text(it.link).trim() || null;
      const id = text(it.guid).trim() || link || text(it.title).trim();
      return { id: id.slice(0, 300), title: text(it.title).trim().slice(0, 300) || "Untitled", link, summary: clip(text(it.description ?? it["content:encoded"])), published: text(it.pubDate ?? it["dc:date"]).trim() || null };
    }).filter((x: FeedItem) => x.id) };
  }
  if (doc.feed) {
    const entries = arr(doc.feed.entry);
    return { title: text(doc.feed.title).trim(), items: entries.map((e: Record<string, unknown>) => {
      const links = arr(e.link) as Record<string, string>[];
      const href = (links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0])?.["@href"] ?? null;
      const id = text(e.id).trim() || href || text(e.title).trim();
      return { id: id.slice(0, 300), title: text(e.title).trim().slice(0, 300) || "Untitled", link: href, summary: clip(text(e.summary ?? e.content)), published: text(e.published ?? e.updated).trim() || null };
    }).filter((x: FeedItem) => x.id) };
  }
  throw new Error("That address is not an RSS or Atom feed.");
}

async function sha(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type WatchRow = typeof flowWatches.$inferSelect;

/** One check of one watch. Returns how many runs it started. */
export async function checkWatch(deps: Deps, w: WatchRow, opts: { manual?: boolean } = {}): Promise<{ started: number; note: string }> {
  const now = deps.now();
  const host = (() => { try { return new URL(w.url).host; } catch { return w.url; } })();
  const last = lastHit.get(host) ?? 0;
  if (!opts.manual && now.getTime() - last < SITE_GAP_MS) {
    await deps.db.update(flowWatches).set({ nextCheckAt: new Date(last + SITE_GAP_MS) }).where(eq(flowWatches.id, w.id));
    return { started: 0, note: "Waiting to be polite to the site." };
  }
  const f = await deps.db.select().from(flows).where(eq(flows.id, w.flowId)).get();
  if (!f || f.deletedAt || !f.enabled) { await deps.db.update(flowWatches).set({ nextCheckAt: null }).where(eq(flowWatches.id, w.id)); return { started: 0, note: "The flow is off." }; }
  lastHit.set(host, now.getTime());
  try {
    const u = checkWatchUrl(deps, w.url);
    if (!(await allowedByRobots(deps, u))) throw new Error("The site asks robots not to read this page (robots.txt), so it is not checked.");
    const res = await guardedGet(deps, w.url);
    if (res.status >= 400) throw new Error(`The site answered ${res.status}.`);
    const { startRun } = await import("./flows");
    let started = 0, note = "";
    if (w.kind === "page") {
      const part = w.selector ? selectHtml(res.text, w.selector) : res.text;
      if (part === null) throw new Error(`Nothing on the page matches ${w.selector}.`);
      const text = htmlText(part).slice(0, TEXT_KEEP);
      const hash = await sha(text);
      if (w.lastHash && hash !== w.lastHash) {
        const d = diffLines(w.lastText ?? "", text);
        const summary = changeSummary(d);
        if (d.added.length || d.removed.length) {
          const id = await startRun(deps, f, { url: w.url, selector: w.selector, added: d.added.slice(0, 40).join("\n"), removed: d.removed.slice(0, 40).join("\n"), summary, checkedAt: now.toISOString() }, `page:${hash}`);
          if (id) started++;
        }
        note = summary;
      } else note = w.lastHash ? "No change" : "First look saved; changes from now on start the flow.";
      await deps.db.update(flowWatches).set({ lastHash: hash, lastText: text, lastCheckedAt: now, lastError: null, failCount: 0, nextCheckAt: new Date(now.getTime() + w.everyMinutes * 60_000) }).where(eq(flowWatches.id, w.id));
    } else {
      const feed = parseFeed(res.text);
      const seen = new Set(JSON.parse(w.seen) as string[]);
      const first = seen.size === 0 && !w.lastCheckedAt;
      const fresh = feed.items.filter((it) => !seen.has(it.id));
      if (!first) {
        for (const it of fresh.slice(0, FEED_NEW_MAX).reverse()) {
          const id = await startRun(deps, f, { title: it.title, link: it.link, summary: it.summary, published: it.published, feed: feed.title, id: it.id }, `feed:${it.id}`);
          if (id) started++;
        }
      }
      const keep = [...feed.items.map((it) => it.id), ...[...seen].filter((s) => !feed.items.some((it) => it.id === s))].slice(0, SEEN_KEEP);
      note = first ? `First look saved: ${feed.items.length} items. New ones from now on start the flow.` : `${fresh.length} new`;
      await deps.db.update(flowWatches).set({ seen: JSON.stringify(keep), lastCheckedAt: now, lastError: null, failCount: 0, nextCheckAt: new Date(now.getTime() + w.everyMinutes * 60_000) }).where(eq(flowWatches.id, w.id));
    }
    return { started, note };
  } catch (err) {
    const message = (err instanceof Error ? err.message : "The check failed.").slice(0, 300);
    const fails = w.failCount + 1;
    await deps.db.update(flowWatches).set({ lastError: message, failCount: fails, lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + watchBackoff(w.everyMinutes, fails)) }).where(eq(flowWatches.id, w.id));
    if (opts.manual) throw new HttpError(422, "check_failed", message);
    return { started: 0, note: message };
  }
}

/** From the maintenance pass: a few due watches, oldest first. One indexed read when none are due. */
export async function runDueWatches(deps: Deps, limit = 5) {
  if (!featureOn(deps, "flows")) return 0; // OPS1: the platform wide value (a cron pass)
  const due = await deps.db.select().from(flowWatches).where(and(isNotNull(flowWatches.nextCheckAt), lte(flowWatches.nextCheckAt, deps.now()))).orderBy(asc(flowWatches.nextCheckAt)).limit(limit);
  let started = 0;
  for (const w of due) started += (await checkWatch(deps, w)).started;
  return started;
}

/** "Check now" on a flow: the same check, at once, with the result in words. */
export async function checkFlowNow(deps: Deps, orgId: string, flowId: string) {
  const w = await deps.db.select().from(flowWatches).where(and(eq(flowWatches.flowId, flowId), eq(flowWatches.orgId, orgId))).get();
  if (!w) throw new HttpError(422, "validation_failed", "Turn the flow on first; then its page or feed can be checked.");
  return checkWatch(deps, w, { manual: true });
}
