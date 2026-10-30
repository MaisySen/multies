# ADR 0005: Run on the Cloudflare free tier

Status: accepted. Date: 23 to 24 October 2026.

## Context

The product is free for startups and has no revenue yet, so hosting must cost nothing until paid add-ons bring money in.

## Decision

Run on Cloudflare's free plan: Workers, D1, Durable Objects with SQLite storage, rate limit
bindings, Email Routing and Web Analytics. No paid add-ons and no card on the account.

## Consequences

- Each request has a 10 ms CPU limit. Heavy routers are built on their first request (lazy loaded), and cron work runs inside per run budgets.
- No R2 without a payment method, so backups use D1 Time Travel and exports.
- Daily request and database limits apply; Sentry and the status page show when we get close.
