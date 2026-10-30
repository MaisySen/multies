# ADR 0007: Auth0 as identity provider

Status: accepted. Date: 24 October 2026.

## Context

Sign in had grown three ways: the app's own email and password form (Better Auth), direct Google
and GitHub buttons, and Auth0 added later as an extra "single sign on" button. Each path had its
own sign up, reset and verification rules, and the mobile app had its own password screen. People
expect one sign in page with passkeys, one time codes, social accounts and second factors, and
businesses expect a standard OIDC setup they can audit.

## Decision

- Auth0 is the identity provider for people, on every client. Its Universal Login is the one sign in
  and sign up page, reached with OIDC Authorization Code and PKCE (state, nonce, issuer, audience and
  expiry checks) through Better Auth's generic OIDC plugin.
- Better Auth keeps owning the Multies session: HttpOnly cookies (Secure in production, SameSite=Lax),
  daily rolling expiry, revocation, workspaces and roles. Provider tokens never become Multies
  credentials.
- Existing accounts link by verified email on first sign in. No provider is trusted by name.
- The app's own password form stays in the code behind AUTH_LOCAL_PASSWORD: off by default once
  Auth0 is configured, on for self host and Node deployments without it (the Stalwart self host).
- The mobile app signs in through the system browser as a public native client with PKCE and trades
  the ID token for a Multies session at /api/auth/mobile/exchange, verified against the provider's JWKS.
- Agents and scripts do not use Auth0. They use personal API keys and MCP tokens: scoped, shown once,
  stored hashed.

## Consequences

- One place for password policy, breached password checks, brute force protection, bot detection,
  passkeys and MFA, configured in the tenant instead of in our code.
- Sign up, reset and verification emails for cloud accounts come from Auth0.
- The Workers bundle stays small: the JWKS client is loaded on first use and cached per isolate.
- A self host without Auth0 behaves as before.
- Production social keys (Google, Apple, Microsoft) and a custom login domain are owner steps; see
  docs/auth.md.
- If Auth0 is ever replaced, only the provider config in src/server/auth/providers.ts and the tenant
  change; sessions, linking and guards stay.
