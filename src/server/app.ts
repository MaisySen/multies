import { productAnalyticsRoutes } from "./routes/product-analytics";
import { productAnalyticsActions } from "./services/product-analytics";
import { docsMarkdown, DOCS_MD_PATHS, llmsFullTxt, llmsTxt, MCP_TOOLS_MD_PATH, versionJson } from "./routes/web-meta-r32";
import { crmRoutes } from "./routes/crm-r94"; // R94: CRM timeline
import { mapsRoutes } from "./routes/maps-r115"; // R115: maps
import { recordWorkspaceWrites, runMetered, workspaceHealthView } from "./services/workspace-budget";
import { Hono, type Context } from "hono";
import { isD1LimitError, READ_ONLY_BODY } from "./lib/d1-limit";
import { busyBody, d1BusyKind } from "./lib/d1-busy";
import { healthView, noteD1LimitHit, readsView, writeBudget } from "./services/write-budget";
import { deferredCounts } from "./services/write-priority";
import { API_CSP, CAMPAIGN_PUBLIC_CSP, appCsp, docsCsp, isHttps, securityHeaders } from "./lib/security-headers";
import { installCspReport } from "./routes/csp-report-r30";
import type { AppEnv, Deps } from "./context";
import { HttpError } from "./lib/errors";
import { clientIp, csrfGuard } from "./middleware";
import { jsonLogger, requestIdFrom } from "./lib/logger";
import { rateLimit } from "./lib/rate-limit";
import { createHash } from "./lib/hash";
import { accountRoutes } from "./routes/account";
import { contactFormRoutes } from "./routes/contact";
import { adminRoutes } from "./routes/admin";
import { adminAppConfigRoutes, appConfigRoutes } from "./routes/app-config-r29b";
import { authFor } from "./auth";
import { clearAuthCache, forgetCachedAuth } from "./auth/guards";
import { forgetProjectCounts } from "./services/suite/tasks";
import { forgetOrgCache } from "./services/plans";
import { forgetUserCaches } from "./lib/isolate-cache";
import { APIError } from "better-auth/api";
import { domainRoutes } from "./routes/domains";
import { aliasRoutes, mailboxRoutes } from "./routes/addresses";
import { freeAddressRoutes } from "./routes/free-address";
import { toolsRoutes } from "./routes/tools";
import { activeToolFeatures } from "./services/tools/features"; // Tools P2: "index" only with INDEX_DB
import { toolsEditorsRoutes } from "./routes/tools-editors"; // Tools P2: editors
import { toolsAiRoutes } from "./routes/tools-ai"; // Tools P2: AI documents
import { mailMergeUnsubscribeRoutes, toolsAutomationRoutes } from "./routes/tools-automation"; // Tools P2: automation
import { campaignPublicRoutes, campaignRoutes } from "./routes/campaigns-r109"; // R109: lists, newsletters, journeys
import { sharePublicRoutes, toolsShareRoutes } from "./routes/tools-share";
import { portalPublicRoutes, portalRoutes } from "./routes/client-portal"; // R120
import { mailArchiveRoutes } from "./routes/mail-archive-r111"; // R111
import { requestPublicRoutes, secretPublicRoutes, toolsRequestRoutes, toolsSecretRoutes } from "./routes/secure-share"; // R88 // Tools P2: share links
import { bioPublicRoutes, linkPublicRoutes, linksRoutes } from "./routes/links"; // R87: Links in Tools
import { esignPublicRoutes, toolsEsignRoutes } from "./routes/tools-esign"; // Tools P2: e-sign
import { attachmentIndexRoutes } from "./routes/attachment-index"; // Tools P2: attachment index and smart folders
import { connectionRoutes } from "./routes/connections";
import { deleteAccountCallbackRoutes, directSocialRoutes, directWebhookRoutes } from "./routes/direct-social"; // R83
import { appConnectionRoutes, socialRoutes } from "./routes/integrations"; // R80C: Connections hub and social posts
import { fxRoutes } from "./routes/fx";
import { orgRoutes } from "./routes/org";
import { brandingRoutes } from "./routes/branding"; // R77
import { mailRoutes } from "./routes/mail";
import { inboundKeyRoutes, inboundWebhookRoutes } from "./routes/inbound";
import { deliveryRoutes } from "./routes/deliveries";
import { dashboardRoutes } from "./routes/dashboard";
import { PLANS } from "@/shared/plans";
import { migrationDriver, pendingMigrations } from "./db";
import { inviteRoutes, teamRoutes } from "./routes/team";
import { billingRoutes, providerWebhookRoutes } from "./routes/billing";
import { mailAccessRoutes } from "./routes/mail-access";
import { mailScheduleRoutes } from "./routes/mail-schedules";
import { epicRoutes } from "./routes/suite-r21-types";
import { sprintRoutes } from "./routes/sprints";
import { shareLinkRoutes, sharePageRoutes } from "./routes/share-links"; // R26 (MB-87): share links
import { dashboardsPlusRoutes, dashboardsPublicRoutes } from "./routes/dashboards-r91"; // R91: dashboards plus
import { workloadRoutes } from "./routes/workload";
import { automationRecipeRoutes } from "./routes/automation-recipes";
import { flowRoutes } from "./routes/flows";
import { docTreeRoutes, guestDocTreeRoutes, taskBacklinkRoutes } from "./routes/doc-tree";
import { docVersionRoutes } from "./routes/doc-versions-r39"; // R39: page history
import { savedDashboardRoutes } from "./routes/dashboards";
import { computedRoutes } from "./routes/computed";
import { triageRoutes } from "./routes/triage";
import { threadCommentRoutes } from "./routes/thread-comments";
import { channelRoutes, metaWebhookRoutes } from "./routes/channels"; // C1: chat channels
import { checklistItemRoutes, checklistTaskRoutes, guestChecklistRoutes } from "./routes/checklists"; // R26 (MB-85)
import { agentRunRoutes, agentRunTaskRoutes } from "./routes/agent-runs-r27"; // R27 (DF-3 slice 2)
import { catchupRoutes } from "./routes/catchup-r31"; // R31: catch-up
import { agentTriggerHookRoutes, agentTriggerRoutes } from "./routes/agent-triggers-r28"; // R28 (DF-3 slice 3)
import { taskTeardownRoutes } from "./routes/task-teardown-r27"; // R27 teardown: watchers, duplicate
import { mailSnippetRoutes } from "./routes/mail-snippets";
import { countsRoutes } from "./routes/counts-r34"; // R34
import { mailPrefRoutes, mailReadStatusRoutes, mailSplitRoutes, openPixelRoutes } from "./routes/mail-splits-r31";
import { mailLabelRoutes, mailRuleRoutes } from "./routes/mail-rules-r85";
import { meetingNotesRoutes } from "./routes/meeting-notes";
import { meetingLiveRoutes, publicMeetingLiveRoutes } from "./routes/meeting-live-r31";
import { meetingLobbyRoutes, publicMeetingLobbyRoutes } from "./routes/meeting-lobby-r32";
import { calendarFeedRoutes, calendarRoutes } from "./routes/calendar-sync";
import { davRoutes, davSettingsRoutes, davWellKnown } from "./routes/dav"; // R99
import { threadStateRoutes } from "./routes/thread-state";
import { threadCollabRoutes } from "./routes/thread-collab";
import { taskBulkRoutes } from "./routes/tasks-bulk";
import { developerRoutes } from "./routes/developer";
import { oauthRoutes, oauthWellKnownRoutes } from "./routes/oauth";
import { v1ParentVars, v1Routes } from "./routes/v1";
import { agentRoutes, approvalRoutes } from "./routes/agents";
import { aiRoutes } from "./routes/ai";
import { webPushRoutes } from "./routes/web-push-r32";
import { automationRoutes, changeRoutes, companyRoutes, contactRoutes, dealRoutes, docRoutes, notificationRoutes, projectRoutes, pushRoutes, taskRoutes } from "./routes/suite";
import { importRoutes, importRunnerRoutes, integrationRoutes } from "./routes/imports";
import { workImportRoutes } from "./routes/work-imports";
import { dataMoveDownloadRoutes, dataMoveRoutes } from "./routes/data-moves";
import { systemStatus, uptimeHistory } from "./services/status";
import { deliverabilityRoutes, resendWebhookRoutes } from "./routes/deliverability";
import { authHookWebhookRoutes } from "./routes/auth-hooks";
import { SECURITY_EMAIL } from "@/shared/trust";
import { authEmailSettingsRoutes } from "./routes/auth-email-settings-r27";
import { formRoutes, meetingRoutes, publicRoutes, reportRoutes, timeRoutes } from "./routes/suite-r7";
import { formResultsRoutes } from "./routes/forms-r31";
import { helpdeskRoutes, surveyRoutes, widgetRoutes, WIDGET_JS_HEADERS } from "./routes/helpdesk"; // R119
import { helpCenterRoutes, helpPublicRoutes } from "./routes/help-center"; // R122
import { docsPlusRoutes } from "./routes/docs-plus"; // R103
import { WIDGET_JS } from "./routes/widget-script"; // R119
import { meetingRecordingRoutes } from "./routes/meeting-recordings";
import { chatPlusRoutes, guestChatPlusRoutes } from "./routes/chat-plus-r96";
import { checkRoutes } from "./routes/check";
import { guestSearchRoutes, myWorkRoutes, searchRoutes } from "./routes/search";
import { fieldRoutes, fileRoutes, guestAdminRoutes, guestRoutes, portfolioRoutes } from "./routes/suite-r8";
import { docImageRoutes } from "./routes/doc-images-r32"; // R32: images in docs
import { imageLinkRoutes, toolsC2Routes } from "./routes/tools-c2-r100b"; // R100b: link preview and image links
import { installHttpCache } from "./lib/http-cache";
import { hostSessionCookie } from "./lib/host-cookie";
import { authErrorPageCode, authErrorRedirectUrl, errorCodeOf, isAuthNavigation } from "./lib/auth-redirect"; // R41 MB-222
import { adminReportsRoutes, blocksRoutes, reportsRoutes } from "./routes/reports-r35"; // R35

