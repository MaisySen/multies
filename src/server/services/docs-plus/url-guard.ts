/**
 * R103: the web clipper's guard against server side request forgery. The clipper only ever reads public web pages:
 *  - http or https, the default port (80 or 443) only, no user name or password in the URL;
 *  - no IP literal or host name in a private, loopback, link local, carrier NAT, multicast, documentation or reserved
 *    range (IPv4 and IPv6, including IPv4 mapped and NAT64 forms; the URL parser already turns "2130706433",
 *    "0x7f.1" and "017700000001" into dotted quads);
 *  - names are resolved first over public DNS over HTTPS and every A and AAAA answer must be public;
 *  - redirects are followed by hand (at most 3), each hop checked again;
 *  - 8 second deadline, 2 MB cap (the body is read in chunks and the read stops at the cap), html or plain text only.
 */
import type { Deps } from "../../context";

export const CLIP_MAX_BYTES = 2_000_000;
export const CLIP_TIMEOUT_MS = 8_000;
export const CLIP_MAX_REDIRECTS = 3;

export class ClipError extends Error {
  constructor(public code: "invalid_url" | "blocked_address" | "dns_failed" | "timeout" | "too_large" | "not_html" | "http_error" | "too_many_redirects" | "fetch_failed", message: string) { super(message); }
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|onion|test|invalid|example|arpa)$/i;

function v4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** True for any IPv4 address that is not on the public internet. */
export function isPrivateV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return true;
  const [a, b, c] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved (incl. broadcast)
    || (a === 100 && b >= 64 && b <= 127) // carrier NAT
    || (a === 169 && b === 254) // link local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol, documentation
    || (a === 192 && b === 88 && c === 99) // 6to4 relay
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113); // documentation
}

/** Expands an IPv6 text form to 8 groups, or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const p = v4Parts(v4[1]);
    if (!p) return null;
    s = `${s.slice(0, -v4[1].length)}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h ? h.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const g = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
}

/** True for any IPv6 address that is not global unicast on the public internet. */
export function isPrivateV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return true;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPrivateV4(v4of(g[6], g[7])); // mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateV4(v4of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPrivateV4(v4of(g[1], g[2])); // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return true; // only 2000::/3 is global unicast (drops fc00::/7, fe80::/10, ff00::/8, ...)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // Teredo and IETF protocol assignments
  return false;
}

export const isIpLiteral = (host: string) => !!v4Parts(host) || host.includes(":");
export const isPrivateIp = (ip: string) => (ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip));

/** Syntax checks that need no network. Returns the parsed URL or throws ClipError. */
export function checkClipUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ClipError("invalid_url", "That is not a web address."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ClipError("invalid_url", "Only http and https pages can be saved.");
  if (u.username || u.password) throw new ClipError("invalid_url", "Addresses with a user name or password cannot be saved.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new ClipError("blocked_address", "Only pages on the standard web ports can be saved.");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) throw new ClipError("invalid_url", "That is not a web address.");
  if (isIpLiteral(host)) {
    if (isPrivateIp(host)) throw new ClipError("blocked_address", "That address is private, so it cannot be saved.");
  } else if (!host.includes(".") || BLOCKED_NAMES.test(host)) {
    throw new ClipError("blocked_address", "That address is private, so it cannot be saved.");
  }
  return u;
}

const DOH = "https://cloudflare-dns.com/dns-query";

/** Every A and AAAA answer for a public name (CNAME chains are followed by the resolver). Throws when none or any is private. */
export async function resolvePublic(fetcher: typeof fetch, host: string): Promise<string[]> {
  const ips: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    let res: Response;
    try {
      res = await fetcher(`${DOH}?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(4000) });
    } catch { throw new ClipError("dns_failed", "We could not look up that site. Check the address and try again."); }
    if (!res.ok) throw new ClipError("dns_failed", "We could not look up that site. Check the address and try again.");
    const body = (await res.json().catch(() => null)) as { Status?: number; Answer?: { type: number; data: string }[] } | null;
    for (const a of body?.Answer ?? []) if (a.type === 1 || a.type === 28) ips.push(String(a.data).trim());
  }
  if (!ips.length) throw new ClipError("dns_failed", "That site could not be found.");
  if (ips.some(isPrivateIp)) throw new ClipError("blocked_address", "That address is private, so it cannot be saved.");
  return ips;
}

export interface FetchedPage { url: string; status: number; contentType: string; body: string }

async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new ClipError("too_large", "That page is too large to save (over 2 MB).");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new ClipError("too_large", "That page is too large to save (over 2 MB)."); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  const charset = /charset=["']?([\w-]+)/i.exec(res.headers.get("content-type") || "")?.[1];
  try { return new TextDecoder(charset || "utf-8").decode(all); } catch { return new TextDecoder("utf-8").decode(all); }
}

/** Fetches a public page with every guard above. */
export async function fetchPublicPage(deps: Pick<Deps, "fetch">, raw: string, opts: { maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchedPage> {
  const max = opts.maxBytes ?? CLIP_MAX_BYTES;
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? CLIP_TIMEOUT_MS);
  let url = checkClipUrl(raw);
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!isIpLiteral(host)) await resolvePublic(deps.fetch, host);
    let res: Response;
    try {
      res = await deps.fetch(url.toString(), {
        redirect: "manual", signal: deadline,
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": "Mozilla/5.0 (compatible; MultiesClipper/1.0; +https://multies.si)" },
      });
    } catch (e) {
      if (deadline.aborted || (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") throw new ClipError("timeout", "That page took too long to answer.");
      throw new ClipError("fetch_failed", "We could not reach that page.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= CLIP_MAX_REDIRECTS) throw new ClipError("too_many_redirects", "That page redirects too many times.");
      url = checkClipUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    if (!res.ok) throw new ClipError("http_error", `That page answered with an error (${res.status}).`);
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (!/text\/html|application\/xhtml\+xml|text\/plain/.test(contentType)) throw new ClipError("not_html", "Only web pages can be saved, not files or images.");
    try {
      return { url: url.toString(), status: res.status, contentType, body: await readCapped(res, max) };
    } catch (e) {
      if (e instanceof ClipError) throw e;
      throw new ClipError(deadline.aborted ? "timeout" : "fetch_failed", deadline.aborted ? "That page took too long to answer." : "We could not read that page.");
    }
  }
}
