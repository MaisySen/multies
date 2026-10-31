/**
 * Public domain mail check: who hosts a domain's mail today, whether SPF and DMARC are set,
 * and the order of steps to move it to Multies without losing a message.
 *
 * Read only. It makes four public DNS lookups and never touches the database, so anyone can
 * run it without signing in. Answers are cached in memory for a few minutes per isolate.
 */
import type { AppConfig } from "../config";
import type { DnsResolver } from "./dns/resolver";
import { IMPORT_PROVIDERS } from "./import";
import { isVerifyValue, ownershipTxt } from "./dns/checks";
import { detectMailProvider, type DomainCheckItem, type DomainMailCheck, type MailProviderInfo, type SwitchStep } from "@/shared/mail-check";

export function spfItem(txt: string[]): DomainCheckItem {
  const spf = txt.filter((v) => /^v=spf1(\s|$)/i.test(v.trim()));
  if (!spf.length) return { status: "fail", records: [], message: "No SPF record. Receivers can't tell which servers may send as this domain." };
  if (spf.length > 1) return { status: "fail", records: spf, message: "More than one SPF record. Receivers treat that as an error, so neither counts. Merge them into one." };
  const terms = spf[0].trim().toLowerCase().split(/\s+/);
  if (terms.includes("+all") || terms.includes("all")) return { status: "fail", records: spf, message: "SPF ends in +all, which lets anyone send as this domain. Use ~all or -all." };
  if (!terms.some((t) => /^[~?-]all$/.test(t))) return { status: "warn", records: spf, message: "SPF has no closing ~all or -all, so unlisted senders are not marked." };
  return { status: "pass", records: spf, message: "SPF is set." };
}

export function dmarcItem(txt: string[]): DomainCheckItem {
  const found = txt.filter((v) => /^v=DMARC1/i.test(v.trim()));
  if (!found.length) return { status: "warn", records: [], message: "No DMARC policy. Gmail and Yahoo expect one from anyone who sends in volume." };
  if (found.length > 1) return { status: "fail", records: found, message: "More than one DMARC record, so receivers ignore all of them. Keep one." };
  const p = found[0].replace(/\s+/g, "").match(/(?:^|;)p=(none|quarantine|reject)/i)?.[1]?.toLowerCase();
  if (!p) return { status: "fail", records: found, message: "The DMARC record has no valid p= policy." };
  if (p === "none") return { status: "warn", records: found, message: "DMARC is set to monitor only (p=none). Forged mail still gets delivered." };
  return { status: "pass", records: found, message: `DMARC is set to ${p}.` };
}

