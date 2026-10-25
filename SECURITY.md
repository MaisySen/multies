# Security policy

Multies holds people's email, chat, tasks and documents, so we take reports seriously and answer them fast.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

- Email **contact@fintex.au** (Fintex Australia Pty Ltd, which provides Multies). It is also the contact in [`/.well-known/security.txt`](https://multies.si/.well-known/security.txt) until security@multies.si is a live mailbox; this page will say when that takes over.
- Or use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability").

Include what you found, where, how to reproduce it, and the impact you expect. A proof of concept helps. Do not include other people's data.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement | 2 business days |
| First assessment and severity (CVSS 4.0) | 5 business days |
| Fix for critical issues | 7 days |
| Fix for high issues | 30 days |
| Fix for medium and low issues | 90 days |

We keep you updated until the fix ships, credit you in the release notes if you want, and tell you before we publish anything.

## Safe harbour

We will not take legal action against research that follows this policy:

- Test only against accounts you own or have permission to use. Sign up for your own workspace.
- Do not read, change or delete other people's data. If you reach any, stop and tell us.
- Do not degrade the service: no denial of service, load tests or spam.
- Give us reasonable time to fix the issue before you disclose it.

## Scope

In scope: the Multies web app, REST API, MCP server and webhooks on its official deployments (multies.si, app.multies.si and the mymail workers.dev hosts), the inbound email worker, the mobile app, and the code in this repository.

Out of scope: findings from automated scanners without a working exploit, missing headers on pages with no sensitive content, self-XSS, clickjacking on pages without actions, rate limits above the documented values, social engineering, and physical attacks. Third-party services (Cloudflare, Stripe, Resend, Auth0, Sentry, LiveKit) and the AI providers that users bring their own keys for have their own programmes.

## Supported versions

| Component | Supported |
| --- | --- |
| Web app and API (multies.si and the official workers.dev hosts) | The current release only: the version on production (see `/api/config`). Fixes ship as a new release, staging first, then production. |
| Inbound email worker | The current release only. |
| Android and iOS apps | The latest store version and the one before it. Older versions keep working but get no fixes. |
| Self-hosted (Docker or Node) | The latest tagged release. Update to it before you report. |

## Disclosure process

1. You report privately to contact@fintex.au.
2. We acknowledge within 2 business days and agree a severity with you (CVSS 4.0).
3. We fix it on a private branch, add a regression test, and deploy within the targets above.
4. We tell you when the fix is live and agree a disclosure date with you, normally within 90 days of your report, or sooner once the fix is deployed.
5. We publish a short advisory in the changelog and credit you if you want.

If a report shows that a secret or customer data may have been exposed, we rotate the secret first and tell affected customers as the law requires.

## How Multies is secured

[docs/security.md](docs/security.md) covers the controls: headers and CSP, CSRF defence, rate limits and lockout, input validation, secrets, encryption at rest, dependency and code scanning, and the ZAP baseline.
