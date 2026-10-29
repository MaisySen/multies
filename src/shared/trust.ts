/**
 * The public trust page (/trust). Every statement here was read from this repository's code,
 * config or docs, or from a provider's own documentation, and the comment beside it names the
 * source. When the code changes, change this file in the same commit; tests/trust.test.ts checks
 * the parts that can be checked mechanically (providers wired in config, the database name, the
 * security contact). Claims that could not be verified are left out, not guessed.
 */

export const TRUST_UPDATED = "30 October 2026";
// One public contact for everything (owner approved review, 30 October 2026). security@multies.si also
// routes to the team inbox and stays in security.txt as a second contact.
export const SECURITY_EMAIL = "contact@fintex.au";

export interface TrustFact { label: string; value: string }
export interface Subprocessor {
  name: string;
  purpose: string;
  data: string;
  where: string;
  /** "always" runs for every workspace; "optional" only when a feature or choice turns it on. */
  when: "always" | "optional";
  /** Environment variables in src/server/config.ts that switch this provider on. */
  env: string[];
}

// Source: wrangler.toml ([[d1_databases]] mymail-au, [placement] region aws:ap-southeast-2) and
// CREDENTIALS (staging D1 region Oceania). Cloudflare treats a location as a hint, not a country.
export const DATA_REGION: TrustFact[] = [
  { label: "Database", value: "Our database, primary placed in our hosting provider's Oceania region. Our hosting provider treats this as a location hint and does not promise a country." },
  { label: "App servers", value: "Our app servers run on our hosting provider, placed in Sydney to sit next to the database. Static pages are served from our hosting provider's network worldwide." },
  { label: "Live docs", value: "Co-editing rooms run on our hosting provider, one per doc. The provider chooses where each one runs." },
];

// Source: src/server/config.ts (env vars per provider), wrangler.toml secrets list, docs/auth.md
// (Auth0 tenant in the US region), CREDENTIALS (Sentry and LiveKit US data regions, Resend us-east-1).
export const SUBPROCESSORS: Subprocessor[] = [
  { name: "Our hosting and database provider", purpose: "Hosting, database, live doc rooms, inbound mail routing, DDoS protection", data: "All service data", where: "Oceania for the database; edge worldwide", when: "always", env: [] },
  { name: "Our sign in provider", purpose: "Sign in and sign up for people", data: "Name, email, sign in method, second factor enrolment", where: "United States", when: "always", env: ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET"] },
  { name: "Our outbound email provider", purpose: "Delivers mail you send to addresses outside Multies", data: "Outbound messages and their recipients", where: "United States", when: "always", env: ["RESEND_API_KEY"] },
  { name: "Our error monitoring provider", purpose: "Error and performance monitoring", data: "Error reports with account ids", where: "United States", when: "always", env: ["SENTRY_DSN_API", "SENTRY_DSN_WEB"] },
  { name: "Our payments provider", purpose: "Payments and invoices for paid add ons", data: "Billing contact; card details are held by our payments provider, never by Multies", where: "Australia and United States", when: "always", env: ["STRIPE_SECRET_KEY"] },
  { name: "Our video meetings provider", purpose: "Video meetings, only while a meeting is running", data: "Meeting audio and video, display names", where: "United States", when: "optional", env: ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] },
  { name: "A public DNS resolver", purpose: "Second resolver for DNS lookups when our hosting provider's resolver does not answer (domain checks)", data: "Domain names being checked, no personal data", where: "Worldwide", when: "always", env: [] },
  { name: "Our push notification provider", purpose: "Notifications to the Multies phone apps, only when push notifications are turned on", data: "Device push token and message ids, no message text", where: "United States", when: "optional", env: ["PUSH_ENABLED"] },
  { name: "Your AI provider", purpose: "Only when your workspace adds its own key: the assistant sends the thread you ask about to that provider", data: "The email thread you ask the assistant about", where: "Set by the provider you choose", when: "optional", env: [] },
];

// Source: docs/runbooks/db-backup-restore.md.
export const BACKUPS: TrustFact[] = [
  { label: "Point in time restore", value: "Our database provider's point in time restore can bring the database back to any minute in the last 7 days." },
  { label: "Encrypted exports", value: "Our release runbook takes a full export, encrypted and kept outside the code repository, before any production release that changes the database schema. Every copy is encrypted, and copies older than 30 days are deleted." },
  { label: "Restores", value: "Our restore runbook loads a backup into a new database and checks it before anything touches production." },
];

// Source: docs/auth.md (tenant section), src/server/auth/session.ts, src/server/services/developer/api-keys.ts.
export const SIGN_IN: TrustFact[] = [
  { label: "People", value: "Our sign in provider supports passkeys, password (at least 12 characters, with dictionary and personal data checks), one time email codes, Google, Apple and GitHub." },
  { label: "Two factor", value: "Authenticator app, security keys, email codes and recovery codes. Once you enrol a factor, every sign in asks for it." },
  { label: "Protection", value: "Brute force lockout and suspicious IP throttling at the identity provider, plus rate limits and a sign in lockout in Multies." },
  { label: "Sessions", value: "An HttpOnly, Secure, SameSite=Lax cookie. Sign out on one device or all of them from Account and security." },
  { label: "Agents and scripts", value: "Personal API keys (full or read only) and MCP tokens. Agents never use a person's password." },
];

// Source: src/server/lib/security-headers.ts (HSTS, CSP), src/server/lib/crypto.ts and
// src/server/db/schema.ts (AES-GCM with the app secret), Cloudflare D1 data security docs
// (https://developers.cloudflare.com/d1/reference/data-security/: AES-256 in GCM mode at rest, TLS in transit).
export const ENCRYPTION: TrustFact[] = [
  { label: "In transit", value: "HTTPS only, with HSTS for two years on every subdomain and a strict Content Security Policy. Traffic between our app servers and the database also uses TLS." },
  { label: "At rest", value: "Our database provider encrypts the database with AES-256 (GCM), with keys it manages." },
  { label: "Secrets we hold", value: "DKIM signing keys, webhook secrets, connected app tokens, mail app passwords and your workspace's AI key are encrypted again with AES-GCM under an app secret before they are stored." },
  { label: "Audit log", value: "Sign ins, lockouts, password and key changes and admin actions are written to your workspace's audit log." },
];

export interface Incident { date: string; title: string; impact: string; fix: string }

// Source: worker report 48c68320 (24 Oct 2026) and docs/runbooks/d1-daily-limits.md.
export const INCIDENTS: Incident[] = [
  {
    date: "24 October 2026",
    title: "Sign in unavailable until the daily database limit reset",
    impact: "Test and demo traffic used up the database's free daily write allowance, so the database answered read only and new sign ins failed until the allowance reset at 00:00 UTC. People already signed in could still read their mail.",
    fix: "A daily write guard now watches the count, stops demos and test runs early, and the app shows a read only notice instead of failing.",
  },
];
