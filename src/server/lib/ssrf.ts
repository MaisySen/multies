/**
 * Outgoing request targets (webhook endpoints) must be public. The URL parser already turns
 * shorthand IPv4 forms ("2130706433", "0x7f.1") into dotted quads, so the checks below see
 * the canonical address. Names that resolve to a private address are a separate risk that the
 * Workers runtime closes (a Worker cannot reach private networks); self-hosted Node should
 * run behind an egress proxy.
 */
const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home\.arpa|localdomain)\.?$/i;

function ipv4Private(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local, cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0) // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)); // benchmarking
}

function parseIpv4(host: string): [number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** True when a URL hostname (as `new URL().hostname` gives it) is a public address or name. */
export function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || BLOCKED_NAMES.test(host)) return false;
  const v4 = parseIpv4(host);
  if (v4) return !ipv4Private(v4[0], v4[1]);
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::" || v6 === "::1") return false;
    // IPv4 mapped or translated (::ffff:7f00:1, 64:ff9b::a00:1): check the embedded IPv4 address.
    const mapped = v6.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) { const hi = parseInt(mapped[1], 16); return !ipv4Private(hi >> 8, hi & 255); }
    if (/^::ffff:/.test(v6) || /^::[0-9a-f]/.test(v6)) return false; // other compatible forms
    const first = parseInt(v6.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
    if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return false; // multicast
    return true;
  }
  // A bare name with no dot (an intranet host) is not public.
  return host.includes(".");
}
