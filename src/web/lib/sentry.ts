/**
 * Browser error tracking with the official Sentry SDK. Off unless the server reports a DSN,
 * and loaded only then (it is about a third of the first-load JavaScript otherwise).
 */
import { sentryPrivacy } from "../../shared/sentry-scrub";
import { shouldHoldBack as slowConnection } from "./prefetch";

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
      ...sentryPrivacy,
    });
    sdk = mod;
    for (const err of early.splice(0)) mod.captureException(err);
  } catch {
    // Error tracking must never break the app.
  }
}

export const sentryEnabled = () => !!sdk;

type Target = Pick<Window, "addEventListener" | "removeEventListener">;

/**
 * R34: errors thrown on the page before the SDK has loaded go into the small queue above and are sent once it
 * starts. The SDK installs its own global handlers when it starts, so these step aside then. Returns a stop function.
 */
export function queueEarlyErrors(target: Target = window): () => void {
  const onError = (e: Event) => captureError((e as ErrorEvent).error ?? new Error((e as ErrorEvent).message || "Script error"));
  const onRejection = (e: Event) => captureError((e as PromiseRejectionEvent).reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/** Errors waiting for the SDK (tests and the admin page read this). */
export const queuedErrorCount = () => early.length;

/**
 * R34: error tracking starts only after the page has loaded and the browser is idle (at most 4 s after load),
 * so its code is never on a page's critical path (sign in was spending 148 KB on it before first paint).
 */
export function scheduleSentry(win: Window & typeof globalThis = window) {
  const stopEarly = queueEarlyErrors(win);
  const start = () => void startSentry().finally(stopEarly);
  const ric = (win as { requestIdleCallback?: Window["requestIdleCallback"] }).requestIdleCallback;
  const now = () => (typeof ric === "function" ? ric.call(win, start, { timeout: 4000 }) : win.setTimeout(start, 1500));
  // R40 (MB-203): on a slow phone network the SDK (about 145 KB) waits 20 s more, so the opened page's data and
  // images come first. Errors in the meantime are queued above and sent once it starts.
  const idle = () => (slowConnection(win.navigator as unknown as Parameters<typeof slowConnection>[0]) ? win.setTimeout(now, 20_000) : now());
  if (win.document.readyState === "complete") idle();
  else win.addEventListener("load", idle, { once: true });
}

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
