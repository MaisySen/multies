export interface MxRecord {
  exchange: string;
  priority: number;
}

/** A failed lookup (network, SERVFAIL). A name that simply has no records returns []. */
export class DnsLookupError extends Error {}

export interface DnsResolver {
  /** TXT records for a name; each record's character-strings are already joined. */
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<MxRecord[]>;
}

const DOH_ENDPOINTS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

interface DohAnswer { name: string; type: number; TTL: number; data: string }
interface DohResponse { Status: number; Answer?: DohAnswer[] }

/** Joins a DoH TXT `data` field: `"part one" "part two"` → `part onepart two`. */
export function parseTxtData(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) return data;
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/**
 * DNS-over-HTTPS resolver (RFC 8484 JSON flavour). Works on Node and Cloudflare
 * Workers alike; falls back to a second public resolver when the first fails.
 */
export class DohResolver implements DnsResolver {
  constructor(private fetchFn: typeof fetch = (...a) => fetch(...a), private endpoints = DOH_ENDPOINTS, private timeoutMs = 4000) {}

  private async query(name: string, type: "TXT" | "MX"): Promise<DohAnswer[]> {
    let lastErr: unknown;
    for (const ep of this.endpoints) {
      try {
        const url = `${ep}?name=${encodeURIComponent(name)}&type=${type}`;
        const res = await this.fetchFn(url, {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new DnsLookupError(`${ep} answered HTTP ${res.status}`);
        const body = (await res.json()) as DohResponse;
        if (body.Status === 3) return []; // NXDOMAIN
        if (body.Status !== 0) throw new DnsLookupError(`DNS status ${body.Status} for ${name}`);
        const want = type === "TXT" ? 16 : 15;
        return (body.Answer ?? []).filter((a) => a.type === want);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof DnsLookupError ? lastErr : new DnsLookupError(`Lookup failed for ${name}: ${String(lastErr)}`);
  }

  async txt(name: string): Promise<string[]> {
    return (await this.query(name, "TXT")).map((a) => parseTxtData(a.data));
  }

  async mx(name: string): Promise<MxRecord[]> {
    return (await this.query(name, "MX")).map((a) => {
      const [prio, host] = a.data.trim().split(/\s+/);
      return { priority: Number(prio), exchange: (host ?? "").replace(/\.$/, "").toLowerCase() };
    });
  }
}

/** In-memory resolver for tests and local experiments. */
export class StaticResolver implements DnsResolver {
  constructor(public records: { txt?: Record<string, string[]>; mx?: Record<string, MxRecord[]> } = {}) {}
  async txt(name: string) { return this.records.txt?.[name.toLowerCase()] ?? []; }
  async mx(name: string) { return this.records.mx?.[name.toLowerCase()] ?? []; }
}
