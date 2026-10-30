import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { checkFreeAddress, claimFreeAddress, freeAddressInfo, MAX_LOCAL_INPUT } from "../services/free-address";
import { RateLimiter } from "../lib/rate-limit";
import { HttpError, tooMany } from "../lib/errors";

const claimSchema = z.object({
  localPart: z.string().trim().min(1, "Choose a name for your address.").max(64, "That name is too long. Use 3 to 40 lowercase letters, numbers, dots or dashes."),
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
      const localPart = c.req.query("localPart") ?? "";
      if (!checks.take(c.var.auth.userId || c.var.ip || "anon")) throw tooMany("Too many checks. Slow down a little.");
      // R56 (MB-241): an over long name is refused before any lookup, in words, never cut short and checked as something else.
      if (localPart.length > MAX_LOCAL_INPUT) throw new HttpError(422, "free_mail_name", "That name is too long. Use 3 to 40 lowercase letters, numbers, dots or dashes.");
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
