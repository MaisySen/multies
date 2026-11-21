// Isolated design model only. No production importer, clock, I/O, credential,
// token, expiry, persisted state or access-producing operation is defined here.
// Inputs are unverified facts supplied by a future trusted owner. Matching local
// generations does NOT prove hooks ran, current authority or antirollback.
export type ApprovalLogin = "email" | "auth0" | "google";
export type MemberRole = "owner" | "admin" | "member";
export interface RelationshipFacts {
  readonly subjectUserId: string;
  readonly approvingUserId: string;
  readonly approval: {
    readonly explicitOngoingNetworking: boolean;
    readonly authenticated: boolean;
    readonly impersonated: boolean;
    readonly loginMethod: ApprovalLogin;
    readonly generation: string;
    readonly securityGeneration: string;
  };
  readonly current: {
    readonly factsAvailable: boolean;
    readonly userEligible: boolean;
    readonly humanMembershipEnabled: boolean;
    readonly workspaceEligible: boolean;
    readonly role: MemberRole;
    readonly requireSso: boolean;
    readonly securityEventsEvaluated: boolean;
    readonly securityGeneration: string;
    readonly approvalGeneration: string;
    readonly approvalWithdrawn: boolean;
  };
}
export type EligibilityReason = "invalid-facts" | "facts-unavailable" | "approval-refused" | "security-reapproval-required" | "approval-withdrawn" | "eligibility-unmet" | "sso-reapproval-required" | "eligible-data";
export interface EligibilityData {
  readonly kind: "relationship-eligibility-design-data";
  readonly reason: EligibilityReason;
  readonly eligibleForFurtherEvaluation: boolean;
  readonly derivedSuspended: boolean;
  readonly authorityGranted: false;
}
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";
function valid(f: RelationshipFacts): boolean {
  if (!f || !f.approval || !f.current) return false;
  const a = f.approval, c = f.current;
  return [f.subjectUserId, f.approvingUserId, a.generation, a.securityGeneration, c.approvalGeneration, c.securityGeneration].every(id)
    && [a.explicitOngoingNetworking, a.authenticated, a.impersonated, c.factsAvailable, c.userEligible, c.humanMembershipEnabled, c.workspaceEligible, c.requireSso, c.securityEventsEvaluated, c.approvalWithdrawn].every(bool)
    && ["email", "auth0", "google"].includes(a.loginMethod) && ["owner", "admin", "member"].includes(c.role);
}
function result(reason: EligibilityReason): EligibilityData {
  return Object.freeze({kind: "relationship-eligibility-design-data", reason, eligibleForFurtherEvaluation: reason === "eligible-data", derivedSuspended: reason === "eligibility-unmet" || reason === "sso-reapproval-required", authorityGranted: false});
}
// A positive DATA predicate cannot authenticate the caller, authorize issuance,
// install peers, extend a session or act as a renewal capability.
export function evaluateRelationship(f: RelationshipFacts): EligibilityData {
  if (!valid(f)) return result("invalid-facts");
  const a = f.approval, c = f.current;
  if (!c.factsAvailable) return result("facts-unavailable");
  if (!a.authenticated || a.impersonated || !a.explicitOngoingNetworking || f.subjectUserId !== f.approvingUserId) return result("approval-refused");
  if (!c.securityEventsEvaluated || a.securityGeneration !== c.securityGeneration) return result("security-reapproval-required");
  if (c.approvalWithdrawn || a.generation !== c.approvalGeneration) return result("approval-withdrawn");
  if (!c.userEligible || !c.humanMembershipEnabled || !c.workspaceEligible) return result("eligibility-unmet");
  // Preserve existing Multies owner break-glass semantics as an explicit input
  // role check. Approval must still have been authenticated/non-impersonated.
  if (c.requireSso && c.role !== "owner" && a.loginMethod !== "auth0" && a.loginMethod !== "google") return result("sso-reapproval-required");
  return result("eligible-data");
}

