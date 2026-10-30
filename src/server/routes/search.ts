/**
 * Search everything and My Work (round 20), for people in the app (cookie session) and for
 * project guests (their own cookie, their one project). Reads only: nothing here writes a row.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { myWork, parseTypes, searchEverything } from "../services/search";
import { GUEST_COOKIE, resolveGuest, type GuestContext } from "../services/suite/guests";

const limitOf = (raw: string | undefined) => (raw && /^\d{1,2}$/.test(raw) ? Number(raw) : undefined);

/** GET /api/search?q=word&types=tasks,docs&limit=5 */
export function searchRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { deps, auth } = c.var;
      const out = await searchEverything(deps, { kind: "actor", actor: auth }, c.req.query("q") ?? "", { types: parseTypes(c.req.query("types")), limit: limitOf(c.req.query("limit")) });
      c.var.log?.info("search", { ms: out.tookMs, groups: out.groups.length, partial: out.partial });
      c.header("Server-Timing", `search;dur=${out.tookMs}`);
      return c.json(out);
    });
}

/** GET /api/my-work?tz=Australia/Sydney */
export function myWorkRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const out = await myWork(c.var.deps, c.var.auth, { timeZone: c.req.query("tz") });
      c.var.log?.info("my_work", { ms: out.tookMs });
      c.header("Server-Timing", `mywork;dur=${out.tookMs}`);
      return c.json(out);
    });
}

type GuestEnv = AppEnv & { Variables: AppEnv["Variables"] & { guest: GuestContext } };
const requireGuest: MiddlewareHandler<GuestEnv> = async (c, next) => {
  const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
  if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
  c.set("guest", g);
  await next();
};

/** GET /api/guest/search?q=word: a guest searches their one project (tasks, docs, guest channels). */
export function guestSearchRoutes() {
  return new Hono<GuestEnv>()
    .use("*", requireGuest)
    .get("/", async (c) => {
      const g = c.var.guest.guest;
      return c.json(await searchEverything(c.var.deps, { kind: "guest", orgId: g.orgId, projectId: g.projectId }, c.req.query("q") ?? "", { types: parseTypes(c.req.query("types")), limit: limitOf(c.req.query("limit")) }));
    });
}
