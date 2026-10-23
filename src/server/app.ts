import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv, Deps } from "./context";
import { HttpError } from "./lib/errors";
import { clientIp, csrfGuard } from "./middleware";
import { authRoutes } from "./routes/auth";
import { domainRoutes } from "./routes/domains";
import { aliasRoutes, mailboxRoutes } from "./routes/addresses";
import { orgRoutes } from "./routes/org";
import { PLANS } from "@/shared/plans";

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
    if (c.req.path.startsWith("/api/inbound/")) return next(); // signed webhooks, not cookie auth
    return csrfGuard(c, next);
  });

  app.get("/api/health", (c) => c.json({ ok: true, mode: deps.config.mode }));
  app.get("/api/config", (c) =>
    c.json({
      appName: deps.config.appName,
      mode: deps.config.mode,
      demoEnabled: deps.config.demoEnabled,
      outboundDriver: deps.outbound.name,
      mxHosts: deps.config.mail.mxHosts,
      plans: Object.values(PLANS),
    }),
  );

  app.route("/api/auth", authRoutes());
  app.route("/api/domains", domainRoutes());
  app.route("/api/mailboxes", mailboxRoutes());
  app.route("/api/aliases", aliasRoutes());
  app.route("/api/org", orgRoutes());

  app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404) : c.text("Not found", 404)));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    console.error("[api] unhandled", err);
    return c.json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
