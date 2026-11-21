/**
 * R111: mail archive and retention (flag MAIL_ARCHIVE_R111=on; off: every route here answers 404).
 *   GET    /api/mail-archive/policy                     the policy that applies (members: read only view)
 *   POST   /api/mail-archive/policy/preview             { keepYears }  dry run: what it would delete today (admin)
 *   PUT    /api/mail-archive/policy                     { enabled, keepYears, confirmEligible }  (admin; the count must match the dry run)
 *   GET    /api/mail-archive/holds  POST /holds  POST /holds/:id/release   GET /holds/targets   (admin)
 *   POST   /api/mail-archive/search                     { filters, cursor? }   (admin, audit logged)
 *   GET    /api/mail-archive/cases  POST /cases  DELETE /cases/:id  GET /cases/:id/export (ZIP, admin, audit logged)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { ArchiveFilters, MAX_KEEP_YEARS, MIN_KEEP_YEARS } from "@/shared/mail-archive";
import {
  caseFileName, caseForExport, createCase, deleteCase, exportCase, holdTargets, listCases, listHolds, placeHold, previewRetention, releaseHold,
  retentionView, savePolicy, searchArchive,
} from "../services/mail/archive-r111";
import { flagOn } from "../services/console/flag-gate"; // OPS1 feature flags

const Years = z.number().int().min(MIN_KEEP_YEARS).max(MAX_KEEP_YEARS).nullable();
const PolicyBody = z.object({ enabled: z.boolean(), keepYears: Years, confirmEligible: z.number().int().min(0).optional() });
const HoldBody = z.object({ kind: z.enum(["mailbox", "person"]), targetId: z.string().min(1).max(64), name: z.string().max(120), note: z.string().max(1000).nullable().optional() });
const SearchBody = z.object({ filters: ArchiveFilters.default({}), cursor: z.string().max(100).optional() });
const CaseBody = z.object({ name: z.string().max(120), filters: ArchiveFilters.default({}) });

export function mailArchiveRoutes() {
  const exports = new RateLimiter(20, 60 * 60_000); // case exports a person can start in an hour
  const searches = new RateLimiter(120, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!(await flagOn(c, "mailArchive"))) throw notFound("Page"); await next(); }) // OPS1: per workspace flag
    .use("*", requireAuth)
    .get("/policy", async (c) => c.json({ policy: await retentionView(c.var.deps, c.var.auth) }))
    .post("/policy/preview", async (c) => {
      const b = await parseBody(c, z.object({ keepYears: Years }));
      return c.json({ preview: await previewRetention(c.var.deps, c.var.auth, b.keepYears) });
    })
    .put("/policy", async (c) => c.json({ policy: await savePolicy(c.var.deps, c.var.auth, await parseBody(c, PolicyBody)) }))
    .get("/holds", async (c) => c.json(await listHolds(c.var.deps, c.var.auth)))
    .get("/holds/targets", async (c) => c.json(await holdTargets(c.var.deps, c.var.auth)))
    .post("/holds", async (c) => c.json({ hold: await placeHold(c.var.deps, c.var.auth, await parseBody(c, HoldBody)) }))
    .post("/holds/:id/release", async (c) => c.json({ hold: await releaseHold(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/search", async (c) => {
      const b = await parseBody(c, SearchBody);
      if (!b.cursor && !searches.take(c.var.auth.userId)) throw tooMany("Too many searches in the last hour. Try again later.");
      return c.json(await searchArchive(c.var.deps, c.var.auth, b.filters, b.cursor));
    })
    .get("/cases", async (c) => c.json(await listCases(c.var.deps, c.var.auth)))
    .post("/cases", async (c) => c.json({ case: await createCase(c.var.deps, c.var.auth, await parseBody(c, CaseBody)) }))
    .delete("/cases/:id", async (c) => { await deleteCase(c.var.deps, c.var.auth, c.req.param("id")); return c.json({ ok: true }); })
    .get("/cases/:id/export", async (c) => {
      const kase = await caseForExport(c.var.deps, c.var.auth, c.req.param("id"));
      if (!exports.take(c.var.auth.userId)) throw tooMany("Too many exports in the last hour. Try again later.");
      const day = c.var.deps.now().toISOString().slice(0, 10);
      return new Response(exportCase(c.var.deps, c.var.auth, kase), {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="${caseFileName(kase.name, day)}"`, "cache-control": "no-store" },
      });
    });
}
