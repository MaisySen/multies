/**
 * Round 21 (R21.3): Triage in the web app (cookie session). The same services back the REST API
 * (v1-triage.ts) and the MCP tools (mcp-r21-triage.ts). Guests have no workspace session, so they get 401.
 *   GET /api/triage/settings  { machineTasksAlwaysWait }
 *   PUT /api/triage/settings  { machineTasksAlwaysWait } (admins signed in to Multies)
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { parseAssignee } from "../services/suite/tasks";
import { setTriageSettings, triageSettings } from "../services/suite/triage-settings";
import { TRIAGE_ACTIONS, triageAction, type TriageActionInput } from "../services/suite/triage-r32";
import { acceptTriage, bulkTriage, createTriageItem, declineTriage, getTriageItem, listTriage, mergeTriage, triageCount, BULK_LIMIT, type AcceptInput } from "../services/suite/triage";

export const TriageSettingsBody = z.object({ machineTasksAlwaysWait: z.boolean() });
export const TriageQuery = z.object({
  projectId: z.string().max(64).optional(),
  /** R32: pending (default, the queue) or snoozed. */
  view: z.enum(["pending", "snoozed"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export const TriageCreate = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().max(20_000).optional(),
  source: z.enum(["mail", "form", "api", "chat", "agent"]).optional(),
  from: z.string().max(300).nullable().optional(),
  projectId: z.string().max(64).optional(),
});
export const TriageAccept = z.object({
  projectId: z.string().max(64).optional(),
  assignee: z.string().max(100).nullable().optional(),
  statusId: z.string().max(64).optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  due: z.string().max(40).nullable().optional(),
});
export const TriageDecline = z.object({
  reason: z.string().max(500).optional(),
  reply: z.boolean().optional(),
  message: z.string().max(5000).optional(),
});
export const TriageMerge = z.object({ targetId: z.string().min(1).max(64) });
/** R32: one body for every action (the app, POST /api/v1/tasks/{id}/triage and MCP task_triage_action). */
export const TriageActionBody = z.object({
  action: z.enum(TRIAGE_ACTIONS),
  accept: TriageAccept.optional(),
  decline: TriageDecline.optional(),
  until: z.string().max(40).optional(),
  duplicateOf: z.string().max(64).optional(),
  /** R33: accept or decline with a one line comment; restore with commentId removes it again. */
  comment: z.string().max(2000).optional(),
  commentId: z.string().max(64).optional(),
});
export const triageActionInput = (b: z.infer<typeof TriageActionBody>): TriageActionInput => ({ ...b, accept: b.accept ? acceptInput(b.accept) : undefined });
export const TriageBulk = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_LIMIT),
  action: z.enum(["accept", "decline"]),
  accept: TriageAccept.optional(),
  decline: TriageDecline.optional(),
});

export const acceptInput = (b: z.infer<typeof TriageAccept>): AcceptInput => ({
  ...b, assignee: b.assignee === undefined ? undefined : parseAssignee(b.assignee),
});

export function triageRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listTriage(c.var.deps, c.var.auth, parseQuery(c, TriageQuery))))
    .get("/count", async (c) => c.json({ count: await triageCount(c.var.deps, c.var.auth) }))
    // Round 2 (PR 24): "AI and API tasks always wait in Triage" (admins signed in to Multies; off by default).
    .get("/settings", async (c) => c.json(await triageSettings(c.var.deps, c.var.auth.orgId)))
    .put("/settings", async (c) => c.json(await setTriageSettings(c.var.deps, c.var.auth, await parseBody(c, TriageSettingsBody))))
    .post("/", async (c) => c.json({ item: await createTriageItem(c.var.deps, c.var.auth, await parseBody(c, TriageCreate)) }, 201))
    .post("/bulk", async (c) => {
      const b = await parseBody(c, TriageBulk);
      return c.json(await bulkTriage(c.var.deps, c.var.auth, { ...b, accept: b.accept ? acceptInput(b.accept) : undefined }));
    })
    .get("/:id", async (c) => c.json({ item: await getTriageItem(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/accept", async (c) => c.json({ task: await acceptTriage(c.var.deps, c.var.auth, c.req.param("id"), acceptInput(await parseBody(c, TriageAccept))) }))
    .post("/:id/decline", async (c) => c.json(await declineTriage(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TriageDecline))))
    .post("/:id/action", async (c) => c.json(await triageAction(c.var.deps, c.var.auth, c.req.param("id"), triageActionInput(await parseBody(c, TriageActionBody)))))
    .post("/:id/merge", async (c) => c.json(await mergeTriage(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, TriageMerge)).targetId)));
}
