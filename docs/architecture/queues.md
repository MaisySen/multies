# Jobs, retries and dead letters

Work that can fail for reasons outside our control runs through a durable queue in D1
(`src/server/services/jobs.ts`). It works on every runtime (Workers and Node) and on the
free Cloudflare plan, where Cloudflare Queues bindings are not available to every host.

## How it works

- `enqueue(type, payload, { delayMs, maxAttempts, dedupeKey })` writes a row with `run_at`.
- The cron (every 15 minutes in production and on staging, staging 7 minutes later), and a run at most every 10 minutes from live traffic, call `runDueJobs`. It leases due jobs (a lease stops two isolates running the same job), runs the handler, and on failure reschedules with backoff and jitter: 30 seconds, 2 minutes, 10 minutes, 30 minutes, then 1, 2, 4, 8, 12 and 24 hours, about 52 hours in total by default.
- After `maxAttempts` the job becomes **dead**. Dead jobs stay visible in the operator console with their last error and can be replayed one by one or in bulk (`replayJobs`).
- Finished jobs are pruned after 7 days, dead ones after 30.

## Job types

| Type | What | On dead |
| --- | --- | --- |
| `mail.deliver` | An outbound message the provider refused for a retryable reason (rate limit, outage) | A non delivery report lands in the sender's inbox |
| `system-mail.send` | Account emails (verification, reset, receipts) during a provider outage | Logged and reported to Sentry |

## Webhooks

Outbound webhooks keep their own delivery log (`webhook_deliveries`) because customers see it:
retries at 1 minute, 5 minutes, 30 minutes, 2 hours and 6 hours. A delivery that fails every
retry is a dead letter: it stays in the log as `failed` and can be replayed from Settings,
Developers. Five dead deliveries in a row switch the endpoint off and email the workspace owners
and admins, the same policy Stripe and Svix use. A successful delivery resets the count.

## Circuit breaker

Calls to the outbound provider go through a cockatiel circuit breaker with a timeout
(`services/resilience.ts`). When the provider keeps failing the breaker opens, sends queue as
`delayed` without waiting on timeouts, and `/status` shows outbound mail as degraded.
