/**
 * Round 23 (R23.4): CalDAV (RFC 4791) read only, with the same username and app password as the
 * connected mailbox. Discovery: /.well-known/caldav, current-user-principal, calendar-home-set,
 * then the calendars in the home. Events: a REPORT calendar-query for the visible window. The XML
 * is read with small tolerant patterns (any namespace prefix), so no XML library is needed.
 * Redirects are followed by hand (at most 4) and every hop is checked against private hosts.
 */
import { HttpError } from "../../lib/errors";
import { isPublicHost } from "../../lib/ssrf";
import { assertPublicHost, checkUrlShape, readCapped } from "../../lib/safe-fetch";

export interface CalDavAuth { username: string; password: string }
export interface RemoteCalendar { url: string; name: string; color: string | null }
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
export interface DavOptions { fetch: Fetcher; allowPrivateHosts: boolean; timeoutMs?: number }

/** CalDAV servers of the providers whose app password also opens the calendar. */
export const CALDAV_BASES: Record<string, string> = {
  fastmail: "https://caldav.fastmail.com/",
  icloud: "https://caldav.icloud.com/",
  zoho: "https://calendar.zoho.com/",
  yahoo: "https://caldav.calendar.yahoo.com/",
  gmx: "https://caldav.gmx.net/",
};
/** Providers whose calendar needs their own sign in (OAuth): offer the ICS link instead. */
export const CALDAV_NEEDS_OAUTH: Record<string, string> = { gmail: "Google", google_workspace: "Google", outlook: "Microsoft", microsoft365: "Microsoft" };

export const davFail = (code: string, message: string, status: 422 | 502 = 422) => new HttpError(status, code, message);
/** PRIV1b (P45): one text for every fetch failure (DNS, private answer, timeout, redirect, odd status), so the add form is no port or host scanner. */
export const davUnreachable = () => davFail("unreachable", "The calendar server could not be reached. Check the address and try again.", 502);
/** PRIV1b (P45): the body is read in a stream and cut here. */
export const DAV_MAX_BYTES = 5_000_000;

/** Refuses anything but a public https address (http and private hosts only in tests). */
export function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw davFail("bad_url", "That is not a web address. Paste the full link, starting with https://."); }
  if (u.protocol === "webcal:") u = new URL(`https:${raw.slice("webcal:".length)}`);
  if (u.username || u.password) throw davFail("bad_url", "Leave the user name and password out of the address.");
  if (!allowPrivate) {
    if (u.protocol !== "https:") throw davFail("bad_url", "Use an https:// address.");
    if (!isPublicHost(u.hostname)) throw davFail("private_host", "That address points to a private network. Use the provider's public address.");
    // PRIV1b (CB3): a refused port says so, not "private network".
    if (u.port && u.port !== "443") throw davFail("bad_url", "That port is not allowed. Use the provider's https address without a port.");
    // PRIV1b (P45): the link preview's shape rules too: port 443 only, no numeric or internal names.
    try { checkUrlShape(u.toString()); } catch { throw davFail("private_host", "That address points to a private network. Use the provider's public address."); }
  } else if (u.protocol !== "https:" && u.protocol !== "http:") throw davFail("bad_url", "Use an https:// address.");
  return u;
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * One request with manual redirects (each hop checked) and a time limit.
 * PRIV1b (P45): every hop's DNS answers must be public (lib/safe-fetch), one deadline covers the whole request
 * including the body, and the body is streamed with a byte cap.
 */
export async function davRequest(opts: DavOptions, url: string, init: { method: string; headers?: Record<string, string>; body?: string; auth?: CalDavAuth }): Promise<{ status: number; text: string; url: string }> {
  let cur = checkUrl(url, opts.allowPrivateHosts).toString();
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (let hop = 0; hop < 5; hop++) {
    if (!opts.allowPrivateHosts) {
      try { await assertPublicHost(opts.fetch as typeof fetch, new URL(cur).hostname.toLowerCase().replace(/^\[|\]$/g, "")); } catch { throw davUnreachable(); }
    }
    const left = deadline - Date.now();
    if (left <= 0) throw davUnreachable();
    const headers: Record<string, string> = { "user-agent": "Multies-Calendar/1.0", ...(init.headers ?? {}) };
    if (init.auth) headers.authorization = `Basic ${b64(`${init.auth.username}:${init.auth.password}`)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), left);
    try {
      let res: Response;
      try {
        res = await opts.fetch(cur, { method: init.method, headers, body: init.body, redirect: "manual", signal: ctrl.signal });
      } catch { throw davUnreachable(); }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        try { await res.body?.cancel(); } catch { /* already closed */ }
        const next = new URL(res.headers.get("location")!, cur);
        // Credentials go only to the same host or a subdomain of the provider's own domain.
        const sameSite = next.hostname === new URL(cur).hostname || next.hostname.split(".").slice(-2).join(".") === new URL(cur).hostname.split(".").slice(-2).join(".");
        if (init.auth && !sameSite) throw davUnreachable();
        try { cur = checkUrl(next.toString(), opts.allowPrivateHosts).toString(); } catch { throw davUnreachable(); }
        continue;
      }
      let bytes: Uint8Array;
      try { bytes = (await readCapped(res, DAV_MAX_BYTES)).bytes; } catch { throw davUnreachable(); }
      return { status: res.status, text: new TextDecoder().decode(bytes), url: cur };
    } finally { clearTimeout(timer); }
  }
  throw davUnreachable();
}

const decode = (s: string) => s
  .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#13;/g, "\r").replace(/&#10;/g, "\n")
  .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");

/** Elements named `local` (any namespace prefix) in an XML text: their inner text. */
export function xmlAll(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:[A-Za-z][\\w.-]*:)?${local}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?${local}\\s*>)`, "g");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}
export const xmlFirst = (xml: string, local: string) => xmlAll(xml, local)[0];
const hrefIn = (xml: string | undefined) => (xml ? decode((xmlFirst(xml, "href") ?? "").trim()) : "");

