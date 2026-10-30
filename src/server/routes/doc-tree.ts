/**
 * R24.5 Docs tree and backlinks in the web app (cookie session):
 * GET /api/docs/tree, PATCH /api/docs/:id/move, GET /api/docs/:id/backlinks, GET /api/tasks/:id/backlinks,
 * and for project guests GET /api/guest/r24/docs/tree, /docs/:id/backlinks and /tasks/:id/backlinks.
 * Mounted before the docs and task routes so "tree" is not read as a doc id. The same service backs
 * the public API (v1-r24-docs.ts) and the MCP tools (mcp-r24-docs.ts).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { getBacklinks, getDocTree, moveDoc } from "../services/suite/doc-tree";
import { GUEST_COOKIE, resolveGuest, type GuestContext } from "../services/suite/guests";
import { resolveTaskId } from "../services/suite/tasks";

const id = z.string().min(1).max(64);
export const DocMove = z.object({
  parentId: id.nullable().optional(),
  beforeId: id.optional(),
  afterId: id.optional(),
  position: z.number().finite().optional(),
}).refine((m) => !(m.beforeId && m.afterId), { message: "Send beforeId or afterId, not both." });

export function docTreeRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/tree", async (c) => c.json(await getDocTree(c.var.deps, { orgId: c.var.auth.orgId })))
    .patch("/:id/move", async (c) => c.json(await moveDoc(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, DocMove))))
    .get("/:id/backlinks", async (c) => c.json(await getBacklinks(c.var.deps, { orgId: c.var.auth.orgId }, { type: "doc", id: c.req.param("id") })));
}

export function taskBacklinkRoutes() {
  return new Hono<AppEnv>()
    .use("/:id/backlinks", requireAuth)
    .get("/:id/backlinks", async (c) => {
      const orgId = c.var.auth.orgId;
      return c.json(await getBacklinks(c.var.deps, { orgId }, { type: "task", id: await resolveTaskId(c.var.deps, orgId, c.req.param("id")) }));
    });
}

type GuestEnv = AppEnv & { Variables: AppEnv["Variables"] & { guest: GuestContext } };
const requireGuest: MiddlewareHandler<GuestEnv> = async (c, next) => {
  const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
  if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
  c.set("guest", g);
  await next();
};

/** A guest sees the pages and backlinks of their own project only. */
export function guestDocTreeRoutes() {
  const viewer = (g: GuestContext) => ({ orgId: g.guest.orgId, projectId: g.guest.projectId });
  return new Hono<GuestEnv>()
    .use("*", requireGuest)
    .get("/docs/tree", async (c) => c.json(await getDocTree(c.var.deps, viewer(c.var.guest))))
    .get("/docs/:id/backlinks", async (c) => c.json(await getBacklinks(c.var.deps, viewer(c.var.guest), { type: "doc", id: c.req.param("id") })))
    .get("/tasks/:id/backlinks", async (c) => {
      const v = viewer(c.var.guest);
      return c.json(await getBacklinks(c.var.deps, v, { type: "task", id: await resolveTaskId(c.var.deps, v.orgId, c.req.param("id")) }));
    });
}
