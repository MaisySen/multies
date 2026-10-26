/**
 * R28 (DF-3 slice 3): agent run triggers in the app (cookie session) and the public webhook that fires one. Admins
 * list, add, edit, turn off, rotate and delete triggers from the agent's row in People; a signed POST to
 * /api/hooks/agent-runs/:id queues a run. REST is v1-r28-agent-triggers.ts and MCP is mcp-r28-agent-triggers.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { DAYS } from "../services/suite/scheduling";
import {
  createTrigger, deleteTrigger, getTrigger, handleTriggerWebhook, listTriggers, rotateTriggerSecret, runTriggerNow, SIGNATURE_HEADER,
  TIMESTAMP_HEADER, TRIGGER_INSTRUCTIONS_MAX, TRIGGER_TITLE_MAX, updateTrigger,
} from "../services/suite/agent-triggers";

const fields = {
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  taskId: z.string().max(80).nullable(),
  projectId: z.string().max(80).nullable(),
  titleTemplate: z.string().max(TRIGGER_TITLE_MAX).nullable(),
  instructions: z.string().max(TRIGGER_INSTRUCTIONS_MAX).nullable(),
  everyHours: z.number().int().min(1).max(744).nullable(),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "dailyAt is a time like 09:00.").nullable(),
  days: z.array(z.enum(DAYS)).max(7).nullable(),
  timezone: z.string().max(64).nullable(),
};
export const TriggerCreateBody = z.object({
  agentUserId: z.string().min(1).max(80),
  kind: z.enum(["schedule", "webhook"]),
  name: fields.name,
  enabled: fields.enabled.optional(),
  taskId: fields.taskId.optional(),
  projectId: fields.projectId.optional(),
  titleTemplate: fields.titleTemplate.optional(),
  instructions: fields.instructions.optional(),
  everyHours: fields.everyHours.optional(),
  dailyAt: fields.dailyAt.optional(),
  days: fields.days.optional(),
  timezone: fields.timezone.optional(),
});
export const TriggerPatchBody = z.object({
  agentUserId: z.string().min(1).max(80).optional(),
  name: fields.name.optional(),
  enabled: fields.enabled.optional(),
  taskId: fields.taskId.optional(),
  projectId: fields.projectId.optional(),
  titleTemplate: fields.titleTemplate.optional(),
  instructions: fields.instructions.optional(),
  everyHours: fields.everyHours.optional(),
  dailyAt: fields.dailyAt.optional(),
  days: fields.days.optional(),
  timezone: fields.timezone.optional(),
});

/** /api/agent-triggers (admins). */
export function agentTriggerRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await listTriggers(c.var.deps, c.var.auth, { agentUserId: c.req.query("agentUserId") || undefined })))
    .post("/", async (c) => c.json(await createTrigger(c.var.deps, c.var.auth, await parseBody(c, TriggerCreateBody)), 201))
    .get("/:id", async (c) => c.json({ trigger: await getTrigger(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ trigger: await updateTrigger(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TriggerPatchBody)) }))
    .delete("/:id", async (c) => c.json(await deleteTrigger(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/rotate-secret", async (c) => c.json(await rotateTriggerSecret(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/run", async (c) => c.json(await runTriggerNow(c.var.deps, c.var.auth, c.req.param("id")), 201));
}

/** /api/hooks/agent-runs/:id: public, signed. No cookies, no CSRF; the signature is the authority. */
export function agentTriggerHookRoutes() {
  return new Hono<AppEnv>()
    .post("/:id", async (c) => {
      const fired = await handleTriggerWebhook(c.var.deps, c.req.param("id"), {
        timestamp: c.req.header(TIMESTAMP_HEADER), signature: c.req.header(SIGNATURE_HEADER), contentLength: c.req.header("content-length"),
      }, () => c.req.arrayBuffer());
      return c.json({ ok: true, run: fired }, 202);
    });
}
