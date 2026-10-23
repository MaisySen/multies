/** Browser error tracking with the official Sentry SDK. Off unless the server reports a DSN. */
import * as Sentry from "@sentry/react";

let started = false;

export async function startSentry() {
  try {
    const res = await fetch("/api/config", { credentials: "same-origin" });
    const config = (await res.json()) as { sentry: { dsn: string; environment: string } | null };
    if (!config.sentry || started) return;
    Sentry.init({ dsn: config.sentry.dsn, environment: config.sentry.environment, tracesSampleRate: 0 });
    started = true;
  } catch {
    // Error tracking must never break the app.
  }
}

export const sentryEnabled = () => started;

/** Sends one test event and waits for it to leave the browser. Returns the event id. */
export async function sendSentryTest() {
  if (!started) return null;
  const id = Sentry.captureException(new Error(`MyMail web test event (${new Date().toISOString()})`));
  await Sentry.flush(3000);
  return id;
}

export { Sentry };
