type VerifiedOidcClaims = Readonly<{ sub: string; email: string; emailVerified: boolean }>;

/** Approval by the release owner, never from a request or from an identity-provider profile. */
export type FirstOperatorIdentity = Readonly<{
  approvalId: string;
  userId: string;
  email: string;
  subject: string;
  origin: string;
  issuer: string;
  audience: string;
  startsAt: number;
  expiresAt: number;
}>;
export type FirstOperatorDeployment = Readonly<{
  origin: string;
  issuer: string;
  audience: string;
  legacyBootstrapConfigured: boolean;
}>;

const BOUNDED_WINDOW_MS = 20 * 60 * 1000;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/;
// Auth0 can issue its own database subjects or linked Google subjects. This is
// a namespace check only; the caller still verifies the pinned Auth0 issuer,
// app audience, nonce and signature, and both sides of the exact app link.
const AUTH0_LINKED_SUBJECT = /^(?:auth0|google-oauth2)\|[a-zA-Z0-9_-]{1,200}$/;
const EXACT_HTTPS = /^https:\/\/[a-z0-9][a-z0-9.-]*[a-z0-9]$/;

function exactOrigin(s: string): boolean {
  if (!EXACT_HTTPS.test(s) || s.length > 260 || s.includes("..")) return false;
  try { return new URL(s).origin === s; } catch { return false; }
}

export function firstOperatorWindow(p: FirstOperatorIdentity, now: number): boolean {
  return Number.isSafeInteger(now) && p.startsAt <= now && now < p.expiresAt;
}

function instant(raw: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) return NaN;
  const n = Date.parse(raw);
  return Number.isSafeInteger(n) && new Date(n).toISOString() === raw ? n : NaN;
}

/** Fixed version/arity rejects duplicate keys, multiple principals and ambiguous fallback. */
export function firstOperatorIdentity(raw: unknown, deploy: FirstOperatorDeployment, now: number): FirstOperatorIdentity | null {
  if (typeof raw !== "string" || !raw || raw.length > 1200 || deploy.legacyBootstrapConfigured) return null;
  try {
    const fields: unknown = JSON.parse(raw);
    if (!Array.isArray(fields) || fields.length !== 10 || fields.some(x => typeof x !== "string")) return null;
    const [version, approvalId, userId, email, subject, origin, issuer, audience, start, end] = fields as string[];
    if (version !== "v1" || !/^[a-f0-9]{32,64}$/.test(approvalId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId) ||
        email.length > 254 || !EMAIL.test(email) || !AUTH0_LINKED_SUBJECT.test(subject) ||
        !exactOrigin(origin) || origin !== deploy.origin || !issuer.endsWith("/") || !exactOrigin(issuer.slice(0, -1)) ||
        issuer !== deploy.issuer || !/^[a-zA-Z0-9_-]{8,128}$/.test(audience) || audience !== deploy.audience) return null;
    const startsAt = instant(start), expiresAt = instant(end);
    if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= startsAt || expiresAt - startsAt > BOUNDED_WINDOW_MS) return null;
    const policy = Object.freeze({approvalId, userId, email, subject, origin, issuer, audience, startsAt, expiresAt});
    return firstOperatorWindow(policy, now) ? policy : null;
  } catch { return null; }
}

/** Admission check only. Caller obtains claims from the app's pinned issuer, audience, signature and nonce verifier. */
export function firstOperatorClaimsMatch(policy: FirstOperatorIdentity, claims: VerifiedOidcClaims, subject: unknown, now: number): boolean {
  return firstOperatorWindow(policy, now) && subject === policy.subject && claims.sub === policy.subject &&
    claims.email === policy.email && claims.emailVerified === true;
}

export type FirstOperatorOrdinarySession = Readonly<{
  userId: string;
  email: string;
  emailVerified: boolean;
  banned: boolean;
  role: string;
  freshlyIssuedSessionId: string;
  authoritativeSessionId: string;
  authoritativeSessionUserId: string;
  authoritativeSessionExpiresAt: number;
  authoritativeSessionCreatedAt: number;
  loginMethod: string;
  impersonatedBy: string | null;
  currentLinkedSubjects: readonly string[];
}>;

/** Pass only an authoritative session row read at the fresh web callback, not an incoming cookie or workspace role. */
export function firstOperatorSessionMatches(p: FirstOperatorIdentity, s: FirstOperatorOrdinarySession, now: number): boolean {
  return firstOperatorWindow(p, now) && s.userId === p.userId && s.email === p.email && s.emailVerified === true &&
    s.banned === false && s.role === "user" && s.authoritativeSessionUserId === p.userId &&
    !!s.freshlyIssuedSessionId && s.freshlyIssuedSessionId === s.authoritativeSessionId && s.loginMethod === "auth0" &&
    s.impersonatedBy === null && Number.isSafeInteger(s.authoritativeSessionCreatedAt) && Number.isSafeInteger(s.authoritativeSessionExpiresAt) &&
    s.authoritativeSessionCreatedAt >= p.startsAt && s.authoritativeSessionCreatedAt <= now &&
    now - s.authoritativeSessionCreatedAt < 60_000 && s.authoritativeSessionExpiresAt > now &&
    s.currentLinkedSubjects.length === 1 && s.currentLinkedSubjects[0] === p.subject;
}
