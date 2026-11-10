/**
 * R26 (DF-18): support@ and security@ on the company domain (multies.si) land in a shared inbox of the
 * operator workspace (OPERATOR_INBOX_ORG_ID) instead of a forward. Three rules, all from config:
 * 1. A listed address goes to the operator workspace and nowhere else, even if another workspace somehow
 *    holds a row for the domain.
 * 2. Any other address on the company domain is refused as before (no mailbox), with no row written.
 * 3. Only the operator workspace can add the company domain; it is added already verified with no
 *    provider registration (the deployment owns the domain and its DNS, and the provider already has it
 *    for system mail), and the scheduled DNS check leaves it alone.
 * Every other domain, the free address domain (mail.multies.si) included, is routed exactly as before.
 * Live steps: docs/runbooks/support-inbox.md.
 */
import type { AppConfig } from "../../config";
import { conflict } from "../../lib/errors";

export type OperatorConfig = Pick<AppConfig, "operatorInbox">;

export type OperatorDecision =
  | { kind: "operator"; orgId: string; address: string }
  | { kind: "closed"; address: string }
  | null;

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

/** Whether `name` is the company domain (multies.si), whatever the operator settings. */
export function isCompanyDomain(config: OperatorConfig, name: string): boolean {
  const d = config.operatorInbox.domain;
  return !!d && name.trim().toLowerCase().replace(/\.$/, "") === d;
}

/** Whether a domain row is the company domain held by the operator workspace. */
export function isOperatorDomainRow(config: OperatorConfig, row: { orgId: string; name: string }): boolean {
  return !!config.operatorInbox.orgId && row.orgId === config.operatorInbox.orgId && isCompanyDomain(config, row.name);
}

/**
 * Where mail for one recipient may go. Null: not the company domain, or no operator workspace is set,
 * so routing is unchanged. `operator`: deliver only into the operator workspace. `closed`: refuse.
 */
export function operatorDecision(config: OperatorConfig, rcpt: string): OperatorDecision {
  const { orgId, addresses } = config.operatorInbox;
  const address = rcpt.trim().toLowerCase();
  if (!orgId || !isCompanyDomain(config, domainOf(address))) return null;
  return addresses.includes(address) ? { kind: "operator", orgId, address } : { kind: "closed", address };
}

/** PRIV1b (P36): public mail services. Nobody owns these through a workspace; a claim would catch their users' mail. */
export const PUBLIC_MAIL_DOMAINS: readonly string[] = [
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "fastmail.com",
  "hey.com", "tutanota.com", "tuta.com", "qq.com", "163.com", "126.com", "naver.com",
];

/** PRIV1b (P50): the shared row for connected mailboxes; the same value as CONNECTED_DOMAIN in services/connect. */
export const CONNECTED_DOMAIN_NAME = "connected.multies.invalid";
const PLATFORM_ORG_ID = "org_platform";

export type ReservedConfig = OperatorConfig & { freeMail?: { domain?: string }; agents?: { sharedDomain?: string } };

const under = (name: string, d: string) => name === d || name.endsWith(`.${d}`);

/**
 * Refuses reserved names. The company domain: every workspace but the operator's. PRIV1b (P36, P50): public mail
 * services, the platform's shared domains (free addresses, agent inboxes, connected mailboxes) and company subdomains:
 * every workspace (the operator may add other company subdomains). The platform's own rows never come through here.
 */
export function assertDomainAllowed(config: ReservedConfig, orgId: string, name: string): void {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (orgId === PLATFORM_ORG_ID) return;
  const operator = !!config.operatorInbox.orgId && orgId === config.operatorInbox.orgId;
  if (isCompanyDomain(config, n)) {
    if (operator) return;
    throw conflict(`${n} is reserved for the Multies team.`);
  }
  if (PUBLIC_MAIL_DOMAINS.some((d) => under(n, d))) throw conflict(`${n} is a public mail service. Add a domain you own.`);
  const platform = [config.freeMail?.domain, config.agents?.sharedDomain, CONNECTED_DOMAIN_NAME].filter((d): d is string => !!d).map((d) => d.toLowerCase());
  const company = config.operatorInbox.domain;
  if (platform.some((d) => under(n, d)) || (company && !operator && under(n, company))) throw conflict(`${n} is reserved for the Multies team.`);
}
