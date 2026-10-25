/**
 * The invitation email. Better Auth's organization plugin sends it for invites made in the app
 * (auth/options.ts); invites made with an API key (POST /api/v1/invites, R25 DF-7) have no
 * session for Better Auth to act on, so services/team.ts sends the same email itself.
 */
import { createElement } from "react";
import type { Deps } from "../context";
import { Invite as InviteEmail } from "../emails";
import { emailBrand, sendSystemEmail } from "./system-mail";

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
  await sendSystemEmail(deps, {
    to: data.email, orgId: data.organization.id,
    subject: `${data.inviter.name} invited you to ${data.organization.name} on ${config.appName}`,
    template: "invite", element: createElement(InviteEmail, {
      brand: emailBrand(deps), inviter: data.inviter.name, inviterEmail: data.inviter.email,
      workspace: data.organization.name, role: data.role, url,
    }),
    text: `${data.inviter.name} (${data.inviter.email}) invited you to join the ${data.organization.name} workspace on ${config.appName} as ${data.role === "admin" ? "an admin" : "a member"}.\n\nThis invitation expires in 7 days.`,
    action: { label: "Accept invitation", url },
  });
}
