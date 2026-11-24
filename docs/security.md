# Security

How Multies protects accounts, mail and keys. The disclosure policy is in [SECURITY.md](../SECURITY.md). Controls map to the OWASP Application Security Verification Standard (ASVS) 4.0, level 2.

## Headers and Content Security Policy

One module, `src/server/lib/security-headers.ts`, builds every security header. The API applies it as middleware, the Worker applies it to the app shell, and a generated `_headers` file applies it to static files served before the Worker runs.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` (app) | `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'` | No inline or third-party script can run. |
| `Content-Security-Policy` (API) | `default-src 'none'` | JSON never renders. |
| `Strict-Transport-Security` | two years, subdomains | HTTPS only. Add `preload` once a custom domain is permanent. |
| `X-Frame-Options` | `DENY` | No framing (clickjacking). |
| `X-Content-Type-Options` | `nosniff` | No MIME sniffing. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | No paths or tokens leak to other sites. |
| `Permissions-Policy` | camera, microphone, geolocation and others off | Nothing in Multies needs them. |
| `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` | `same-origin` | Process isolation. |

`style-src` allows inline styles because React sets style attributes and email bodies render in a sandboxed `srcdoc` iframe that inherits the page policy. `img-src` allows `https:` so a reader can opt in to remote images; the iframe adds its own policy that blocks them until then. The API reference page (Scalar) has a separate policy that allows its renderer from jsDelivr; it holds no user data.

## CSRF

Review, 2026-10-23:

- Session cookies are `HttpOnly`, `Secure` in production and `SameSite=Lax`, set by Better Auth.
- Every state-changing call under `/api` that uses cookies must be JSON: the media type itself must be `application/json` (or `+json`), so `text/plain; x=application/json`, which a page can send without a preflight, is refused. A request with no `Origin` but `Sec-Fetch-Site: cross-site` is refused too. A cross-site HTML form cannot send that without a CORS preflight, and Multies answers no preflights. See `csrfGuard` in `src/server/middleware.ts`.
- When the browser sends `Origin`, it must match the host. Cross-site requests get `403 bad_origin`. The smoke test checks this on every deploy.
- Better Auth checks the request origin against the app URL on its own endpoints.
- Routes that skip the guard never use cookies: signed provider webhooks (`/api/webhooks/*`, `/api/inbound/*`) and the API key REST API (`/api/v1/*`).

## Rate limits and lockout

