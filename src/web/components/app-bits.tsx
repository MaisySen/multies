import type { AuditEntry, Domain } from "@/web/lib/types";
import { Badge } from "./ui/misc";
import { tr } from "@/web/i18n"; // R104

export function DomainStatusBadge({ status }: { status: Domain["status"] }) {
  if (status === "verified") return <Badge tone="ok" dot>{tr("common.verified")}</Badge>;
  if (status === "failed") return <Badge tone="bad" dot>{tr("common.needs_attention")}</Badge>;
  return <Badge tone="warn" dot>{tr("common.pending_dns")}</Badge>;
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
  "billing.addons_changed": "changed add-ons",
  "billing.addons_synced": "add-ons updated from billing",
  "agent.created": "created agent inbox",
  "agent.updated": "updated agent inbox",
  "agent.deleted": "deleted agent inbox",
  "agent.key_created": "created an agent key",
  "agent.key_revoked": "revoked an agent key",
  "agent.message_read": "read a thread",
  "agent.message_sent": "sent a message",
  "agent.send_queued": "asked to send a message",
  "agent.send_blocked": "was stopped from sending",
  "approval.approved": "approved an agent's message",
  "approval.rejected": "rejected an agent's message",
  "ai.summarized": "summarised a thread with AI",
  "ai.triaged": "triaged a thread with AI",
  "ai.drafted": "drafted a reply with AI",
  "import.started": "started an import",
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
  "workspace.switched": "switched to the workspace",
  "workspace.ownership_transferred": "transferred ownership to",
  "app_password.created": "created an app password for",
  "app_password.revoked": "revoked an app password for",
  "api_key.created": "created API key",
  "api_key.deleted": "deleted API key",
  "webhook.created": "added a webhook endpoint",
  "webhook.deleted": "removed a webhook endpoint",
  "suppression.added": "blocked an address",
  "suppression.removed": "unblocked an address",
  "agent_run.started": "started a run on",
  "agent_run.queued": "queued a run on",
  "agent_run.finished": "finished a run on",
  "agent_run.cancelled": "cancelled a run on", // R30
  "agent_trigger.created": "added the agent trigger",
  "agent_trigger.updated": "edited the agent trigger",
  "agent_trigger.deleted": "deleted the agent trigger",
  "agent_trigger.secret_rotated": "rotated the secret of the agent trigger",
  "agent_trigger.fired": "fired the agent trigger",
  "agent_trigger.refused": "refused to fire the agent trigger",
};

/** R28 (DF-3 slice 3): why a trigger did not fire, in plain words. */
export const TRIGGER_REFUSALS: Record<string, string> = {
  agent_queue_full: "the agent's queue is full",
  agent_paused: "the agent is paused",
  agent_not_member: "the agent was removed",
  run_in_progress: "a run is already active",
  task_missing: "its task was deleted",
  project_missing: "its project is gone",
  // R29: webhook refusals before a fire, sampled at most once every 10 minutes.
  missing_signature: "the request was not signed",
  bad_timestamp: "the timestamp was not unix seconds",
  stale_signature: "the timestamp was more than 5 minutes off",
  bad_signature: "the signature did not match",
  replayed: "the request was a replay",
  trigger_rate_limited: "it fired less than a minute before",
};

/** "approved an agent's message", for one audit action. */
export function auditLabel(action: string) {
  return ACTIONS[action] ?? action.replace(/[._]/g, " ");
}

export function describeAudit(e: AuditEntry): { verb: string; object?: string; subject?: string } {
  const m = e.metadata ?? {};
  // R27 (DF-3 slice 2): "Builder started a run on MB-12", "Olive queued a run on MB-12 for Builder".
  if (e.action.startsWith("agent_run.") && typeof m.taskRef === "string") {
    const verb = ACTIONS[e.action] ?? e.action.replace(/[._]/g, " ");
    const agent = typeof m.agentName === "string" ? m.agentName : "An agent";
    if (e.action === "agent_run.queued") return { verb, object: `${m.taskRef} for ${agent}` };
    const outcome = e.action === "agent_run.finished" && typeof m.status === "string" ? ` (${m.status})` : "";
    return { verb, object: `${m.taskRef}${outcome}`, subject: m.byAgent === false ? undefined : agent };
  }
  // R28 (DF-3 slice 3): "Trigger fired the agent trigger Nightly (MB-12 for Builder)".
  if (e.action.startsWith("agent_trigger.") && typeof m.triggerName === "string") {
    const verb = ACTIONS[e.action] ?? e.action.replace(/[._]/g, " ");
    if (e.action === "agent_trigger.fired" && typeof m.taskRef === "string") return { verb, object: `${m.triggerName} (${m.taskRef} for ${typeof m.agentName === "string" ? m.agentName : "an agent"})` };
    if (e.action === "agent_trigger.refused") return { verb, object: `${m.triggerName}: ${TRIGGER_REFUSALS[String(m.reason)] ?? String(m.reason ?? "refused")}` };
    return { verb, object: m.triggerName };
  }
  // AIS1 (row 15): a thread entry (an agent's read) names the thread by its subject.
  const subject = e.targetType === "thread" && typeof m.subject === "string" && m.subject ? `"${m.subject}"` : undefined;
  const object = (subject ?? m.name ?? m.address ?? m.email ?? (m.to ? `${m.from} → ${m.to}` : undefined)) as string | undefined;
  return { verb: ACTIONS[e.action] ?? e.action.replace(/[._]/g, " "), object };
}

/**
 * Mutes a user or seed colour for display so tags, statuses and project dots stay calm next to the one
 * accent. The stored colour is unchanged.
 */
export function tone(hex: string | null | undefined): string {
  return `color-mix(in srgb, ${hex || "#8e8e93"} 62%, #8e8e93)`;
}
