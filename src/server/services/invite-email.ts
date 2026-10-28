/**
 * The invitation email. Better Auth's organization plugin sends it for invites made in the app
 * (auth/options.ts); invites made with an API key (POST /api/v1/invites, R25 DF-7) have no
 * session for Better Auth to act on, so services/team.ts sends the same email itself.
 */
import { createElement } from "react";
import type { Deps } from "../context";
// R53 (cold start): the template loads on the first invite sent, not at isolate startup.
import { emailBrand, sendSystemEmail, type SystemEmailResult } from "./system-mail";

/* R41 (MB-228): what the last send of each invitation answered, so POST /api/team/invites can say the truth
 * (emailed only when the email really went out) instead of guessing from the deployment. Kept per isolate for
 * a minute; the request that created the invite reads it straight after. */
const lastSend = new Map<string, { r: SystemEmailResult; at: number }>();
export function takeInviteSend(id: string) {
  const v = lastSend.get(id);
  lastSend.delete(id);
  return v && Date.now() - v.at < 60_000 ? v.r : undefined;
}

export interface InviteEmailData {
  id: string;
  email: string;
  role: string;
  organization: { id: string; name: string };
  inviter: { name: string; email: string };
}

export async function sendInviteEmail(deps: Deps, data: InviteEmailData) {
  const { config } = deps;
  const url = `${config.appUrl}/invite/${data.id}`;
  const r = await sendSystemEmail(deps, {
    to: data.email, orgId: data.organization.id,
    subject: `${data.inviter.name} invited you to ${data.organization.name} on ${config.appName}`,
    template: "invite", element: createElement((await import("../emails")).Invite, {
      brand: emailBrand(deps), inviter: data.inviter.name, inviterEmail: data.inviter.email,
      workspace: data.organization.name, role: data.role, url,
    }),
    text: `${data.inviter.name} (${data.inviter.email}) invited you to join the ${data.organization.name} workspace on ${config.appName} as ${data.role === "admin" ? "an admin" : "a member"}.\n\nThis invitation expires in 7 days.`,
    action: { label: "Accept invitation", url },
  });
  if (lastSend.size > 200) lastSend.clear();
  lastSend.set(data.id, { r, at: Date.now() });
  return r;
}
