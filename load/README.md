# Load test

`load/smoke.js` is a [k6](https://k6.io) script with two scenarios that run together for 90 seconds:

- **browse**: up to 10 virtual users load the landing page, the status API and the health check, with 2 to 4 seconds of think time between page views.
- **api**: 5 requests a second to `GET /api/v1/domains` with a read only API key.

It fails when more than 1% of requests fail, when fewer than 99% of checks pass, or when the 95th percentile latency goes over 800 ms for browse or 500 ms for the API.

## Running it

Run it against staging, never production. The staging load test account and its read only key are in the credentials file under "Staging load test account".

```bash
BASE_URL=https://mymail-staging.mymail-app.workers.dev K6_API_KEY=mm_live_... k6 run load/smoke.js
```

Rate limits are per client IP (300 app requests and 600 API requests a minute), so one machine measures latency and errors, not maximum throughput. A throughput test needs several source IPs or a staging build with higher limits.

## Baseline, 23 October 2026

Staging on Cloudflare Workers, database in the Oceania region (Sydney). k6 1.3.0 ran from a machine in the US west, so every database query crossed the Pacific. Visitors in Australia will see lower numbers.

| Run | Requests | Failed | Browse p95 | API median | API p95 |
| --- | --- | --- | --- | --- | --- |
| Before the API fix (release 7dd951c94125) | 1,112 | 0 | 549 ms | 1,440 ms | 1,620 ms |
| After the API fix (release 458de402f38a) | 1,131 | 0 | 453 ms | 343 ms | 396 ms |

The first run broke the API threshold. Two causes, both fixed in `perf(api)`:

1. Hono matches `/domains/*` for `/domains` too, so the API key check ran twice on every collection request.
2. The key, its creator's membership and the workspace's suspension state were three queries in a row. They are now one query, and the domain list runs its three reads in parallel.

Server side time for `GET /api/v1/domains`, read from the Worker's request logs, went from about 1.3 s to about 300 ms. Almost all of what is left is two round trips from a US edge to the database in Sydney.

## When to run it

- Before a release that changes the API layer, auth or database access.
- After changing rate limits or Worker placement.

Record new numbers in the table above with the release they were taken on.
