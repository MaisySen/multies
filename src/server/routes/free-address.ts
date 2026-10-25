import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import { claimFreeAddress, freeAddressInfo } from "../services/free-address";

const claimSchema = z.object({
  localPart: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(120).optional(),
});

/** Free addresses on the shared Multies domain (services/free-address.ts). */
export function freeAddressRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await freeAddressInfo(c.var.deps, c.var.auth)))
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, claimSchema);
      const { auth, deps } = c.var;
      const m = await claimFreeAddress(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.created", targetType: "mailbox", targetId: m.id, metadata: { address: m.address, free: true }, ip: c.var.ip });
      return c.json({ mailbox: m }, 201);
    });
}
