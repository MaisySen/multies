# Security policy

Multies holds people's email, chat, tasks and documents, so we take reports seriously and answer them fast.

## Reporting a vulnerability

Please report privately. Do not open a public issue.

- Email **mymail.builder@mail.tab.bot** (the support address today; it is also the contact in [`/.well-known/security.txt`](https://multies.si/.well-known/security.txt)). A dedicated security address on multies.si will replace it once mail on the domain is set up, and this page will say so.
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

Only the latest release is supported: the version on production (see `/api/config`) and the newest mobile app build in the stores. Fixes ship as a new release, staging first, then production.

## How Multies is secured

[docs/security.md](docs/security.md) covers the controls: headers and CSP, CSRF defence, rate limits and lockout, input validation, secrets, encryption at rest, dependency and code scanning, and the ZAP baseline.
