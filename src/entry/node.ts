/**
 * Node entry: serves the API and, when built, the web app from dist/web.
 *   npm run dev:api   (API on :8787, Vite proxies /api to it)
 *   npm run build && npm start   (one process serves everything)
 */
import { fakeAskAi, fakeAskAllowed } from "../server/services/ask-fake"; // R110
import { MemoryToolFileStore } from "../server/services/tools/p2-bindings";
import { isKnownPage } from "../shared/known-routes";
import { movedPath } from "../shared/nav-menu"; // R121
import * as Sentry from "@sentry/node";
import { sentryPrivacy } from "../shared/sentry-scrub";
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
import { migrate, migrateIndex } from "../server/db";
import { indexDbPath, openSqlite } from "../server/db/node";
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
import { attachChatLive } from "../server/realtime/node";
import { SmtpOutbound, smtpSettingsFrom } from "./smtp-outbound";
import { MemoryImportFileStore } from "../server/services/data-move/kept-file";
import { domains } from "../server/db/schema";
import { decryptSecret } from "../server/lib/crypto";
import { eq } from "drizzle-orm";
import { fakeAiAllowed, fakeAiFetch } from "../server/services/ai/fake-fetch";
import { nodeBuiltinAi } from "../server/services/ai/node-builtin";
import { mockComposioAllowed, mockComposioFetch } from "../server/services/integrations/mock"; // R80C: local stand in only
import { mockDirectAllowed, mockDirectFetch } from "../server/services/direct-social/mock"; // R83: local stand in only
import { AUTH_SHELL_PATHS, BRAND_CACHE, AUTH_CARD_PATH, loginHtmlFor, originHintsFor, withOriginHints, type LoginPrerender } from "../shared/prerender-shell";
import { loginVariant } from "../server/auth/config";

