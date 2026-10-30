import { Hono } from "hono";
import type { AppEnv } from "../context";
import { domainNameSchema } from "@/shared/schemas";
import { HttpError, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { DnsLookupError } from "../services/dns/resolver";
import { CheckCache, checkDomainMail } from "../services/mail-check";

/**
 * GET /api/check/domain?domain=example.com: the public domain mail check (no sign in).
 * Limited in memory per IP and cached per domain, so a call costs no database write.
 */
export function checkRoutes() {
  const limiter = new RateLimiter(20, 60_000);
  const cache = new CheckCache();
  return new Hono<AppEnv>()
    .get("/domain", async (c) => {
      const parsed = domainNameSchema.safeParse(c.req.query("domain") ?? "");
      if (!parsed.success) throw new HttpError(422, "invalid_domain", "Enter a domain like example.com.");
      const domain = parsed.data;
      const { deps } = c.var;
      const now = deps.now();
      const hit = cache.get(domain, now.getTime());
      if (hit) return c.json({ check: hit }, 200, { "cache-control": "public, max-age=300" });
      if (!limiter.take(c.var.ip)) throw tooMany("Too many checks from your network. Try again in a minute.");
      try {
        const check = await checkDomainMail(deps.dns, deps.config, domain, now);
        cache.set(domain, check, now.getTime());
        return c.json({ check }, 200, { "cache-control": "public, max-age=300" });
      } catch (err) {
        if (err instanceof DnsLookupError) throw new HttpError(502, "dns_unavailable", "We couldn't reach DNS for that domain just now. Try again in a moment.");
        throw err;
      }
    });
}
