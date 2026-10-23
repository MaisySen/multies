/**
 * Graceful degradation for provider calls, built on cockatiel (circuit breaker and
 * timeout policies). When a provider fails repeatedly the breaker opens and calls
 * fail fast for 30 seconds instead of piling up; callers turn that into a queued
 * retry (mail) or a clear "temporarily unavailable" message (billing). The breaker
 * state also feeds the status page.
 */
import { BrokenCircuitError, CircuitState, ConsecutiveBreaker, TaskCancelledError, TimeoutStrategy, circuitBreaker, handleWhen, timeout, wrap } from "cockatiel";
import { OutboundError, type OutboundMessage, type OutboundProvider, type OutboundResult } from "./mail/outbound";

export type Provider = "outbound" | "stripe";

const isTransient = (e: unknown) => e instanceof TaskCancelledError || (e instanceof OutboundError ? e.retryable : !(e instanceof BrokenCircuitError) && isServerSideError(e));

function isServerSideError(e: unknown): boolean {
  const status = (e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status;
  const type = (e as { type?: string })?.type;
  return (typeof status === "number" && status >= 500) || type === "StripeConnectionError" || type === "StripeAPIError" || type === "StripeRateLimitError";
}

const breakers = new Map<Provider, ReturnType<typeof makePolicy>>();

function makePolicy(timeoutMs: number) {
  const breaker = circuitBreaker(handleWhen(isTransient), { halfOpenAfter: 30_000, breaker: new ConsecutiveBreaker(5) });
  return { breaker, policy: wrap(breaker, timeout(timeoutMs, TimeoutStrategy.Aggressive)) };
}

export function providerPolicy(p: Provider) {
  let b = breakers.get(p);
  if (!b) { b = makePolicy(p === "outbound" ? 15_000 : 20_000); breakers.set(p, b); }
  return b;
}

/** "closed" (healthy), "open" (failing fast) or "half-open" (testing recovery). */
export function breakerState(p: Provider): "closed" | "open" | "half-open" {
  const s = breakers.get(p)?.breaker.state;
  return s === CircuitState.Open || s === CircuitState.Isolated ? "open" : s === CircuitState.HalfOpen ? "half-open" : "closed";
}

/** For tests. */
export const resetBreakers = () => breakers.clear();

/** Runs a provider call under its breaker and timeout. Open circuit or timeout: a retryable error. */
export async function guarded<T>(p: Provider, fn: () => Promise<T>): Promise<T> {
  try {
    return await providerPolicy(p).policy.execute(() => fn());
  } catch (e) {
    if (e instanceof BrokenCircuitError) throw new ProviderUnavailableError(p);
    if (e instanceof TaskCancelledError) throw new ProviderUnavailableError(p, "timed out");
    throw e;
  }
}

export class ProviderUnavailableError extends Error {
  readonly retryable = true;
  constructor(public provider: Provider, why = "is not responding") {
    super(`${provider === "outbound" ? "The email provider" : "The billing provider"} ${why}.`);
  }
}

/** The outbound provider behind the breaker. Failures it cannot settle come back as retryable. */
export class ResilientOutbound implements OutboundProvider {
  constructor(private inner: OutboundProvider) {}
  get name() { return this.inner.name; }
  async send(msg: OutboundMessage): Promise<OutboundResult> {
    try {
      return await guarded("outbound", () => this.inner.send(msg));
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw new OutboundError(e.message, true);
      throw e;
    }
  }
}
