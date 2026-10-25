import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { checkFreeAddress, claimFreeAddress, freeAddressInfo } from "../services/free-address";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";

const claimSchema = z.object({
  localPart: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(120).optional(),
});

/** Free addresses on the shared Multies domain (services/free-address.ts). */
export function freeAddressRoutes() {
  // Checks run as the name is typed (debounced in the apps); enough for that, not for sweeping names.
  const checks = new RateLimiter(60, 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json(await freeAddressInfo(c.var.deps, c.var.auth)))
    .get("/check", async (c) => {
      const localPart = (c.req.query("localPart") ?? "").slice(0, 64);
      if (!checks.take(c.var.auth.userId || c.var.ip || "anon")) throw tooMany("Too many checks. Slow down a little.");
      return c.json(await checkFreeAddress(c.var.deps, localPart));
    })
    .post("/", requireAdmin, async (c) => {
      const input = await parseBody(c, claimSchema);
      const { auth, deps } = c.var;
      // The claim writes its own audit row, which the abuse limits count (services/free-address.ts).
      const m = await claimFreeAddress(deps, auth, input, { ip: c.var.ip, deviceId: c.req.header("x-device-id") ?? null });
      return c.json({ mailbox: m }, 201);
    });
}