export type RelationshipEvent = "browser-sign-out" | "local-disconnect" | "disable-startup" | "companion-sign-out" | "own-device-revoke" | "password-change" | "password-reset" | "session-compromise" | "credential-compromise" | "security-revoke" | "membership-removed" | "user-banned" | "workspace-suspended" | "workspace-deleted" | "sso-required" | "eligibility-restored" | "source-unavailable";
export interface EventFacts {
  readonly event: RelationshipEvent;
  readonly subjectUserId: string;
  readonly actorUserId: string;
  readonly actorAuthenticated: boolean;
  readonly actorImpersonated: boolean;
  // Independent source-verified event provenance, never inferred from role/name.
  readonly sourceEventVerified: boolean;
  readonly approvalLoginMethod: ApprovalLogin;
  readonly currentRole: MemberRole;
}
export interface EventDesignData {
  readonly kind: "relationship-event-design-data";
  readonly recognizedWithinModel: boolean;
  readonly requirement: "refuse" | "no-change" | "local-stop-only" | "local-preference-only" | "withdraw-approval-and-request-stop" | "deny-new-evaluation-without-revocation" | "recheck-only-no-reapproval";
  readonly requiresNewApprovalGeneration: boolean;
  readonly requiresSecurityGenerationChange: boolean;
  readonly authorityGranted: false;
}
const ownEvents = new Set<RelationshipEvent>(["browser-sign-out", "local-disconnect", "disable-startup", "companion-sign-out", "own-device-revoke"]);
const securityEvents = new Set<RelationshipEvent>(["password-change", "password-reset", "session-compromise", "credential-compromise", "security-revoke"]);
const withdrawalEvents = new Set<RelationshipEvent>(["membership-removed", "user-banned", "workspace-suspended", "workspace-deleted"]);
function eventData(requirement: EventDesignData["requirement"], approval = false, security = false): EventDesignData {
  return Object.freeze({kind: "relationship-event-design-data", recognizedWithinModel: requirement !== "refuse", requirement, requiresNewApprovalGeneration: approval, requiresSecurityGenerationChange: security, authorityGranted: false});
}
// Event requirements only: no state update, hook dispatch or grant decision.
// Security generation is an input/output design obligation, not created storage.
export function relationshipEvent(f: EventFacts): EventDesignData {
  if (!f || !id(f.subjectUserId) || !id(f.actorUserId) || ![f.actorAuthenticated, f.actorImpersonated, f.sourceEventVerified].every(bool)
    || !["email", "auth0", "google"].includes(f.approvalLoginMethod) || !["owner", "admin", "member"].includes(f.currentRole)) return eventData("refuse");
  if (ownEvents.has(f.event)) {
    // No admin/operator exception and no workspace-eligibility prerequisite:
    // own-user revocation is possible after membership loss.
    if (!f.actorAuthenticated || f.actorImpersonated || f.actorUserId !== f.subjectUserId) return eventData("refuse");
    switch (f.event) {
      case "browser-sign-out": return eventData("no-change"); // Proposed logout-independent model only.
      case "local-disconnect": return eventData("local-stop-only");
      case "disable-startup": return eventData("local-preference-only");
      default: return eventData("withdraw-approval-and-request-stop", true);
    }
  }
  if (!f.sourceEventVerified) return eventData("refuse");
  if (securityEvents.has(f.event)) return eventData("withdraw-approval-and-request-stop", true, true);
  if (withdrawalEvents.has(f.event)) return eventData("withdraw-approval-and-request-stop", true);
  if (f.event === "sso-required") return f.currentRole !== "owner" && f.approvalLoginMethod === "email" ? eventData("withdraw-approval-and-request-stop", true) : eventData("no-change");
  if (f.event === "eligibility-restored") return eventData("recheck-only-no-reapproval");
  if (f.event === "source-unavailable") return eventData("deny-new-evaluation-without-revocation");
  return eventData("refuse");
}
