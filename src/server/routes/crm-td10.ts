/**
 * TD10 (CRM_TD10; 404 when off). Signed in, never cached.
 *   GET  /api/crm-td10/suggestions                 open suggestions from mailboxes the viewer may read
 *   POST /api/crm-td10/suggestions/scan            read recent mail by rules (429 within a minute)
 *   POST /api/crm-td10/suggestions/:id/accept      { name?, title?, phone?, company?, due?, stepTitle? }
 *   POST /api/crm-td10/suggestions/:id/discard, POST /api/crm-td10/suggestions/:id/undo
 *   GET  /api/crm-td10/analyses/templates, GET/POST /api/crm-td10/analyses, PATCH/DELETE /api/crm-td10/analyses/:id
 *   POST /api/crm-td10/analyses/run { template, filters, tz }, GET /api/crm-td10/analyses/:id/run?tz=
 *   GET/PUT /api/crm-td10/prefs { shortcutsOff }
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { validZone } from "../services/suite/dash-r91-common";
import { TEMPLATE_INFO, ANALYSIS_TEMPLATES } from "../../shared/crm-td10";
import {
  AcceptEdits, AnalysisCreate, AnalysisPatch, FiltersInput, TemplateName, acceptSuggestion, createAnalysis, deleteAnalysis, discardSuggestion,
  getPrefs, listAnalyses, listSuggestions, runAnalysis, runSaved, scanMail, setPrefs, undoDiscard, updateAnalysis,
} from "../services/crm-td10";
import { flagOn } from "../services/console/flag-gate"; // OPS1 feature flags

const IdParam = /^[A-Za-z0-9_-]{1,64}$/;
const zone = (tz: unknown) => (typeof tz === "string" && validZone(tz) ? tz : "UTC");

export function crmTd10Routes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!(await flagOn(c, "crmTd10"))) throw new HttpError(404, "not_found", "Page not found."); await next(); }) // OPS1: per workspace flag
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      c.header("Cache-Control", "private, no-store");
      const id = c.req.param("id");
      if (id !== undefined && !IdParam.test(id)) throw new HttpError(404, "not_found", "Not found.");
      await next();
    })
    .get("/suggestions", async (c) => c.json(await listSuggestions(c.var.deps, c.var.auth)))
    .post("/suggestions/scan", async (c) => c.json(await scanMail(c.var.deps, c.var.auth)))
    .post("/suggestions/:id/accept", async (c) => c.json(await acceptSuggestion(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AcceptEdits.default({})))))
    .post("/suggestions/:id/discard", async (c) => c.json(await discardSuggestion(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/suggestions/:id/undo", async (c) => c.json(await undoDiscard(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/analyses/templates", (c) => c.json({ items: ANALYSIS_TEMPLATES.map((id) => ({ id, ...TEMPLATE_INFO[id] })) }))
    .get("/analyses", async (c) => c.json(await listAnalyses(c.var.deps, c.var.auth)))
    .post("/analyses", async (c) => c.json(await createAnalysis(c.var.deps, c.var.auth, await parseBody(c, AnalysisCreate)), 201))
    .post("/analyses/run", async (c) => {
      const b = await parseBody(c, z.object({ template: TemplateName, filters: FiltersInput.default({}), tz: z.string().max(64).optional() }).strict());
      return c.json({ result: await runAnalysis(c.var.deps, c.var.auth, b.template, b.filters, zone(b.tz)) });
    })
    .get("/analyses/:id/run", async (c) => c.json(await runSaved(c.var.deps, c.var.auth, c.req.param("id"), zone(c.req.query("tz")))))
    .patch("/analyses/:id", async (c) => c.json(await updateAnalysis(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, AnalysisPatch))))
    .delete("/analyses/:id", async (c) => c.json(await deleteAnalysis(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/prefs", async (c) => c.json(await getPrefs(c.var.deps, c.var.auth)))
    .put("/prefs", async (c) => c.json(await setPrefs(c.var.deps, c.var.auth, await parseBody(c, z.object({ shortcutsOff: z.boolean() }).strict()))));
}
