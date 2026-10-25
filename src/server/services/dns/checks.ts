import type { AppConfig } from "../../config";
import type { DnsCheckReport, ExpectedRecord, RecordCheck } from "@/shared/dns";
import { DnsLookupError, type DnsResolver } from "./resolver";
import { classifyProviderRecords, parseProviderRecords, type ProviderRecord } from "../mail/provider-domains";

export interface DomainDnsInput {
  name: string;
  verificationToken: string;
  dkimSelector: string;
  dkimPublicKey: string;
  /** JSON of the outbound provider's records (provider-domains.ts), when the domain is registered there. */
  providerRecords?: string | null;
}

const fqdnOf = (host: string, domain: string) => (host === "" || host === "@" || host.toLowerCase() === domain.toLowerCase() ? domain : `${host}.${domain}`);

/** The provider's records for this domain, sorted by what they do. Empty when there are none. */
function providerParts(d: DomainDnsInput) {
  return classifyProviderRecords(parseProviderRecords(d.providerRecords), d.name);
}

/** The MX hosts mail for the domain should go to: the provider's receiving MX, else the configured hosts. */
function mxTargets(d: DomainDnsInput, config: AppConfig) {
  const { receivingMx } = providerParts(d);
  if (receivingMx.length) return receivingMx.map((r) => ({ host: r.value, priority: r.priority ?? 10 }));
  return [...config.mail.mxHosts].sort((a, b) => a.priority - b.priority);
}

export const OWNERSHIP_LABEL = "_mymail";

export function dmarcValue(domain: string, config: AppConfig): string {
  const rua = config.mail.dmarcRua ?? `dmarc@${domain}`;
  return `v=DMARC1; p=quarantine; rua=mailto:${rua}; adkim=r; aspf=r; pct=100`;
}

export function spfValue(config: AppConfig): string {
  return `v=spf1 ${config.mail.spfIncludes.map((i) => `include:${i}`).join(" ")} ~all`;
}

