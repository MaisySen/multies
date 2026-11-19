import { and, eq, inArray, or } from "drizzle-orm";
import type { Deps } from "../context";
import { operatorAccessAudit as audit } from "../db/schema";
import { firstOperatorWindow, type FirstOperatorIdentity } from "./first-operator-identity";

// One initial grant for the deployment's lifetime. Never rely on an isolate-local first-user check.
const GRANT = "first_operator_v1_initial_grant";
const DISABLE = "first_operator_v1_disable";
const SESSIONS = "first_operator_v1_end_sessions";

/** Non-secret correlation over exactly one release-owner approved identity, never stored raw. */
async function ownerKey(p: FirstOperatorIdentity): Promise<string> {
  const bits = new TextEncoder().encode(JSON.stringify([p.approvalId, p.origin, p.issuer, p.audience, p.userId, p.email, p.subject]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
  return "release-owner:first-operator:" + Array.from(digest,b => b.toString(16).padStart(2,"0")).join("");
}

async function rowsFor(deps: Deps) {
  return await deps.db.select({id:audit.id, owner:audit.actorId, target:audit.targetId, action:audit.action,
    requested:audit.requestedOperator, outcome:audit.outcome, at:audit.requestedAt}).from(audit)
    .where(inArray(audit.id,[GRANT,DISABLE,SESSIONS])).all();
}

/** Must run only after the supported OAuth callback has authenticated the exact ordinary session. */
export async function claimFirstOperatorGrant(deps: Deps, p: FirstOperatorIdentity): Promise<boolean> {
  const now=deps.now();
  if (!firstOperatorWindow(p, now.getTime())) return false;
  const owner=await ownerKey(p);
  const rows=await deps.db.insert(audit).values({id:GRANT, actorId:owner, targetId:p.userId, action:"role_change",
    observedOperator:false, requestedOperator:true, requestedAt:now, outcome:"pending"})
    .onConflictDoNothing().returning({id:audit.id}).all();
  return rows.length === 1 && rows[0]?.id === GRANT;
}

/** Used only after authoritative readback confirms the supported role change. */
export async function finishFirstOperatorGrant(deps: Deps, p: FirstOperatorIdentity): Promise<boolean> {
  const now=deps.now();
  if (!firstOperatorWindow(p,now.getTime())) return false;
  const owner=await ownerKey(p);
  const rows=await rowsFor(deps);
  if (rows.some(r=>r.id !== GRANT)) return false;
  const done=await deps.db.update(audit).set({outcome:"applied",finishedAt:now}).where(and(
    eq(audit.id,GRANT),eq(audit.actorId,owner),eq(audit.targetId,p.userId),eq(audit.outcome,"pending"),
    eq(audit.action,"role_change"),eq(audit.requestedOperator,true),
  )).returning({id:audit.id}).all();
  // A concurrent revocation still takes precedence on every authorization decision.
  return done.length === 1 && !(await rowsFor(deps)).some(r=>r.id !== GRANT);
}

/** A deny gate only. An applied audit record never substitutes for ordinary authentication and the real role. */
export async function firstOperatorNotBlocked(deps: Deps, userId: string): Promise<boolean> {
  try {
    const match=(await rowsFor(deps)).filter(r=>r.target === userId);
    if (match.length === 0) return true;  // Existing Operators are not controlled by the initial grant.
    return match.length === 1 && match[0]?.id === GRANT && match[0].action === "role_change" &&
      match[0].requested === true && match[0].outcome === "applied" && match[0].owner.startsWith("release-owner:first-operator:");
  } catch { return false; }
}

/** Only the deployment owner command can authorise a first cutoff or a separately audited recovery. */
export type FreshGrantRevocation = Readonly<{ priorOwner: string; expectedGrantOutcome?: "pending" | "applied";
  resume?: Readonly<{ cutoffOwner: string; cutoffAtMs: number }> }>;
type FirstCutoff = Readonly<{ auditOwner: string; cutoff: Date; resume?: Readonly<{ id: string; owner: string }> }>;
const FINGERPRINT = /^release-owner:first-operator:[a-f0-9]{64}$/;

export async function recordFirstOperatorCutoff(deps: Deps, p: FirstOperatorIdentity, recovery?: FreshGrantRevocation): Promise<FirstCutoff | null> {
  const now=deps.now();
  if (!firstOperatorWindow(p,now.getTime())) return null;
  const owner=await ownerKey(p), initial=await rowsFor(deps);
  const grant=initial.find(r=>r.id===GRANT);
  if (!grant || grant.target !== p.userId || grant.action !== "role_change" || grant.requested !== true) return null;
  if (recovery) {
    if (grant.outcome !== (recovery.expectedGrantOutcome ?? "pending") || !FINGERPRINT.test(recovery.priorOwner) ||
        recovery.priorOwner !== grant.owner || owner === grant.owner) return null;
  } else if (grant.owner !== owner) return null;
  const pair=(rows:typeof initial, auditOwner:string, at:number)=>{
    const cut=rows.find(r=>r.id===DISABLE), rev=rows.find(r=>r.id===SESSIONS);
    return cut?.owner===auditOwner && cut.target===p.userId && cut.action==="role_change" && cut.requested===false && cut.outcome==="pending" && cut.at.getTime()===at &&
      rev?.owner===auditOwner && rev.target===p.userId && rev.action==="sessions_revoked" && rev.requested===null && rev.outcome==="pending" && rev.at.getTime()===at;
  };
  if (recovery?.resume) {
    const {cutoffOwner,cutoffAtMs}=recovery.resume;
    if (!FINGERPRINT.test(cutoffOwner) || owner===cutoffOwner || !Number.isSafeInteger(cutoffAtMs) || cutoffAtMs<=0 ||
        cutoffAtMs >= p.startsAt || initial.length!==3 || !pair(initial,cutoffOwner,cutoffAtMs)) return null;
    const id="first_operator_v1_resume:"+owner.slice(-64);
    const inserted=await deps.db.insert(audit).values({id,actorId:owner,targetId:p.userId,action:"sessions_revoked",
      observedOperator:grant.outcome==="applied",requestedOperator:null,requestedAt:now,outcome:"pending"}).onConflictDoNothing().returning({id:audit.id}).all();
    // Fresh window is single-use. It never broadens the original session cutoff or replaces any original audit.
    if (inserted.length!==1 || !pair(await rowsFor(deps),cutoffOwner,cutoffAtMs)) return null;
    return {auditOwner:cutoffOwner,cutoff:new Date(cutoffAtMs),resume:{id,owner}};
  }
  if (initial.length!==1) return null;
  const added=await deps.db.insert(audit).values([
    {id:DISABLE,actorId:owner,targetId:p.userId,action:"role_change",observedOperator:grant.outcome==="applied",requestedOperator:false,requestedAt:now,outcome:"pending"},
    {id:SESSIONS,actorId:owner,targetId:p.userId,action:"sessions_revoked",observedOperator:grant.outcome==="applied",requestedOperator:null,requestedAt:now,outcome:"pending"},
  ]).onConflictDoNothing().returning({id:audit.id}).all();
  return added.length===2 && pair(await rowsFor(deps),owner,now.getTime()) ? {auditOwner:owner,cutoff:now} : null;
}

/** Finalise only after authoritative role and bounded session absence checks. */
export async function finishFirstOperatorCutoff(deps: Deps, p: FirstOperatorIdentity, scope:FirstCutoff): Promise<boolean> {
  const now=deps.now();
  if (!firstOperatorWindow(p,now.getTime())) return false;
  const original=and(inArray(audit.id,[DISABLE,SESSIONS]),eq(audit.actorId,scope.auditOwner),eq(audit.requestedAt,scope.cutoff));
  const resume=scope.resume && and(eq(audit.id,scope.resume.id),eq(audit.actorId,scope.resume.owner));
  const rows=await deps.db.update(audit).set({outcome:"applied",finishedAt:now}).where(and(
    resume ? or(original,resume) : original,eq(audit.targetId,p.userId),eq(audit.outcome,"pending"),
  )).returning({id:audit.id}).all();
  return rows.length===(scope.resume?3:2) && rows.some(r=>r.id===DISABLE) && rows.some(r=>r.id===SESSIONS) && (!scope.resume || rows.some(r=>r.id===scope.resume?.id));
}