loadDotEnv();
const config = loadConfig(process.env);
if (config.sentry.dsnApi) Sentry.init({ dsn: config.sentry.dsnApi, environment: config.sentry.environment, release: config.release, tracesSampleRate: config.sentry.tracesSampleRate, ...sentryPrivacy });
const dbPath = process.env.DATABASE_PATH ?? ".data/mymail.db";
const db = openSqlite(dbPath);
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(", ")}`);
// Tools P2 (17): the attachment text index lives in a second SQLite file (INDEX_DATABASE_PATH, by default next
// to the main one), the way the Worker uses a second D1 database (INDEX_DB). INDEX_DATABASE_PATH=off leaves it out.
const indexPath = indexDbPath(dbPath);
const indexDb = indexPath ? openSqlite(indexPath) : undefined;
if (indexDb) {
  const appliedIndex = await migrateIndex(indexDb);
  if (appliedIndex.length) console.log(`[db] applied index migrations: ${appliedIndex.join(", ")}`);
}

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

const fetchImpl = ((f: typeof fetch) => (mockDirectAllowed(process.env) ? mockDirectFetch(f) : f))(((f: typeof fetch) => (mockComposioAllowed(process.env) ? mockComposioFetch(f) : f))(fakeAiAllowed(process.env) ? fakeAiFetch(globalThis.fetch.bind(globalThis)) : globalThis.fetch.bind(globalThis)));
const deps = {
  db, indexDb, config, dns, outbound, now: () => new Date(),
  // R110: ASK_AI_FAKE=1 on a localhost APP_URL answers Ask locally (end to end tests only).
  askAi: fakeAskAllowed(process.env) ? fakeAskAi : undefined,
  // The in-app workspace agent, the same door the Worker opens with its AI binding.
  ai: nodeBuiltinAi(process.env, fetchImpl),
  // Round 23: AI_FAKE=1 on a localhost APP_URL answers the AI providers locally (end to end tests only).
  fetch: fetchImpl,
  log: jsonLogger({ service: "mymail-api", release: config.release, env: config.sentry.environment }),
  authenticate: mailauthAuthenticator(),
  bodyStore: config.bodyStore ? new S3BodyStore(config.bodyStore) : undefined,
  // R43: IMPORT_FILES=memory keeps import uploads in this process so the scheduled pass can finish a run (tests).
  importFiles: process.env.IMPORT_FILES === "memory" ? new MemoryImportFileStore() : undefined,
  // Tools P2: TOOL_FILES=memory keeps share and signing files in this process (tests and local runs).
  toolFiles: process.env.TOOL_FILES === "memory" ? new MemoryToolFileStore() : undefined,
  reportError: config.sentry.dsnApi ? (err: unknown, context?: Record<string, unknown>) => Sentry.captureException(err, { extra: context }) : undefined,
};
const app = createApp(deps);

// Housekeeping: DNS re-checks, session expiry, sandbox purge.
const tick = () => {
  void runMaintenanceIfMigrated(deps).catch((err) => console.error("[maintenance]", err));
  // R129: course reminders (self hosted servers run the same pass as the cloud cron).
  if (deps.config.coursesR129) void import("../server/services/courses-r129").then((m) => m.runCourseReminders(deps)).catch((err) => console.error("[courses.reminders]", err));
  if (deps.config.teamaiTd8) void import("../server/services/teamai-td8").then((m) => m.runTeamAiPass(deps)).catch(() => console.error("[teamai.pass] failed")); // TD8
  // R97: due notification digests (self hosted servers run the same pass as the cloud cron).
  if (deps.config.notificationCentre !== false) {
    void import("../server/services/suite/notify-centre-r97").then((m) => m.runNotificationDigests(deps)).catch((err) => console.error("[notify.digest]", err));
  }
};
setInterval(tick, 10 * 60_000).unref();
setTimeout(tick, 5_000).unref();

const webRoot = path.resolve("dist/web");
if (existsSync(webRoot)) {
  // gzip or brotli for the app's static files (Workers compress at the edge).
  app.use("/*", compress());
  // R25: hashed build files never change, so browsers keep them a year (the Worker does the same).
  app.use("/assets/*", async (c, next) => { await next(); if (c.res.status === 200) c.header("cache-control", "public, max-age=31536000, immutable"); });
  app.use("/brand/*", async (c, next) => { await next(); if (c.res.status === 200) c.header("cache-control", BRAND_CACHE); });
  // R32: the service worker is always checked for a newer copy.
  app.use("/sw.js", async (c, next) => { await next(); if (c.res.status === 200) c.header("cache-control", "no-cache"); });
  // R30: "/" gets the landing page prerendered at build time (scripts/prerender-landing.ts) when there is one.
  app.get("/", async (c, next) => {
    const landing = path.join(webRoot, "landing.html");
    if (!existsSync(landing)) return next();
    return c.html(readFileSync(landing, "utf8"));
  });
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), webRoot) }));
  // Read per request so a rebuilt web app is picked up without a restart.
  // R30: the auth pages get the shell that preloads their code (auth.html) when the build made one.
  const shellPath = (p: string) => (AUTH_SHELL_PATHS.test(p) && existsSync(path.join(webRoot, "auth.html")) ? "auth.html" : "index.html");
  const hints = originHintsFor(config.sentry.dsnWeb); // R34: preconnect to the error tracker's host
  // R34 (perf2): /login gets the card prerendered for this deployment's setup, when the build made it.
  const variant = loginVariant(config);
  const loginPrerender = (): LoginPrerender | null => {
    const file = path.join(webRoot, "auth-login.json");
    try { return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as LoginPrerender) : null; } catch { return null; }
  };
  const pageHtml = (p: string, search: string) => loginHtmlFor(p, search, AUTH_CARD_PATH.test(p) ? loginPrerender() : null, variant) ?? readFileSync(path.join(webRoot, shellPath(p)), "utf8");
  // R121 (NAV_P2_R121): an old mail setup address lands in Settings, Mail setup (302: the switch can be turned off).
  // Semgrep (QUAL1): not an open redirect. movedPath answers only for the old mail setup paths, always with a fixed
  // /app/settings/ prefix on our own site; the query string rides along (tests/open-redirect-qual1.test.ts).
  app.get("*", (c, next) => { const moved = config.navP2R121 ? movedPath(c.req.path) : null; return moved ? c.redirect(`${moved}${new URL(c.req.url).search}`, 302) : next(); }); // nosemgrep: ajinabraham.njsscan.redirect.open_redirect.express_open_redirect
  app.get("*", (c) => (c.req.path.startsWith("/api/") ? c.notFound() : c.html(withOriginHints(pageHtml(c.req.path, new URL(c.req.url).search), hints), isKnownPage(c.req.path) ? 200 : 404)));
}

const port = Number(process.env.PORT ?? 8787);
// One Better Auth request state per request (see src/server/lib/request-state.ts).
const server = serve({ fetch: (req, env) => withAuthRequestState(() => Promise.resolve(app.fetch(req, env))), port }, () => {
  console.log(`[multies] ${config.mode} · http://localhost:${port} · outbound=${outbound.name} · dns=${config.dnsResolver} · demo=${config.demoEnabled}`);
});
// Doc co-editing: GET /api/docs/:id/collab upgrades to a WebSocket (in-memory rooms).
attachCollab(server as unknown as import("node:http").Server, app, deps as never);
// Round 32: live chat: GET /api/chat/live upgrades to a WebSocket (one in-process hub).
attachChatLive(server as unknown as import("node:http").Server, deps as never);

function loadDotEnv() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
