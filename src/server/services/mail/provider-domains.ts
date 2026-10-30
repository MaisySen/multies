/**
 * Registers a customer domain with the outbound provider (Resend) so mail from it is
 * signed and delivered, and so mail to it can arrive through the provider's MX when the
 * domain's DNS is not on Cloudflare (a GoDaddy or Namecheap domain, for example).
 *
 * The provider answers with the exact DNS records it needs: a DKIM key, a return path
 * (an MX and an SPF record on `send.<domain>`) and, with receiving on, an MX for the
 * domain itself. Those records replace Multies' own DKIM and Cloudflare MX in the setup
 * page, because they are the ones the mail actually depends on.
 */
import type { Deps } from "../../context";

export interface ProviderRecord {
  /** The provider's label: "DKIM", "SPF", "Receiving", ... */
  record: string;
  /** Host relative to the domain ("send", "resend._domainkey"), or "@" / "" for the domain itself. */
  name: string;
  type: string;
  value: string;
  priority?: number;
  status?: string;
}

export interface ProviderDomainState {
  providerDomainId: string | null;
  providerRecords: string | null;
  providerStatus: string | null;
}

const API = "https://api.resend.com";

export function usesProviderDomains(deps: Pick<Deps, "config">): boolean {
  return deps.config.outbound.driver === "resend" && !!deps.config.outbound.resendApiKey;
}

