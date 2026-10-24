import { idpIssuer } from "./config";

/**
 * Verifies an ID token from the identity provider against its published keys (JWKS):
 * RS256 signature, issuer, audience, expiry (60 s clock tolerance) and, when given, nonce.
 * jose is loaded on first use and each JWKS is cached per domain for the life of the
 * isolate, so a cold request that never signs in pays nothing for it.
 */
type RemoteJwks = ReturnType<typeof import("jose").createRemoteJWKSet>;
const jwksCache = new Map<string, RemoteJwks>();

export interface IdTokenClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  nickname?: string;
  picture?: string;
}

export class IdTokenError extends Error {
  constructor(public reason: string, message = "That sign in could not be verified. Please try again.") { super(message); }
}

/** For tests: inject a key set (a local JWKS) instead of fetching the provider's. */
export function setJwksForTests(domain: string, jwks: RemoteJwks | null) {
  if (jwks) jwksCache.set(domain, jwks); else jwksCache.delete(domain);
}

async function jwksFor(domain: string): Promise<RemoteJwks> {
  let ks = jwksCache.get(domain);
  if (!ks) {
    const { createRemoteJWKSet } = await import("jose");
    ks = createRemoteJWKSet(new URL(`${idpIssuer(domain)}.well-known/jwks.json`), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000, timeoutDuration: 5_000 });
    jwksCache.set(domain, ks);
  }
  return ks;
}

export async function verifyIdToken(token: string, opts: { domain: string; audience: string | string[]; nonce?: string }): Promise<IdTokenClaims> {
  if (!token || token.split(".").length !== 3) throw new IdTokenError("malformed");
  const { jwtVerify } = await import("jose");
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, await jwksFor(opts.domain), {
      issuer: idpIssuer(opts.domain),
      audience: opts.audience,
      algorithms: ["RS256"],
      clockTolerance: 60,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch (err) {
    const code = (err as { code?: string }).code ?? "invalid";
    throw new IdTokenError(code === "ERR_JWT_EXPIRED" ? "expired" : code === "ERR_JWT_CLAIM_VALIDATION_FAILED" ? "claims" : "signature");
  }
  if (opts.nonce !== undefined && payload.nonce !== opts.nonce) throw new IdTokenError("nonce");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new IdTokenError("no_email", "Your account has no email address. Add one and try again.");
  return {
    sub: String(payload.sub),
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    nickname: typeof payload.nickname === "string" ? payload.nickname : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}
