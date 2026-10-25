import type { Deps } from "../../context";
import type { OutboundAddress } from "./outbound";
import { QUEUED_PREFIX } from "./provider-domains";

/**
 * Who an outside recipient sees a message from.
 *
 * Normally the mailbox itself. A custom domain still waiting for one of the provider's domain
 * slots (round 17, the domain cap) can't be signed by the provider yet, so its mail goes out from
 * the deployment's shared domain instead, named "<person> via Multies", with the person's own
 * address as Reply-To so replies reach them. Honest, and it keeps the domain usable from day one.
 */
export function outboundIdentity(
  deps: Pick<Deps, "config">,
  mb: { address: string; displayName: string },
  domain: { providerStatus: string | null },
): { from: OutboundAddress; replyTo?: string; relayed: boolean } {
  const shared = deps.config.freeMail.domain;
  if (shared && domain.providerStatus?.startsWith(QUEUED_PREFIX)) {
    return { from: { address: `relay@${shared}`, name: `${mb.displayName || mb.address} via Multies` }, replyTo: mb.address, relayed: true };
  }
  return { from: { address: mb.address, name: mb.displayName }, relayed: false };
}
