/**
 * R26 (MB-85): checklists inside a task, in the app (cookie session). Members see and edit the checklist of any
 * task they can open; a project guest reads the checklists of their own project only. The same service backs
 * REST (v1-r26-checklists.ts) and MCP (mcp-r26-checklists.ts).
 */
import { Hono, type MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { addChecklistItems, checklistItemToSubtask, CHECKLIST_TITLE_MAX, deleteChecklistItem, listChecklist, reorderChecklist, updateChecklistItem } from "../services/suite/checklists";
import { GUEST_COOKIE, resolveGuest, type GuestContext } from "../services/suite/guests";

export const ChecklistItemBody = z.object({
  title: z.string().min(1).max(CHECKLIST_TITLE_MAX),
  done: z.boolean().optional(),
  assignee: z.string().max(120).nullable().optional(),
  due: z.string().max(40).nullable().optional(),
  position: z.number().finite().optional(),
});
export const ChecklistAddBody = z.union([ChecklistItemBody, z.object({ items: z.array(ChecklistItemBody).min(1).max(200) })]);
export const ChecklistPatchBody = ChecklistItemBody.partial();
export const ChecklistReorderBody = z.object({ ids: z.array(z.string().min(1).max(80)).max(200) });

export const addInput = (b: z.infer<typeof ChecklistAddBody>) => ("items" in b ? b.items : b);

/** /api/tasks/:id/checklist (mounted before taskRoutes). */
export function checklistTaskRoutes() {
  return new Hono<AppEnv>()
    .use("/:id/checklist", requireAuth)
    .use("/:id/checklist/*", requireAuth)
    .get("/:id/checklist", async (c) => c.json(await listChecklist(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/checklist", async (c) => c.json({ items: await addChecklistItems(c.var.deps, c.var.auth, c.req.param("id"), addInput(await parseBody(c, ChecklistAddBody))) }, 201))
    .post("/:id/checklist/reorder", async (c) => c.json(await reorderChecklist(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, ChecklistReorderBody)).ids)));
}

/** /api/checklist-items/:id */
export function checklistItemRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .patch("/:id", async (c) => c.json({ item: await updateChecklistItem(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, ChecklistPatchBody)) }))
    .delete("/:id", async (c) => c.json(await deleteChecklistItem(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/to-subtask", async (c) => c.json(await checklistItemToSubtask(c.var.deps, c.var.auth, c.req.param("id")), 201));
}

type GuestEnv = AppEnv & { Variables: AppEnv["Variables"] & { guest: GuestContext } };
const requireGuest: MiddlewareHandler<GuestEnv> = async (c, next) => {
  const g = await resolveGuest(c.var.deps, getCookie(c, GUEST_COOKIE));
  if (!g) throw new HttpError(401, "guest_unauthenticated", "Open your invite link again, or ask for a new one.");
  c.set("guest", g);
  await next();
};

/** /api/guest/r26/tasks/:id/checklist: read only, the guest's own project. */
export function guestChecklistRoutes() {
  return new Hono<GuestEnv>()
    .use("*", requireGuest)
    .get("/tasks/:id/checklist", async (c) => {
      const g = c.var.guest;
      const res = await listChecklist(c.var.deps, g.actor, c.req.param("id"), g.guest.projectId);
      return c.json({ ...res, items: res.items.map((i) => ({ ...i, assignee: null })) });
    });
}
