# Service level objectives

What we promise ourselves, how we measure it, and what happens when we miss. Targets are monthly
(calendar month, UTC).

| Service level indicator (SLI) | How it is measured | Objective (SLO) | Error budget per month |
| --- | --- | --- | --- |
| API availability | Share of `/api/*` requests that do not answer 5xx, from Workers analytics | 99.9% | 43 minutes of full outage |
| Health check | `/api/health` answers 200, recorded every 5 minutes by the cron and shown as the 90 day strip on `/status` | 99.9% | 9 failed checks |
| Inbound mail | Messages accepted by Email Routing and stored, from the delivery log | 99.9% delivered within 2 minutes | 1 in 1,000 late |
| Outbound mail | Sends handed to the provider within 60 seconds, including retries from the job queue | 99.5% | 1 in 200 delayed |
| API latency | p95 of `/api/v1/*` from Sentry tracing | under 400 ms | |
| Webmail | Largest Contentful Paint p75 from Sentry browser tracing, Lighthouse CI budget on every change | under 2.5 s | |
| Webhooks | Deliveries that succeed within 9 hours (receiver permitting) | 99% | |

## Alerting

- Sentry issue alerts email the team on any new error type in production.
- The cross check (`services/status.ts`): production and staging probe each other's `/api/health` every cron run and raise a Sentry issue after 2 failures in a row (one blip during a deploy stays quiet), once per outage.
- The status page shows component state live (database, outbound mail breaker, job queue backlog, inbound pipeline).
- External: point a free uptime monitor (for example UptimeRobot or Better Stack) at `/api/health` once production has its custom domain, so an outage of the whole Cloudflare account is noticed from outside it.

## When the budget runs out

1. Freeze feature releases; only reliability fixes ship until the month resets or the cause is fixed.
2. Write a postmortem for each incident that spent more than a quarter of the budget ([incident-response.md](runbooks/incident-response.md)).
3. Review the objective itself each quarter: an SLO nobody misses is too loose, one we always miss is wrong.
