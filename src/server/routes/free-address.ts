import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
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
      // The claim writes its own audit row, which the abuse limits count (services/free-address.ts).
      const m = await claimFreeAddress(deps, auth, input, { ip: c.var.ip, deviceId: c.req.header("x-device-id") ?? null });
      return c.json({ mailbox: m }, 201);
    });
}
