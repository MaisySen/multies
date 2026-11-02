/**
 * R31: form logic and results over the cookie session (/api/forms/:id/...) and the public API
 * (/api/v1/forms/{id}/...). Same services as the MCP tools form_logic_set and form_results
 * (services/suite/form-results.ts).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import type { SuiteActor } from "../services/suite/common";
import { formResponses, formResponsesCsv, formSummary, setFieldLogic } from "../services/suite/form-results";

export const LogicCondition = z.object({
  field: z.string().min(1).max(40),
  op: z.enum(["is", "is_not", "contains", "answered", "not_answered", "gt", "lt"]),
  value: z.string().max(200).optional(),
});
export const FieldLogicSchema = z.object({ join: z.enum(["all", "any"]).default("all"), conditions: z.array(LogicCondition).max(10),
  // TD2 (FORMS_TD2): groups of conditions and "hide when"; dropped by the service with the flag off.
  groups: z.array(z.object({ join: z.enum(["all", "any"]).default("all"), conditions: z.array(LogicCondition).max(10) })).max(5).optional(), action: z.enum(["show", "hide"]).optional() }).nullable();
export const FieldRulesSchema = z.object({
  minLength: z.number().int().min(0).max(100_000).optional(), maxLength: z.number().int().min(0).max(100_000).optional(),
  min: z.number().optional(), max: z.number().optional(),
  minSelected: z.number().int().min(0).max(50).optional(), maxSelected: z.number().int().min(0).max(50).optional(),
  pattern: z.string().max(200).optional(), patternMessage: z.string().max(120).optional(),
}).nullable();
/** R31 routing: when a question's answer matches, the task goes to this project and/or person. */
export const FormRouteSchema = z.object({ when: LogicCondition, projectId: z.string().max(60).nullable().optional(), assigneeId: z.string().max(80).nullable().optional() });
export const FormLogicBody = z.object({ logic: FieldLogicSchema.optional(), rules: FieldRulesSchema.optional(), required: z.boolean().optional() });
export const ResponsesQuerySchema = z.object({
  q: z.string().max(100).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional(),
  sort: z.string().max(40).optional(), dir: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export const SummaryQuerySchema = z.object({ q: z.string().max(100).optional(), from: z.string().max(30).optional(), to: z.string().max(30).optional() });

const csvResponse = (r: { filename: string; csv: string }) => new Response(r.csv, {
  headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${r.filename}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
});

export function formResultsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:id/responses", async (c) => c.json(await formResponses(c.var.deps, c.var.auth.orgId, c.req.param("id"), parseQuery(c, ResponsesQuerySchema))))
    .get("/:id/responses.csv", async (c) => csvResponse(await formResponsesCsv(c.var.deps, c.var.auth.orgId, c.req.param("id"), parseQuery(c, SummaryQuerySchema))))
    .get("/:id/summary", async (c) => c.json(await formSummary(c.var.deps, c.var.auth.orgId, c.req.param("id"), parseQuery(c, SummaryQuerySchema))))
    .put("/:id/fields/:fieldId/logic", requireAdmin, async (c) => c.json(await setFieldLogic(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("fieldId"), await parseBody(c, FormLogicBody))));
}

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });
const IdField = Id.extend({ fieldId: z.string().min(1).max(40).openapi({ param: { name: "fieldId", in: "path" } }) });
const Any = z.record(z.string(), z.unknown());
const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown) => c.json(data as any, 200) as any;

export function registerFormsR31Routes(api: OpenAPIHono<AppEnv>) {
  api.openapi(createRoute({ method: "get", path: "/forms/{id}/responses", tags: ["Forms"], summary: "A form's responses, a page at a time", security: secured,
    description: "Newest first. q searches every answer, from and to (YYYY-MM-DD) filter by day, sort is createdAt or a question id with dir asc or desc, limit up to 200 with offset.",
    request: { params: Id, query: ResponsesQuerySchema }, responses: { 200: json(Any, "{ fields, responses, total, limit, offset }"), 401: err("Missing or invalid API key."), 404: err("Not found."), 422: err("Validation failed.") } }),
  async (c) => send(c, await formResponses(c.var.deps, actor(c).orgId, c.req.valid("param").id, c.req.valid("query"))));

  api.openapi(createRoute({ method: "get", path: "/forms/{id}/summary", tags: ["Forms"], summary: "A summary per question", security: secured,
    description: "Counts per option for choice questions, average, min and max for numbers, the latest answers for text. Looks at up to 10,000 of the newest matching responses.",
    request: { params: Id, query: SummaryQuerySchema }, responses: { 200: json(Any, "{ total, firstAt, lastAt, capped, questions }"), 401: err("Missing or invalid API key."), 404: err("Not found.") } }),
  async (c) => send(c, await formSummary(c.var.deps, actor(c).orgId, c.req.valid("param").id, c.req.valid("query"))));

  api.openapi(createRoute({ method: "put", path: "/forms/{id}/fields/{fieldId}/logic", tags: ["Forms"], summary: "Set a question's logic and rules", security: secured,
    description: "logic { join: all | any, conditions: [{ field, op, value }] } shows the question only when the conditions hold; a condition can only use a question above it (422 later, cycle or self). rules: minLength, maxLength, min, max, minSelected, maxSelected, pattern, patternMessage. null clears either.",
    request: { params: IdField, body: { required: true, content: { "application/json": { schema: FormLogicBody } } } },
    responses: { 200: json(Any, "{ form, field }"), 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } }),
  async (c) => { const p = c.req.valid("param"); return send(c, await setFieldLogic(c.var.deps, actor(c), p.id, p.fieldId, c.req.valid("json"))); });
}
