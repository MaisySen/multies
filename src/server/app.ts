import { Hono, type Context } from "hono";
import { isD1LimitError, READ_ONLY_BODY } from "./lib/d1-limit";
import { writeBudget } from "./services/write-budget";
import { API_CSP, appCsp, docsCsp, isHttps, securityHeaders } from "./lib/security-headers";
import type { AppEnv, Deps } from "./context";
import { HttpError } from "./lib/errors";
import { clientIp, csrfGuard } from "./middleware";
import { jsonLogger, requestIdFrom } from "./lib/logger";
import { rateLimit } from "./lib/rate-limit";
import { createHash } from "./lib/hash";
import { accountRoutes } from "./routes/account";
import { adminRoutes } from "./routes/admin";
import { authFor } from "./auth";
import { APIError } from "better-auth/api";
import { domainRoutes } from "./routes/domains";
import { aliasRoutes, mailboxRoutes } from "./routes/addresses";
import { orgRoutes } from "./routes/org";
import { mailRoutes } from "./routes/mail";
import { inboundKeyRoutes, inboundWebhookRoutes } from "./routes/inbound";
import { deliveryRoutes } from "./routes/deliveries";
import { dashboardRoutes } from "./routes/dashboard";
import { PLANS } from "@/shared/plans";
import { migrationDriver, pendingMigrations } from "./db";
import { inviteRoutes, teamRoutes } from "./routes/team";
import { billingRoutes, providerWebhookRoutes } from "./routes/billing";
import { mailAccessRoutes } from "./routes/mail-access";
import { developerRoutes } from "./routes/developer";
import { v1ParentVars, v1Routes } from "./routes/v1";
import { agentRoutes, approvalRoutes } from "./routes/agents";
import { aiRoutes } from "./routes/ai";
import { automationRoutes, changeRoutes, companyRoutes, contactRoutes, dealRoutes, docRoutes, notificationRoutes, projectRoutes, pushRoutes, taskRoutes } from "./routes/suite";
import { importRoutes, importRunnerRoutes, integrationRoutes } from "./routes/imports";
import { systemStatus, uptimeHistory } from "./services/status";
import { deliverabilityRoutes, resendWebhookRoutes } from "./routes/deliverability";
import { authHookWebhookRoutes } from "./routes/auth-hooks";
import { formRoutes, meetingRoutes, publicRoutes, reportRoutes, timeRoutes } from "./routes/suite-r7";
import { fieldRoutes, fileRoutes, guestAdminRoutes, guestRoutes, portfolioRoutes } from "./routes/suite-r8";

