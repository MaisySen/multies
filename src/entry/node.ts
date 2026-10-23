/**
 * Node entry: serves the API and, when built, the web app from dist/web.
 *   npm run dev:api   (API on :8787, Vite proxies /api to it)
 *   npm run build && npm start   (one process serves everything)
 */
import * as Sentry from "@sentry/node";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate } from "../server/db";
import { openSqlite } from "../server/db/node";
import { DohResolver } from "../server/services/dns/resolver";
import { NodeResolver } from "../server/services/dns/node-resolver";
import { LogOutbound, ResendOutbound } from "../server/services/mail/outbound";
import { runMaintenance } from "../server/services/maintenance";

loadDotEnv();
const config = loadConfig(process.env);
if (config.sentry.dsnApi) Sentry.init({ dsn: config.sentry.dsnApi, environment: config.sentry.environment, tracesSampleRate: 0.05 });
const db = openSqlite(process.env.DATABASE_PATH ?? ".data/mymail.db");
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

const outbound = config.outbound.driver === "resend"
  ? new ResendOutbound(config.outbound.resendApiKey!)
  : new LogOutbound((line) => console.log(line));
const dns = config.dnsResolver === "node" ? new NodeResolver() : new DohResolver();

const deps = {
  db, config, dns, outbound, now: () => new Date(), fetch: globalThis.fetch.bind(globalThis),
  reportError: config.sentry.dsnApi ? (err: unknown, context?: Record<string, unknown>) => Sentry.captureException(err, { extra: context }) : undefined,
};
const app = createApp(deps);

// Housekeeping: DNS re-checks, session expiry, sandbox purge.
const tick = () => runMaintenance(deps).catch((err) => console.error("[maintenance]", err));
setInterval(tick, 10 * 60_000).unref();
setTimeout(tick, 5_000).unref();

const webRoot = path.resolve("dist/web");
if (existsSync(webRoot)) {
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), webRoot) }));
  // Read per request so a rebuilt web app is picked up without a restart.
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(readFileSync(path.join(webRoot, "index.html"), "utf8"))));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  console.log(`[mymail] ${config.mode} · http://localhost:${port} · outbound=${outbound.name} · dns=${config.dnsResolver} · demo=${config.demoEnabled}`);
});

function loadDotEnv() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
