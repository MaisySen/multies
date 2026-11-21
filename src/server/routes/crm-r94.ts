/**
 * R94 CRM timeline routes (CRM_TIMELINE; 404 when off).
 *   GET    /api/crm/timeline?type=contact|company&id=&cursor=&kinds=mail,note&limit=
 *   POST   /api/crm/entries, PATCH/DELETE /api/crm/entries/:id, POST /api/crm/entries/:id/restore
 *   POST   /api/crm/next-step
 *   POST   /api/crm/companies
 *   GET    /api/crm/contacts?segment=&q=&source=&noCompany=&hasOpenDeal=&lastWithinDays=&lastOlderThanDays=
 *   GET/POST /api/crm/segments, PATCH/DELETE /api/crm/segments/:id
 *   POST   /api/crm/import/check, POST /api/crm/import/batch
 *   GET    /api/crm/forecast
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { notFound } from "../lib/errors";
import {
  CALL_OUTCOMES, IMPORT_BATCH, TIMELINE_KINDS, createCompany, createEntry, createSegment, deleteEntry, deleteSegment, forecast, importBatch, importCheck,
  listSegments, restoreEntry, segmentContacts, setNextStep, timelinePage, updateEntry, updateSegment, type TimelineKind,
} from "../services/suite/crm-r94";
import { flagOn } from "../services/console/flag-gate"; // OPS1 feature flags

const EntryBody = z.object({
  entityType: z.enum(["contact", "company", "deal"]), entityId: z.string().min(1).max(64),
  kind: z.enum(["note", "call", "meeting"]), body: z.string().max(20_000).default(""),
  outcome: z.enum(CALL_OUTCOMES).nullable().optional(), durationMin: z.number().int().min(0).max(1440).nullable().optional(),
  occurredAt: z.string().max(40).nullable().optional(), private: z.boolean().optional(),
});
const EntryPatch = EntryBody.pick({ body: true, outcome: true, durationMin: true, occurredAt: true, private: true }).partial();
const NextStepBody = z.object({ entityType: z.enum(["contact", "company"]), entityId: z.string().min(1).max(64), title: z.string().trim().min(1).max(200), due: z.string().min(8).max(40) });
const CompanyBody = z.object({ name: z.string().trim().min(1).max(120), domain: z.string().trim().max(253).nullable().optional(), notes: z.string().max(20_000).optional() });
const Filters = z.record(z.string(), z.unknown());
const SegmentBody = z.object({ name: z.string().trim().min(1).max(60), filters: Filters.default({}), shared: z.boolean().optional() });
const SegmentPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), filters: Filters.optional() });
const CheckBody = z.object({ emails: z.array(z.string().max(254)).max(5000) });
const Row = z.object({ email: z.string().trim().email().max(254), name: z.string().max(120).default(""), phone: z.string().max(40).optional(), title: z.string().max(120).optional(), company: z.string().max(120).optional(), notes: z.string().max(2000).optional() });
const BatchBody = z.object({ rows: z.array(Row).min(1).max(IMPORT_BATCH), mode: z.enum(["skip", "update"]).default("skip") });

export function crmRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { if (!(await flagOn(c, "crmTimeline"))) throw notFound("Page"); await next(); }) // OPS1: per workspace flag
    .use("*", requireAuth)
    .get("/timeline", async (c) => {
      const type = c.req.query("type") === "company" ? "company" : "contact";
      const kinds = (c.req.query("kinds") ?? "").split(",").filter((k): k is TimelineKind => (TIMELINE_KINDS as readonly string[]).includes(k));
      return c.json(await timelinePage(c.var.deps, c.var.auth, { type, id: c.req.query("id") ?? "", cursor: c.req.query("cursor"), kinds, limit: Number(c.req.query("limit")) || undefined }));
    })
    .post("/entries", async (c) => c.json({ entry: await createEntry(c.var.deps, c.var.auth, await parseBody(c, EntryBody)) }, 201))
    .patch("/entries/:id", async (c) => c.json({ entry: await updateEntry(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, EntryPatch)) }))
    .delete("/entries/:id", async (c) => c.json(await deleteEntry(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/entries/:id/restore", async (c) => c.json({ entry: await restoreEntry(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/next-step", async (c) => c.json({ nextStep: await setNextStep(c.var.deps, c.var.auth, await parseBody(c, NextStepBody)) }, 201))
    .post("/companies", async (c) => c.json({ company: await createCompany(c.var.deps, c.var.auth, await parseBody(c, CompanyBody)) }, 201))
    .get("/contacts", async (c) => {
      const q = c.req.query();
      let filters: Record<string, unknown> = { ...q };
      if (q.segment) {
        const seg = (await listSegments(c.var.deps, c.var.auth)).find((s) => s.id === q.segment);
        if (!seg) throw notFound("Segment");
        filters = { ...seg.filters, ...(q.q ? { q: q.q } : {}) };
      }
      return c.json(await segmentContacts(c.var.deps, c.var.auth, filters, { limit: Number(q.limit) || 100, offset: Number(q.offset) || 0 }));
    })
    .get("/segments", async (c) => c.json({ segments: await listSegments(c.var.deps, c.var.auth) }))
    .post("/segments", async (c) => c.json({ segment: await createSegment(c.var.deps, c.var.auth, await parseBody(c, SegmentBody)) }, 201))
    .patch("/segments/:id", async (c) => c.json({ segment: await updateSegment(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SegmentPatch)) }))
    .delete("/segments/:id", async (c) => c.json(await deleteSegment(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/import/check", async (c) => c.json(await importCheck(c.var.deps, c.var.auth.orgId, (await parseBody(c, CheckBody)).emails)))
    .post("/import/batch", async (c) => { const b = await parseBody(c, BatchBody); return c.json(await importBatch(c.var.deps, c.var.auth, b.rows, b.mode)); })
    .get("/forecast", async (c) => c.json(await forecast(c.var.deps, c.var.auth.orgId)));
}
