/**
 * R100b: fetching a URL someone typed without letting it reach a private network (SSRF guard).
 * Used by the link preview and its image proxy. http and https on ports 80 and 443 only; no credentials in the
 * URL; IP literals and DNS answers (checked over DNS over HTTPS, keyless) must be public; every redirect is
 * followed by hand and checked again; a hard timeout and a byte cap on the body.
 */

export class UnsafeUrlError extends Error {}

const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa)$/i;

function v4Parts(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** True for addresses that are not on the public internet (IPv4 and IPv6, including mapped and NAT64 forms). */
export function isPrivateAddress(ip: string): boolean {
  const s = ip.trim().replace(/^\[|\]$/g, "").toLowerCase();
  const v4 = v4Parts(s);
  if (v4) {
    const [a, b, c] = v4;
    return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
      || (a === 100 && b >= 64 && b <= 127) // carrier NAT
      || (a === 169 && b === 254) // link local (cloud metadata)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) // IETF, test, benchmark
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (!s.includes(":")) return true; // not an address we can read: refuse
  if (s === "::" || s === "::1") return true;
  const mapped = s.match(/^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/) ?? s.match(/^64:ff9b::(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const hexMapped = s.match(/^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (first & 0xffc0) === 0xfe80 // link local fe80::/10
    || (first & 0xff00) === 0xff00 // multicast
    || first === 0 || (first === 0x2001 && /^2001:0?db8:/.test(s)) || first === 0x100;
}

const isIpLiteral = (host: string) => !!v4Parts(host) || host.startsWith("[") || /^[0-9a-f:]+$/i.test(host) && host.includes(":");

/** Checks the shape of a URL (no network). Returns the parsed URL or throws a plain sentence. */
export function checkUrlShape(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new UnsafeUrlError("That is not a web address."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new UnsafeUrlError("Only http and https links can be previewed.");
  if (u.username || u.password) throw new UnsafeUrlError("Links with a user name or password can't be previewed.");
  if (u.port && u.port !== "80" && u.port !== "443") throw new UnsafeUrlError("Only links on the normal web ports can be previewed.");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new UnsafeUrlError("That is not a web address.");
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError("Links to private networks can't be previewed.");
    return u;
  }
  // Numeric forms some resolvers read as addresses (2130706433, 0x7f.1, 017700000001): refuse outright.
  if (/^[0-9.]+$/.test(host) || /^(0x[0-9a-f]+\.?)+$/i.test(host)) throw new UnsafeUrlError("Links to private networks can't be previewed.");
  if (!host.includes(".") || BLOCKED_NAMES.test(host)) throw new UnsafeUrlError("Links to private networks can't be previewed.");
  return u;
}

type Fetcher = typeof fetch;

/** Every A and AAAA answer for a name must be public. Uses DNS over HTTPS (keyless). */
export async function assertPublicHost(fetcher: Fetcher, host: string, timeoutMs = 3000): Promise<void> {
  if (isIpLiteral(host)) { if (isPrivateAddress(host)) throw new UnsafeUrlError("Links to private networks can't be previewed."); return; }
  const answers: string[] = [];
  for (const type of ["A", "AAAA"]) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetcher(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: ctl.signal });
      if (!r.ok) throw new Error("dns");
      const j = (await r.json()) as { Answer?: { type: number; data: string }[] };
      for (const a of j.Answer ?? []) if (a.type === 1 || a.type === 28) answers.push(a.data);
    } catch {
      throw new UnsafeUrlError("That site could not be reached. Check the link and try again.");
    } finally { clearTimeout(t); }
  }
  if (!answers.length) throw new UnsafeUrlError("That site could not be found. Check the link and try again.");
  if (answers.some(isPrivateAddress)) throw new UnsafeUrlError("Links to private networks can't be previewed.");
}

export interface SafeFetchResult { url: string; status: number; contentType: string; bytes: Uint8Array; truncated: boolean }

/** GET with the guard on every hop, a deadline for the whole fetch and a cap on the body. */
export async function safeFetch(fetcher: Fetcher, raw: string, o: { maxBytes: number; timeoutMs?: number; maxRedirects?: number; accept?: string; userAgent?: string }): Promise<SafeFetchResult> {
  const deadline = Date.now() + (o.timeoutMs ?? 6000);
  let url = checkUrlShape(raw);
  for (let hop = 0; ; hop++) {
    await assertPublicHost(fetcher, url.hostname.toLowerCase().replace(/^\[|\]$/g, ""));
    const left = deadline - Date.now();
    if (left <= 0) throw new UnsafeUrlError("That site took too long to answer.");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), left);
    let res: Response;
    try {
      res = await fetcher(url.toString(), {
        redirect: "manual", signal: ctl.signal,
        headers: { accept: o.accept ?? "*/*", "user-agent": o.userAgent ?? "Mozilla/5.0 (compatible; MultiesLinkPreview/1.0)", "accept-language": "en" },
      });
    } catch {
      clearTimeout(timer);
      throw new UnsafeUrlError(Date.now() >= deadline ? "That site took too long to answer." : "That site could not be reached. Check the link and try again.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      clearTimeout(timer);
      try { await res.body?.cancel(); } catch { /* already closed */ }
      if (hop >= (o.maxRedirects ?? 4)) throw new UnsafeUrlError("That link redirects too many times.");
      url = checkUrlShape(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    try {
      const { bytes, truncated } = await readCapped(res, o.maxBytes);
      return { url: url.toString(), status: res.status, contentType: (res.headers.get("content-type") ?? "").toLowerCase(), bytes, truncated };
    } catch {
      throw new UnsafeUrlError("That site took too long to answer.");
    } finally { clearTimeout(timer); }
  }
}

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size)); size = max; truncated = true;
      try { await reader.cancel(); } catch { /* fine */ }
      break;
    }
    chunks.push(value); size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return { bytes: out, truncated };
}