`src/server/lib/rate-limit.ts` uses [hono-rate-limiter](https://github.com/rhinobase/hono-rate-limiter). On Cloudflare it uses the Workers rate limiting bindings declared in `wrangler.toml`; elsewhere it falls back to a fixed-window counter in the database that every instance shares.

| Scope | Limit | Keyed by |
| --- | --- | --- |
| Sign-in, sign-up, reset, 2FA (`/api/auth/*`) | 30 a minute | IP |
| REST API (`/api/v1/*`) | 600 a minute | API key |
| Provider webhooks and inbound mail | 600 a minute | IP |
| Other app calls | 300 a minute | session |

Better Auth adds tighter per-path limits (10 sign-ins a minute per IP, 5 resets per 15 minutes). On top of that, `src/server/services/lockout.ts` locks password sign-in for an account for 15 minutes after 10 failed attempts in 15 minutes, from any number of IPs, and emails the owner. Password reset and single sign-on keep working, so the real owner is never stuck. Passwords that appear in known breaches are refused (Have I Been Pwned, k-anonymity).

## Input validation

Every request body goes through `parseBody` and every query string through `parseQuery`, both zod schemas, in `src/server/middleware.ts`. The REST API validates with `@hono/zod-openapi`, which also generates the OpenAPI document. Invalid input is a `422 validation_failed` with the failing field named. Email HTML is sanitised with DOMPurify and rendered in a sandboxed iframe that cannot run scripts.

## Secrets and encryption

- Secrets live in Cloudflare (`wrangler secret put`) or the host's secret store, never in the repository. CI and `npm run security` run gitleaks over the whole history, and the pre-commit hook stops a key before it is committed. The round 11 scan (252 commits in the app, 60 in the mobile app) found no secret ever committed.
- Webhook signing secrets, app passwords and similar values are encrypted at rest with a key derived from `APP_SECRET` (AES-GCM, WebCrypto).
- API keys and invite tokens are stored as SHA-256 hashes; the plain key is shown once.
- Rotation for every secret: [security/secrets-rotation.md](security/secrets-rotation.md).

## Idempotency

Mutating REST API calls accept an `Idempotency-Key` header (Stripe semantics): a retry with the same key and body replays the first response, the same key with a different body is a `422`, and a retry while the first call is running is a `409`. The web composer sends one with every message, so a double click or a dropped connection never sends twice.

## Dependency and code scanning

- Dependabot opens weekly grouped updates for npm, GitHub Actions and Docker images, and security updates as soon as an advisory exists (`.github/dependabot.yml`).
- Semgrep (community edition, no account) runs the OWASP Top 10, TypeScript, React, Node and secrets rulesets on every push and fails CI on a finding (`.github/workflows/security.yml`). CodeQL is free only for public repositories, so it switches on when this one is public or has GitHub Advanced Security.
- CI fails when `npm audit` finds a high or critical issue in shipped dependencies, or a critical one anywhere.
- The OWASP ZAP baseline scan runs weekly against the preview and production (`.github/workflows/zap.yml`). Accepted findings and the reason for each are in `.zap/rules.tsv`. The latest results are in [security/zap-baseline.md](security/zap-baseline.md).

## Abuse

Outbound mail gets a rule-based spam score (`src/server/services/abuse.ts`). Suspicious messages are flagged for review, clear spam is held with the reasons shown to the sender, and a new workspace that keeps tripping the filter is suspended automatically. Operators can suspend a workspace and cap its daily sends from the console.

## Threat model

What we protect, from whom, and where it could break.

| Asset | Threats | Main controls |
| --- | --- | --- |
| Mail, chat, tasks, docs and files of each workspace | Another customer reading or changing them by id (IDOR); a guest seeing more than one project | Every query carries the workspace id; guests resolve to one project and see only channels shared with guests; the cross-workspace sweep test |
| Accounts and sessions | Credential stuffing, password guessing, session theft, CSRF | PBKDF2 hashes, breach check, per-IP and per-account limits, lockout, 2FA, HttpOnly Secure SameSite=Lax cookies, JSON-only and same-origin writes |
| API keys and MCP access | A leaked key, a key used outside its scope | Keys stored as SHA-256 hashes and shown once, agent keys scoped to one agent, per-key rate limits, audit entries on create and delete |
| Secrets (signing keys, provider keys) | A secret in the repository, logs or error reports | Secrets only in Cloudflare or the host's secret store, gitleaks over the whole history, encrypted at rest (AES-GCM), Sentry scrubbing |
| The servers and the network behind them | SSRF through webhook URLs, forged or replayed incoming webhooks | Public-address check on save and on every delivery, no redirects followed, signed incoming webhooks with a 5 minute window |
| The browser | XSS in chat, docs, email and templates | No inline script (CSP), React escaping, sanitised email in a sandboxed iframe, safe link targets in docs, downloads with a sandbox CSP |
| Service availability and the free tier budget | Floods, spam, outsized inputs that spend database writes | Rate limits, Turnstile on public forms, daily send caps and the spam score, size caps on bodies, files and stored report rows |

Out of scope for this model: a compromised Cloudflare account or owner device (protected by the provider's 2FA), and physical attacks.

## Authorisation

- Every session route and every `/api/v1` route resolves the caller's workspace first and reads or writes only rows with that workspace id. An id from another workspace is a `404`, the same answer as an id that does not exist, so ids cannot be probed.
- Links between records (a doc linked to a task, a form that files into a project, a task assigned to a person) are checked against the same workspace before they are saved.
- Admin actions need the Better Auth admin role (operator console) or the workspace owner or admin role (members, billing, domains, keys).
- Personal mailboxes (a connected inbox, a claimed free address) open only to their owner and the people the owner shares them with; owners and admins manage people, not their mail. Only the owner suspends, deletes or disconnects one; admins keep its storage quota, and once its owner has left the workspace owner may suspend, delete or disconnect it (PRIV1b P59). A workspace key acts for the workspace, so it never opens its maker's personal mailboxes. An agent's key opens a personal mailbox only when the person who minted it in their own app session owns it, checked on every request, not only when the key was made: a key minted by another admin, a workspace key or a connected AI app never reaches a personal mailbox the agent is given later (Wave 2 review X1, migration 0179). A mailbox made at a member's sign in address is that member's personal mailbox (it gets their password resets), whoever makes it (P37). Migration 0174 converted older ones that nobody else used. A member joining, or changing their sign in address, converts nothing (an admin could otherwise invite a team mailbox's address to capture it, Wave 2 review X3): a team mailbox at a member's sign in address is listed for admins in Settings, Connections, and only the workspace owner, signed in to the app, makes it that member's personal mailbox (`POST /api/mailboxes/:id/make-personal`, audited as `mailbox.made_personal_by_owner`; other people's grants and AI agents' access to it end). Connecting a mailbox through a server Multies doesn't recognise ("Other server", or a known provider with its servers changed) proves nothing about the address, so the connection waits, syncing and sending nothing, until the person enters a code emailed to that address (`POST /api/connections/:id/verify`, a new code with `/verify/resend` once a minute); a waiting connection holds no claim on the address and is removed after 24 hours (P60). No sync pass turns a waiting connection back on, and the code turns its mailbox back on only when the wait is what suspended it, never undoing a suspend made meanwhile (Wave 2 review X5). Gmail, Outlook and the other known providers at their own servers connect at once, as before, when the provider is the address's own (Google Workspace or Microsoft 365 for a company address) and the user name is the address itself (iCloud also takes the name before the @); a different user name, at connect or on Reconnect, waits for the emailed code like an unrecognised server (Wave 2 review X2).
- Guests sign in with a per-guest token, see only their project, and in chat only the channels a member shared with guests.
- MCP tools run with the API key's actor, so they get the same checks as the REST API. An agent key acts only as its own agent.
- `tests/isolation-sweep.test.ts` seeds one workspace, signs up a second with its own API key, and calls every route that takes an id (about 290 routes across the app API and `/api/v1`) and every MCP tool that takes an id with the first workspace's real ids. Any `2xx` or `5xx` fails the test. `tests/authz-matrix.test.ts` calls every route with no session and expects `401`.

## Outgoing and incoming webhooks

- Outgoing webhook URLs must be `https` and point at a public host. `src/server/lib/ssrf.ts` refuses loopback, private, link-local (including cloud metadata), carrier-grade NAT, benchmarking, multicast, IPv4-mapped IPv6, unique-local IPv6 and names such as `localhost`, `*.internal`, `*.local` or a bare intranet name. The check runs when an endpoint is saved and again before every delivery. Redirects are not followed and each attempt times out after 5 seconds.
- Deliveries are signed with the Standard Webhooks scheme (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
- Incoming provider webhooks verify signatures and reject timestamps older than 5 minutes: Resend (Standard Webhooks), Stripe (`Stripe-Signature`) and the inbound mail worker (HMAC over timestamp, envelope and body, with a per-key secret).

## Uploads and downloads

Files are size-checked against the plan's limit before they are stored, and the JSON upload body is capped (14 MB of base64). Every download is `Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` and `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded HTML or SVG file can never run on our origin. A type supplied by a sender is passed on only when it is a plain `type/subtype` token.

## Logging and error reports

- Access logs carry method, route pattern, status, duration and the user and workspace ids. No query strings, bodies or email addresses.
- Sentry (Workers, Node and browser) runs `src/shared/sentry-scrub.ts` on every event: request bodies and cookies are dropped, credential and IP headers are redacted, query values are removed, the user is reduced to an id, and tokens, API keys and email addresses in messages and breadcrumbs are masked. `sendDefaultPii` stays off.
- The audit log records security events: sign-in lockout, password change, two-factor on and off, new backup codes, revoked sessions, email change requests, API key, webhook, inbound key and app password changes, member and role changes, and admin actions. Owners and admins can export it.

## Mobile app

Session tokens live in the iOS Keychain or Android Keystore through `expo-secure-store`, never AsyncStorage. The bundle holds no secrets (only the public API base URL). All API traffic is HTTPS, and Android release builds keep the platform default that blocks cleartext traffic. Deep links (`mymail://`) only open screens inside the app; ids from a link are fetched through the API, which applies the normal checks.

## Running the checks

```
npm run security        # npm audit, gitleaks over history and pending changes, authorisation and isolation tests
npm run hooks:install   # once per clone: a gitleaks pre-commit hook
```

`npm run security` is part of the release checklist. It fails on a high or critical advisory in shipped dependencies, a critical one anywhere, any gitleaks finding, or any authorisation test failure. It runs locally and never touches a deployed host. gitleaks (MIT) is used from `PATH`, or downloaded once from its GitHub release and checked against the published checksum.

## Open items

Tracked from the round 11 audit (2026-10-24):

- Dev only advisories: `@lhci/cli` (Lighthouse CI) pulls in puppeteer, proxy-agent and others with high advisories and no fix short of a major change. It is a developer tool, not shipped. Replace or upgrade it when a fixed release is out.
- `wrangler` and `drizzle-kit` have moderate advisories (miniflare, esbuild) that need a major upgrade. Both are build tools; nothing from them ships in the Worker.
- Mobile: `expo` and `serve` need major upgrades to clear high advisories in `node-forge`, `@expo/cli` and `compression`. These run at build time, not in the app. Plan with the next Expo SDK upgrade.
- PBKDF2-SHA256 runs 100,000 iterations on Cloudflare Workers, the most the Workers runtime allows for PBKDF2 on any plan, so the hosted service can't raise it; OWASP suggests 600,000. A Node server (self host) hashes new passwords at 600,000 and upgrades an older hash after its owner's next successful password sign in (round 2, `upgradePasswordHash` in src/server/auth/options.ts). Hosted hashes stay at 100,000 until the service moves to a hash Workers can run at a stronger setting.
- API keys can be given an end date when they are made (round 2); keys without one never end. They are revocable, hashed and audited.
- Signed webhooks (the Supabase auth hook, Resend events, the Cloudflare Email Worker, TikTok) have a 5 minute timestamp window, and since round 2 each delivery id is kept for 10 minutes (`webhook_receipts`), so a captured request replayed inside the window is answered without running again. Stripe events and agent run hooks dedupe on their own ids; WhatsApp and Messenger on the message id.
- Self-hosted Node behind no proxy: the rate limiter trusts `X-Forwarded-For`. Run it behind a proxy that sets the header, as the self-host guide says.
