import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAdmin, requireAuth } from "../middleware";
import {
  agentAudit, approveSend, createAgent, createAgentKey, deleteAgent, getAgent, listAgentKeys, listAgents, listApprovals, listThreads, readThread,
  rejectSend, revokeAgentKey, scopeFor, updateAgent,
} from "../services/agents";
import { agentTrackRecord } from "../services/agents/autonomy";
import { ThreadViewQuery } from "./thread-state";

const ApprovalMode = z.enum(["always", "external", "never"]);
const Recipients = z.array(z.string().trim().min(3).max(254)).max(200).nullable().optional();

/** Agent inboxes in the app (cookie session). The same service backs the public API and MCP. */
export function agentRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ agents: await listAgents(c.var.deps, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, z.object({
        name: z.string().trim().min(1).max(80), description: z.string().max(500).optional(),
        localPart: z.string().trim().min(1).max(64).regex(/^[a-z0-9._-]+$/i, "Use letters, numbers, dots, dashes or underscores.").optional(),
        domainId: z.string().optional(), approvalMode: ApprovalMode.optional(), sendCapDaily: z.number().int().min(0).max(100_000).optional(),
        allowedRecipients: Recipients, mailboxIds: z.array(z.string()).max(50).optional(),
      }));
      return c.json(await createAgent(c.var.deps, c.var.auth, input), 201);
    })
    // The shared inbox: threads across every mailbox this person can open, with agent activity labelled.
    .get("/threads", async (c) => {
      const q = parseQuery(c, z.object({ mailboxId: z.string().optional(), folder: z.enum(["inbox", "sent", "archive", "spam"]).optional(), before: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).merge(ThreadViewQuery));
      // Round 22: the list shows open threads unless a view says otherwise (all, mine, unassigned, assigned, waiting, done).
      return c.json(await listThreads(c.var.deps, c.var.auth.orgId, await scopeFor(c.var.deps, c.var.auth), { ...q, view: q.view ?? "open", viewerUserId: c.var.auth.userId }));
    })
    .get("/threads/:id", async (c) => c.json(await readThread(c.var.deps, c.var.auth, c.req.param("id"), new URL(c.req.url).origin)))
    .get("/:id", async (c) => c.json(await getAgent(c.var.deps, c.var.auth.orgId, c.req.param("id"))))
    .patch("/:id", requireAdmin, async (c) => {
      const patch = await parseBody(c, z.object({
        name: z.string().trim().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), approvalMode: ApprovalMode.optional(),
        sendCapDaily: z.number().int().min(0).max(100_000).optional(), allowedRecipients: Recipients, mailboxIds: z.array(z.string()).max(50).optional(),
        status: z.enum(["active", "paused"]).optional(),
      }));
      return c.json(await updateAgent(c.var.deps, c.var.auth, c.req.param("id"), patch));
    })
    .delete("/:id", requireAdmin, async (c) => c.json(await deleteAgent(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:id/keys", requireAdmin, async (c) => c.json({ keys: await listAgentKeys(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/:id/keys", requireAdmin, async (c) => {
      const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80).optional() }));
      const k = await createAgentKey(c.var.deps, c.var.auth, c.req.param("id"), name);
      return c.json({ apiKey: k.apiKey, secret: k.secret }, 201);
    })
    .delete("/:id/keys/:keyId", requireAdmin, async (c) => c.json(await revokeAgentKey(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("keyId"))))
    .get("/:id/audit", async (c) => c.json({ entries: await agentAudit(c.var.deps, c.var.auth, c.req.param("id"), 200) }))
    .get("/:id/track-record", async (c) => c.json(await agentTrackRecord(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function approvalRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, z.object({ status: z.enum(["pending", "sent", "rejected", "failed", "expired"]).optional(), agentId: z.string().optional() }));
      return c.json({ approvals: await listApprovals(c.var.deps, c.var.auth, q) });
    })
    .post("/:id/approve", async (c) => {
      const edits = await parseBody(c, z.object({ subject: z.string().max(998).optional(), text: z.string().max(1_000_000).optional() }));
      const r = await approveSend(c.var.deps, c.var.auth, c.req.param("id"), edits);
      return c.json({ approval: r.approval, result: r.result });
    })
    .post("/:id/reject", async (c) => {
      const { note } = await parseBody(c, z.object({ note: z.string().max(1000).optional() }));
      return c.json({ approval: await rejectSend(c.var.deps, c.var.auth, c.req.param("id"), note) });
    });
}