/** The exact records a customer must publish for `domain`, with plain-language reasons. */
export function expectedRecords(d: DomainDnsInput, config: AppConfig): ExpectedRecord[] {
  const mx = mxTargets(d, config);
  const parts = providerParts(d);
  const dkim: ExpectedRecord[] = parts.dkim.length
    ? parts.dkim.map((r) => ({
      id: "dkim" as const, type: "TXT" as const, host: r.name, fqdn: fqdnOf(r.name, d.name), value: r.value, required: true,
      title: "Signing key (DKIM)",
      why: "The key your outgoing mail is signed with. Receivers use it to check that your mail was not altered or forged.",
    }))
    : [{
      id: "dkim", type: "TXT", host: `${d.dkimSelector}._domainkey`, fqdn: `${d.dkimSelector}._domainkey.${d.name}`,
      value: `v=DKIM1; k=rsa; p=${d.dkimPublicKey}`, required: true,
      title: "Signing key (DKIM)",
      why: "A public key unique to this domain. Receivers use it to check that your mail was not altered or forged.",
    }];
  const returnPath: ExpectedRecord[] = parts.returnPath.flatMap((r): ExpectedRecord[] => {
    if (r.type === "MX") return [{
      id: "return_mx", type: "MX", host: r.name, fqdn: fqdnOf(r.name, d.name), value: r.value, values: [{ value: r.value, priority: r.priority ?? 10 }], required: true,
      title: "Bounce handling (MX)",
      why: `Bounces and replies about delivery for mail you send come back through ${fqdnOf(r.name, d.name)}. It does not change where your normal mail arrives.`,
    }];
    if (r.type === "TXT") return [{
      id: "return_spf", type: "TXT", host: r.name, fqdn: fqdnOf(r.name, d.name), value: r.value, required: true,
      title: "Sending permission (SPF)",
      why: `Lets the sending servers use ${fqdnOf(r.name, d.name)} as the return address, so your mail passes SPF.`,
    }];
    // The provider checks this one itself (the sending status on the domain page), so it is listed
    // but does not hold up verification here.
    if (r.type === "CNAME") return [{
      id: "return_cname", type: "CNAME", host: r.name, fqdn: fqdnOf(r.name, d.name), value: r.value, required: false,
      title: "Sending host (CNAME)",
      why: `The sending provider asks for ${fqdnOf(r.name, d.name)} before it marks sending as verified. It does not change where your normal mail arrives.`,
    }];
    return [];
  });
  return [
    {
      id: "ownership", type: "TXT", host: OWNERSHIP_LABEL, fqdn: `${OWNERSHIP_LABEL}.${d.name}`,
      value: `mymail-verify=${d.verificationToken}`, required: true,
      title: "Ownership",
      why: "Proves this domain is yours. Nothing else reads it, and it is safe to keep forever.",
    },
    {
      id: "mx", type: "MX", host: "@", fqdn: d.name,
      value: mx.map((m) => m.host).join(", "),
      values: mx.map((m) => ({ value: m.host, priority: m.priority })),
      required: true,
      title: "Inbound mail (MX)",
      why: "Tells the internet where to deliver mail for your domain. Remove any other MX records, or some mail will go elsewhere.",
    },
    {
      id: "spf", type: "TXT", host: "@", fqdn: d.name, value: spfValue(config), required: true,
      title: "Sender policy (SPF)",
      why: "Lists the servers allowed to send as your domain. A domain can have only one SPF record, so merge it if you already have one.",
    },
    ...dkim,
    ...returnPath,
    {
      id: "dmarc", type: "TXT", host: "_dmarc", fqdn: `_dmarc.${d.name}`, value: dmarcValue(d.name, config), required: false,
      title: "Policy (DMARC)",
      why: "Tells receivers what to do with mail that fails SPF and DKIM. Gmail and Yahoo expect one; start at quarantine.",
    },
  ];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");

function lookupError(id: RecordCheck["id"], err: unknown): RecordCheck {
  return { id, status: "error", found: [], message: `DNS lookup failed (${err instanceof Error ? err.message : String(err)}). We'll retry.` };
}

async function checkOwnership(dns: DnsResolver, d: DomainDnsInput): Promise<RecordCheck> {
  const want = `mymail-verify=${d.verificationToken}`;
  const found = await dns.txt(`${OWNERSHIP_LABEL}.${d.name}`);
  if (found.some((v) => v.trim() === want)) return { id: "ownership", status: "pass", found, message: "Ownership confirmed." };
  if (found.some((v) => v.startsWith("mymail-verify="))) {
    return { id: "ownership", status: "fail", found, message: "A verification record exists but the token doesn't match this workspace." };
  }
  return { id: "ownership", status: "fail", found, message: "Ownership record not found yet. DNS changes can take a few minutes to appear." };
}

async function checkMx(dns: DnsResolver, d: DomainDnsInput, config: AppConfig): Promise<RecordCheck> {
  const records = await dns.mx(d.name);
  const found = records.sort((a, b) => a.priority - b.priority).map((r) => `${r.priority} ${r.exchange}`);
  if (!records.length) return { id: "mx", status: "fail", found, message: "No MX records found. Mail to this domain has nowhere to go yet." };
  const have = new Set(records.map((r) => norm(r.exchange)));
  const want = mxTargets(d, config).map((m) => norm(m.host));
  const missing = want.filter((h) => !have.has(h));
  const extra = [...have].filter((h) => !want.includes(h));
  if (missing.length) {
    return { id: "mx", status: "fail", found, message: `Missing MX ${missing.length === 1 ? "host" : "hosts"}: ${missing.join(", ")}.` };
  }
  if (extra.length) {
    return { id: "mx", status: "warn", found, message: `Other MX hosts are also published (${extra.join(", ")}). Remove them so all mail reaches Multies.` };
  }
  return { id: "mx", status: "pass", found, message: "Inbound mail is routed correctly." };
}

/** Builds one SPF record that keeps existing mechanisms and adds the missing includes. */
export function mergeSpf(existing: string, includes: string[]): string {
  const terms = existing.trim().split(/\s+/).slice(1);
  const all = terms.find((t) => /^[~?+-]?all$/i.test(t)) ?? "~all";
  const body = terms.filter((t) => !/^[~?+-]?all$/i.test(t));
  for (const inc of includes) if (!body.some((t) => norm(t) === `include:${norm(inc)}`)) body.push(`include:${inc}`);
  return ["v=spf1", ...body, all === "+all" || all === "all" ? "~all" : all].join(" ");
}

async function checkSpf(dns: DnsResolver, d: DomainDnsInput, config: AppConfig): Promise<RecordCheck> {
  const txt = await dns.txt(d.name);
  const spf = txt.filter((v) => /^v=spf1(\s|$)/i.test(v.trim()));
  if (!spf.length) return { id: "spf", status: "fail", found: [], message: "No SPF record found." };
  if (spf.length > 1) {
    return {
      id: "spf", status: "fail", found: spf,
      message: "More than one SPF record is published. Receivers treat that as a permanent error. Merge them into one.",
      suggestion: mergeSpf(spf[0], config.mail.spfIncludes),
    };
  }
  const record = spf[0];
  const terms = record.trim().split(/\s+/).map(norm);
  const missing = config.mail.spfIncludes.filter((i) => !terms.includes(`include:${norm(i)}`));
  if (missing.length) {
    return {
      id: "spf", status: "fail", found: spf,
      message: `Your SPF record is missing ${missing.map((m) => `include:${m}`).join(" and ")}.`,
      suggestion: mergeSpf(record, config.mail.spfIncludes),
    };
  }
  if (terms.includes("+all") || terms.includes("all")) {
    return { id: "spf", status: "fail", found: spf, message: "SPF ends in +all, which lets anyone send as you. Use ~all or -all.", suggestion: mergeSpf(record, config.mail.spfIncludes) };
  }
  if (!terms.some((t) => /^[~?-]all$/.test(t))) {
    return { id: "spf", status: "warn", found: spf, message: "SPF has no closing ~all or -all; add one so unlisted senders fail." };
  }
  return { id: "spf", status: "pass", found: spf, message: "Sender policy is valid." };
}

export function dkimKeyFrom(record: string): string | null {
  const m = record.replace(/\s+/g, "").match(/(?:^|;)p=([^;]*)/i);
  return m ? m[1] : null;
}

async function checkDkim(dns: DnsResolver, d: DomainDnsInput): Promise<RecordCheck> {
  const provider = providerParts(d).dkim[0];
  if (provider) {
    const found = await dns.txt(fqdnOf(provider.name, d.name));
    const want = dkimKeyFrom(provider.value) ?? provider.value.replace(/\s+/g, "");
    const keys = found.map((v) => dkimKeyFrom(v) ?? v.replace(/\s+/g, ""));
    if (!found.length) return { id: "dkim", status: "fail", found, message: "DKIM key not found yet." };
    if (keys.includes(want)) return { id: "dkim", status: "pass", found, message: "Signing key matches." };
    return { id: "dkim", status: "fail", found, message: "A DKIM record exists but its key is different. Copy the value again; it is easy to truncate." };
  }
  const found = await dns.txt(`${d.dkimSelector}._domainkey.${d.name}`);
  const keys = found.map(dkimKeyFrom).filter((k): k is string => k !== null);
  if (!keys.length) return { id: "dkim", status: "fail", found, message: "DKIM key not found yet." };
  if (keys.includes(d.dkimPublicKey)) return { id: "dkim", status: "pass", found, message: "Signing key matches." };
  if (keys.some((k) => k === "")) return { id: "dkim", status: "fail", found, message: "The DKIM record has an empty key (revoked)." };
  return { id: "dkim", status: "fail", found, message: "A DKIM record exists but its key is different. Copy the value again; it is easy to truncate." };
}

async function checkDmarc(dns: DnsResolver, d: DomainDnsInput): Promise<RecordCheck> {
  const found = (await dns.txt(`_dmarc.${d.name}`)).filter((v) => /^v=DMARC1/i.test(v.trim()));
  if (!found.length) return { id: "dmarc", status: "warn", found, message: "No DMARC policy. Mail still flows, but Gmail and Yahoo increasingly expect one." };
  if (found.length > 1) return { id: "dmarc", status: "fail", found, message: "Multiple DMARC records; receivers will ignore all of them. Keep one." };
  const p = found[0].replace(/\s+/g, "").match(/(?:^|;)p=(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  if (!p) return { id: "dmarc", status: "fail", found, message: "DMARC record has no valid p= policy." };
  if (p === "none") return { id: "dmarc", status: "warn", found, message: "DMARC is in monitor-only mode (p=none). Move to quarantine once mail looks healthy." };
  return { id: "dmarc", status: "pass", found, message: `DMARC policy is ${p}.` };
}

/** The provider's return path records: present exactly as given. */
async function checkReturnPath(dns: DnsResolver, d: DomainDnsInput, r: ProviderRecord): Promise<RecordCheck> {
  const fqdn = fqdnOf(r.name, d.name);
  if (r.type === "MX") {
    const found = (await dns.mx(fqdn)).map((m) => `${m.priority} ${m.exchange}`);
    const ok = found.some((f) => norm(f.split(" ").pop() ?? "") === norm(r.value));
    return { id: "return_mx", status: ok ? "pass" : "fail", found, message: ok ? "Bounce handling is set up." : `MX record on ${fqdn} not found yet.` };
  }
  const found = await dns.txt(fqdn);
  const ok = found.some((v) => v.replace(/\s+/g, " ").trim() === r.value.replace(/\s+/g, " ").trim());
  return { id: "return_spf", status: ok ? "pass" : "fail", found, message: ok ? "Sending permission is set up." : `SPF record on ${fqdn} not found yet.` };
}

/** Runs every lookup live and decides whether the domain is verified. */
export async function runDnsChecks(dns: DnsResolver, d: DomainDnsInput, config: AppConfig, now: Date): Promise<DnsCheckReport> {
  const guard = (id: RecordCheck["id"], p: Promise<RecordCheck>) =>
    p.catch((err) => (err instanceof DnsLookupError ? lookupError(id, err) : lookupError(id, err)));
  const records = await Promise.all([
    guard("ownership", checkOwnership(dns, d)),
    guard("mx", checkMx(dns, d, config)),
    guard("spf", checkSpf(dns, d, config)),
    guard("dkim", checkDkim(dns, d)),
    guard("dmarc", checkDmarc(dns, d)),
    ...providerParts(d).returnPath.filter((r) => r.type === "MX" || r.type === "TXT")
      .map((r) => guard(r.type === "MX" ? "return_mx" : "return_spf", checkReturnPath(dns, d, r))),
  ]);
  const required = new Set(expectedRecords(d, config).filter((r) => r.required).map((r) => r.id));
  const verified = records.every((r) => !required.has(r.id) || r.status === "pass" || r.status === "warn");
  return { checkedAt: now.toISOString(), verified, records };
}
