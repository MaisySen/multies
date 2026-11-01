/**
 * R125: tables API (signed in, flag TABLES_R125; vv8k and TABLES_EXCLUDE workspaces get 404).
 *   GET /api/tables (list, for linked record fields), POST /api/tables (blank or template), POST /api/tables/import (CSV into a new table)
 *   GET /api/tables/:id, PATCH /api/tables/:id/settings
 *   POST /api/tables/:id/fields, PATCH|DELETE /api/tables/:id/fields/:fid
 *   GET /api/tables/:id/rows?view&cursor&limit&q&sort&filters, POST /api/tables/:id/rows, PATCH /api/tables/:id/rows (batch),
 *   POST /api/tables/:id/rows/delete | restore, GET /api/tables/:id/rows/:rid
 *   POST /api/tables/:id/views, PATCH|DELETE /api/tables/:id/views/:vid, POST /api/tables/:id/views/:vid/submit (form)
 *   POST /api/tables/:id/import (CSV into this table), GET /api/tables/:id/export.csv?view
 *   GET|POST /api/tables/:id/rows/:rid/comments, DELETE /api/tables/:id/comments/:cid, GET /api/tables/:id/rows/:rid/history
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import {
  addRowComment, assertTablesOn, createField, createRows, createTable, createView, deleteField, deleteRowComment, deleteRows, deleteView, exportCsv, getRow, importCsv,
  listRowComments, listRows, listTables, rowHistory, tableDetail, updateField, updateRows, updateSettings, updateView, type Viewer,
} from "../services/tables-r125";
import { FIELD_TYPES, FILTER_OPS, LIMITS, type TFilter, type TSort } from "@/shared/tables-r125";

const id = z.string().regex(/^[\w-]{1,64}$/);
const cellMap = z.record(z.string().max(64), z.unknown()).refine((o) => Object.keys(o).length <= LIMITS.fields, "Too many fields.");
const ViewCfg = z.object({
  sort: z.array(z.object({ fieldId: id, dir: z.enum(["asc", "desc"]) })).max(3).optional(),
  filters: z.array(z.object({ fieldId: id, op: z.enum(FILTER_OPS), value: z.string().max(200).optional() })).max(10).optional(),
  groupBy: id.nullable().optional(),
  hidden: z.array(id).max(LIMITS.fields).optional(),
  widths: z.record(z.string().max(64), z.number()).optional(),
  by: id.nullable().optional(),
  formFields: z.array(id).max(LIMITS.fields).optional(),
  formTitle: z.string().max(120).optional(),
  formNote: z.string().max(1000).optional(),
}).strict();
const FieldIn = z.object({ name: z.string().max(200), type: z.enum(FIELD_TYPES), config: z.record(z.string(), z.unknown()).optional(), afterId: id.nullable().optional() });
const FieldPatch = z.object({ name: z.string().max(200).optional(), type: z.enum(FIELD_TYPES).optional(), config: z.record(z.string(), z.unknown()).optional(), width: z.number().nullable().optional(), position: z.number().optional() });
const ImportIn = z.object({
  title: z.string().max(200).optional(), parentId: id.nullable().optional(),
  columns: z.array(z.object({ name: z.string().max(200), type: z.enum(FIELD_TYPES), fieldId: id.nullable().optional(), skip: z.boolean().optional() })).min(1).max(LIMITS.fields),
  rows: z.array(z.array(z.string().max(LIMITS.longtext)).max(200)).max(LIMITS.importRows),
});

const member = (c: Context<AppEnv>): Viewer => ({ kind: "member", actor: c.var.auth });
function rowQuery(c: Context<AppEnv>) {
  const json = <T,>(k: string): T | undefined => {
    const v = c.req.query(k);
    if (!v) return undefined;
    try { return JSON.parse(v) as T; } catch { throw new HttpError(422, "bad_query", `${k} is not readable.`); }
  };
  const limit = Number(c.req.query("limit") ?? "");
  return {
    viewId: c.req.query("view") || undefined, cursor: c.req.query("cursor") || undefined, q: (c.req.query("q") ?? "").slice(0, 200) || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined, sort: json<TSort[]>("sort"), filters: json<TFilter[]>("filters"),
  };
}

export function tableRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { await assertTablesOn(c.var.deps, c.var.auth.orgId); await next(); })
    .get("/", async (c) => c.json({ tables: await listTables(c.var.deps, c.var.auth) }))
    .post("/", async (c) => {
      const b = await parseBody(c, z.object({ title: z.string().max(200).optional(), template: z.enum(["clients", "stock", "jobs"]).nullable().optional(), parentId: id.nullable().optional(), projectId: id.nullable().optional() }));
      return c.json({ table: await createTable(c.var.deps, c.var.auth, b) }, 201);
    })
    .post("/import", async (c) => c.json(await importCsv(c.var.deps, c.var.auth, await parseBody(c, ImportIn)), 201))
    .get("/:id", async (c) => c.json(await tableDetail(c.var.deps, member(c), c.req.param("id"))))
    .patch("/:id/settings", async (c) => c.json(await updateSettings(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({ editAccess: z.enum(["everyone", "admins"]) })))))
    .post("/:id/fields", async (c) => c.json({ field: await createField(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, FieldIn)) }, 201))
    .patch("/:id/fields/:fid", async (c) => c.json(await updateField(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("fid"), await parseBody(c, FieldPatch))))
    .delete("/:id/fields/:fid", async (c) => c.json(await deleteField(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("fid"))))
    .get("/:id/rows", async (c) => c.json(await listRows(c.var.deps, member(c), c.req.param("id"), rowQuery(c))))
    .post("/:id/rows", async (c) => {
      const b = await parseBody(c, z.object({ rows: z.array(cellMap).min(1).max(LIMITS.pasteRows) }));
      return c.json({ rows: await createRows(c.var.deps, c.var.auth, c.req.param("id"), b.rows) }, 201);
    })
    .patch("/:id/rows", async (c) => {
      const b = await parseBody(c, z.object({ rows: z.array(z.object({ id, cells: cellMap, version: z.number().int().optional() })).min(1).max(LIMITS.pasteRows) }));
      return c.json({ rows: await updateRows(c.var.deps, c.var.auth, c.req.param("id"), b.rows) });
    })
    .post("/:id/rows/delete", async (c) => c.json(await deleteRows(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ ids: z.array(id).min(1).max(LIMITS.pasteRows) }))).ids)))
    .post("/:id/rows/restore", async (c) => c.json(await deleteRows(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, z.object({ ids: z.array(id).min(1).max(LIMITS.pasteRows) }))).ids, true)))
    .get("/:id/rows/:rid", async (c) => c.json({ row: await getRow(c.var.deps, member(c), c.req.param("id"), c.req.param("rid")) }))
    .get("/:id/rows/:rid/comments", async (c) => c.json({ comments: await listRowComments(c.var.deps, member(c), c.req.param("id"), c.req.param("rid")) }))
    .post("/:id/rows/:rid/comments", async (c) => c.json({ comment: await addRowComment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("rid"), (await parseBody(c, z.object({ body: z.string().max(5000) }))).body) }, 201))
    .delete("/:id/comments/:cid", async (c) => c.json(await deleteRowComment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("cid"))))
    .get("/:id/rows/:rid/history", async (c) => c.json({ history: await rowHistory(c.var.deps, member(c), c.req.param("id"), c.req.param("rid")) }))
    .post("/:id/views", async (c) => c.json({ view: await createView(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, z.object({ name: z.string().max(200), type: z.enum(["grid", "kanban", "calendar", "form"]), config: ViewCfg.optional() }))) }, 201))
    .patch("/:id/views/:vid", async (c) => c.json({ view: await updateView(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("vid"), await parseBody(c, z.object({ name: z.string().max(200).optional(), config: ViewCfg.optional() }))) }))
    .delete("/:id/views/:vid", async (c) => c.json(await deleteView(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("vid"))))
    .post("/:id/views/:vid/submit", async (c) => {
      const b = await parseBody(c, z.object({ cells: cellMap }));
      return c.json({ rows: await createRows(c.var.deps, c.var.auth, c.req.param("id"), [b.cells], { formViewId: c.req.param("vid") }) }, 201);
    })
    .post("/:id/import", async (c) => c.json(await importCsv(c.var.deps, c.var.auth, { ...(await parseBody(c, ImportIn.omit({ title: true, parentId: true }))), docId: c.req.param("id") })))
    .get("/:id/export.csv", async (c) => {
      const { filename, csv } = await exportCsv(c.var.deps, member(c), c.req.param("id"), c.req.query("view") || undefined);
      return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/"/g, "")}"`, "cache-control": "no-store" });
    });
}
