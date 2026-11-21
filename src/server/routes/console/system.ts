/**
 * OPS1: /api/console/system, System health.
 *
 *   GET  /snapshot         the whole status page in one read (system.read): release, pending migrations, D1 writes and
 *                          reads against budget, busiest workspaces today, uptime, integrations (configured or not, never
 *                          keys), circuit breakers (the answering isolate only) and rate limits
 *   GET  /lockouts         { items, nextCursor } (system.read) ?status=locked|all|any (locked; any is all) &sort=lockedUntil|failures|windowStart:dir
 *   POST /lockouts/clear   { email, reason } (users.unlock) clears the failed sign in count and lock
 *   POST /sentry-test      { reason } (system.manage) sends one test error to Sentry, as POST /api/admin/sentry-test
 */
import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../../context";
import { users } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { parseBody, parseQuery } from "../../middleware";
import { operatorSession, requireOperator } from "../../auth/operator";
import { operatorAction, reasonSchema } from "../../services/console/audit";
import { clearLockout, listLockouts, systemSnapshot, type LockoutSortField } from "../../services/console/system";
import type { ConsoleCursor, ConsolePage, ConsolePageResult } from "../../services/console/jobs";

const STALE = "That page link is out of date. Start the list again.";

function encodeCursor(c: ConsoleCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: c.v, id: c.id }));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(s: string): ConsoleCursor {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const o = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)))) as ConsoleCursor;
    if (!o || typeof o.id !== "string" || !o.id || (typeof o.v !== "string" && typeof o.v !== "number")) throw new Error("shape");
    return { v: o.v, id: o.id };
  } catch {
    throw new HttpError(400, "bad_cursor", STALE);
  }
}

function pageOf<F extends string>(c: Context<AppEnv>, defaultSort: `${F}:${"asc" | "desc"}`): ConsolePage<F> {
  const q = c.req.query();
  const n = Number.parseInt(q.limit ?? "", 10);
  const [df, dd] = defaultSort.split(":") as [F, "asc" | "desc"];
  const [f, d] = (q.sort ?? "").split(":");
  return {
    limit: Number.isFinite(n) && n > 0 ? n : 50,
    cursor: q.cursor ? decodeCursor(q.cursor) : null,
    sort: { field: f || df, dir: d === "asc" || d === "desc" ? d : dd },
  };
}

const answer = <T>(p: ConsolePageResult<T>) => ({ items: p.items, nextCursor: p.next ? encodeCursor(p.next) : null });

// "any", the console's older word for all, is still accepted.
const LockoutsQuery = z.object({ status: z.enum(["locked", "all", "any"]).default("locked") }).passthrough();

export function systemRoutes() {
  return new Hono<AppEnv>()
    .use("*", operatorSession)
    .get("/snapshot", requireOperator("system.read"), async (c) => {
      c.header("cache-control", "no-store");
      return c.json(await systemSnapshot(c.var.deps));
    })
    .get("/lockouts", requireOperator("system.read"), async (c) => {
      const f = parseQuery(c, LockoutsQuery);
      c.header("cache-control", "no-store");
      return c.json(answer(await listLockouts(c.var.deps, { lockedOnly: f.status === "locked" }, pageOf<LockoutSortField>(c, "lockedUntil:desc"))));
    })
    .post("/lockouts/clear", requireOperator("users.unlock"), async (c) => {
      const body = await parseBody(c, z.object({ email: z.string().trim().min(3, "Give the account's email address.").max(320), reason: reasonSchema }));
      const email = body.email.toLowerCase();
      const user = await c.var.deps.db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
      type R = Awaited<ReturnType<typeof clearLockout>>;
      const out = await operatorAction(c, {
        action: "user.lockout_cleared", targetType: "user", targetId: user?.id ?? email, reason: body.reason,
        before: (x: R) => ({ failures: x.failures, locked: x.wasLocked }), after: { failures: 0, locked: false },
        metadata: { email },
      }, () => clearLockout(c.var.deps, body.email));
      return c.json({ ok: true, email: out.email, wasLocked: out.wasLocked });
    })
    .post("/sentry-test", requireOperator("system.manage"), async (c) => {
      const { reason } = await parseBody(c, z.object({ reason: reasonSchema }));
      const { deps } = c.var;
      if (!deps.config.sentry.dsnApi || !deps.reportError) return c.json({ configured: false, eventId: null });
      const eventId = await operatorAction(c, {
        action: "system.sentry_test", targetType: "system", reason, after: (e: string | null) => ({ eventId: e }),
      }, () => deps.reportError!(new Error(`Multies API test event (${deps.now().toISOString()})`), { test: true, by: c.var.auth.email }) ?? null);
      return c.json({ configured: true, eventId });
    });
}
