/**
 * R43 (MB-199): error reporting without a per request wrapper.
 *
 * Until R42 every request and cron run went through the reporting SDK's request wrapper. Its init, isolation scope
 * and request span cost about 17 ms of CPU on the first request of each new isolate and about 0.8 ms on every warm
 * request, with tracing already off (files/multies-r43/cpu-first-pass.md). Now our own try/catch in worker.ts does the
 * job, and the reporting client is created lazily, with the real address, only when there is something to report:
 *  - deps.reportError (the API's error handler, the cron, background jobs) calls reportException here;
 *  - an error that escapes a request or a cron run is caught in worker.ts and reported here too.
 * The client is never created at startup or by the startup warm up (the R42 incident: a client created early keeps
 * the address it saw first). Events are sent when flushReporting runs inside ctx.waitUntil. No tracing, no request
 * spans: errors only, through the same privacy scrubber as before.
 */
import { CloudflareClient, getDefaultIntegrations, setCurrentClient, getCurrentScope, createTransport, withScope, captureException } from "@sentry/cloudflare";
import { createStackParser, getIntegrationsToSetup } from "@sentry/core";
import { nodeStackLineParser } from "@sentry/core/server";
import { sentryPrivacy } from "../shared/sentry-scrub";

export interface ReportingEnv { dsn?: string; environment?: string; release?: string }

let client: CloudflareClient | null = null;
let settings: ReportingEnv = {};
let created = 0;

/** Called once per request with the worker's settings; cheap (no SDK work). */
export function configureReporting(env: ReportingEnv) {
  settings = env;
}

/** Whether a reporting client exists in this isolate (the first request log reads this). */
export function reportingClientExists() {
  return client !== null;
}

/** How many clients this isolate created (always 0 or 1; tests read it). */
export function reportingClientsCreated() {
  return created;
}

function stackParser() {
  const [order, parse] = nodeStackLineParser();
  return createStackParser([order, (line: string) => {
    const frame = parse(line);
    if (frame && frame.filename !== undefined) { frame.in_app = true; if (!frame.filename.startsWith("/")) frame.abs_path = `/${frame.filename}`; }
    return frame;
  }]);
}

/** The client, created on first use with the real address. Null when no address is set (reporting off). */
export function reportingClient(): CloudflareClient | null {
  if (client) return client;
  if (!settings.dsn) return null;
  const options = {
    dsn: settings.dsn,
    environment: settings.environment ?? "production",
    release: settings.release,
    // Errors only. sendDefaultPii stays off; the scrubber runs on every event.
    beforeSend: sentryPrivacy.beforeSend,
    stackParser: stackParser(),
    integrations: [] as ReturnType<typeof getDefaultIntegrations>,
    transport: (o: Parameters<typeof createTransport>[0] & { url: string; headers?: Record<string, string> }) =>
      createTransport(o, (req) => fetch(o.url, { method: "POST", body: req.body as BodyInit, headers: o.headers }).then(async (res) => {
        try { await res.text(); } catch { /* the body is not needed */ }
        return { statusCode: res.status, headers: { "x-sentry-rate-limits": res.headers.get("X-Sentry-Rate-Limits"), "retry-after": res.headers.get("Retry-After") } };
      })),
  };
  // The SDK's own defaults minus the ones that wrap fetch or the console (we only send errors we hand it).
  const keep = new Set(["Dedupe", "EventFilters", "FunctionToString", "LinkedErrors"]);
  options.integrations = getIntegrationsToSetup({ defaultIntegrations: getDefaultIntegrations(options as never).filter((i) => keep.has(i.name)) } as never) as never;
  const c = new CloudflareClient(options as never);
  setCurrentClient(c);
  getCurrentScope().setClient(c);
  c.init();
  client = c;
  created++;
  return c;
}

/** Reports one error; answers the event id, or undefined when reporting is off. */
export function reportException(err: unknown, context?: Record<string, unknown>): string | undefined {
  try {
    if (!reportingClient()) return undefined;
    // A report about another environment (an uptime cross check) carries that environment, not this worker's.
    const about = typeof context?.environment === "string" ? context.environment : null;
    if (!about) return captureException(err, { extra: context });
    return withScope((scope) => {
      scope.addEventProcessor((e) => ({ ...e, environment: about }));
      scope.setTag("reported_by", settings.environment ?? "production");
      return captureException(err, { extra: context });
    });
  } catch {
    return undefined; // reporting is never in the way
  }
}

/** Sends what is queued; call inside ctx.waitUntil. A no-op until the client exists. */
export function flushReporting(timeoutMs = 2000): Promise<unknown> {
  return client ? client.flush(timeoutMs).catch(() => false) : Promise.resolve(true);
}

/** Tests only. */
export function resetReportingForTests() {
  client = null; settings = {}; created = 0;
}
