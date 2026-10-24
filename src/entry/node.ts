/**
 * Node entry: serves the API and, when built, the web app from dist/web.
 *   npm run dev:api   (API on :8787, Vite proxies /api to it)
 *   npm run build && npm start   (one process serves everything)
 */
import * as Sentry from "@sentry/node";
import { S3BodyStore } from "../server/services/storage/body-store";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { jsonLogger } from "../server/lib/logger";
import { withAuthRequestState } from "../server/lib/request-state";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { migrate } from "../server/db";
import { openSqlite } from "../server/db/node";
import { DohResolver } from "../server/services/dns/resolver";
import { NodeResolver } from "../server/services/dns/node-resolver";
import { LogOutbound, ResendOutbound, type OutboundMessage } from "../server/services/mail/outbound";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Development outbox: every email the log driver records is written as JSON to `dir`. */
function writeOutbox(dir: string) {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return (msg: OutboundMessage) => {
    const { attachments: _a, ...rest } = msg;
    writeFileSync(join(dir, `${Date.now()}-${++n}.json`), JSON.stringify(rest, null, 2));
  };
}
import { ResilientOutbound } from "../server/services/resilience";
import { runMaintenanceIfMigrated } from "../server/services/maintenance";
import { mailauthAuthenticator } from "../server/services/mail/mailauth";
import { attachCollab } from "../server/collab/node";
import { SmtpOutbound, smtpSettingsFrom } from "./smtp-outbound";
import { domains } from "../server/db/schema";
import { decryptSecret } from "../server/lib/crypto";
import { eq } from "drizzle-orm";

loadDotEnv();
const config = loadConfig(process.env);
if (config.sentry.dsnApi) Sentry.init({ dsn: config.sentry.dsnApi, environment: config.sentry.environment, release: config.release, tracesSampleRate: config.sentry.tracesSampleRate });
const db = openSqlite(process.env.DATABASE_PATH ?? ".data/mymail.db");
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);

// Self-hosted installs send through their own mail server when SMTP_HOST is set (src/entry/smtp-outbound.ts).
const smtp = smtpSettingsFrom(process.env);
const outbound = config.outbound.driver === "resend"
  ? new ResilientOutbound(new ResendOutbound(config.outbound.resendApiKey!))
  : smtp
    ? new ResilientOutbound(new SmtpOutbound(smtp, async (name) => {
      const row = await db.select().from(domains).where(eq(domains.name, name)).get();
      return row ? { domainName: row.name, keySelector: row.dkimSelector, privateKey: await decryptSecret(config.appSecret, row.dkimPrivateKeyEnc) } : undefined;
    }))
    : new LogOutbound((line) => console.log(line), process.env.OUTBOX_DIR ? writeOutbox(process.env.OUTBOX_DIR) : undefined);
const dns = config.dnsResolver === "node" ? new NodeResolver() : new DohResolver();

const deps = {
  db, config, dns, outbound, now: () => new Date(), fetch: globalThis.fetch.bind(globalThis),
  log: jsonLogger({ service: "mymail-api", release: config.release, env: config.sentry.environment }),
  authenticate: mailauthAuthenticator(),
  bodyStore: config.bodyStore ? new S3BodyStore(config.bodyStore) : undefined,
  reportError: config.sentry.dsnApi ? (err: unknown, context?: Record<string, unknown>) => Sentry.captureException(err, { extra: context }) : undefined,
};
const app = createApp(deps);

// Housekeeping: DNS re-checks, session expiry, sandbox purge.
const tick = () => runMaintenanceIfMigrated(deps).catch((err) => console.error("[maintenance]", err));
setInterval(tick, 10 * 60_000).unref();
setTimeout(tick, 5_000).unref();

const webRoot = path.resolve("dist/web");
if (existsSync(webRoot)) {
  // gzip or brotli for the app's static files (Workers compress at the edge).
  app.use("/*", compress());
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), webRoot) }));
  // Read per request so a rebuilt web app is picked up without a restart.
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(readFileSync(path.join(webRoot, "index.html"), "utf8"))));
}

const port = Number(process.env.PORT ?? 8787);
// One Better Auth request state per request (see src/server/lib/request-state.ts).
const server = serve({ fetch: (req, env) => withAuthRequestState(() => Promise.resolve(app.fetch(req, env))), port }, () => {
  console.log(`[mymail] ${config.mode} · http://localhost:${port} · outbound=${outbound.name} · dns=${config.dnsResolver} · demo=${config.demoEnabled}`);
});
// Doc co-editing: GET /api/docs/:id/collab upgrades to a WebSocket (in-memory rooms).
attachCollab(server as unknown as import("node:http").Server, app, deps as never);

function loadDotEnv() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
