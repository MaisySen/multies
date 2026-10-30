import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { createAppPassword, listAppPasswords, mailAccessSettings, revokeAppPassword } from "../services/mailserver";

const createSchema = z.object({ name: z.string().trim().min(1, "Give it a name, like the device it's for.").max(60) });

/** Mail app access: server settings and app passwords per mailbox. */
export function mailAccessRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", (c) => c.json(mailAccessSettings(c.var.deps)))
    .get("/mailboxes/:id/app-passwords", async (c) => c.json({ appPasswords: await listAppPasswords(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/mailboxes/:id/app-passwords", async (c) => {
      const { name } = await parseBody(c, createSchema);
      const { auth, deps } = c.var;
      const out = await createAppPassword(deps, auth, c.req.param("id"), name);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "app_password.created", targetType: "mailbox", targetId: out.appPassword.mailboxId, metadata: { name, username: out.username }, ip: c.var.ip });
      return c.json(out, 201);
    })
    .delete("/app-passwords/:id", async (c) => {
      const { auth, deps } = c.var;
      const p = await revokeAppPassword(deps, auth, c.req.param("id"));
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "app_password.revoked", targetType: "mailbox", targetId: p.mailboxId, metadata: { name: p.name }, ip: c.var.ip });
      return c.json({ ok: true });
    });
}
