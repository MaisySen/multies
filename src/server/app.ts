import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Deps } from "./context";
import { HttpError } from "./lib/errors";
import { clientIp, csrfGuard } from "./middleware";
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
import { deliverabilityRoutes, resendWebhookRoutes } from "./routes/deliverability";

/** Builds the HTTP API. Runtime-agnostic: Node and Workers entries both call this. */
export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("ip", clientIp(c));
    await next();
  });
  app.use("/api/*", secureHeaders({ crossOriginResourcePolicy: "same-origin" }));
  app.use("/api/*", async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
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
      return c.json({ ok: true, mode: deps.config.mode, db: "ok" });
    } catch {
      return c.json({ ok: false, mode: deps.config.mode, db: "unreachable" }, 503);
    }
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
      sentry: deps.config.sentry.dsnWeb ? { dsn: deps.config.sentry.dsnWeb, environment: deps.config.sentry.environment } : null,
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
