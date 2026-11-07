import { Hono } from "hono";
import { assertMailboxNotHeld } from "../services/mail/archive-r111"; // R111
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { createAliasSchema, createMailboxSchema, updateAliasSchema, updateMailboxSchema } from "@/shared/schemas";
import { audit } from "../services/audit";
import {
  createAlias, createMailbox, deleteAlias, deleteMailbox, listAliases, listMailboxes, updateAlias, updateMailbox,
} from "../services/addresses";
import { deprovisionMailbox, syncQuota } from "../services/mailserver";
import { myMailboxPrivacy, shareMailbox, sharingView, unshareMailbox } from "../services/mailbox-sharing-priv1a";
import { z } from "zod";

export function mailboxRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ mailboxes: await listMailboxes(c.var.deps.db, c.var.auth.orgId) }))
    // PRIV1a (MB-366): personal mailboxes. My own and the ones shared with me; sharing (owner only) and the access log.
    .get("/privacy/mine", async (c) => c.json(await myMailboxPrivacy(c.var.deps, c.var.auth)))
    .get("/:id/sharing", async (c) => c.json(await sharingView(c.var.deps, c.var.auth, c.req.param("id"))))
    .put("/:id/sharing/:userId", async (c) => {
      const { level } = await parseBody(c, z.object({ level: z.enum(["read", "reply", "send_as"]) }));
      return c.json(await shareMailbox(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("userId"), level));
    })
    .delete("/:id/sharing/:userId", async (c) => c.json(await unshareMailbox(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("userId"))))
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, createMailboxSchema);
      const { auth, deps } = c.var;
      const m = await createMailbox(deps.db, auth.orgId, input, deps.config);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.created", targetType: "mailbox", targetId: m.id, metadata: { address: m.address }, ip: c.var.ip });
      return c.json({ mailbox: m }, 201);
    })
    .patch("/:id", requireAdmin, async (c) => {
      const patch = await parseBody(c, updateMailboxSchema);
      const { auth, deps } = c.var;
      const m = await updateMailbox(deps.db, auth.orgId, c.req.param("id"), patch);
      if (patch.quotaMb !== undefined) await syncQuota(deps, auth.orgId, m.id, m.quotaMb);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.updated", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, ...patch }, ip: c.var.ip });
      return c.json({ mailbox: m });
    })
    .delete("/:id", requireAdmin, async (c) => {
      const { auth, deps } = c.var;
      await assertMailboxNotHeld(deps, auth.orgId, c.req.param("id")); // R111: a mailbox on legal hold stays
      // Remove the mail server account first, so a failure there leaves nothing orphaned.
      await deprovisionMailbox(deps, auth.orgId, c.req.param("id"));
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
