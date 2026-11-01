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
import { parseFilters, searchIndex } from "../services/search-r98"; // R98
import { GUEST_COOKIE, resolveGuest, type GuestContext } from "../services/suite/guests";

const limitOf = (raw: string | undefined) => (raw && /^\d{1,2}$/.test(raw) ? Number(raw) : undefined);

/** R98: person, from, to, project and strict, read only while SEARCH_R98 is on (ignored otherwise, as before). */
const r98Opts = (deps: AppEnv["Variables"]["deps"], q: (k: string) => string | undefined) => (deps.config.searchR98
  ? { filters: parseFilters({ person: q("person"), from: q("from"), to: q("to"), project: q("project") }), strict: q("strict") === "1" }
  : {});

/** GET /api/search?q=word&types=tasks,docs&limit=5 (R98: &person=<user id>&from=2026-10-01&to=2026-10-31&project=<id>&strict=1) */
export function searchRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // R98: the titles the command menu indexes in the browser for instant results (404 unless SEARCH_R98).
    .get("/index", async (c) => {
      if (!c.var.deps.config.searchR98) throw new HttpError(404, "not_found", "Page not found.");
      const out = await searchIndex(c.var.deps, c.var.auth);
      c.header("Cache-Control", "private, no-store");
      c.header("Server-Timing", `searchindex;dur=${out.tookMs}`);
      return c.json(out);
    })
    .get("/", async (c) => {
      const { deps, auth } = c.var;
      const out = await searchEverything(deps, { kind: "actor", actor: auth }, c.req.query("q") ?? "", { ...r98Opts(c.var.deps, (k) => c.req.query(k)), types: parseTypes(c.req.query("types")), limit: limitOf(c.req.query("limit")), ...r98Opts(deps, (k) => c.req.query(k)) });
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
