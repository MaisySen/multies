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

/** Refuses the company domain to every workspace but the operator's. */
export function assertDomainAllowed(config: OperatorConfig, orgId: string, name: string): void {
  if (!isCompanyDomain(config, name)) return;
  if (config.operatorInbox.orgId && orgId === config.operatorInbox.orgId) return;
  throw conflict(`${name.trim().toLowerCase()} is reserved for the Multies team.`);
}
