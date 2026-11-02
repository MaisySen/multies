/**
 * TD9 (PORTAL_TD9 with CLIENT_PORTAL): team side paths. Every handler answers 404 while the flag is off.
 * Chained into portalRoutes (/api/portals, already signed in and flag checked there) without a "*" middleware,
 * so nothing here touches the R120 paths.
 *   GET|PUT  /api/portals/:id/people/:pid/access          { area, level }        (PUT: portal managers)
 *   GET      /api/portals/:id/pick?kind=project|invoice|form&q=
 *   PATCH    /api/portals/:id/items/:itemId               { projectItemId }       (link a shared file to a shared project)
 *   GET|POST /api/portals/:id/items/:itemId/milestones    PATCH|DELETE .../milestones/:mid
 *   GET|POST /api/portals/:id/items/:itemId/comments      { body, toUserId?, toPersonId? }
 * Mounted at /api/item-comments (task panel and project page):
 *   GET|POST /:kind/:refId   GET /:kind/:refId/recipients   DELETE /:id
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { notFound } from "../lib/errors";
import { PORTAL_AREAS, PORTAL_LEVELS } from "@/shared/portal-td9";
import {
  addMilestone, deleteComment, deleteMilestone, getAccess, linkFile, pick, recipients, setAccess, targetComment, targetComments,
  td9On, teamItemComment, teamItemComments, teamMilestones, updateMilestone,
} from "../services/portal/portal-td9";

const gate = (c: Context<AppEnv>) => { if (!td9On(c.var.deps)) throw notFound("Page"); c.header("Cache-Control", "private, no-store"); };
const AccessBody = z.object({ area: z.enum(PORTAL_AREAS), level: z.enum(PORTAL_LEVELS) });
const LinkBody = z.object({ projectItemId: z.string().max(64).nullable() });
const MilestoneBody = z.object({ title: z.string().max(400), due: z.string().max(20).nullable().optional() });
const MilestonePatch = z.object({ title: z.string().max(400).optional(), due: z.string().max(20).nullable().optional(), done: z.boolean().optional() });
const CommentBody = z.object({ body: z.string().max(5000), toUserId: z.string().max(64).nullable().optional(), toPersonId: z.string().max(64).nullable().optional() });
const Kind = z.enum(["task", "project"]);
const kindOf = (c: Context<AppEnv>) => { const k = Kind.safeParse(c.req.param("kind")); if (!k.success) throw notFound("Page"); return k.data; };

export function portalTd9TeamRoutes() {
  return new Hono<AppEnv>()
    .get("/:id/people/:pid/access", async (c) => { gate(c); return c.json(await getAccess(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid"))); })
    .put("/:id/people/:pid/access", async (c) => {
      gate(c);
      const b = await parseBody(c, AccessBody);
      return c.json(await setAccess(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("pid"), b.area, b.level));
    })
    .get("/:id/pick", async (c) => {
      gate(c);
      const k = z.enum(["project", "invoice", "form"]).safeParse(c.req.query("kind"));
      if (!k.success) throw notFound("Page");
      return c.json({ items: await pick(c.var.deps, c.var.auth, c.req.param("id"), k.data, (c.req.query("q") ?? "").trim()) });
    })
    .patch("/:id/items/:itemId", async (c) => { gate(c); return c.json(await linkFile(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), (await parseBody(c, LinkBody)).projectItemId)); })
    .get("/:id/items/:itemId/milestones", async (c) => { gate(c); return c.json(await teamMilestones(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"))); })
    .post("/:id/items/:itemId/milestones", async (c) => { gate(c); return c.json(await addMilestone(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), await parseBody(c, MilestoneBody)), 201); })
    .patch("/:id/items/:itemId/milestones/:mid", async (c) => { gate(c); return c.json(await updateMilestone(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), c.req.param("mid"), await parseBody(c, MilestonePatch))); })
    .delete("/:id/items/:itemId/milestones/:mid", async (c) => { gate(c); return c.json(await deleteMilestone(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), c.req.param("mid"))); })
    .get("/:id/items/:itemId/comments", async (c) => { gate(c); return c.json(await teamItemComments(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"))); })
    .post("/:id/items/:itemId/comments", async (c) => { gate(c); return c.json(await teamItemComment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("itemId"), await parseBody(c, CommentBody)), 201); });
}

export function itemCommentRoutes() {
  return new Hono<AppEnv>()
    .use("*", async (c, next) => { gate(c); await next(); })
    .use("*", requireAuth)
    .delete("/:id", async (c) => c.json(await deleteComment(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/:kind/:refId/recipients", async (c) => c.json(await recipients(c.var.deps, c.var.auth, kindOf(c), c.req.param("refId"))))
    .get("/:kind/:refId", async (c) => c.json(await targetComments(c.var.deps, c.var.auth, kindOf(c), c.req.param("refId"))))
    .post("/:kind/:refId", async (c) => c.json(await targetComment(c.var.deps, c.var.auth, kindOf(c), c.req.param("refId"), await parseBody(c, CommentBody)), 201));
}
