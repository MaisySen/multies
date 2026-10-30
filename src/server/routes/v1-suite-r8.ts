/**
 * Round 8 in the public API (v1): custom fields, guests and the portfolio. A guest invite is
 * mail that leaves the business: from an agent key it follows that agent's approval rules.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { idempotentCreate } from "../lib/idempotency"; // R52 (MB-239)
import type { Context } from "hono";
import type { AppEnv } from "../context";
import type { SuiteActor } from "../services/suite/common";
import { createField, deleteField, listFields, updateField } from "../services/suite/fields";
import { inviteGuest, listGuests, revokeGuest } from "../services/suite/guests";
import { portfolio } from "../services/suite/portfolio";
import { getAgent } from "../services/agents";
import { HttpError } from "../lib/errors";
import { FieldCreate, FieldPatch, GuestInvite } from "./suite-schemas";

const ErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) });
const err = (description: string) => ({ description, content: { "application/json": { schema: ErrorSchema } } });
const errors = { 401: err("Missing or invalid API key."), 403: err("The key can't do this."), 404: err("Not found."), 422: err("Validation failed.") } as const;
const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodTypeAny>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const secured = [{ bearerAuth: [] }];
const Id = z.object({ id: z.string().min(1).openapi({ param: { name: "id", in: "path" } }) });

const Field = z.object({
  id: z.string(), projectId: z.string(), name: z.string(),
  type: z.enum(["text", "number", "currency", "date", "select", "multiselect", "person", "checkbox", "url", "formula", "rollup"]),
  options: z.array(z.object({ id: z.string(), label: z.string(), color: z.string() })), position: z.number(),
  config: z.record(z.string(), z.unknown()).optional().openapi({ description: "R24.1: formula or rollup settings." }),
}).openapi("Field", { description: "A custom field on a project. Currency is AUD. Values are set on tasks with PATCH /tasks/{id} { fields: { <fieldId>: value } }." });
const Guest = z.object({
  id: z.string(), projectId: z.string(), email: z.string(), name: z.string(), status: z.enum(["pending", "active", "revoked"]),
  invitedBy: z.object({ type: z.string(), id: z.string().nullable() }), approvalId: z.string().nullable(), lastSeenAt: z.string().nullable(), inviteExpiresAt: z.string().nullable(), createdAt: z.string(),
}).openapi("Guest");
const PortfolioRow = z.object({
  id: z.string(), name: z.string(), key: z.string(), color: z.string(), archived: z.boolean(),
  owner: z.object({ id: z.string(), name: z.string() }).nullable(), health: z.enum(["on_track", "at_risk", "off_track"]).nullable(), healthNote: z.string(),
  progress: z.number().int().openapi({ description: "Percentage of top level tasks done, 0 to 100." }), total: z.number().int(), done: z.number().int(), overdue: z.number().int(),
  timeLoggedSeconds: z.number().int(), nextDue: z.string().nullable(), nextDueTask: z.object({ id: z.string(), ref: z.string(), title: z.string() }).nullable(),
}).openapi("PortfolioProject");

const actor = (c: Context<AppEnv>) => c.var.auth as unknown as SuiteActor;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const send = (c: Context<AppEnv>, data: unknown, status: 200 | 201 = 200) => c.json(data as any, status) as any;

export function registerSuiteR8Routes(api: OpenAPIHono<AppEnv>) {
  // ---------------------------------------------------------------- custom fields
  api.openapi(createRoute({ method: "get", path: "/projects/{id}/fields", tags: ["Custom fields"], summary: "List a project's custom fields", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ fields: z.array(Field) }), "Fields in order."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { fields: await listFields(c.var.deps, actor(c).orgId, c.req.valid("param").id) }));

  api.openapi(createRoute({ method: "post", path: "/projects/{id}/fields", tags: ["Custom fields"], summary: "Add a custom field to a project", security: secured,
    description: "Types: text, number, currency (AUD), date, select, multiselect, person, checkbox, url. Select types take options [{ label, color? }].",
    request: { params: Id, ...body(FieldCreate) }, responses: { 201: json(z.object({ field: Field }), "The field."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, { field: await createField(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json"), await idempotentCreate(c.req.raw, "fld")) }, 201));

  api.openapi(createRoute({ method: "patch", path: "/fields/{id}", tags: ["Custom fields"], summary: "Rename a field, reorder it or change its options", security: secured,
    description: "Options keep their ids when you pass them back (or match by label), so values survive a rename. Values that point at a removed option are cleared.",
    request: { params: Id, ...body(FieldPatch) }, responses: { 200: json(z.object({ field: Field }), "The field."), 401: errors[401], 404: errors[404], 422: errors[422] } }),
  async (c) => send(c, { field: await updateField(c.var.deps, actor(c), c.req.valid("param").id, c.req.valid("json")) }));

  api.openapi(createRoute({ method: "delete", path: "/fields/{id}", tags: ["Custom fields"], summary: "Delete a field and its values", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ ok: z.boolean() }), "Deleted."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await deleteField(c.var.deps, actor(c), c.req.valid("param").id)));

  // ---------------------------------------------------------------- guests
  api.openapi(createRoute({ method: "get", path: "/projects/{id}/guests", tags: ["Guests"], summary: "List a project's guests", security: secured,
    request: { params: Id }, responses: { 200: json(z.object({ guests: z.array(Guest) }), "Guests."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, { guests: await listGuests(c.var.deps, actor(c).orgId, c.req.valid("param").id) }));

  api.openapi(createRoute({ method: "post", path: "/projects/{id}/guests", tags: ["Guests"], summary: "Invite a guest to a project", security: secured,
    description: "Guests are free on every plan and take no seat. They see the project's tasks, comments and docs, and can comment and upload files. From an agent key (or with agentId) the invite email goes from that agent's inbox and follows its approval rules, so it may wait in the approval queue: delivery.status is then pending_approval.",
    request: { params: Id, ...body(GuestInvite) },
    responses: { 201: json(z.object({ guest: Guest, delivery: z.object({ status: z.enum(["sent", "pending_approval", "not_sent"]), approvalId: z.string().optional(), detail: z.string().optional() }) }), "The guest and how the invite went."), 401: errors[401], 403: errors[403], 404: errors[404], 422: errors[422] } }),
  async (c) => {
    const b = c.req.valid("json");
    let a = actor(c);
    if (b.agentId && !a.agentId) { const ag = await getAgent(c.var.deps, a.orgId, b.agentId); a = { ...a, agentId: ag.id, name: ag.name }; }
    else if (b.agentId && b.agentId !== a.agentId) throw new HttpError(403, "agent_key_scope", "This key belongs to another agent.");
    const r = await inviteGuest(c.var.deps, a, c.req.valid("param").id, b);
    return send(c, { guest: r.guest, delivery: r.delivery }, 201);
  });

  api.openapi(createRoute({ method: "delete", path: "/guests/{id}", tags: ["Guests"], summary: "Remove a guest", security: secured,
    description: "Ends the guest's access at once.", request: { params: Id }, responses: { 200: json(z.object({ ok: z.boolean() }), "Removed."), 401: errors[401], 404: errors[404] } }),
  async (c) => send(c, await revokeGuest(c.var.deps, actor(c), c.req.valid("param").id)));

  // ---------------------------------------------------------------- portfolio
  api.openapi(createRoute({ method: "get", path: "/portfolio", tags: ["Portfolio"], summary: "Every project with progress, overdue, time and health", security: secured,
    description: "Set health and owner with PATCH /projects/{id} { health, healthNote, ownerId }.",
    request: { query: z.object({ archived: z.enum(["0", "1"]).optional() }) }, responses: { 200: json(z.object({ projects: z.array(PortfolioRow) }), "Projects."), 401: errors[401] } }),
  async (c) => send(c, { projects: await portfolio(c.var.deps, actor(c).orgId, { includeArchived: c.req.valid("query").archived === "1" }) }));
}