async function call(deps: Deps, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await deps.fetch(`${API}${path}`, {
    method,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: { authorization: `Bearer ${deps.config.outbound.resendApiKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

function cleanRecords(raw: unknown): ProviderRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    if (typeof x.type !== "string" || typeof x.value !== "string") return [];
    return [{
      record: String(x.record ?? ""), name: String(x.name ?? "@"), type: x.type.toUpperCase(), value: x.value,
      priority: typeof x.priority === "number" ? x.priority : undefined, status: typeof x.status === "string" ? x.status : undefined,
    }];
  });
}

function stateFrom(json: Record<string, unknown>): ProviderDomainState {
  return {
    providerDomainId: typeof json.id === "string" ? json.id : null,
    providerRecords: JSON.stringify(cleanRecords(json.records)),
    providerStatus: typeof json.status === "string" ? json.status : "pending",
  };
}

// R40 (MB-206): the provider's own words stay on the server (this log and the stored status); the app shows our copy.
const failed = (why: string): ProviderDomainState => {
  console.warn("provider domain refused:", why.slice(0, 300));
  return { providerDomainId: null, providerRecords: null, providerStatus: `error: ${why.slice(0, 300)}` };
};

/** Status prefix for a domain waiting for one of the provider's domain slots. */
export const QUEUED_PREFIX = "queued:";

/** The provider's words when its plan has no domain slot left (Resend: "domain limit", "maximum number of domains"). */
const SLOT_LIMIT = /limit|maximum|max(imum)? number|upgrade|plan allows|quota/i;

/** True when a refusal is the provider's per-account domain cap, not a problem with the domain itself. */
export function isDomainSlotRefusal(status: number, message: string): boolean {
  return (status === 403 || status === 422 || status === 429 || status === 400) && SLOT_LIMIT.test(message);
}

const queued = (why: string): ProviderDomainState => ({ providerDomainId: null, providerRecords: null, providerStatus: `${QUEUED_PREFIX} ${why.slice(0, 280)}` });

/** Adds the domain to the provider with sending and receiving on. Never throws: a refusal is kept as the status. */
export async function registerProviderDomain(deps: Deps, name: string): Promise<ProviderDomainState | null> {
  if (!usesProviderDomains(deps)) return null;
  try {
    const made = await call(deps, "POST", "/domains", { name, capabilities: { sending: "enabled", receiving: "enabled" } });
    if (made.ok) return stateFrom(made.json);
    // Already registered on the provider account (an earlier attempt): adopt it.
    const list = await call(deps, "GET", "/domains");
    const found = Array.isArray(list.json.data) ? (list.json.data as Record<string, unknown>[]).find((d) => d.name === name) : undefined;
    if (found && typeof found.id === "string") {
      const one = await call(deps, "GET", `/domains/${found.id}`);
      if (one.ok) return stateFrom(one.json);
    }
    const why = String(made.json.message ?? `the provider answered ${made.status}`);
    // The provider's plan is full: wait for a slot instead of failing. Sign up and the domain's own
    // setup never depend on this; the domain still receives mail and sends through the shared domain.
    if (isDomainSlotRefusal(made.status, why)) return queued(why);
    return failed(why);
  } catch {
    return failed("the email provider could not be reached");
  }
}

/** Asks the provider to check the records again and reads its answer. Registers first when that never worked. */
export async function refreshProviderDomain(deps: Deps, d: { name: string; providerDomainId: string | null }): Promise<ProviderDomainState | null> {
  if (!usesProviderDomains(deps)) return null;
  if (!d.providerDomainId) return registerProviderDomain(deps, d.name);
  try {
    // A verify request puts the provider's domain back to "pending" while it looks again, so a domain
    // the provider already shows as verified is read, not re-verified (25 Oct: haajir.xyz).
    const before = await call(deps, "GET", `/domains/${d.providerDomainId}`);
    if (before.ok && before.json.status === "verified") return stateFrom(before.json);
    await call(deps, "POST", `/domains/${d.providerDomainId}/verify`);
    const one = await call(deps, "GET", `/domains/${d.providerDomainId}`);
    if (one.ok) return stateFrom(one.json);
    console.warn("provider domain read failed:", String(one.json.message ?? one.status).slice(0, 300));
    return { providerDomainId: d.providerDomainId, providerRecords: null, providerStatus: `error: ${String(one.json.message ?? one.status)}` };
  } catch {
    return null;
  }
}

export function parseProviderRecords(json: string | null | undefined): ProviderRecord[] {
  if (!json) return [];
  try { return cleanRecords(JSON.parse(json)); } catch { return []; }
}

const isApex = (name: string, domain: string) => name === "" || name === "@" || name.toLowerCase() === domain.toLowerCase();

/** Splits the provider's records by what they do. */
export function classifyProviderRecords(records: ProviderRecord[], domain: string) {
  const receivingMx = records.filter((r) => r.type === "MX" && (/receiv|inbound/i.test(r.record) || isApex(r.name, domain)));
  const dkim = records.filter((r) => r.type === "TXT" && /_domainkey/i.test(r.name));
  const returnPath = records.filter((r) => !receivingMx.includes(r) && !dkim.includes(r));
  return { receivingMx, dkim, returnPath };
}

/** Fetches a message that arrived through the provider's MX, as raw RFC 5322 bytes. */
export async function fetchReceivedEmail(deps: Deps, emailId: string): Promise<{ raw: Uint8Array; recipients: string[]; from: string } | null> {
  if (!usesProviderDomains(deps)) return null;
  const got = await call(deps, "GET", `/emails/receiving/${encodeURIComponent(emailId)}`);
  if (!got.ok) return null;
  const j = got.json;
  const url = (j.raw as { download_url?: string } | undefined)?.download_url;
  if (!url) return null;
  const res = await deps.fetch(url);
  if (!res.ok) return null;
  const raw = new Uint8Array(await res.arrayBuffer());
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const envelope = list(j.received_for);
  const recipients = envelope.length ? envelope : [...list(j.to), ...list(j.cc), ...list(j.bcc)];
  const fromHeader = typeof j.from === "string" ? j.from : "";
  const from = fromHeader.match(/<([^>]+)>/)?.[1] ?? fromHeader;
  return { raw, recipients: [...new Set(recipients.map((a) => (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase()))], from };
}

/** How long the sent event waits for the provider's answer before giving up (the reply then starts its own thread). */
export const SENT_MESSAGE_ID_TIMEOUT_MS = 5000;

/**
 * The Message-ID header a sent email actually went out with. Resend replaces ours with its own
 * (<...@email.amazonses.com>) and returns it as `message_id` on GET /emails/{id}, so outside replies
 * point at that one. Null when it can't be read; a failure or a timeout is logged, never thrown.
 */
export async function fetchSentMessageIdHeader(deps: Deps, emailId: string): Promise<string | null> {
  if (!usesProviderDomains(deps)) return null;
  try {
    const got = await call(deps, "GET", `/emails/${encodeURIComponent(emailId)}`, undefined, SENT_MESSAGE_ID_TIMEOUT_MS);
    if (!got.ok) {
      deps.log?.warn("resend.sent_message_id_failed", { emailId, status: got.status });
      return null;
    }
    const v = (got.json as { message_id?: unknown }).message_id;
    if (typeof v !== "string" || !v.trim()) {
      deps.log?.warn("resend.sent_message_id_missing", { emailId });
      return null;
    }
    const id = v.trim();
    return id.startsWith("<") ? id : `<${id}>`;
  } catch (err) {
    deps.log?.warn("resend.sent_message_id_failed", { emailId, error: err instanceof Error ? err.name : String(err) });
    return null;
  }
}

/** Removes the domain from the provider when it leaves Multies. Never throws. */
export async function removeProviderDomain(deps: Deps, providerDomainId: string): Promise<void> {
  if (!usesProviderDomains(deps)) return;
  try { await call(deps, "DELETE", `/domains/${encodeURIComponent(providerDomainId)}`); } catch { /* best effort */ }
}
