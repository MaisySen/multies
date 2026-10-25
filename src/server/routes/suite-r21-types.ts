/**
 * Round 21 (R21.4) in the app (cookie session): epics with their progress, and adding or removing
 * items. Task types themselves ride the normal task create and update (type: task, story, bug, epic).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { addToEpic, getEpic, listEpics, MAX_EPIC_BATCH, removeFromEpic } from "../services/suite/task-types";

export const EpicQuery = z.object({ project: z.string().max(64).optional(), projectId: z.string().max(64).optional() });
export const EpicItems = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_EPIC_BATCH) });

export function epicRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const q = parseQuery(c, EpicQuery);
      return c.json({ epics: await listEpics(c.var.deps, c.var.auth, { projectId: q.project ?? q.projectId }) });
    })
    .get("/:id", async (c) => c.json(await getEpic(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/items", async (c) => c.json(await addToEpic(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, EpicItems)).ids)))
    .delete("/:id/items", async (c) => c.json(await removeFromEpic(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, EpicItems)).ids)));
}
