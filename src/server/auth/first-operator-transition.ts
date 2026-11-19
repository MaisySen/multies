import { and, eq, or, sql } from "drizzle-orm";
import type { Deps } from "../context";
import { accounts, sessions, users } from "../db/schema";
import { verifyFirstOperatorBrowserProof } from "./first-operator-browser-proof";
import { firstOperatorWindow, type FirstOperatorIdentity } from "./first-operator-identity";
import { claimFirstOperatorGrant, finishFirstOperatorGrant, recordFirstOperatorCutoff, finishFirstOperatorCutoff } from "./first-operator-ledger";
import { idpIssuer } from "./config";

/** The supported Better Auth identity adapter. No direct database update of a user or its sessions. */
type IdentityWriter = Readonly<{
  updateUser(id: string, fields: {role:"admin"|"user"}): Promise<unknown>;
  deleteUserSessions(id: string): Promise<unknown>;
  deleteSession(token: string): Promise<unknown>;
}>;
type Issued = Parameters<typeof verifyFirstOperatorBrowserProof>[2];
type Outcome = "closed" | "applied" | "unconfirmed";

function approvedDeployment(deps: Deps, p: FirstOperatorIdentity) {
  const c=deps.config; const issuer=c.auth.auth0;
  return c.platformAdmins.length === 0 && c.appUrl.replace(/\/$/,"") === p.origin && issuer?.clientId === p.audience &&
    idpIssuer(issuer.domain) === p.issuer && firstOperatorWindow(p,deps.now().getTime());
}

async function exactRole(deps: Deps, p: FirstOperatorIdentity) {
  const person=await deps.db.select({id:users.id,role:users.role}).from(users).where(and(
    eq(users.id,p.userId),eq(users.email,p.email),eq(users.emailVerified,true),eq(users.banned,false),
  )).get();
  if (!person) return null;
  const links=await deps.db.select({user:accounts.userId,subject:accounts.accountId}).from(accounts).where(and(
    eq(accounts.providerId,"auth0"),or(eq(accounts.userId,p.userId),eq(accounts.accountId,p.subject)),
  )).limit(2).all();
  return links.length===1 && links[0]?.user===p.userId && links[0]?.subject===p.subject ? person.role : null;
}

async function hasFullOperator(deps: Deps) {
  const existing=await deps.db.select({id:users.id}).from(users).where(sql`instr(',' || replace(coalesce(${users.role}, ''), ' ', '') || ',', ',admin,') > 0`).limit(1).get();
  return !!existing;
}

/** This operation is available only from the same successful, ordinary browser callback. */
export async function applyFirstOperatorGrant(deps: Deps, p: FirstOperatorIdentity, issued: Issued, writer: IdentityWriter): Promise<Outcome> {
  try {
    if (!approvedDeployment(deps,p) || !await verifyFirstOperatorBrowserProof(deps,p,issued) || await hasFullOperator(deps)) return "closed";
    if (!await claimFirstOperatorGrant(deps,p)) return "closed";
    if (!approvedDeployment(deps,p) || await exactRole(deps,p)!=="user" || await hasFullOperator(deps)) return "unconfirmed";
    // The serving app must deny this tracked role while the durable grant record is pending.
    await writer.updateUser(p.userId,{role:"admin"});
    if (await exactRole(deps,p)!=="admin") return "unconfirmed";
    return await finishFirstOperatorGrant(deps,p) ? "applied" : "unconfirmed";
  } catch { return "unconfirmed"; }
}

/** The caller is a separate deployment-owner command, never an HTTP route, browser or app Operator. */
export async function applyFirstOperatorRecovery(deps: Deps, p: FirstOperatorIdentity, writer: IdentityWriter): Promise<Outcome> {
  try {
    if (!approvedDeployment(deps,p)) return "closed";
    const before=await exactRole(deps,p);
    if (before!=="admin" && before!=="user") return "closed";
    // The single winning recovery may mutate; a duplicate request must never sign fresh sessions out.
    if (await recordFirstOperatorCutoff(deps,p)!=="eligible") return "closed";
    if (!approvedDeployment(deps,p) || await exactRole(deps,p)!==before) return "unconfirmed";
    if (before==="admin") await writer.updateUser(p.userId,{role:"user"});
    if (await exactRole(deps,p)!=="user") return "unconfirmed";
    await writer.deleteUserSessions(p.userId);
    // Also revoke sessions this exact Operator impersonated; never touch other people's regular sessions.
    // A large or interrupted set remains denied and can be reconciled by a new authorised recovery window.
    const outstanding=await deps.db.select({token:sessions.token}).from(sessions).where(eq(sessions.impersonatedBy,p.userId)).limit(32).all();
    for (const s of outstanding) await writer.deleteSession(s.token);
    if (await deps.db.select({id:sessions.id}).from(sessions).where(or(eq(sessions.userId,p.userId),eq(sessions.impersonatedBy,p.userId))).get()) return "unconfirmed";
    return await finishFirstOperatorCutoff(deps,p) ? "applied" : "unconfirmed";
  } catch { return "unconfirmed"; }
}
