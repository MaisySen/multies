/**
 * R91 Dashboards plus routes (DASHBOARDS_PLUS; 404 when off).
 * Signed in, /api/dashboards-plus: public links, emailed reports and alerts per dashboard, workspace data
 * sources, and the question builder's catalogue and live preview.
 * Public, /api/dash-public: open a link (password in the x-share-password header), its PDF, and the one
 * click unsubscribe from report mails. Public routes are rate limited per address.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { RateLimiter } from "../lib/rate-limit";
import { parseBody } from "./dashboards";
import { plusEnabled } from "../services/suite/dash-r91-common";
import { createShare, listShares, openShare, revokeShare, ShareCreate } from "../services/suite/dash-r91-share";
import { createReport, deleteReport, listReports, pdfForDashboard, ReportInput, sendReportNow, unsubscribe, updateReport } from "../services/suite/dash-r91-reports";
import { AlertInput, createAlert, deleteAlert, listAlerts, updateAlert } from "../services/suite/dash-r91-alerts";
import { createSource, deleteSource, listSources, refreshSource, SourceInput } from "../services/suite/dash-r91-sources";
import { questionCatalog, QuestionSpec, runQuestion } from "../services/suite/dash-r91-question";
import { readableMailboxes, zoneOffset } from "../services/suite/dashboards";
import { validZone } from "../services/suite/dash-r91-common";

const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));
const flagged: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!plusEnabled(c.var.deps)) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
  return next();
};

export function dashboardsPlusRoutes() {
  return new Hono<AppEnv>()
    .use("*", flagged)
    .use("*", requireAuth)
    .post("/test/run", async (c) => {
      if (!c.var.deps.config.dashboardsPlusTestHook) return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
      return c.json(await (await import("../services/suite/dash-r91-cron")).runDashboardsPlus(c.var.deps));
    })
    .get("/question/catalog", (c) => c.json(questionCatalog()))
    .post("/question/preview", async (c) => {
      const raw = (await body(c)) as { question?: unknown; tz?: string };
      const spec = parseBody(QuestionSpec, raw.question);
      const now = c.var.deps.now().getTime();
      const tz = raw.tz && validZone(raw.tz) ? raw.tz : "UTC";
      return c.json({ result: await runQuestion(c.var.deps, c.var.auth, spec, { mailboxes: () => readableMailboxes(c.var.deps, c.var.auth), offsetMin: Math.round(zoneOffset(now, tz) / 60_000), now }) });
    })
    .get("/sources", async (c) => c.json(await listSources(c.var.deps, c.var.auth)))
    .post("/sources", async (c) => c.json(await createSource(c.var.deps, c.var.auth, parseBody(SourceInput, await body(c))), 201))
    .post("/sources/:id/refresh", async (c) => c.json(await refreshSource(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/sources/:id", async (c) => c.json(await deleteSource(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/shares/:id", async (c) => c.json(await revokeShare(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/reports/:id", async (c) => c.json(await updateReport(c.var.deps, c.var.auth, c.req.param("id"), parseBody(ReportInput, await body(c)))))
    .delete("/reports/:id", async (c) => c.json(await deleteReport(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/reports/:id/send", async (c) => c.json(await sendReportNow(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/alerts/:id", async (c) => c.json(await updateAlert(c.var.deps, c.var.auth, c.req.param("id"), parseBody(AlertInput.partial(), await body(c)))))
    .delete("/alerts/:id", async (c) => c.json(await deleteAlert(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:dashboardId/shares", async (c) => c.json(await listShares(c.var.deps, c.var.auth, c.req.param("dashboardId"))))
    .post("/:dashboardId/shares", async (c) => c.json(await createShare(c.var.deps, c.var.auth, c.req.param("dashboardId"), parseBody(ShareCreate, await body(c))), 201))
    .get("/:dashboardId/reports", async (c) => c.json(await listReports(c.var.deps, c.var.auth, c.req.param("dashboardId"))))
    .post("/:dashboardId/reports", async (c) => c.json(await createReport(c.var.deps, c.var.auth, c.req.param("dashboardId"), parseBody(ReportInput, await body(c))), 201))
    .get("/:dashboardId/alerts", async (c) => c.json(await listAlerts(c.var.deps, c.var.auth, c.req.param("dashboardId"))))
    .post("/:dashboardId/alerts", async (c) => c.json(await createAlert(c.var.deps, c.var.auth, c.req.param("dashboardId"), parseBody(AlertInput, await body(c))), 201));
}

function limit(n: number, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  const local = new RateLimiter(n, 60_000);
  return async (c, next) => {
    let ok = local.take(key(c));
    const bound = c.var.deps.rateLimiters?.webhooks;
    if (ok && bound) ok = (await bound.limit({ key: `dashpub:${key(c)}` })).success;
    if (!ok) { c.header("retry-after", "60"); return c.json({ error: { code: "rate_limited", message: "Too many tries. Wait a minute and try again." } }, 429); }
    return next();
  };
}
const ip = (c: Context<AppEnv>) => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
const page = (title: string, text: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7f9;color:#16181d}@media(prefers-color-scheme:dark){body{background:#111317;color:#e8eaee}}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;line-height:1.5;opacity:.8}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

export function dashboardsPublicRoutes() {
  return new Hono<AppEnv>()
    .use("*", flagged)
    .use("*", async (c, next) => { await next(); c.header("x-robots-tag", "noindex"); c.header("cache-control", "no-store"); c.header("referrer-policy", "no-referrer"); })
    .get("/reports/unsubscribe", limit(30, ip), async (c) => {
      const ok = await unsubscribe(c.var.deps, c.req.query("r") ?? "", c.req.query("e") ?? "", c.req.query("t") ?? "");
      return c.html(ok ? page("You are unsubscribed", "You won't get this dashboard report any more. The person who set it up can add you again.") : page("That link didn't work", "It may be incomplete. Copy the whole link from the email and try again."), ok ? 200 : 400);
    })
    .get("/:token/pdf", limit(20, ip), async (c) => {
      const r = await openShare(c.var.deps, c.req.param("token"), { password: c.req.header("x-share-password") ?? undefined });
      if (r.status !== "ok") return c.html(page("This link isn't available", "It was turned off, it expired, or it needs a password. Ask the person who sent it."), r.status === "gone" ? 404 : 401);
      const pdf = await pdfForDashboard(r.dashboard);
      const name = r.dashboard.name.replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 60) || "dashboard";
      return new Response(pdf as BodyInit, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}.pdf"`, "cache-control": "no-store", "x-robots-tag": "noindex" } });
    })
    .get("/:token", limit(60, ip), async (c) => {
      const pw = c.req.header("x-share-password") ?? undefined;
      const r = await openShare(c.var.deps, c.req.param("token"), { password: pw, refresh: c.req.query("refresh") === "1" });
      if (r.status === "ok") return c.json({ dashboard: r.dashboard });
      if (r.status === "gone") return c.json({ error: { code: "not_found", message: "This link was turned off or it expired." } }, 404);
      return c.json({ error: { code: r.status, message: r.status === "password_wrong" ? "That password isn't right." : "This dashboard needs a password." } }, 401);
    });
}
