import { Hono } from "hono";
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
import { v1Routes } from "./routes/v1";
import { agentRoutes, approvalRoutes } from "./routes/agents";
import { systemStatus, uptimeHistory } from "./services/status";
import { deliverabilityRoutes, resendWebhookRoutes } from "./routes/deliverability";

/** Builds the HTTP API. Runtime-agnostic: Node and Workers entries both call this. */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

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
  const pageHeaders = securityHeaders({ csp: appCsp(), hsts });
  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    const set = p === "/api/v1/docs" ? docsHeaders : p.startsWith("/api/") || p.startsWith("/.well-known/") ? apiHeaders : pageHeaders;
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
    if (p.startsWith("/api/auth/") || p.startsWith("/api/webhooks/") || p.startsWith("/api/inbound/") || p.startsWith("/api/v1/")) return next();
    return appLimiter(c, next);
  });
  app.use("/api/*", async (c, next) => {
    // Signed webhooks and the API-key REST API never use cookies, so CSRF does not apply.
    if (c.req.path.startsWith("/api/inbound/") || c.req.path.startsWith("/api/webhooks/") || c.req.path.startsWith("/api/v1/")) return next();
    return csrfGuard(c, next);
  });

  // Health: the database must be reachable and fully migrated (migrations run at deploy time).
  let schemaCurrent = false;
  app.get("/api/health", async (c) => {
    try {
      if (!schemaCurrent) {
        const pending = await pendingMigrations(migrationDriver((deps.db as unknown as { $client: unknown }).$client));
        if (pending.length) return c.json({ ok: false, mode: deps.config.mode, db: "migrations_pending", pending }, 503);
        schemaCurrent = true;
      }
      return c.json({ ok: true, mode: deps.config.mode, db: "ok", release: deps.config.release });
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
      demoEnabled: deps.config.demoEnabled,
      outboundDriver: deps.outbound.name,
      billingEnabled: deps.config.billing.enabled,
      mxHosts: deps.config.mail.mxHosts,
      plans: Object.values(PLANS),
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
  app.route("/api/v1", v1Routes());
  app.route("/api/webhooks/resend", resendWebhookRoutes());
  app.route("/api/webhooks", providerWebhookRoutes());
  app.route("/api/deliverability", deliverabilityRoutes());
  app.route("/api/inbound-keys", inboundKeyRoutes());
  app.route("/api/inbound", inboundWebhookRoutes());

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404) : c.text("Not found", 404)));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof APIError) {
      // Better Auth errors raised from server-side calls (team routes and similar).
      const body = (err.body ?? {}) as { code?: string; message?: string };
      const code = body.code === "PLAN_LIMIT" ? "plan_limit" : (body.code ?? "error").toLowerCase();
      return c.json({ error: { code, message: body.message ?? err.message } }, err.statusCode as 400);
    }
    console.error("[api] unhandled", err);
    const eventId = deps.reportError?.(err, { method: c.req.method, path: c.req.path });
    return c.json({ error: { code: "internal", message: "Something went wrong on our side.", ...(eventId ? { details: { eventId } } : {}) } }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
