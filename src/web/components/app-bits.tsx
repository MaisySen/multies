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
  "inbound_key.created": "created an inbound key",
  "inbound_key.revoked": "revoked an inbound key",
  "demo.workspace_created": "opened a demo workspace",
};

export function describeAudit(e: AuditEntry): { verb: string; object?: string } {
  const m = e.metadata ?? {};
  const object = (m.name ?? m.address ?? (m.to ? `${m.from} → ${m.to}` : undefined)) as string | undefined;
  return { verb: ACTIONS[e.action] ?? e.action.replace(/[._]/g, " "), object };
}
