import type { AuditEntry, Domain } from "@/web/lib/types";
import { Badge } from "./ui/misc";

export function DomainStatusBadge({ status }: { status: Domain["status"] }) {
  if (status === "verified") return <Badge tone="ok" dot>Verified</Badge>;
  if (status === "failed") return <Badge tone="bad" dot>Needs attention</Badge>;
  return <Badge tone="warn" dot>Pending DNS</Badge>;
}

const ACTIONS: Record<string, string> = {
  "account.created": "created the workspace",
  "auth.login": "signed in",
  "auth.logout": "signed out",
  "auth.password_changed": "changed their password",
  "auth.sessions_revoked": "signed out other devices",
  "domain.added": "added domain",
  "domain.verified": "verified domain",
  "domain.failed": "domain failed verification",
  "domain.pending": "domain is pending",
  "domain.removed": "removed domain",
  "domain.catch_all_changed": "changed catch-all",
  "mailbox.created": "created mailbox",
  "mailbox.updated": "updated mailbox",
  "mailbox.deleted": "deleted mailbox",
  "alias.created": "created alias",
  "alias.updated": "updated alias",
  "alias.deleted": "deleted alias",
  "message.sent": "sent a message",
  "plan.upgraded": "upgraded the plan",
  "plan.downgraded": "changed the plan",
  "workspace.renamed": "renamed the workspace",
  "workspace.region_changed": "changed the time zone or country",
  "inbound_key.created": "created an inbound key",
  "inbound_key.revoked": "revoked an inbound key",
  "demo.workspace_created": "opened a demo workspace",
  "auth.password_reset": "reset their password",
  "auth.2fa_enabled": "turned on two-factor authentication",
  "auth.2fa_disabled": "turned off two-factor authentication",
  "auth.recovery_codes_regenerated": "generated new recovery codes",
  "auth.session_revoked": "signed out a device",
  "auth.login_recovery_code": "signed in with a recovery code",
  "member.invited": "invited",
  "member.invite_resent": "re-sent an invitation to",
  "member.invite_revoked": "revoked the invitation for",
  "member.joined": "joined the workspace",
  "member.updated": "updated access for",
  "member.removed": "removed",
  "member.left": "left the workspace",
  "workspace.created": "created the workspace",
  "workspace.ownership_transferred": "transferred ownership to",
  "app_password.created": "created an app password for",
  "app_password.revoked": "revoked an app password for",
  "api_key.created": "created API key",
  "api_key.deleted": "deleted API key",
  "webhook.created": "added a webhook endpoint",
  "webhook.deleted": "removed a webhook endpoint",
  "suppression.added": "blocked an address",
  "suppression.removed": "unblocked an address",
};

export function describeAudit(e: AuditEntry): { verb: string; object?: string } {
  const m = e.metadata ?? {};
  const object = (m.name ?? m.address ?? m.email ?? (m.to ? `${m.from} → ${m.to}` : undefined)) as string | undefined;
  return { verb: ACTIONS[e.action] ?? e.action.replace(/[._]/g, " "), object };
}
