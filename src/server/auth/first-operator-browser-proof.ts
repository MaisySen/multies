import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import { and, eq } from "drizzle-orm";
import { getOAuthState } from "better-auth/api";
import type { Deps } from "../context";
import { accounts, sessions, users } from "../db/schema";
import { verifyIdToken } from "./tokens";
import { firstOperatorClaimsMatch, firstOperatorSessionMatches, firstOperatorWindow, type FirstOperatorIdentity } from "./first-operator-identity";

// Request-local only. Never store the signed token, raw profile or a callback capability in the browser.
const callbackProof = defineRequestState<FirstOperatorIdentity | null>(() => null);

/**
 * Called solely by the pinned web OAuth callback's account-subject resolver, after provider checks.
 * The nonce is from Better Auth's protected OAuth state, not a request parameter. An ordinary sign-in
 * can still succeed when the additional first-Operator checks do not pass.
 */
export async function captureFirstOperatorBrowserProof(policy: FirstOperatorIdentity, token: string | undefined,
    resolvedSubject: string | number, now: () => number): Promise<void> {
  if (!token || resolvedSubject !== policy.subject || !firstOperatorWindow(policy, now()) || !await hasRequestState()) return;
  try {
    const state = await getOAuthState();
    if (!state || state.link || typeof state.idTokenNonce !== "string" || !state.idTokenNonce) return;
    const domain = new URL(policy.issuer).hostname;
    const claims = await verifyIdToken(token, { domain, audience: policy.audience, nonce: state.idTokenNonce });
    if (firstOperatorClaimsMatch(policy, claims, resolvedSubject, now())) await callbackProof.set(policy);
  } catch { /* No eligibility proof. Do not change the result of the ordinary login. */ }
}

type Issued = Readonly<{ user: { id: string }; session: { id: string; userId: string } }>;

/** Read only. Called from that same successful callback with its newly issued (not incoming) session. */
export async function verifyFirstOperatorBrowserProof(deps: Deps, policy: FirstOperatorIdentity, issued: Issued): Promise<boolean> {
  try {
    if (!await hasRequestState() || await callbackProof.get() !== policy) return false;
    // The exact immutable policy object is held by this auth instance. Consume even on mismatch.
    await callbackProof.set(null);
    if (issued.user.id !== policy.userId || issued.session.userId !== policy.userId || !issued.session.id) return false;
    const row = await deps.db.select({
      userId: users.id, email: users.email, emailVerified: users.emailVerified, banned: users.banned, role: users.role,
      sid: sessions.id, sessionUserId: sessions.userId, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt,
      method: sessions.loginMethod, impersonatedBy: sessions.impersonatedBy,
    }).from(sessions).innerJoin(users, eq(users.id, sessions.userId)).where(and(
      eq(sessions.id, issued.session.id), eq(sessions.userId, policy.userId),
    )).get();
    if (!row || row.banned !== false) return false;
    // Both directions must identify one link. No same email, different subject/account joins.
    const ownLinks = await deps.db.select({subject:accounts.accountId}).from(accounts)
      .where(and(eq(accounts.userId,policy.userId), eq(accounts.providerId,"auth0"))).limit(2).all();
    const owners = await deps.db.select({userId:accounts.userId}).from(accounts)
      .where(and(eq(accounts.accountId,policy.subject), eq(accounts.providerId,"auth0"))).limit(2).all();
    if (owners.length !== 1 || owners[0]?.userId !== policy.userId) return false;
    return firstOperatorSessionMatches(policy, {
      userId:row.userId, email:row.email, emailVerified:row.emailVerified, banned:false,
      role:row.role ?? "", freshlyIssuedSessionId:issued.session.id, authoritativeSessionId:row.sid,
      authoritativeSessionUserId:row.sessionUserId, authoritativeSessionCreatedAt:row.createdAt.getTime(),
      authoritativeSessionExpiresAt:row.expiresAt.getTime(), loginMethod:row.method ?? "",
      impersonatedBy:row.impersonatedBy, currentLinkedSubjects:ownLinks.map(link=>link.subject),
    }, deps.now().getTime());
  } catch { return false; }
}
