import { and, eq, inArray } from "drizzle-orm";
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
    requested:audit.requestedOperator, outcome:audit.outcome}).from(audit)
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

/**
 * Only for a separate authorised deployment-owner recovery operation, with grant config no longer serving.
 * An audit lock is written before any revocation. Denial remains even when role/session cleanup needs retry.
 */
export async function recordFirstOperatorCutoff(deps: Deps, p: FirstOperatorIdentity): Promise<"closed" | "eligible" | "already-recorded"> {
  const now=deps.now();
  if (!firstOperatorWindow(p,now.getTime())) return "closed";
  const owner=await ownerKey(p);
  const initial=await rowsFor(deps);
  const grant=initial.find(r=>r.id===GRANT);
  if (!grant || grant.owner !== owner || grant.target !== p.userId || grant.action !== "role_change" || grant.requested !== true) return "closed";
  const matches=(rows:typeof initial)=>{
    const cut=rows.find(r=>r.id===DISABLE), sessions=rows.find(r=>r.id===SESSIONS);
    return cut?.owner===owner && cut.target===p.userId && cut.action==="role_change" && cut.requested===false &&
      sessions?.owner===owner && sessions.target===p.userId && sessions.action==="sessions_revoked" && sessions.requested===null;
  };
  if (initial.length!==1) return matches(initial) ? "already-recorded" : "closed";
  const added=await deps.db.insert(audit).values([
    {id:DISABLE,actorId:owner,targetId:p.userId,action:"role_change",observedOperator:grant.outcome==="applied",requestedOperator:false,requestedAt:now,outcome:"pending"},
    {id:SESSIONS,actorId:owner,targetId:p.userId,action:"sessions_revoked",observedOperator:grant.outcome==="applied",requestedOperator:null,requestedAt:now,outcome:"pending"},
  ]).onConflictDoNothing().returning({id:audit.id}).all();
  if (!matches(await rowsFor(deps))) return "closed";
  return added.length === 2 ? "eligible" : "already-recorded";
}

/** Marks only this approval after authoritative confirmation of role and session cleanup. */
export async function finishFirstOperatorCutoff(deps: Deps, p: FirstOperatorIdentity): Promise<boolean> {
  const now=deps.now();
  if (!firstOperatorWindow(p,now.getTime())) return false;
  const owner=await ownerKey(p);
  await deps.db.update(audit).set({outcome:"applied",finishedAt:now}).where(and(
    inArray(audit.id,[DISABLE,SESSIONS]),eq(audit.actorId,owner),eq(audit.targetId,p.userId),eq(audit.outcome,"pending"),
  ));
  const rows=(await rowsFor(deps)).filter(r=>r.id!==GRANT);
  return rows.length===2 && rows.every(r=>r.owner===owner && r.target===p.userId && r.outcome==="applied");
}
