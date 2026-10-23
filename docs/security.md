# Security

How MyMail protects accounts, mail and keys. The disclosure policy is in [SECURITY.md](../SECURITY.md). Controls map to the OWASP Application Security Verification Standard (ASVS) 4.0, level 2.

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
| `Permissions-Policy` | camera, microphone, geolocation and others off | Nothing in MyMail needs them. |
| `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` | `same-origin` | Process isolation. |

`style-src` allows inline styles because React sets style attributes and email bodies render in a sandboxed `srcdoc` iframe that inherits the page policy. `img-src` allows `https:` so a reader can opt in to remote images; the iframe adds its own policy that blocks them until then. The API reference page (Scalar) has a separate policy that allows its renderer from jsDelivr; it holds no user data.

## CSRF

Review, 2026-10-23:

- Session cookies are `HttpOnly`, `Secure` in production and `SameSite=Lax`, set by Better Auth.
- Every state-changing call under `/api` that uses cookies must be JSON (`content-type: application/json`). A cross-site HTML form cannot send that without a CORS preflight, and MyMail answers no preflights. See `csrfGuard` in `src/server/middleware.ts`.
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

- Secrets live in Cloudflare (`wrangler secret put`) or the host's secret store, never in the repository. CI runs gitleaks on every push to catch a key committed by mistake.
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
