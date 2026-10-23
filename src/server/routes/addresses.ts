import { Hono } from "hono";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { createAliasSchema, createMailboxSchema, updateAliasSchema, updateMailboxSchema } from "@/shared/schemas";
import { audit } from "../services/audit";
import {
  createAlias, createMailbox, deleteAlias, deleteMailbox, listAliases, listMailboxes, updateAlias, updateMailbox,
} from "../services/addresses";

export function mailboxRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ mailboxes: await listMailboxes(c.var.deps.db, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, createMailboxSchema);
      const { auth, deps } = c.var;
      const m = await createMailbox(deps.db, auth.orgId, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.created", targetType: "mailbox", targetId: m.id, metadata: { address: m.address }, ip: c.var.ip });
      return c.json({ mailbox: m }, 201);
    })
    .patch("/:id", requireAdmin, async (c) => {
      const patch = await parseBody(c, updateMailboxSchema);
      const { auth, deps } = c.var;
      const m = await updateMailbox(deps.db, auth.orgId, c.req.param("id"), patch);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.updated", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, ...patch }, ip: c.var.ip });
      return c.json({ mailbox: m });
    })
    .delete("/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const m = await deleteMailbox(deps.db, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.deleted", targetType: "mailbox", targetId: m.id, metadata: { address: m.address }, ip: c.var.ip });
      return c.json({ ok: true });
    });
}

export function aliasRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ aliases: await listAliases(c.var.deps.db, c.var.auth.orgId) }))
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, createAliasSchema);
      const { auth, deps } = c.var;
      const a = await createAlias(deps.db, auth.orgId, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "alias.created", targetType: "alias", targetId: a.id, metadata: { address: a.address, destinations: a.destinations }, ip: c.var.ip });
      return c.json({ alias: a }, 201);
    })
    .patch("/:id", requireAdmin, async (c) => {
      const patch = await parseBody(c, updateAliasSchema);
      const { auth, deps } = c.var;
      const a = await updateAlias(deps.db, auth.orgId, c.req.param("id"), patch);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "alias.updated", targetType: "alias", targetId: a.id, metadata: { address: a.address, ...patch }, ip: c.var.ip });
      return c.json({ alias: a });
    })
    .delete("/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      const a = await deleteAlias(deps.db, auth.orgId, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "alias.deleted", targetType: "alias", targetId: a.id, metadata: { address: a.address }, ip: c.var.ip });
      return c.json({ ok: true });
    });
}