/** Builds the HTTP API. Runtime-agnostic: Node and Workers entries both call this. */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const notFoundHandler = (c: Context<AppEnv>) => (c.req.path.startsWith("/api/") ? c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404) : c.text("Not found", 404));
  const errorHandler = (err: Error, c: Context<AppEnv>) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof APIError) {
      // Better Auth errors raised from server-side calls (team routes and similar).
      const body = (err.body ?? {}) as { code?: string; message?: string };
      const code = body.code === "PLAN_LIMIT" ? "plan_limit" : (body.code ?? "error").toLowerCase();
      return c.json({ error: { code, message: body.message ?? err.message } }, err.statusCode as 400);
    }
    if (isD1LimitError(err)) {
      console.warn("[api] database daily limit reached", c.req.method, c.req.path);
      // A browser landing on a sign in callback gets the sign in page with the read only notice, not raw JSON.
      if (c.req.method === "GET" && c.req.path.startsWith("/api/auth/") && (c.req.header("accept") ?? "").includes("text/html")) {
        return c.redirect("/login?error=read_only", 302);
      }
      return c.json(READ_ONLY_BODY, 503, { "retry-after": "600" });
    }
    console.error("[api] unhandled", err);
    const eventId = deps.reportError?.(err, { method: c.req.method, path: c.req.path });
    return c.json({ error: { code: "internal", message: "Something went wrong on our side.", ...(eventId ? { details: { eventId } } : {}) } }, 500);
  };

  const rootLog = deps.log ?? jsonLogger({ service: "mymail-api", release: deps.config.release, env: deps.config.sentry.environment });
  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = requestIdFrom(c.req.raw.headers);
    const log = "child" in rootLog ? (rootLog as ReturnType<typeof jsonLogger>).child({ requestId }) : rootLog;
    c.set("deps", deps);
    c.set("ip", clientIp(c));
    c.set("requestId", requestId);
    c.set("log", log);
    await next();
    c.res.headers.set("x-request-id", requestId);
    // One access line per API request. No query strings (they can carry tokens) and no bodies.
    if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health") {
      const status = c.res.status;
      const fields = { method: c.req.method, path: c.req.routePath && c.req.routePath !== "/*" ? c.req.routePath : c.req.path, status, ms: Date.now() - started, user: c.var.auth?.userId, org: c.var.auth?.orgId };
      if (status >= 500) log.error("request", fields); else if (status >= 400) log.warn("request", fields); else log.info("request", fields);
    }
  });
  const hsts = isHttps(deps.config.appUrl);
  const apiHeaders = securityHeaders({ csp: API_CSP, hsts });
  const docsHeaders = securityHeaders({ csp: docsCsp(), hsts });
  // Pages served by this app (the Node server serves the SPA too) get the page policy.
  const pageHeaders = securityHeaders({ csp: appCsp({ analytics: !!deps.config.cfBeaconToken }), hsts });
  const formPageHeaders = securityHeaders({ csp: appCsp({ turnstile: true, analytics: !!deps.config.cfBeaconToken }), hsts });
  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    const set = p === "/api/v1/reference" ? docsHeaders : p.startsWith("/api/") || p.startsWith("/.well-known/") ? apiHeaders : p.startsWith("/f/") ? formPageHeaders : pageHeaders;
    for (const [k, v] of Object.entries(set)) c.res.headers.set(k, v);
  });
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });
  // Rate limits (hono-rate-limiter; a Cloudflare binding when bound, else a shared counter).
  const ipKey = (c: { var: { ip: string } }) => c.var.ip;
  app.use("/api/auth/*", rateLimit("auth", ipKey));
  app.use("/api/webhooks/*", rateLimit("webhooks", ipKey));
  app.use("/api/inbound/*", rateLimit("webhooks", ipKey));
  app.use("/api/v1/*", rateLimit("api", (c) => createHash(c.req.header("authorization") ?? c.var.ip), { countReads: true }));
  const appLimiter = rateLimit("app", (c) => c.req.header("cookie")?.match(/mymail\.session_token=([^;.]+)/)?.[1]?.slice(0, 24) ?? c.var.ip);
  app.use("/api/*", async (c, next) => {
    const p = c.req.path;
    if (p.startsWith("/api/auth/") || p.startsWith("/api/webhooks/") || p.startsWith("/api/inbound/") || p.startsWith("/api/v1/") || p.startsWith("/api/import-runner/")) return next();
    // Incoming hooks and the booking page limit themselves in memory, so a public call costs no limiter write.
    if (p.startsWith("/api/hooks/in/") || p.startsWith("/api/book/")) return next();
    return appLimiter(c, next);
  });
  app.use("/api/*", async (c, next) => {
    // Signed webhooks, the API-key REST API and the import runner (token) never use cookies, so CSRF does not apply.
    const p = c.req.path;
    if (p.startsWith("/api/inbound/") || p.startsWith("/api/webhooks/") || p.startsWith("/api/v1/") || p.startsWith("/api/import-runner/") || p.startsWith("/api/hooks/in/")) return next();
    return csrfGuard(c, next);
  });

  // Staging (WRITE_BUDGET_GUARD=strict) shares production's daily D1 write budget, so once the account
  // passes the warn level its API refuses writes with the same read only answer a D1 limit gives.
  // Production never refuses here; it only stops optional writers (services/write-budget.ts).
  if (deps.config.writeBudget.strict) {
    app.use("/api/*", async (c, next) => {
      if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS" || c.req.path === "/api/health") return next();
      const r = await writeBudget(deps);
      if (r.level === "warn" || r.level === "shed") return c.json(READ_ONLY_BODY, 503, { "retry-after": "3600" });
      return next();
    });
  }

  // Health: the database must be reachable and fully migrated (migrations run at deploy time).
  let schemaCurrent = false;
  app.get("/api/health", async (c) => {
    try {
      if (!schemaCurrent) {
        const pending = await pendingMigrations(migrationDriver((deps.db as unknown as { $client: unknown }).$client));
        // Pending migrations are a deploy step not yet run, not an outage: answer 200 and say so, so
        // uptime checks page only when the database itself fails. Deploy checks read `db`.
        if (pending.length) return c.json({ ok: true, degraded: true, mode: deps.config.mode, db: "migrations_pending", pending, release: deps.config.release });
        schemaCurrent = true;
      }
      // The account's D1 writes today (cached five minutes per isolate; absent when the guard is off).
      const wb = await writeBudget(deps);
      return c.json({ ok: true, mode: deps.config.mode, db: "ok", release: deps.config.release, ...(wb.level !== "off" ? { writes: { today: wb.rowsWritten, budget: wb.budget, level: wb.level, at: wb.at } } : {}) });
    } catch {
      return c.json({ ok: false, mode: deps.config.mode, db: "unreachable" }, 503);
    }
  });
  // RFC 9116: where to report a vulnerability.
  app.get("/.well-known/security.txt", (c) => {
    const expires = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)).toISOString();
    c.header("cache-control", "public, max-age=86400");
    return c.text([
      `Contact: ${deps.config.securityContact}`,
      `Expires: ${expires}`,
      "Preferred-Languages: en",
      `Canonical: ${deps.config.appUrl}/.well-known/security.txt`,
      `Policy: ${deps.config.appUrl}/security`,
      "",
    ].join("\n"));
  });
  app.get("/api/status", async (c) => {
    const [body, history] = await Promise.all([systemStatus(deps), uptimeHistory(deps).catch(() => null)]);
    c.header("cache-control", "public, max-age=30");
    return c.json({ ...body, history }, body.overall === "down" ? 503 : 200);
  });
  app.get("/api/config", (c) =>
    c.json({
      appName: deps.config.appName,
      mode: deps.config.mode,
      release: deps.config.release,
      cfBeaconToken: deps.config.cfBeaconToken,
      demoEnabled: deps.config.demoEnabled,
      supportEmail: deps.config.supportEmail,
      outboundDriver: deps.outbound.name,
      billingEnabled: deps.config.billing.enabled,
      mxHosts: deps.config.mail.mxHosts,
      plans: Object.values(PLANS),
      meetings: !!deps.config.meetings,
      scheduling: deps.config.schedulingEnabled,
      // A browser DSN is public by design (it can only submit events).
      sentry: deps.config.sentry.dsnWeb
        ? { dsn: deps.config.sentry.dsnWeb, environment: deps.config.sentry.environment, release: deps.config.release, tracesSampleRate: deps.config.sentry.tracesSampleRate }
        : null,
    }),
  );

  app.route("/api/account", accountRoutes());
  app.route("/api/admin", adminRoutes());
  // Better Auth: sign-up/in, sessions, 2FA, password reset, verification, organizations, OAuth.
  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(deps).handler(c.req.raw));
  app.route("/api/domains", domainRoutes());
  app.route("/api/mailboxes", mailboxRoutes());
  app.route("/api/aliases", aliasRoutes());
  app.route("/api/org", orgRoutes());
  app.route("/api/mail", mailRoutes());
  app.route("/api/deliveries", deliveryRoutes());
  app.route("/api/dashboard", dashboardRoutes());
  app.route("/api/team", teamRoutes());
  app.route("/api/invites", inviteRoutes());
  app.route("/api/billing", billingRoutes());
  app.route("/api/mail-access", mailAccessRoutes());
  app.route("/api/developer", developerRoutes());
  app.route("/api/agents", agentRoutes());
  app.route("/api/approvals", approvalRoutes());
  app.route("/api/ai", aiRoutes());
  app.route("/api/projects", projectRoutes());
  app.route("/api/tasks", taskRoutes());
  app.route("/api/docs", docRoutes());
  app.route("/api/contacts", contactRoutes());
  app.route("/api/companies", companyRoutes());
  app.route("/api/deals", dealRoutes());
  app.route("/api/automations", automationRoutes());
  app.route("/api/notifications", notificationRoutes());
  app.route("/api/push", pushRoutes());
  app.route("/api/changes", changeRoutes());
  app.route("/api/time", timeRoutes());
  app.route("/api/forms", formRoutes());
  app.route("/api/reports", reportRoutes());
  app.route("/api/meetings", meetingRoutes());
  app.route("/api/public", publicRoutes());
  app.route("/api/fields", fieldRoutes());
  app.route("/api/portfolio", portfolioRoutes());
  app.route("/api/guests", guestAdminRoutes());
  app.route("/api/files", fileRoutes());
  app.route("/api/guest", guestRoutes());
  app.route("/api/imports", importRoutes());
  app.route("/api/import-runner", importRunnerRoutes());
  app.route("/api/integrations", integrationRoutes());
  // The public API is the biggest part of the app to build (about 150 OpenAPI routes, roughly
  // 10 ms of CPU), so it is built the first time an /api/v1 request arrives rather than on
  // every new isolate. On the Workers Free plan the first request of an isolate pays for
  // the build, and with it every API call there went over the 10 ms CPU limit and was
  // answered 503 with an empty body (round 8 and 9 load tests).
  let v1: ReturnType<typeof v1Routes> | undefined;
  const v1Handler = (c: Context<AppEnv>) => {
    if (!v1) {
      v1 = v1Routes();
      v1.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));
      v1.onError(errorHandler);
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice("/api/v1".length) || "/";
    const req = new Request(url, c.req.raw);
    v1ParentVars.set(req, { deps: c.var.deps, ip: c.var.ip, requestId: c.var.requestId, log: c.var.log });
    let ctx: Parameters<ReturnType<typeof v1Routes>["fetch"]>[2];
    try { ctx = c.executionCtx; } catch { ctx = undefined; }
    return v1.fetch(req, c.env, ctx);
  };
  // Round 10 (chat, templates, goals, guest chat) is built on its first request too, for the same reason.
  type R10 = import("hono").Hono<AppEnv>;
  let r10: R10 | undefined;
  const r10Vars = new WeakMap<Request, { deps: Deps; ip: string; requestId: string; log: AppEnv["Variables"]["log"] }>();
  const r10Handler = async (c: Context<AppEnv>) => {
    if (!r10) {
      const { r10Routes } = await import("./routes/suite-r10");
      r10 = r10Routes(r10Vars) as unknown as R10;
      r10.notFound(notFoundHandler);
      r10.onError(errorHandler);
    }
    r10Vars.set(c.req.raw, { deps: c.var.deps, ip: c.var.ip, requestId: c.var.requestId, log: c.var.log });
    let ctx: Parameters<R10["fetch"]>[2];
    try { ctx = c.executionCtx; } catch { ctx = undefined; }
    return r10.fetch(c.req.raw, c.env, ctx);
  };
  for (const prefix of ["/api/chat", "/api/templates", "/api/goals", "/api/key-results", "/api/guest/chat"]) {
    app.all(prefix, r10Handler);
    app.all(`${prefix}/*`, r10Handler);
  }
  // Round 11 (integrations, incoming hooks, scheduling and the booking page), lazily for the same reason.
  let r11: R10 | undefined;
  const r11Vars = new WeakMap<Request, { deps: Deps; ip: string; requestId: string; log: AppEnv["Variables"]["log"] }>();
  const r11Handler = async (c: Context<AppEnv>) => {
    if (!r11) {
      const { r11Routes } = await import("./routes/suite-r11");
      r11 = r11Routes(r11Vars) as unknown as R10;
      r11.notFound(notFoundHandler);
      r11.onError(errorHandler);
    }
    r11Vars.set(c.req.raw, { deps: c.var.deps, ip: c.var.ip, requestId: c.var.requestId, log: c.var.log });
    let ctx: Parameters<R10["fetch"]>[2];
    try { ctx = c.executionCtx; } catch { ctx = undefined; }
    return r11.fetch(c.req.raw, c.env, ctx);
  };
  for (const prefix of ["/api/connectors", "/api/incoming-hooks", "/api/hooks/in", "/api/scheduling", "/api/book"]) {
    app.all(prefix, r11Handler);
    app.all(`${prefix}/*`, r11Handler);
  }
  app.all("/api/v1", v1Handler);
  app.all("/api/v1/*", v1Handler);
  app.route("/api/webhooks/resend", resendWebhookRoutes());
  app.route("/api/auth-hooks", authHookWebhookRoutes());
  app.route("/api/webhooks", providerWebhookRoutes());
  app.route("/api/deliverability", deliverabilityRoutes());
  app.route("/api/inbound-keys", inboundKeyRoutes());
  app.route("/api/inbound", inboundWebhookRoutes());

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return app;
}

export type App = ReturnType<typeof createApp>;
