/**
 * R108 Contracts routes, mounted at /api/contracts when CONTRACTS_R108 is on (404 otherwise, since nothing is mounted).
 * Signed in workspace people only: guests have no session here, so they get nothing. Admin rules live in the service.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import {
  contractPdf, generateContract, listClauses, listContractTemplates, myContracts, saveClause, saveContractTemplate, setClauseRetired, setTemplateRetired, templateDetail,
} from "../services/tools/contracts-r108";

const Answers = z.record(z.string().max(40), z.union([z.string().max(6000), z.number()])).refine((o) => Object.keys(o).length <= 60, "Too many answers.");
const GenerateBody = z.object({ templateId: z.string().min(1).max(60), answers: Answers, reminders: z.boolean().optional() });
const PdfBody = z.object({ templateId: z.string().min(1).max(60), answers: Answers });
const TemplateBody = z.object({ baseId: z.string().max(60).optional(), name: z.string().max(200), description: z.string().max(1000).optional(), clauseKeys: z.array(z.string().max(40)).max(60) });
const ClauseBody = z.object({ title: z.string().max(200), body: z.string().max(10000) });

export function contractsRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ ...(await listContractTemplates(c.var.deps, c.var.auth)), recent: await myContracts(c.var.deps, c.var.auth) }))
    .get("/templates/:id", async (c) => c.json(await templateDetail(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/templates", async (c) => {
      const b = await parseBody(c, TemplateBody);
      const r = await saveContractTemplate(c.var.deps, c.var.auth, b);
      await audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action: "contracts.template_created", targetType: "contract_template", targetId: r.id, ip: c.var.ip });
      return c.json(r, 201);
    })
    .put("/templates/:id", async (c) => {
      const b = await parseBody(c, TemplateBody);
      const r = await saveContractTemplate(c.var.deps, c.var.auth, { ...b, id: c.req.param("id") });
      await audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action: "contracts.template_updated", targetType: "contract_template", targetId: r.id, ip: c.var.ip });
      return c.json(r);
    })
    .post("/templates/:id/retire", async (c) => c.json(await setTemplateRetired(c.var.deps, c.var.auth, c.req.param("id"), true)))
    .post("/templates/:id/restore", async (c) => c.json(await setTemplateRetired(c.var.deps, c.var.auth, c.req.param("id"), false)))
    .get("/clauses", async (c) => c.json({ clauses: await listClauses(c.var.deps, c.var.auth) }))
    .post("/clauses", async (c) => c.json(await saveClause(c.var.deps, c.var.auth, await parseBody(c, ClauseBody)), 201))
    .put("/clauses/:key", async (c) => c.json(await saveClause(c.var.deps, c.var.auth, { ...(await parseBody(c, ClauseBody)), key: c.req.param("key") })))
    .post("/clauses/:key/retire", async (c) => c.json(await setClauseRetired(c.var.deps, c.var.auth, c.req.param("key"), true)))
    .post("/clauses/:key/restore", async (c) => c.json(await setClauseRetired(c.var.deps, c.var.auth, c.req.param("key"), false)))
    .post("/generate", async (c) => {
      const b = await parseBody(c, GenerateBody);
      const r = await generateContract(c.var.deps, c.var.auth, { templateId: b.templateId, answers: b.answers, reminders: !!b.reminders });
      await audit(c.var.deps.db, { orgId: c.var.auth.orgId, actorUserId: c.var.auth.userId, actorEmail: c.var.auth.email, action: "contracts.generated", targetType: "doc", targetId: r.doc.id, metadata: { template: b.templateId, reminders: r.tasks.length }, ip: c.var.ip });
      return c.json(r, 201);
    })
    .post("/pdf", async (c) => {
      const b = await parseBody(c, PdfBody);
      const job = await contractPdf(c.var.deps, c.var.auth, b);
      return c.json({ token: job.token, op: job.op, status: job.status, name: job.name }, 202);
    });
}
