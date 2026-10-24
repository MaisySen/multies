/**
 * The public domain mail check (multies.si/check) and the switch plan on a domain's page.
 * Types and the provider table are shared so the web app can label results the same way.
 */

export type MailProviderKind = "suite" | "mailbox" | "forwarding" | "gateway" | "multies" | "unknown" | "none";

export interface MailProviderInfo {
  id: string;
  name: string;
  kind: MailProviderKind;
  /** Which IMAP import preset fits this provider, when old mail can be copied over. */
  importFrom: "gmail" | "outlook" | "imap" | null;
}

interface ProviderRule extends MailProviderInfo {
  /** MX host suffixes, lower case, without a trailing dot. */
  mx: string[];
}

/** Known mail hosts, matched on the MX host name. Order matters: the first match wins. */
export const MAIL_PROVIDERS: ProviderRule[] = [
  { id: "google", name: "Google Workspace or Gmail", kind: "suite", importFrom: "gmail", mx: ["google.com", "googlemail.com"] },
  { id: "microsoft", name: "Microsoft 365 or Outlook", kind: "suite", importFrom: "outlook", mx: ["mail.protection.outlook.com", "outlook.com", "hotmail.com"] },
  { id: "zoho", name: "Zoho Mail", kind: "suite", importFrom: "imap", mx: ["zoho.com", "zoho.com.au", "zoho.eu", "zoho.in", "zoho.jp", "zohomail.com"] },
  { id: "fastmail", name: "Fastmail", kind: "mailbox", importFrom: "imap", mx: ["messagingengine.com"] },
  { id: "proton", name: "Proton Mail", kind: "mailbox", importFrom: null, mx: ["protonmail.ch", "proton.me"] },
  { id: "icloud", name: "iCloud Mail", kind: "mailbox", importFrom: "imap", mx: ["mail.icloud.com", "icloud.com"] },
  { id: "godaddy", name: "GoDaddy email", kind: "mailbox", importFrom: "imap", mx: ["secureserver.net"] },
  { id: "namecheap", name: "Namecheap Private Email", kind: "mailbox", importFrom: "imap", mx: ["privateemail.com"] },
  { id: "hostinger", name: "Hostinger email", kind: "mailbox", importFrom: "imap", mx: ["hostinger.com"] },
  { id: "yandex", name: "Yandex 360", kind: "mailbox", importFrom: "imap", mx: ["yandex.net", "yandex.ru"] },
  { id: "amazon", name: "Amazon WorkMail or SES", kind: "mailbox", importFrom: "imap", mx: ["amazonaws.com"] },
  { id: "cloudflare", name: "Cloudflare Email Routing", kind: "forwarding", importFrom: null, mx: ["mx.cloudflare.net"] },
  { id: "improvmx", name: "ImprovMX", kind: "forwarding", importFrom: null, mx: ["improvmx.com"] },
  { id: "forwardemail", name: "Forward Email", kind: "forwarding", importFrom: null, mx: ["forwardemail.net"] },
  { id: "mimecast", name: "Mimecast (a filter in front of another host)", kind: "gateway", importFrom: "imap", mx: ["mimecast.com"] },
  { id: "proofpoint", name: "Proofpoint (a filter in front of another host)", kind: "gateway", importFrom: "imap", mx: ["pphosted.com", "ppe-hosted.com"] },
  { id: "barracuda", name: "Barracuda (a filter in front of another host)", kind: "gateway", importFrom: "imap", mx: ["barracudanetworks.com"] },
];

export const NO_MAIL: MailProviderInfo = { id: "none", name: "No mail host yet", kind: "none", importFrom: null };
export const UNKNOWN_HOST: MailProviderInfo = { id: "other", name: "Another mail host", kind: "unknown", importFrom: "imap" };
export const MULTIES_HOST: MailProviderInfo = { id: "multies", name: "Multies", kind: "multies", importFrom: null };

const clean = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");
const endsWith = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);

/** MX hosts Multies receives on: this deployment's own, plus the receiving services it uses for customer domains. */
export const MULTIES_RECEIVING_MX = ["mx.cloudflare.net", "amazonaws.com", "resend.com"];

/**
 * Names the mail host from a domain's MX hosts (lowest priority first wins).
 * Those receiving hosts are shared with other customers of the same services, so a domain counts
 * as on Multies only when it also publishes the Multies ownership record (`multiesOwned`).
 */
export function detectMailProvider(mx: { exchange: string; priority: number }[], opts: { multiesOwned?: boolean; multiesMx?: string[] } = {}): MailProviderInfo {
  const hosts = [...mx].sort((a, b) => a.priority - b.priority).map((m) => clean(m.exchange)).filter((h) => h && h !== ".");
  if (!hosts.length) return NO_MAIL;
  const own = opts.multiesOwned ? [...(opts.multiesMx ?? []), ...MULTIES_RECEIVING_MX].map(clean) : [];
  for (const h of hosts) {
    if (own.some((o) => endsWith(h, o))) return MULTIES_HOST;
    const rule = MAIL_PROVIDERS.find((p) => p.mx.some((s) => endsWith(h, s)));
    if (rule) return { id: rule.id, name: rule.name, kind: rule.kind, importFrom: rule.importFrom };
  }
  return UNKNOWN_HOST;
}

export type CheckStatus = "pass" | "warn" | "fail";

export interface DomainCheckItem { status: CheckStatus; message: string; records: string[] }

export interface SwitchStep { id: string; title: string; body: string }

export interface DomainMailCheck {
  domain: string;
  checkedAt: string;
  provider: MailProviderInfo;
  mx: { host: string; priority: number }[];
  spf: DomainCheckItem;
  dmarc: DomainCheckItem;
  steps: SwitchStep[];
}