/** The order of steps to move `domain` to Multies from `provider`, written for the person doing it. */
export function switchSteps(domain: string, provider: MailProviderInfo, spf: DomainCheckItem, dmarc: DomainCheckItem): SwitchStep[] {
  if (provider.kind === "multies") {
    const fix: SwitchStep[] = [];
    if (spf.status !== "pass") fix.push({ id: "spf", title: "Fix SPF", body: "Open the domain in Multies. Its page shows the exact SPF value to publish." });
    if (dmarc.status !== "pass") fix.push({ id: "dmarc", title: "Turn on DMARC", body: "Publish the DMARC record shown on the domain's page in Multies, starting at quarantine." });
    return [{ id: "done", title: `${domain} already uses Multies`, body: "Mail for this domain arrives at Multies. Nothing to move." }, ...fix];
  }
  const steps: SwitchStep[] = [];
  const keep = provider.kind === "none" ? "" : ` Mail keeps arriving at ${provider.name} until the MX step, so nobody misses anything.`;
  steps.push({ id: "add", title: "Add the domain to Multies", body: `Create a free workspace and add ${domain}. Multies makes its signing key and shows the records to publish.${keep}` });
  steps.push({
    id: "records", title: "Publish the sending records",
    body: spf.records.length
      ? "Add the ownership and DKIM records, and add Multies to your existing SPF record rather than making a second one. Multies shows the merged SPF value for you. These records let Multies send as you and change nothing for incoming mail."
      : "Add the ownership, DKIM and SPF records Multies shows. They let Multies send as you and change nothing for incoming mail.",
  });
  steps.push({ id: "mailboxes", title: "Create the same addresses", body: "Make a mailbox or alias in Multies for every address people write to today, including shared ones like hello@ and support@. An address missing here bounces after the switch." });
  if (provider.importFrom) {
    const help = IMPORT_PROVIDERS[provider.importFrom].help;
    steps.push({ id: "import", title: `Copy old mail from ${provider.name}`, body: `In Multies, open Mailboxes and import over IMAP. ${help}` });
  } else if (provider.kind === "forwarding") {
    steps.push({ id: "import", title: "Nothing to import", body: `${provider.name} forwards mail to another inbox and keeps no copies. Old mail stays where it was forwarded to.` });
  } else if (provider.id === "proton") {
    steps.push({ id: "import", title: "Export old mail from Proton", body: "Proton does not offer IMAP without its Bridge app. Export with Proton's export tool, or run Bridge on a computer and import from it." });
  }
  if (provider.kind !== "none") {
    steps.push({ id: "ttl", title: "Lower the MX TTL a day ahead", body: "Set the TTL on your MX records to 300 seconds at least a day before the switch, so the change spreads in minutes rather than hours." });
  }
  steps.push({
    id: "mx", title: provider.kind === "none" ? "Point MX at Multies" : "Switch MX to Multies",
    body: provider.kind === "none"
      ? "Publish the MX records Multies shows. Mail starts arriving as soon as they spread."
      : `At a quiet time, replace the MX records with the ones Multies shows. For a few hours some mail can still land at ${provider.name}; keep that account open for 14 days and run a final import before you cancel it.`,
  });
  if (provider.kind === "gateway") {
    steps.push({ id: "gateway", title: "Check the filter in front", body: `${provider.name} filters mail before it reaches the real host. Decide whether to keep it: if you do, point it at Multies instead of changing MX.` });
  }
  steps.push({ id: "dmarc", title: "Tighten DMARC after a week", body: dmarc.status === "pass" ? "Your DMARC policy already protects the domain. Watch the DMARC reports in Multies for a week after the switch." : "Once mail has flowed through Multies for a week, publish DMARC at quarantine. Multies reads the reports and shows who sends as you." });
  return steps;
}

export async function checkDomainMail(dns: DnsResolver, config: AppConfig, domain: string, now: Date): Promise<DomainMailCheck> {
  const [mx, txt, dmarcTxt, ownership] = await Promise.all([dns.mx(domain), dns.txt(domain), dns.txt(`_dmarc.${domain}`), ownershipTxt(dns, domain).catch(() => [] as string[])]);
  const multiesOwned = ownership.some(isVerifyValue);
  const provider = detectMailProvider(mx, { multiesOwned, multiesMx: config.mail.mxHosts.map((m) => m.host) });
  const spf = spfItem(txt);
  const dmarc = dmarcItem(dmarcTxt);
  return {
    domain,
    checkedAt: now.toISOString(),
    provider,
    mx: [...mx].sort((a, b) => a.priority - b.priority).map((m) => ({ host: m.exchange.replace(/\.$/, ""), priority: m.priority })),
    spf, dmarc,
    steps: switchSteps(domain, provider, spf, dmarc),
  };
}

/** A small per isolate cache, so a shared link opened many times costs one set of lookups. */
export class CheckCache {
  private map = new Map<string, { at: number; value: DomainMailCheck }>();
  constructor(private ttlMs = 5 * 60_000, private max = 500) {}
  get(domain: string, now: number) {
    const hit = this.map.get(domain);
    if (!hit || now - hit.at > this.ttlMs) return null;
    return hit.value;
  }
  set(domain: string, value: DomainMailCheck, now: number) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(domain, { at: now, value });
  }
}
