import { sql } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { rateLimiter, type Store } from "hono-rate-limiter";
import type { AppEnv, RateLimitScope } from "../context";
import type { DB } from "../db";

/**
 * Fixed-window in-memory limiter. Per process (per isolate on Workers), which is
 * enough to blunt credential stuffing; put a shared store behind this interface
 * when running many instances.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(t);
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}


/** Requests allowed per minute, per client, in each scope. */
export const RATE_LIMITS: Record<RateLimitScope, number> = {
  /** Sign-in, sign-up, password reset, 2FA: per IP. Better Auth adds per-path limits too. */
  auth: 30,
  /** REST API: per API key. */
  api: 600,
  /** Provider webhooks and inbound mail: per source IP. */
  webhooks: 600,
  /** The web app's state-changing calls: per signed-in user, else per IP. */
  app: 300,
  /** MH1: app to web sign in handoff, per person for new codes and per address for redeems. */
  handoff: 20,
};

/**
 * A fixed-window counter in the database, so every Worker isolate and every Node
 * process shares one count. Used when no Cloudflare rate limiting binding is bound.
 * One upsert per counted request; reads (GET) are not counted in this mode.
 */
export class DbRateLimitStore implements Store<AppEnv> {
  private windowMs = 60_000;
  prefix = "rl:";
  constructor(private db: () => DB, private now: () => number = Date.now) {}
  init(options: { windowMs: number }) { this.windowMs = options.windowMs; }

  async increment(key: string) {
    const t = this.now();
    const reset = t + this.windowMs;
    const rows = (await this.db().all(sql`
      INSERT INTO api_rate_limits (key, hits, reset_at) VALUES (${this.prefix + key}, 1, ${reset})
      ON CONFLICT(key) DO UPDATE SET
        hits = CASE WHEN api_rate_limits.reset_at <= ${t} THEN 1 ELSE api_rate_limits.hits + 1 END,
        reset_at = CASE WHEN api_rate_limits.reset_at <= ${t} THEN ${reset} ELSE api_rate_limits.reset_at END
      RETURNING hits, reset_at`)) as { hits: number; reset_at: number }[];
    const row = rows[0] ?? { hits: 1, reset_at: reset };
    return { totalHits: Number(row.hits), resetTime: new Date(Number(row.reset_at)) };
  }
  async decrement(key: string) {
    await this.db().run(sql`UPDATE api_rate_limits SET hits = MAX(hits - 1, 0) WHERE key = ${this.prefix + key}`);
  }
  async resetKey(key: string) {
    await this.db().run(sql`DELETE FROM api_rate_limits WHERE key = ${this.prefix + key}`);
  }
}

/**
 * Removes expired counters. Called from maintenance. A prune that fails (the database busy with
 * other writes, or a preview database still migrating) is skipped: expired rows are ignored when
 * counting anyway, and the next pass removes them.
 */
export async function pruneRateLimits(db: DB, now = Date.now()): Promise<boolean> {
  try {
    await db.run(sql`DELETE FROM api_rate_limits WHERE reset_at <= ${now}`);
    return true;
  } catch {
    return false;
  }
}

const body = { error: { code: "rate_limited", message: "Too many requests. Slow down and try again shortly." } };

/**
 * Rate limiting by scope, through hono-rate-limiter. A Cloudflare rate limiting
 * binding is used when the deployment declares one (RL_AUTH, RL_API, RL_WEBHOOKS,
 * RL_APP in wrangler.toml); otherwise the shared database counter above.
 */
export function rateLimit(scope: RateLimitScope, keyGenerator: (c: Context<AppEnv>) => string, opts: { countReads?: boolean } = {}): MiddlewareHandler<AppEnv> {
  let dbLimiter: MiddlewareHandler<AppEnv> | null = null;
  let current: DB | null = null;
  const store = new DbRateLimitStore(() => current!);
  const limit = RATE_LIMITS[scope];
  return async (c, next) => {
    const deps = c.var.deps;
    const bound = deps.rateLimiters?.[scope];
    if (bound) {
      const { success } = await bound.limit({ key: `${scope}:${keyGenerator(c)}` });
      if (!success) {
        c.header("retry-after", "60");
        c.var.log?.warn("rate_limited", { scope });
        return c.json(body, 429);
      }
      return next();
    }
    // Without a binding, reads are free so a page load costs no database writes.
    if (!opts.countReads && (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS")) return next();
    current = deps.db;
    dbLimiter ??= rateLimiter<AppEnv>({
      windowMs: 60_000, limit, standardHeaders: "draft-6", store, keyGenerator: (ctx) => `${scope}:${keyGenerator(ctx)}`,
      handler: (ctx) => {
        ctx.var.log?.warn("rate_limited", { scope });
        return ctx.json(body, 429);
      },
    }) as unknown as MiddlewareHandler<AppEnv>;
    return dbLimiter(c, next);
  };
}
