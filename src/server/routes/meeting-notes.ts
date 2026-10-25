/**
 * Round 23 (R23.1): a meeting's agenda and notes doc in the web app (cookie session), mounted at
 * /api/meeting-notes. Anyone in the workspace who can open the meeting can open its notes; project
 * guests and meeting guests (the /m/<token> page) have no workspace session and get 401.
 * The same service backs the REST API (v1-r23-notes.ts) and the MCP tools (mcp-r23-notes.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { createActionItems, ensureNotesDoc, meetingForDoc, meetingNotes } from "../services/suite/meeting-notes";

const AssigneeIn = z.union([z.string().max(320), z.object({ type: z.enum(["member", "agent"]), id: z.string().min(1).max(100) })]).nullable().optional();
export const ActionItemsCreate = z.object({
  projectId: z.string().min(1).max(100).nullable().optional(),
  items: z.array(z.object({
    key: z.string().min(1).max(40).optional(),
    title: z.string().max(500).optional(),
    assignee: AssigneeIn,
    due: z.string().max(40).nullable().optional(),
  })).max(50).optional(),
});

export function meetingNotesRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/by-doc/:docId", async (c) => c.json({ meeting: await meetingForDoc(c.var.deps, c.var.auth, c.req.param("docId")) }))
    .get("/:id", async (c) => c.json(await meetingNotes(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id", async (c) => {
      await ensureNotesDoc(c.var.deps, c.var.auth, c.req.param("id"));
      return c.json(await meetingNotes(c.var.deps, c.var.auth, c.req.param("id")));
    })
    .post("/:id/action-items", async (c) => {
      const r = await createActionItems(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ActionItemsCreate));
      return c.json({ ...r, notes: await meetingNotes(c.var.deps, c.var.auth, c.req.param("id")) });
    });
}
