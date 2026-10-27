/**
 * Settings, Import, Work tools: preview a file from Trello, Asana, ClickUp, monday, Jira, Linear or
 * Notion with a column mapping, then bring it into a new or existing project. Any workspace member
 * may import (members can already make projects and tasks); a read only key cannot.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { MAP_FIELDS } from "../services/work-import/parse";
import { previewImport, runImport } from "../services/work-import/service";

const MappingBody = z.object(Object.fromEntries(MAP_FIELDS.map((f) => [f, z.string().max(200).nullable().optional()]))).partial();
export const WorkImportFile = z.object({
  fileName: z.string().max(255).optional(),
  content: z.string().min(1).max(8_000_000),
  mapping: MappingBody.optional(),
});
export const WorkImportRun = WorkImportFile.extend({
  projectId: z.string().max(64).nullable().optional(),
  projectName: z.string().trim().max(120).nullable().optional(),
});

export function workImportRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/preview", async (c) => c.json(await previewImport(c.var.deps, c.var.auth, await parseBody(c, WorkImportFile))))
    .post("/run", async (c) => c.json(await runImport(c.var.deps, c.var.auth, await parseBody(c, WorkImportRun))));
}
