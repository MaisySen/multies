import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import {
  IMPORT_PROVIDERS, assertRunner, cancelImport, claimNext, createImport, finish, importEnabled, importMessage, listImports, reportProgress,
} from "../services/import";
import * as xero from "../services/integrations/xero";

export function importRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requireAdmin)
    .get("/", async (c) => c.json({
      enabled: importEnabled(c.var.deps),
      providers: Object.entries(IMPORT_PROVIDERS).map(([id, p]) => ({ id, label: p.label, help: p.help, host: p.host })),
      imports: await listImports(c.var.deps, c.var.auth.orgId),
    }))
    .post("/", async (c) => {
      const b = await parseBody(c, z.object({
        mailboxId: z.string(), provider: z.enum(["gmail", "outlook", "imap"]), sourceUser: z.string().trim().min(3).max(254),
        appPassword: z.string().min(4).max(200), sourceHost: z.string().trim().max(253).optional(), sourcePort: z.number().int().min(1).max(65535).optional(),
      }));
      return c.json({ import: await createImport(c.var.deps, c.var.auth, b) }, 201);
    })
    .post("/:id/cancel", async (c) => c.json({ import: await cancelImport(c.var.deps, c.var.auth, c.req.param("id")) }));
}

/** For the import runner only (IMPORT_RUNNER_TOKEN). */
export function importRunnerRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { assertRunner(c.var.deps, c.req.header("authorization")); await next(); })
    .post("/claim", async (c) => {
      const job = await claimNext(c.var.deps);
      return job ? c.json({ job }) : c.body(null, 204);
    })
    .post("/jobs/:id/progress", async (c) => {
      const b = await parseBody(c, z.object({ total: z.number().int().min(0).optional() }));
      await reportProgress(c.var.deps, c.req.param("id"), b);
      return c.json({ ok: true });
    })
    .post("/jobs/:id/messages", async (c) => {
      const raw = new Uint8Array(await c.req.arrayBuffer());
      if (!raw.byteLength) throw new HttpError(422, "validation_failed", "Empty message.");
      if (raw.byteLength > c.var.deps.config.maxMessageBytes * 3) throw new HttpError(413, "too_large", "Message too large.");
      const r = await importMessage(c.var.deps, c.req.param("id"), raw, { folder: c.req.header("x-mymail-folder") ?? "INBOX", seen: c.req.header("x-mymail-seen") !== "false" });
      return c.json(r, r.stored ? 201 : 200);
    })
    .post("/jobs/:id/finish", async (c) => {
      const b = await parseBody(c, z.object({ error: z.string().max(2000).optional() }));
      await finish(c.var.deps, c.req.param("id"), b);
      return c.json({ ok: true });
    });
}

const XERO_STATE = "mymail_xero_state";

export function integrationRoutes() {
  const redirect = (c: { req: { url: string } }) => `${new URL(c.req.url).origin}/api/integrations/xero/callback`;
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ xero: await xero.status(c.var.deps, c.var.auth.orgId) }))
    .get("/xero/connect", requireAdmin, (c) => {
      const { url, state } = xero.authorizeUrl(c.var.deps, redirect(c));
      setCookie(c, XERO_STATE, state, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/api/integrations/xero", maxAge: 600 });
      return c.redirect(url);
    })
    .get("/xero/callback", requireAdmin, async (c) => {
      const state = getCookie(c, XERO_STATE);
      deleteCookie(c, XERO_STATE, { path: "/api/integrations/xero" });
      const q = new URL(c.req.url).searchParams;
      if (!state || state !== q.get("state") || !q.get("code")) return c.redirect("/app/settings/general?xero=failed");
      await xero.connect(c.var.deps, c.var.auth, q.get("code")!, redirect(c));
      return c.redirect("/app/settings/general?xero=connected");
    })
    .get("/xero/invoices", async (c) => c.json({ invoices: await xero.unpaidInvoices(c.var.deps, c.var.auth.orgId) }))
    .delete("/xero", requireAdmin, async (c) => { await xero.disconnect(c.var.deps, c.var.auth); return c.json({ ok: true }); });
}