/** Builds the HTTP API. Runtime-agnostic: Node and Workers entries both call this. */
/** Presence heartbeats and leaves (round 22): memory only, never a D1 write. */
export const PRESENCE_PATH = /^\/api\/threads\/[^/]+\/presence(\/leave)?$/;

/**
 * R34: on local E2E servers only (E2E_LOCAL_RATE_KEYS, refused in production) a request with no client address
 * gets an address key of its own, so the per address limits (auth, demo, contact, checks) do not all share one
 * "unknown" counter and trip late in a long run. Everywhere else the address is used as read.
 */
export function requestIp(ip: string, localAddresslessUnlimited?: boolean): string {
  return localAddresslessUnlimited && ip === "unknown" ? `unknown:${crypto.randomUUID()}` : ip;
}

/** Writes that can change another person's access or end their sessions (R40 sec). */
const ACCESS_WRITE = /^\/api\/(team|org|admin|invites|account)(\/|$)|^\/api\/auth\/(revoke|change-password|reset-password|organization|admin|two-factor|delete-user)/;

/** R45 (MB-199): per app, builds the lazily made public API now. Used by the Worker at isolate startup only. */
export const appPrebuild = new WeakMap<object, () => void>();

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
      noteD1LimitHit(); // R32: deferrable writes stop for the rest of the UTC day in this isolate
      // A browser landing on a sign in callback gets the sign in page with the read only notice, not raw JSON.
      if (c.req.method === "GET" && c.req.path.startsWith("/api/auth/") && (c.req.header("accept") ?? "").includes("text/html")) {
        return c.redirect("/login?error=read_only", 302);
      }
      return c.json(READ_ONLY_BODY, 503, { "retry-after": "600" });
    }
    const busy = d1BusyKind(err); // R28: an export, an overload or a lost connection is a wait, not a bug
    if (busy) {
      (c.var.log ?? deps.log)?.warn("database_busy", { method: c.req.method, path: c.req.path, reason: busy.kind, error: err.message.slice(0, 200) });
      return c.json(busyBody(busy.kind), 503, { "retry-after": String(busy.retryAfter) });
    }
    console.error("[api] unhandled", err);
    const eventId = deps.reportError?.(err, { method: c.req.method, path: c.req.path });
    return c.json({ error: { code: "internal", message: "Something went wrong on our side.", ...(eventId ? { details: { eventId } } : {}) } }, 500);
  };

  // R31: the session cookie travels as __Host-mymail.session_token in production (dual read of the old name).
  app.use("*", hostSessionCookie(deps.config.mode === "production"));
  // R40 (MB-199): any write and any sign in route (sign out, confirming an address) drops the in-isolate copy of this cookie's session first.
  app.use("/api/*", async (c, next) => {
    const write = c.req.method !== "GET" && c.req.method !== "HEAD";
    if (write || c.req.path.startsWith("/api/auth/")) forgetCachedAuth(c.req.raw.headers);
    // R40 sec: a write that can change someone else's access (removing a member, a role change, revoking sessions,
    // a password reset) empties this isolate's whole copy, so that person's next read here sees it at once.
    if (write && ACCESS_WRITE.test(c.req.path)) clearAuthCache();
    await next();
    // R40 D1 reads: a write to the workspace drops its cached project counts (services/suite/tasks.ts).
    if (write) {
      forgetProjectCounts(c.var.auth?.orgId);
      // R40 deploy 3: and its cached workspace row and plan. A write with no session (a billing webhook, an
      // operator call) drops every workspace's copy in this isolate.
      forgetOrgCache(c.var.auth?.orgId);
      // R41: and this person's per isolate copies (preferences, mail tabs); every copy when there is no session.
      forgetUserCaches(c.var.auth?.userId);
    }
  });
  const rootLog = deps.log ?? jsonLogger({ service: "mymail-api", release: deps.config.release, env: deps.config.sentry.environment });
  app.use("*", async (c, next) => {
    const started = Date.now();
    const requestId = requestIdFrom(c.req.raw.headers);
    const log = "child" in rootLog ? (rootLog as ReturnType<typeof jsonLogger>).child({ requestId }) : rootLog;
    c.set("deps", deps);
    c.set("ip", requestIp(clientIp(c), deps.config.auth.localAddresslessUnlimited));
    c.set("requestId", requestId);
    c.set("log", log);
    await next();
    c.res.headers.set("x-request-id", requestId);
    // One access line per API request. No query strings (they can carry tokens) and no bodies.
    if (c.req.path.startsWith("/api/") && c.req.path !== "/api/health") {
      const status = c.res.status;
      const fields = { method: c.req.method, path: c.req.routePath && c.req.routePath !== "/*" ? c.req.routePath : c.req.path, status, ms: Date.now() - started, user: c.var.auth?.userId, org: c.var.auth?.orgId };
      // R40 deploy 3 (free plan CPU): a successful read writes no access line in production; the platform's own
      // request log already has it, and building and printing the JSON line cost CPU on every page load.
      const quietRead = status < 400 && (c.req.method === "GET" || c.req.method === "HEAD") && deps.config.mode === "production";
      if (status >= 500) log.error("request", fields); else if (status >= 400) log.warn("request", fields); else if (!quietRead) log.info("request", fields);
    }
  });
  const hsts = isHttps(deps.config.appUrl);
  const apiHeaders = securityHeaders({ csp: API_CSP, hsts });
  const campaignPublicHeaders = securityHeaders({ csp: CAMPAIGN_PUBLIC_CSP, hsts }); // R109: its pages post their own forms
  const docsHeaders = securityHeaders({ csp: docsCsp(), hsts });
  // Pages served by this app (the Node server serves the SPA too) get the page policy.
  // R67 (QA5 #11): the zone adds Cloudflare's cookieless analytics beacon to pages this worker makes (the public sign and
  // share pages), so its script and reporting host are always allowed; a blocked beacon was a console error on each load.
  const cspBase = { analytics: true, appUrl: deps.config.appUrl, livekitUrl: deps.config.meetings?.url };
  const pageHeaders = securityHeaders({ csp: appCsp(cspBase), hsts });
  const formPageHeaders = securityHeaders({ csp: appCsp({ ...cspBase, turnstile: true }), hsts });
  app.use("*", async (c, next) => {
    await next();
    const p = c.req.path;
    if (p === "/widget.js") return; // R119: the chat script loads on other sites (its own headers)
    const set = p === "/api/v1/reference" ? docsHeaders : p.startsWith("/api/campaign-public/") ? campaignPublicHeaders : p.startsWith("/api/") || p.startsWith("/.well-known/") ? apiHeaders : p.startsWith("/f/") ? formPageHeaders : pageHeaders;
    for (const [k, v] of Object.entries(set)) c.res.headers.set(k, v);
  });
  app.use("/api/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });
  installCspReport(app); // R30: CSP violation reports, logged only; before the limiters so it writes nothing
  installHttpCache(app); // R25 API speed: ETag and 304 for a few read only GETs (src/server/lib/http-cache.ts)
  // Rate limits (hono-rate-limiter; a Cloudflare binding when bound, else a shared counter).
  const ipKey = (c: { var: { ip: string } }) => c.var.ip;
  const oauthLimiter = rateLimit("auth", ipKey);
  // R41 (MB-222): a browser navigating a sign in redirect route never ends on raw JSON or an error body;
  // a refusal, a limit or a server error there becomes /login?error=... with a Try again button.
  app.use("/api/auth/*", async (c, next) => {
    if (!isAuthNavigation(c.req.method, c.req.path, c.req.raw.headers)) return next();
    if (c.req.path.startsWith("/api/auth/error")) return c.redirect(authErrorRedirectUrl(c.req.path, 400, c.req.query("error")), 302);
    try { await next(); } catch (err) { c.var.log?.warn?.("auth_nav_error", { path: c.req.path, error: String(err).slice(0, 200) }); c.res = c.redirect(authErrorRedirectUrl(c.req.path, 500), 302); return; }
    const loc = c.res.status >= 300 && c.res.status < 400 ? c.res.headers.get("location") : null;
    const errLoc = loc ? authErrorPageCode(loc) : undefined;
    if (errLoc !== undefined) {
      // Better Auth's own error page is a bare page; send the browser straight to ours, keeping the cookies it set.
      const res = new Response(null, { status: 302, headers: c.res.headers });
      res.headers.set("location", authErrorRedirectUrl(c.req.path, 400, errLoc));
      res.headers.delete("content-type");
      c.res = undefined as never;
      c.res = res;
    } else if (c.res.status >= 400) {
      const status = c.res.status;
      const code = await errorCodeOf(c.res);
      const res = new Response(null, { status: 302, headers: { location: authErrorRedirectUrl(c.req.path, status, code), "cache-control": "no-store" } });
      c.res = undefined as never; // Hono: clear first so the error body's headers do not carry over to the redirect
      c.res = res;
    }
  });
  app.use("/api/auth/*", rateLimit("auth", ipKey));
  app.use("/api/webhooks/*", rateLimit("webhooks", ipKey));
  app.use("/api/connections/webhooks/*", rateLimit("webhooks", ipKey)); // R83: TikTok webhook (signed)
  app.use("/api/inbound/*", rateLimit("webhooks", ipKey));
  // OAuth for MCP (round 20): registration and token calls come from AI apps, not from a session.
  const isOAuthPublic = (p: string) => p === "/api/oauth/register" || p === "/api/oauth/token" || p === "/api/oauth/revoke";
  app.use("/api/oauth/*", async (c, next) => (isOAuthPublic(c.req.path) && c.req.method === "POST" ? oauthLimiter(c, next) : next()));
  app.use("/api/v1/*", rateLimit("api", (c) => createHash(c.req.header("authorization") ?? c.var.ip), { countReads: true }));
  const appLimiter = rateLimit("app", (c) => c.req.header("cookie")?.match(/mymail\.session_token=([^;.]+)/)?.[1]?.slice(0, 24) ?? c.var.ip);
  app.use("/api/*", async (c, next) => {
    const p = c.req.path;
    if (p.startsWith("/api/auth/") || p.startsWith("/api/webhooks/") || p.startsWith("/api/connections/webhooks/") || p.startsWith("/api/inbound/") || p.startsWith("/api/v1/") || p.startsWith("/api/import-runner/") || isOAuthPublic(p)) return next();
    // Incoming hooks and the booking page limit themselves in memory, so a public call costs no limiter write.
    if (p.startsWith("/api/hooks/in/") || p.startsWith("/api/hooks/agent-runs/") || p.startsWith("/api/book/") || p.startsWith("/api/widget/") || p.startsWith("/api/check/")) return next();
    return appLimiter(c, next);
  });
  app.use("/api/*", async (c, next) => {
    // Signed webhooks, the API-key REST API and the import runner (token) never use cookies, so CSRF does not apply.
    const p = c.req.path;
    if (p.startsWith("/api/campaign-public/")) return next(); // R109: cookie free public pages keyed by a random token (one click unsubscribe is a form POST by design, RFC 8058)
    if (p.startsWith("/api/widget/")) return next(); // R119: the website chat is public and cookie free (origin checked per key)
    if (p.startsWith("/api/inbound/") || p.startsWith("/api/webhooks/") || p.startsWith("/api/connections/webhooks/") || p.startsWith("/api/v1/") || p.startsWith("/api/import-runner/") || p.startsWith("/api/hooks/in/") || p.startsWith("/api/hooks/agent-runs/") || isOAuthPublic(p)) return next();
    return csrfGuard(c, next);
  });

  // R48 (MB-235): count the D1 rows each write request writes and charge them to its workspace
  // (services/workspace-budget.ts). Reads are not metered: signed in GETs write nothing.
  if (deps.config.workspaceBudget.daily) {
    app.use("/api/*", async (c, next) => {
      if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return next();
      const { rows } = await runMetered(() => next());
      const orgId = (c.var as { auth?: { orgId?: string | null } }).auth?.orgId;
      if (!orgId || !rows) return;
      const flush = recordWorkspaceWrites(deps, orgId, rows);
      if (flush) { try { c.executionCtx.waitUntil(flush); } catch { await flush; } }
    });
  }

  // Staging (WRITE_BUDGET_GUARD=strict) shares production's daily D1 write budget, so once the account
  // passes the warn level its API refuses writes with the same read only answer a D1 limit gives.
  // Production never refuses here; it only stops optional writers (services/write-budget.ts).
  if (deps.config.writeBudget.strict) {
    app.use("/api/*", async (c, next) => {
      if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS" || c.req.path === "/api/health") return next();
      // Round 22: presence heartbeats live in memory and write nothing, so they keep working.
      if (PRESENCE_PATH.test(c.req.path)) return next();
      const r = await writeBudget(deps);
      if (r.level === "warn" || r.level === "shed") return c.json(READ_ONLY_BODY, 503, { "retry-after": "3600" });
      return next();
    });
  }

  // Health: the database must be reachable and fully migrated (migrations run at deploy time).
  let schemaCurrent = false;
  const health = async (c: Context<AppEnv>) => {
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
      return c.json({ ok: true, mode: deps.config.mode, db: "ok", release: deps.config.release, ...(wb.level !== "off" ? { writes: { ...healthView(wb, deps.config.writeBudget, deps.now()), deferred: deferredCounts() }, reads: readsView(wb.rowsRead, deps.config.writeBudget) } : {}), workspaces: await workspaceHealthView(deps).catch(() => null) });
    } catch {
      return c.json({ ok: false, mode: deps.config.mode, db: "unreachable" }, 503);
    }
  };
  app.get("/api/health", health);
  // R45: production test session for the build team (404 unless the TEST_SESSION_* settings are set; see routes/test-session-r45.ts).
  app.post("/api/_test-session", async (c) => (await import("./routes/test-session-r45")).mintTestSession(c));
  // Uptime monitors try /health and /healthz first (MB-53): same JSON answer, never the HTML 404 page.
  app.get("/health", health);
  // R32: release check for open tabs, and the public developer docs for agents.
  app.get("/version.json", versionJson);
  app.get("/llms.txt", llmsTxt);
  app.get("/llms-full.txt", llmsFullTxt);
  for (const p of DOCS_MD_PATHS) app.get(p, docsMarkdown); // R33: a .md copy of each docs page
  // R36: the MCP tool catalog, generated from the server's own tool registrations (no D1).
  app.get("/api/mcp-tools", async (c) => {
    const { mcpCatalog, mcpCatalogView } = await import("./services/developer/mcp-catalog");
    const release = c.var.deps.config.release;
    // R37: a key's view. Send the key (Authorization: Bearer ...) with ?view=key, or preview any scope
    // value with ?scope=mail:read+tasks:write. Without either, every tool, as before.
    const scopeParam = c.req.query("scope");
    const wantsKey = c.req.query("view") === "key" && !!c.req.header("authorization");
    if (!scopeParam && !wantsKey) {
      c.header("cache-control", "public, max-age=3600");
      return c.json({ release, endpoint: "/api/v1/mcp", tools: mcpCatalog(release, !!c.var.deps.config.channels?.enabled) });
    }
    let scope = scopeParam ?? "full";
    if (wantsKey) {
      const { resolveApiKey } = await import("./services/developer/api-keys");
      const { resolveOAuthToken } = await import("./services/developer/oauth");
      const header = c.req.header("authorization");
      const auth = (await resolveApiKey(c.var.deps, header)) ?? (await resolveOAuthToken(c.var.deps, header));
      if (!auth) return c.json({ error: { code: "unauthorized", message: "That key or token is not valid." } }, 401);
      scope = auth.scope ?? "full";
    }
    const view = mcpCatalogView(release, scope, !!c.var.deps.config.channels?.enabled);
    if (!view.ok) return c.json({ error: { code: "invalid_scope", message: `Unknown scope: ${view.unknown.join(", ")}.` } }, 422);
    c.header("cache-control", wantsKey ? "private, no-store" : "public, max-age=3600");
    return c.json({ release, endpoint: "/api/v1/mcp", scope: view.scope, total: view.total, tools: view.tools });
  });
  app.get(MCP_TOOLS_MD_PATH, async (c) => {
    const { mcpCatalogMarkdown } = await import("./services/developer/mcp-catalog");
    c.header("content-type", "text/markdown; charset=utf-8");
    c.header("cache-control", "public, max-age=3600");
    return c.body(mcpCatalogMarkdown(c.var.deps.config.release, !!c.var.deps.config.channels?.enabled));
  });
  app.get("/healthz", health);

  // RFC 9116: where to report a vulnerability.
  app.get("/.well-known/security.txt", (c) => {
    const expires = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)).toISOString();
    c.header("cache-control", "public, max-age=86400");
    return c.text([
      // One public contact everywhere (legal pages, Trust page); the routed security address follows it.
      ...[`mailto:${SECURITY_EMAIL}`, deps.config.securityContact].filter((v, i, a) => a.indexOf(v) === i).map((v) => `Contact: ${v}`),
      `Expires: ${expires}`,
      "Preferred-Languages: en",
      `Canonical: ${deps.config.appUrl}/.well-known/security.txt`,
      `Policy: ${deps.config.appUrl}/trust`,
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
      // ANALYTICS-PH: internal product usage analytics (on only with ANALYTICS_PH and its keys; the browser still honours Do Not Track).
      analyticsPh: !!deps.config.productAnalytics,
      demoEnabled: deps.config.demoEnabled,
      // R117: Social composer v2, planner views and slots, drafts and approvals, library (SOCIAL_P2; on unless "off").
      socialP2: deps.config.socialP2 !== false,
      // R118: Social inbox, analytics and account health alerts (SOCIAL_P2B); the staging only test network.
      socialP2b: deps.config.socialP2b !== false,
      socialTestNetwork: deps.config.socialTestNetwork === true,
      supportEmail: deps.config.supportEmail,
      outboundDriver: deps.outbound.name,
      billingEnabled: deps.config.billing.enabled,
      mxHosts: deps.config.mail.mxHosts,
      plans: Object.values(PLANS),
      meetings: !!deps.config.meetings,
      scheduling: deps.config.schedulingEnabled,
      flows: deps.config.flows !== false, // R90
      // R94: CRM timeline (CRM_TIMELINE): paged timeline, logged calls and notes, segments, CSV import, deal forecast.
      crmTimeline: !!deps.config.crmTimeline,
      // R91: dashboards plus (DASHBOARDS_PLUS): share, reports, question builder, alerts, data sources.
      dashboardsPlus: !!deps.config.dashboardsPlus,
      // R98: typo tolerant search with filters and instant results in the command menu (SEARCH_R98).
      searchR98: !!deps.config.searchR98,
      // R115: maps (MAPS_R115): address cards, visit routes, booking meeting place.
      maps: !!deps.config.mapsR115,
      // R59: chat channels (WhatsApp, Messenger, Instagram), CHAT_CHANNELS=on. Off: no pane, menu entry or chat rows.
      chatChannels: deps.config.channels.enabled,
      // R111: mail archive and retention (MAIL_ARCHIVE_R111=on): the Archive and retention pane and Audit log filters.
      mailArchive: !!deps.config.mailArchive,
      // Tools P1: whether the Tools page and its menu entries show (TOOLS_ENABLED with an engine configured).
      tools: deps.config.tools.enabled,
      // Tools P2: the P2 features on here (TOOLS_FEATURES), so menus can follow each flag without another request.
      toolFeatures: deps.config.tools.enabled ? activeToolFeatures(deps) : [],
      // R122: the help center in Docs (HELP_CENTER=on).
      helpCenter: !!deps.config.helpCenter,
      davSync: !!deps.config.davSync,
      // R103: Docs plus (DOCS_PLUS_R103=on).
      docsPlus: !!deps.config.docsPlus,
      // R43: whether the import pages say a run carries on after the page closes (BACKGROUND_COPY).
      backgroundCopy: !!deps.config.backgroundCopy,
      // R89: whiteboards, diagrams, mind map and Present in Docs (DOCS_VISUAL; on unless "off").
      docsVisual: deps.config.docsVisual !== false,
      // Round 25: provider connections shown as sign in buttons (AUTH0_SOCIAL_CONNECTIONS).
      socialConnections: deps.config.auth.socialConnections ?? [],
      // R32: the VAPID public key a browser subscribes with (absent when web push is off).
      vapidPublicKey: deps.config.webPush?.publicKey ?? null,
      // A browser DSN is public by design (it can only submit events).
      sentry: deps.config.sentry.dsnWeb
        ? { dsn: deps.config.sentry.dsnWeb, environment: deps.config.sentry.environment, release: deps.config.release, tracesSampleRate: deps.config.sentry.tracesSampleRate }
        : null,
    }),
  );

  // ANALYTICS-PH: a successful key action (send mail, new task, invite...) is recorded after the response (off unless ANALYTICS_PH).
  app.use("/api/*", productAnalyticsActions);
  app.route("/api/account", accountRoutes());
  app.route("/api/contact", contactFormRoutes());
  app.route("/api/admin/app-config", adminAppConfigRoutes()); // R29b: mobile remote config
  app.route("/api/admin/reports", adminReportsRoutes()); // R35: moderation queue (Apple 1.2)
  app.route("/api/admin", adminRoutes());
  // Better Auth: sign-up/in, sessions, 2FA, password reset, verification, organizations, OAuth.
  // R39 security hotfix: Better Auth's own organization endpoints (list, read and accept invitations, members,
  // roles) are not used by any client; the app's /api/team and /api/invites routes carry the checks. Closed over HTTP;
  // the server still calls them in process through auth.api.
  app.all("/api/auth/organization/*", (c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));
  app.on(["GET", "POST"], "/api/auth/*", (c) => authFor(deps).handler(c.req.raw));
  app.route("/api/domains", domainRoutes());
  app.route("/api/mailboxes", mailboxRoutes());
  app.route("/api/free-address", freeAddressRoutes());
  app.route("/api/tools/editors", toolsEditorsRoutes()); // Tools P2: editors (page editor, forms, compare)
  app.route("/api/tools/ai", toolsAiRoutes()); // Tools P2: AI documents (ask, translate, invoices, expenses, contracts)
  app.route("/api/tools/share", toolsShareRoutes()); // Tools P2: share links
  app.route("/api/tools/requests", toolsRequestRoutes()); // R88: file requests
  app.route("/api/portals", portalRoutes()); // R120: client portals
  app.route("/api/mail-archive", mailArchiveRoutes()); // R111: mail archive and retention (MAIL_ARCHIVE_R111)
  app.route("/api/tools/secrets", toolsSecretRoutes()); // R88: secret links
  app.route("/api/links", linksRoutes()); // R87: short links, bio pages, go links, link domain
  app.route("/api/tools/esign", toolsEsignRoutes()); // Tools P2: e-sign
  app.route("/api/tools", toolsRoutes()); // Tools P1: document tools (off unless TOOLS_ENABLED)
  app.route("/api/tools/campaigns", campaignRoutes()); // R109 (flag merge_plus_r109)
  app.route("/api/tools", toolsAutomationRoutes()); // Tools P2: automation (rules, workflows, templates, mail merge)
  app.route("/api/mail-merge", mailMergeUnsubscribeRoutes());
  app.route("/api/campaign-public", campaignPublicRoutes()); // R109: one click unsubscribe, counts, signup (cookie free, token keyed) // Tools P2: automation (public mail merge unsubscribe)
  app.route("/api/attachment-files", attachmentIndexRoutes()); // Tools P2: attachment index and smart folders
  app.route("/api/connections/webhooks", directWebhookRoutes()); // R83: before the session routes below
  app.route("/api/connections", connectionRoutes());
  app.route("/api/direct", directSocialRoutes()); // R83: own TikTok and Threads connections
  app.route("/", deleteAccountCallbackRoutes()); // R83: POST /delete-account (Threads uninstall and delete callbacks)
  app.route("/api/apps", appConnectionRoutes()); // R80C: Connections hub
  app.route("/api/social", socialRoutes()); // R80C: social posts
  app.route("/api/fx", fxRoutes());
  app.route("/api/aliases", aliasRoutes());
  app.route("/api/org", orgRoutes());
  app.route("/api/branding", brandingRoutes()); // R77: workspace branding and personal themes
  app.route("/api/channels", channelRoutes()); // C1: chat channels in the shared inbox
  if (deps.config.chatPlus !== false) {
    // R96: chat plus: topics, announcements, decision votes, polls, live Q&A and word clouds.
    app.route("/api/chat-plus", chatPlusRoutes());
    app.route("/api/guest/chat-plus", guestChatPlusRoutes());
  }
  if (deps.config.helpdesk !== false) {
    // R119: helpdesk mode, the website chat (public, CORS for the workspace's own domains) and the one tap survey.
    app.route("/api/helpdesk", helpdeskRoutes());
    app.route("/api/widget", widgetRoutes());
    app.get("/widget.js", (c) => c.body(WIDGET_JS, 200, WIDGET_JS_HEADERS));
    app.route("/csat", surveyRoutes());
  }
  if (deps.config.docsPlus) app.route("/api/docs-plus", docsPlusRoutes()); // R103: link library, clipper, doc comments
  if (deps.config.helpCenter) {
    // R122: the help center (team API) and its public pages /help/<slug> (only what a workspace published).
    app.route("/api/help-center", helpCenterRoutes());
    app.route("/help", helpPublicRoutes());
  }
  app.route("/api/mail/snippets", mailSnippetRoutes()); // Round 22: saved replies
  app.route("/api/mail/splits", mailSplitRoutes()); // R31: split inbox
  app.route("/api/mail/rules", mailRuleRoutes()); // R85: mail rules with several actions
  app.route("/api/mail/labels", mailLabelRoutes()); // R85: thread labels
  app.route("/api/counts", countsRoutes()); // R34: unread counts for badges
  app.route("/api/reports", reportsRoutes()); // R35: report a message or person
  app.route("/api/blocks", blocksRoutes()); // R35: blocks
  app.route("/api/mail/prefs", mailPrefRoutes()); // R31: mail settings (read status)
  app.route("/api/mail/read-status", mailReadStatusRoutes()); // R31: read status of a sent message
  app.route("/api/mail", mailRoutes());
  app.route("/api/deliveries", deliveryRoutes());
  app.route("/api/dashboard", dashboardRoutes());
  app.route("/api/team", teamRoutes());
  app.route("/api/invites", inviteRoutes());
  app.route("/api/billing", billingRoutes());
  app.route("/api/analytics", productAnalyticsRoutes()); // ANALYTICS-PH: area opens from the browser
  app.route("/api/mail-access", mailAccessRoutes());
  app.route("/api/mail-schedules", mailScheduleRoutes());
  app.route("/api/sprints", sprintRoutes());
  app.route("/api/workload", workloadRoutes()); // R24.2: workload view
  app.route("/api/dashboards", savedDashboardRoutes()); // R24.3: dashboards
  app.route("/api/computed", computedRoutes()); // R24.1: formula and rollup fields
  app.route("/api/triage", triageRoutes());
  app.route("/api/threads", threadCommentRoutes()); // Round 22: internal notes on shared inbox threads
  app.route("/api/threads", threadStateRoutes()); // Round 22: assign, done, reply times
  app.route("/api/threads", threadCollabRoutes()); // Round 22: thread presence and shared drafts
  app.route("/api/developer", developerRoutes());
  app.route("/api/oauth", oauthRoutes());
  app.on(["GET", "HEAD", "PROPFIND", "OPTIONS"], ["/.well-known/caldav", "/.well-known/carddav"], davWellKnown); // R99
  app.route("/.well-known", oauthWellKnownRoutes());
  app.route("/api/agents", agentRoutes());
  app.route("/api/approvals", approvalRoutes());
  app.route("/api/ai", aiRoutes());
  app.route("/api/projects", projectRoutes());
  app.route("/api/tasks", taskBacklinkRoutes()); // R24.5: GET /api/tasks/:id/backlinks
  app.route("/api/tasks", checklistTaskRoutes()); // R26 (MB-85): /api/tasks/:id/checklist
  app.route("/api/checklist-items", checklistItemRoutes()); // R26 (MB-85)
  app.route("/api/tasks", agentRunTaskRoutes()); // R27 (DF-3 slice 2): /api/tasks/:id/runs
  app.route("/api/agent-runs", agentRunRoutes()); // R27 (DF-3 slice 2)
  app.route("/api/agent-triggers", agentTriggerRoutes()); // R28 (DF-3 slice 3)
  app.route("/api/hooks/agent-runs", agentTriggerHookRoutes()); // R28 (DF-3 slice 3): public, signed
  app.route("/api/tasks", taskTeardownRoutes()); // R27 teardown: /api/tasks/:id/watchers, /duplicate
  app.route("/api/tasks", taskRoutes());
  app.route("/api/tasks", taskBulkRoutes()); // Round 21: POST /api/tasks/bulk and /bulk-delete
  app.route("/api/docs", docTreeRoutes()); // R24.5: tree, move, backlinks (before /:id)
  app.route("/api/docs", docVersionRoutes()); // R39: page history
  app.route("/api/docs", docRoutes());
  app.route("/api/contacts", contactRoutes());
  app.route("/api/companies", companyRoutes());
  app.route("/api/deals", dealRoutes());
  app.route("/api/crm", crmRoutes()); // R94: CRM timeline (404 unless CRM_TIMELINE)
  app.route("/api/maps", mapsRoutes()); // R115: maps (404 unless MAPS_R115)
  app.route("/api/automations/recipes", automationRecipeRoutes()); // R24.4: automation recipes
  app.route("/api/automations", automationRoutes());
  app.route("/api/flows", flowRoutes()); // R90: automation builder
  app.route("/api/notifications", notificationRoutes());
  app.route("/api/catchup", catchupRoutes()); // R31
  app.route("/api/push/web", webPushRoutes()); // R32: browser notifications (web push)
  app.route("/api/push", pushRoutes());
  app.route("/api/changes", changeRoutes());
  app.route("/api/time", timeRoutes());
  app.route("/api/forms", formRoutes());
  app.route("/api/forms", formResultsRoutes()); // R31: logic and results
  app.route("/api/reports", reportRoutes());
  app.route("/api/meetings", meetingRoutes());
  app.route("/api/meeting-notes", meetingNotesRoutes()); // Round 23: agenda and notes doc, action items
  app.route("/api/meetings", meetingRecordingRoutes()); // Round 23: recording and transcript
  app.route("/api/meeting-live", meetingLiveRoutes()); // R31: call notes and the So far digest
  app.route("/api/public/meeting-live", publicMeetingLiveRoutes()); // R31: guest read only notes
  app.route("/api/meeting-lobby", meetingLobbyRoutes()); // R32: waiting room (members)
  app.route("/api/public/meeting-lobby", publicMeetingLobbyRoutes()); // R32: waiting room (guests)
  app.route("/api/public", publicRoutes());
  app.route("/api/check", checkRoutes());
  app.route("/api/fields", fieldRoutes());
  app.route("/api/portfolio", portfolioRoutes());
  app.route("/api/guests", guestAdminRoutes());
  app.route("/api/files", fileRoutes());
  app.route("/api/doc-images", docImageRoutes()); // R32: images in docs (file storage only)
  app.route("/api/tools-c2", toolsC2Routes()); // R100b: link preview (SSRF guarded)
  app.route("/api/img", imageLinkRoutes()); // R100b: image links (resize, crop, format)
  // Round 20: search everything and My Work (reads only). Guest search sits before the guest routes.
  app.route("/api/search", searchRoutes());
  app.route("/api/my-work", myWorkRoutes());
  app.route("/api/guest/search", guestSearchRoutes());
  app.route("/api/guest/r26", guestChecklistRoutes()); // R26 (MB-85): a guest reads checklists in their project
  app.route("/api/guest/r24", guestDocTreeRoutes()); // R24.5: a guest's page tree and backlinks
  app.route("/api/guest", guestRoutes());
  app.route("/api/imports", importRoutes());
  app.route("/api/work-imports", workImportRoutes());
  // R38 move your data: the download link (token, no session) first, then the signed in routes.
  app.route("/api/data-moves", dataMoveDownloadRoutes());
  app.route("/api/data-moves", dataMoveRoutes());
  app.route("/api/import-runner", importRunnerRoutes());
  app.route("/api/integrations", integrationRoutes());
  app.route("/api/epics", epicRoutes());
  app.route("/api/calendar", calendarRoutes()); // Round 23: calendar feed and other calendars
  app.route("/cal", calendarFeedRoutes()); // Round 23: public calendar feed /cal/<token>.ics
  app.route("/api/dav", davSettingsRoutes()); // R99: app passwords for calendar and contacts sync
  app.route("/dav", davRoutes()); // R99: CalDAV and CardDAV with app passwords
  app.route("/api/share-links", shareLinkRoutes()); // R26 (MB-87): read only share links
  app.route("/api/dashboards-plus", dashboardsPlusRoutes()); // R91: links, reports, alerts, sources, questions
  app.route("/api/dash-public", dashboardsPublicRoutes()); // R91: public dashboard links and report unsubscribe
  app.route("/s", sharePageRoutes()); // R26 (MB-87): the public page /s/<token>
  app.route("/d", sharePublicRoutes()); // Tools P2: share links, the public page /d/<token>
  app.route("/u", requestPublicRoutes()); // R88: file requests, the public upload page /u/<token>
  app.route("/p", portalPublicRoutes()); // R120: client portals, the public space /p/<key>
  app.route("/x", secretPublicRoutes()); // R88: secret links, the public page /x/<token>#key
  app.route("/l", linkPublicRoutes()); // R87: short links /l/<code>
  app.route("/bio", bioPublicRoutes()); // R87: link in bio pages /bio/<slug>
  app.route("/sign", esignPublicRoutes()); // Tools P2: e-sign, the public signing page /sign/<token>
  app.route("/r/o", openPixelRoutes()); // R31: read status open image /r/o/<token>.gif (public)
  // The public API is the biggest part of the app to build (about 150 OpenAPI routes, roughly
  // 10 ms of CPU), so it is built the first time an /api/v1 request arrives rather than on
  // every new isolate. On the Workers Free plan the first request of an isolate pays for
  // the build, and with it every API call there went over the 10 ms CPU limit and was
  // answered 503 with an empty body (round 8 and 9 load tests).
  let v1: ReturnType<typeof v1Routes> | undefined;
  const buildV1 = () => {
    if (v1) return;
    v1 = v1Routes();
    v1.notFound((c) => c.json({ error: { code: "not_found", message: "No such endpoint." } }, 404));
    v1.onError(errorHandler);
  };
  // R45 (MB-199): the Worker builds it at isolate startup instead (src/entry/worker.ts startupBoot, its own and much
  // larger CPU allowance), so the first /api/v1 request of a new isolate no longer pays for it.
  appPrebuild.set(app, buildV1);
  const v1Handler = (c: Context<AppEnv>) => {
    if (!v1) buildV1();
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice("/api/v1".length) || "/";
    const req = new Request(url, c.req.raw);
    v1ParentVars.set(req, { deps: c.var.deps, ip: c.var.ip, requestId: c.var.requestId, log: c.var.log });
    let ctx: Parameters<ReturnType<typeof v1Routes>["fetch"]>[2];
    try { ctx = c.executionCtx; } catch { ctx = undefined; }
    return v1!.fetch(req, c.env, ctx);
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
  app.route("/api/v1/app-config", appConfigRoutes()); // R29b: public mobile remote config, before the lazy v1 API
  app.all("/api/v1", v1Handler);
  app.all("/api/v1/*", v1Handler);
  app.route("/api/webhooks/resend", resendWebhookRoutes());
  app.route("/api/auth-hooks", authHookWebhookRoutes());
  app.route("/api/auth-email-settings", authEmailSettingsRoutes()); // R27: Sign-up emails settings
  app.route("/api/webhooks/meta", metaWebhookRoutes()); // C1: WhatsApp, Messenger and Instagram webhooks (signed)
  app.route("/api/webhooks", providerWebhookRoutes());
  app.route("/api/deliverability", deliverabilityRoutes());
  app.route("/api/inbound-keys", inboundKeyRoutes());
  app.route("/api/inbound", inboundWebhookRoutes());

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return app;
}

export type App = ReturnType<typeof createApp>;
