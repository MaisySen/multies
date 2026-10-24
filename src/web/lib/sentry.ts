/**
 * Browser error tracking with the official Sentry SDK. Off unless the server reports a DSN,
 * and loaded only then (it is about a third of the first-load JavaScript otherwise).
 */
type SentryModule = typeof import("@sentry/react");
let sdk: SentryModule | null = null;
const early: unknown[] = [];

export async function startSentry() {
  try {
    const res = await fetch("/api/config", { credentials: "same-origin" });
    const config = (await res.json()) as { sentry: { dsn: string; environment: string; release?: string; tracesSampleRate?: number } | null };
    if (!config.sentry || sdk) return;
    const mod = await import("@sentry/react");
    mod.init({
      dsn: config.sentry.dsn,
      environment: config.sentry.environment,
      release: config.sentry.release,
      // Performance tracing: page loads, navigations and API calls (same origin only).
      integrations: [mod.browserTracingIntegration()],
      tracesSampleRate: config.sentry.tracesSampleRate ?? 0.1,
      tracePropagationTargets: [/^\/api\//],
    });
    sdk = mod;
    for (const err of early.splice(0)) mod.captureException(err);
  } catch {
    // Error tracking must never break the app.
  }
}

export const sentryEnabled = () => !!sdk;

/** Reports an error; errors raised before the SDK loads are queued (up to 10). */
export function captureError(err: unknown) {
  if (sdk) sdk.captureException(err);
  else if (early.length < 10) early.push(err);
}

/** Sends one test event and waits for it to leave the browser. Returns the event id. */
export async function sendSentryTest() {
  if (!sdk) return null;
  const id = sdk.captureException(new Error(`Multies web test event (${new Date().toISOString()})`));
  await sdk.flush(3000);
  return id;
}