/** The <response> parts of a multistatus with their href and the 200 propstat's props. */
export function multistatus(xml: string) {
  return xmlAll(xml, "response").map((r) => {
    const props = xmlAll(r, "propstat").filter((p) => /\s200\s/.test(` ${xmlFirst(p, "status") ?? "200"} `)).map((p) => xmlFirst(p, "prop") ?? "").join("");
    return { href: decode((xmlFirst(r, "href") ?? "").trim()), props };
  });
}

const PROPFIND = (props: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:prop>${props}</d:prop></d:propfind>`;

function explain(status: number): never {
  if (status === 401 || status === 403) throw davFail("caldav_auth", "The provider did not accept the app password for its calendar. Check it, or make a new app password.");
  if (status === 404 || status === 405 || status === 501) throw davFail("caldav_unsupported", "This provider does not offer its calendar over CalDAV. Add the calendar's ICS link instead.");
  throw davUnreachable(); // PRIV1b (P45): no status echo
}

async function propfind(opts: DavOptions, url: string, depth: "0" | "1", props: string, auth: CalDavAuth) {
  const r = await davRequest(opts, url, { method: "PROPFIND", headers: { depth, "content-type": "application/xml; charset=utf-8" }, body: PROPFIND(props), auth });
  if (r.status !== 207) explain(r.status);
  return r;
}

/** Finds the person's calendars that hold events. */
export async function discoverCalendars(opts: DavOptions, base: string, auth: CalDavAuth): Promise<RemoteCalendar[]> {
  const root = new URL(base);
  let start = new URL("/.well-known/caldav", root).toString();
  if (root.pathname.length > 1) start = root.toString();
  let r = await davRequest(opts, start, { method: "PROPFIND", headers: { depth: "0", "content-type": "application/xml; charset=utf-8" }, body: PROPFIND("<d:current-user-principal/>"), auth });
  // Some servers have no well-known address but answer at the root.
  if (r.status === 404 || r.status === 405) r = await davRequest(opts, root.origin + "/", { method: "PROPFIND", headers: { depth: "0", "content-type": "application/xml; charset=utf-8" }, body: PROPFIND("<d:current-user-principal/>"), auth });
  if (r.status !== 207) explain(r.status);
  const principalHref = hrefIn(xmlFirst(r.text, "current-user-principal"));
  const principal = principalHref ? new URL(principalHref, r.url).toString() : r.url;
  const p = await propfind(opts, principal, "0", "<c:calendar-home-set/>", auth);
  const homeHref = hrefIn(xmlFirst(p.text, "calendar-home-set"));
  if (!homeHref) throw davFail("caldav_unsupported", "This provider does not offer its calendar over CalDAV. Add the calendar's ICS link instead.");
  const home = new URL(homeHref, p.url).toString();
  const h = await propfind(opts, home, "1", "<d:resourcetype/><d:displayname/><a:calendar-color/><c:supported-calendar-component-set/>", auth);
  const out: RemoteCalendar[] = [];
  for (const resp of multistatus(h.text)) {
    const type = xmlFirst(resp.props, "resourcetype") ?? "";
    if (!/<(?:[\w.-]+:)?calendar[\s/>]/.test(type)) continue;
    const comps = xmlFirst(resp.props, "supported-calendar-component-set");
    if (comps && !/name=["']VEVENT["']/i.test(comps)) continue;
    const color = decode((xmlFirst(resp.props, "calendar-color") ?? "").trim()).slice(0, 7);
    out.push({ url: new URL(resp.href, h.url).toString(), name: decode((xmlFirst(resp.props, "displayname") ?? "").trim()) || "Calendar", color: /^#[0-9a-f]{6}$/i.test(color) ? color : null });
  }
  return out.slice(0, 20);
}

const davTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** The calendar-data of every event in [from, to) in one calendar (each an iCalendar text). */
export async function reportEvents(opts: DavOptions, calendarUrl: string, auth: CalDavAuth, from: Date, to: Date): Promise<string[]> {
  const body = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${davTime(from)}" end="${davTime(to)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await davRequest(opts, calendarUrl, { method: "REPORT", headers: { depth: "1", "content-type": "application/xml; charset=utf-8" }, body, auth });
  if (r.status !== 207) explain(r.status);
  return multistatus(r.text).map((x) => decode(xmlFirst(x.props, "calendar-data") ?? "")).filter((s) => s.includes("BEGIN:VCALENDAR"));
}
