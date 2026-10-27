/**
 * R38 move your data (Settings, Import and export): the history, a workspace export with a download link that expires,
 * and imports of tasks (any work tool file), calendar (.ics), contacts (vCard or CSV), docs (Markdown) and a whole
 * workspace (an export zip), each with Undo. The download link answers without a session: its token is the key.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { idempotency, sessionIdempotencyScope } from "../lib/idempotency"; // R40 (MB-201)
import { exportWorkspace } from "../services/privacy";
import { exportFinished, getMove, listMoves, openExport, previewMove, runMove, startExport, undoMove } from "../services/data-move/service";
import { WorkImportRun } from "./work-imports";
import { importMboxBatch, MBOX_BATCH, stopMbox } from "../services/data-move/mbox"; // R40 mbox upload

/** R40: one batch of an .mbox upload, read and split in the browser. */
export const MboxBatch = z.object({
  mailboxId: z.string().min(1).max(64), moveId: z.string().max(64).nullable().optional(), fileName: z.string().max(255).optional(),
  total: z.number().int().min(0).max(1_000_000), folder: z.string().max(100).optional(), last: z.boolean().optional(),
  messages: z.array(z.string().max(40_000_000)).max(MBOX_BATCH),
});

export const DataMoveRun = WorkImportRun.extend({
  kind: z.enum(["tasks", "calendar", "contacts", "docs", "workspace"]).default("tasks"),
  moveId: z.string().max(64).nullable().optional(),
  statusMap: z.record(z.string().max(200), z.string().max(64).nullable()).optional(),
  people: z.record(z.string().max(200), z.string().max(64).nullable()).optional(),
});

/** The download: the token in the link is checked against its stored hash and its expiry. */
export function dataMoveDownloadRoutes() {
  return new Hono<AppEnv>().get("/exports/:id/download", async (c) => {
    const deps = c.var.deps;
    const { move, auth } = await openExport(deps, c.req.param("id"), c.req.query("token") ?? "");
    const stream = exportWorkspace(deps, auth, { onDone: (counts) => exportFinished(deps, move.id, counts) });
    const day = move.createdAt.toISOString().slice(0, 10);
    return new Response(stream, { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="workspace-export-${day}.zip"`, "cache-control": "no-store", "x-robots-tag": "noindex" } });
  });
}

export function dataMoveRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", idempotency(sessionIdempotencyScope)) // R40 (MB-201)
    .get("/", async (c) => c.json(await listMoves(c.var.deps, c.var.auth)))
    .get("/:id", async (c) => c.json(await getMove(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/exports", async (c) => c.json(await startExport(c.var.deps, c.var.auth)))
    .post("/imports/preview", async (c) => c.json(await previewMove(c.var.deps, c.var.auth, await parseBody(c, DataMoveRun))))
    .post("/imports/run", async (c) => c.json(await runMove(c.var.deps, c.var.auth, await parseBody(c, DataMoveRun))))
    .post("/mbox/batch", async (c) => c.json(await importMboxBatch(c.var.deps, c.var.auth, await parseBody(c, MboxBatch))))
    .post("/mbox/:id/stop", async (c) => c.json(await stopMbox(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/undo", async (c) => c.json(await undoMove(c.var.deps, c.var.auth, c.req.param("id"))));
}
