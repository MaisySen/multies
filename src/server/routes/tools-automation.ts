/**
 * Tools P2 (automation): auto rules before sending (flag rules), workflows (flag workflows), document
 * templates (flag templates) and mail merge (flag merge_mail), under /api/tools. Every route checks its
 * flag first, then the workspace Tools switch and plan limits through services/tools/automation.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { HttpError, badRequest } from "../lib/errors";
import { audit } from "../services/audit";
import { requireToolFeature } from "../services/tools/features";
import { assertMailboxAccess } from "../services/team";
import {
  cancelMerge, checkRunAllowance, checkUnsubscribe, deleteTemplate, deleteWorkflow, getWorkflow, listMerges, listTemplates, listWorkflows,
  loadAttachmentFiles, mergeProgress, mergeUsedToday, readRules, recordUnsubscribe, renderTemplate, runWorkflow, saveRules, saveTemplate,
  saveWorkflow, startMerge, templateContext, toolStateOrOff, type EngineFile,
} from "../services/tools/automation";
import "../services/tools/merge-job";
import {
  MERGE_DAILY_CAP, MERGE_MAX_ROWS, RULE_MB_MAX, RULE_MB_MIN, TEMPLATE_FIELD_TYPES, WORKFLOW_MAX_STEPS, WORKFLOW_STARTERS, escapeHtml,
  isWorkflowOp, mergeFields, type WorkflowStep,
} from "@/shared/tools-automation";

const mode = z.enum(["on", "off"]).nullable();
const rulesSchema = z.object({ compress: mode, compressOverMb: z.number().int().min(RULE_MB_MIN).max(RULE_MB_MAX).nullable(), wordPdf: mode });

const stepSchema = z.object({ op: z.string().refine(isWorkflowOp, "That tool can't be used in a workflow."), options: z.record(z.string(), z.string().max(500)).default({}) });
const workflowSchema = z.object({ name: z.string().min(1).max(80), steps: z.array(stepSchema).min(1).max(WORKFLOW_MAX_STEPS), finish: z.enum(["download", "email", "share"]).default("download") });
const runJsonSchema = z.object({ workflowId: z.string().max(64).optional(), steps: z.array(stepSchema).max(WORKFLOW_MAX_STEPS).optional(), attachmentIds: z.array(z.string().min(1).max(64)).min(1).max(20), password: z.string().max(128).optional() });

const fieldSchema = z.object({ key: z.string().min(1).max(40), label: z.string().max(80).default(""), type: z.enum(TEMPLATE_FIELD_TYPES as [string, ...string[]]), required: z.boolean().optional() });
const templateSchema = z.object({ kind: z.enum(["invoice", "quote", "letter", "custom"]).default("custom"), name: z.string().min(1).max(80), html: z.string().min(1).max(100_000), fields: z.array(fieldSchema).max(40) });
const renderSchema = z.object({ values: z.record(z.string(), z.union([z.string().max(20_000), z.number(), z.array(z.unknown()).max(50)])) });

const personSchema = z.object({ email: z.string().max(254), name: z.string().max(200).default(""), data: z.record(z.string(), z.string().max(2000)).default({}) });
const mergeSchema = z.object({
  templateId: z.string().min(1).max(64), mailboxId: z.string().min(1).max(64), subject: z.string().max(300), body: z.string().max(20_000),
  people: z.array(personSchema).min(1).max(MERGE_MAX_ROWS + 50), consent: z.boolean().default(false), marketing: z.boolean().default(false),
});

/** Reads a workflow run upload: files plus workflowId or steps, and the run time password. */
async function readUpload(c: Context<AppEnv>) {
  if (c.req.header("x-multies-upload") !== "1") throw new HttpError(403, "bad_origin", "Cross-site request blocked.");
  const len = Number(c.req.header("content-length") ?? "0");
  const s = await toolStateOrOff(c.var.deps, c.var.auth.orgId);
  checkRunAllowance(s, Math.max(0, len - 64 * 1024));
  const fd = await c.req.formData().catch(() => null);
  if (!fd) throw badRequest("Send the files as a form upload.");
  const files: EngineFile[] = [];
  for (const f of fd.getAll("files")) {
    if (typeof f === "string") continue;
    files.push({ name: f.name.replace(/[\r\n"\\/]/g, "_").slice(0, 120) || "file", type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  const stepsRaw = fd.get("steps");
  let steps: WorkflowStep[] | undefined;
  if (typeof stepsRaw === "string" && stepsRaw) {
    try { steps = z.array(stepSchema).max(WORKFLOW_MAX_STEPS).parse(JSON.parse(stepsRaw)) as WorkflowStep[]; } catch { throw badRequest("Those workflow steps could not be read."); }
  }
  const workflowId = fd.get("workflowId");
  const password = fd.get("password");
  return { files, steps, workflowId: typeof workflowId === "string" ? workflowId : undefined, password: typeof password === "string" ? password : undefined };
}

async function stepsFor(c: Context<AppEnv>, workflowId: string | undefined, steps: WorkflowStep[] | undefined): Promise<WorkflowStep[]> {
  if (steps?.length) return steps;
  if (!workflowId) throw badRequest("Choose a workflow.");
  const starter = WORKFLOW_STARTERS.find((w) => w.id === workflowId);
  if (starter) return starter.steps;
  return (await getWorkflow(c.var.deps, c.var.auth.orgId, workflowId)).steps;
}

/** Tools P2 automation routes, mounted at /api/tools after the P1 routes. */
export function toolsAutomationRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // ---------------------------------------------------------------- 3: auto rules before sending
    .get("/rules", async (c) => {
      requireToolFeature(c, "rules");
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      const r = await readRules(c.var.deps, c.var.auth.orgId, c.var.auth.userId);
      return c.json({ ...r, canEditWorkspace: c.var.auth.role !== "member" });
    })
    .put("/rules/workspace", requireAdmin, async (c) => {
      requireToolFeature(c, "rules");
      const input = await parseBody(c, rulesSchema);
      const { auth, deps } = c.var;
      await toolStateOrOff(deps, auth.orgId);
      await saveRules(deps, auth.orgId, "", input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.rules_changed", targetType: "organization", targetId: auth.orgId, metadata: { ...input }, ip: c.var.ip });
      return c.json(await readRules(deps, auth.orgId, auth.userId));
    })
    .put("/rules/mine", async (c) => {
      requireToolFeature(c, "rules");
      const input = await parseBody(c, rulesSchema);
      const { auth, deps } = c.var;
      await toolStateOrOff(deps, auth.orgId);
      await saveRules(deps, auth.orgId, auth.userId, input);
      return c.json(await readRules(deps, auth.orgId, auth.userId));
    })
    // ---------------------------------------------------------------- 25: workflows
    .get("/workflows", async (c) => {
      requireToolFeature(c, "workflows");
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      return c.json({ starters: WORKFLOW_STARTERS, workflows: await listWorkflows(c.var.deps, c.var.auth.orgId) });
    })
    .post("/workflows", async (c) => {
      requireToolFeature(c, "workflows");
      const input = await parseBody(c, workflowSchema);
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      return c.json(await saveWorkflow(c.var.deps, c.var.auth, { ...input, steps: input.steps as WorkflowStep[] }), 201);
    })
    .put("/workflows/:id", async (c) => {
      requireToolFeature(c, "workflows");
      const input = await parseBody(c, workflowSchema);
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      return c.json(await saveWorkflow(c.var.deps, c.var.auth, { ...input, id: c.req.param("id"), steps: input.steps as WorkflowStep[] }));
    })
    .delete("/workflows/:id", async (c) => {
      requireToolFeature(c, "workflows");
      await deleteWorkflow(c.var.deps, c.var.auth.orgId, c.req.param("id"));
      return c.json({ ok: true });
    })
    // Run on uploaded files (multipart) or on mail attachments (JSON). One engine chain job.
    .post("/workflows/run", async (c) => {
      requireToolFeature(c, "workflows");
      const { auth, deps } = c.var;
      const isForm = /^multipart\/form-data/i.test(c.req.header("content-type") ?? "");
      let files: EngineFile[];
      let steps: WorkflowStep[];
      let password: string | undefined;
      if (isForm) {
        const u = await readUpload(c);
        files = u.files; password = u.password;
        steps = await stepsFor(c, u.workflowId, u.steps);
      } else {
        const input = runJsonSchema.safeParse(await c.req.json().catch(() => null));
        if (!input.success) throw badRequest("Choose a workflow and at least one attachment.");
        await toolStateOrOff(deps, auth.orgId);
        steps = await stepsFor(c, input.data.workflowId, input.data.steps as WorkflowStep[] | undefined);
        files = await loadAttachmentFiles(deps, auth, input.data.attachmentIds);
        password = input.data.password;
      }
      const job = await runWorkflow(deps, auth, steps, files, password);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.jobId, metadata: { op: "chain", steps: steps.map((s) => s.op), source: isForm ? "upload" : "attachment", files: files.length }, ip: c.var.ip });
      return c.json({ token: job.token, op: job.op, status: job.status, name: job.name }, 202);
    })
    // ---------------------------------------------------------------- 14: templates
    .get("/templates", async (c) => {
      requireToolFeature(c, "templates");
      const { auth, deps } = c.var;
      await toolStateOrOff(deps, auth.orgId);
      const ctx = await templateContext(deps, auth.orgId);
      return c.json({ templates: await listTemplates(deps, auth.orgId), workspaceName: ctx.workspaceName, logo: ctx.logoDataUri, today: ctx.today });
    })
    .post("/templates", async (c) => {
      requireToolFeature(c, "templates");
      const input = await parseBody(c, templateSchema);
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      return c.json(await saveTemplate(c.var.deps, c.var.auth, input as Parameters<typeof saveTemplate>[2]), 201);
    })
    .put("/templates/:id", async (c) => {
      requireToolFeature(c, "templates");
      const input = await parseBody(c, templateSchema);
      await toolStateOrOff(c.var.deps, c.var.auth.orgId);
      return c.json(await saveTemplate(c.var.deps, c.var.auth, { ...(input as Parameters<typeof saveTemplate>[2]), id: c.req.param("id") }));
    })
    .delete("/templates/:id", async (c) => {
      requireToolFeature(c, "templates");
      await deleteTemplate(c.var.deps, c.var.auth.orgId, c.req.param("id"));
      return c.json({ ok: true });
    })
    .post("/templates/:id/render", async (c) => {
      requireToolFeature(c, "templates");
      const input = await parseBody(c, renderSchema);
      const { auth, deps } = c.var;
      const job = await renderTemplate(deps, auth, c.req.param("id"), input.values);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.run", targetType: "tool_job", targetId: job.jobId, metadata: { op: "render", source: "template" }, ip: c.var.ip });
      return c.json({ token: job.token, op: job.op, status: job.status, name: job.name }, 202);
    })
    // ---------------------------------------------------------------- 15: mail merge
    .get("/merge", async (c) => {
      requireToolFeature(c, "merge_mail");
      const { auth, deps } = c.var;
      const s = await toolStateOrOff(deps, auth.orgId);
      const templates = await listTemplates(deps, auth.orgId);
      return c.json({
        cap: MERGE_DAILY_CAP[s.plan], usedToday: await mergeUsedToday(deps, auth.orgId), maxRows: MERGE_MAX_ROWS,
        runs: await listMerges(deps, auth.orgId),
        templates: templates.map((t) => ({ id: t.id, name: t.name, kind: t.kind, fields: mergeFields(t) })),
      });
    })
    .post("/merge", async (c) => {
      requireToolFeature(c, "merge_mail");
      const input = await parseBody(c, mergeSchema);
      const { auth, deps } = c.var;
      await assertMailboxAccess(deps.db, auth, input.mailboxId);
      const run = await startMerge(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "tools.merge_started", targetType: "merge_run", targetId: run.id, metadata: { people: run.total, marketing: input.marketing, consent: true }, ip: c.var.ip });
      return c.json(run, 201);
    })
    .get("/merge/:id", async (c) => {
      requireToolFeature(c, "merge_mail");
      return c.json(await mergeProgress(c.var.deps, c.var.auth.orgId, c.req.param("id")));
    })
    .post("/merge/:id/cancel", async (c) => {
      requireToolFeature(c, "merge_mail");
      await cancelMerge(c.var.deps, c.var.auth.orgId, c.req.param("id"));
      return c.json(await mergeProgress(c.var.deps, c.var.auth.orgId, c.req.param("id")));
    });
}

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 20px;color:#1f2430}button{font:inherit;padding:10px 18px;border-radius:8px;border:0;background:#2f5bea;color:#fff;cursor:pointer}p{line-height:1.5}</style></head><body>${body}</body></html>`;

/**
 * Public unsubscribe for mail merge emails (no sign in). The link shows a button; the button is a
 * plain GET form with confirm=1 (link scanners open links but don't submit forms, and the app's
 * JSON only rule for POSTs stays as it is). Signed per workspace and address.
 */
export function mailMergeUnsubscribeRoutes() {
  return new Hono<AppEnv>()
    .get("/unsubscribe", async (c) => {
      const { o = "", e = "", s = "", confirm = "" } = c.req.query();
      c.header("cache-control", "no-store");
      if (!(await checkUnsubscribe(c.var.deps, o, e, s))) return c.html(page("Link not valid", "<h1>This link isn't valid</h1><p>It may have been cut short. Reply to the email and ask to be taken off the list.</p>"), 400);
      if (confirm === "1") {
        await recordUnsubscribe(c.var.deps, o, e);
        return c.html(page("Unsubscribed", `<h1>You're unsubscribed</h1><p>${escapeHtml(e)} won't get these emails again.</p>`));
      }
      const hidden = Object.entries({ o, e, s, confirm: "1" }).map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`).join("");
      return c.html(page("Unsubscribe", `<h1>Unsubscribe</h1><p>Stop getting these emails at ${escapeHtml(e)}?</p><form method="get" action="/api/mail-merge/unsubscribe">${hidden}<button type="submit">Unsubscribe</button></form>`));
    });
}
