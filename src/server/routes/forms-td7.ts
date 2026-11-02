/**
 * TD7 Forms pro B routes (flag FORMS_TD7; every service checks the flag per workspace, excluded workspaces always off).
 *   Signed in, /api/forms (admins; other workspace 404):
 *     GET|PUT /:id/pro            brand kit, close date, response cap, save and resume, password (set or remove; never shown)
 *     GET     /:id/analytics      views, starts, completions, drop off per question
 *     GET     /:id/partials, DELETE /:id/partials/:pid   saved parts not yet sent
 *     POST    /td7/ai-draft       a form drafted from a sentence (workspace AI switch and own key; never our paid call)
 *   Public, /api/public (JSON only, per address limits, no cookies):
 *     POST /forms/:slug/password         { password } -> short lived access and the form
 *     POST /forms/:slug/partial        { answers, resume?, access? } -> signed resume link token, 7 days
 *     POST /forms/:slug/partial/load   { resume, access? } -> the saved answers
 *     POST /forms/:slug/events         { kind: view | start | reach, field? } -> 204
 *     GET  /forms/:slug/logo           the workspace logo the form shows, from our own origin
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { publicForm } from "../services/suite/forms";
import { aiDraft, analytics, deletePartial, formLogo, getPro, listPartials, loadPartial, putPro, recordEvent, savePartial, unlock } from "../services/forms-td7/pro";

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
const Token = z.string().max(200).optional().nullable();
const ProBody = z.object({ settings: z.record(z.string(), z.unknown()).optional(), password: z.string().max(200).nullable().optional() });

export function formsTd7Routes() {
  return new Hono<AppEnv>()
    .post("/td7/ai-draft", requireAuth, requireAdmin, async (c) => {
      const b = await parseBody(c, z.object({ prompt: z.string().max(2000) }));
      return c.json(await aiDraft(c.var.deps, actor(c), b.prompt));
    })
    .get("/:id/pro", requireAuth, requireAdmin, async (c) => c.json(await getPro(c.var.deps, actor(c), c.req.param("id"))))
    .put("/:id/pro", requireAuth, requireAdmin, async (c) => c.json(await putPro(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, ProBody))))
    .get("/:id/analytics", requireAuth, requireAdmin, async (c) => c.json(await analytics(c.var.deps, actor(c), c.req.param("id"))))
    .get("/:id/partials", requireAuth, requireAdmin, async (c) => c.json(await listPartials(c.var.deps, actor(c), c.req.param("id"))))
    .delete("/:id/partials/:pid", requireAuth, requireAdmin, async (c) => c.json(await deletePartial(c.var.deps, actor(c), c.req.param("id"), c.req.param("pid"))));
}

export function formsTd7PublicRoutes() {
  return new Hono<AppEnv>()
    .post("/forms/:slug/password", async (c) => {
      const b = await parseBody(c, z.object({ password: z.string().max(200) }));
      const slug = c.req.param("slug");
      const { access } = await unlock(c.var.deps, slug, b.password, c.var.ip);
      return c.json({ access, form: await publicForm(c.var.deps, slug, { access }) });
    })
    .post("/forms/:slug/partial/load", async (c) => {
      const b = await parseBody(c, z.object({ resume: z.string().max(200), access: Token }));
      return c.json(await loadPartial(c.var.deps, c.req.param("slug"), b.resume, b.access));
    })
    .post("/forms/:slug/partial", async (c) => {
      const b = await parseBody(c, z.object({ answers: z.record(z.string(), z.unknown()), resume: Token, access: Token }));
      return c.json(await savePartial(c.var.deps, c.req.param("slug"), b, c.var.ip));
    })
    .post("/forms/:slug/events", async (c) => {
      const b = await parseBody(c, z.object({ kind: z.string().max(10), field: z.string().max(60).optional() }));
      await recordEvent(c.var.deps, c.req.param("slug"), b, c.var.ip);
      return c.body(null, 204);
    })
    .get("/forms/:slug/logo", async (c) => {
      const l = await formLogo(c.var.deps, c.req.param("slug"), c.req.query("theme") === "dark");
      return c.body(l.bytes, 200, { "content-type": l.contentType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" });
    });
}
