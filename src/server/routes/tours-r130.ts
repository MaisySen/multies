/** R130: guided onboarding (flag TOURS_R130; mounted only when on). Session routes: project guests and portal users never reach them. */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { ProgressInput, TourInput, TourPatch } from "@/shared/tours-r130";
import { createTour, deleteTour, getTour, listTours, recordProgress, resetProgress, toursMe, updateChecklist, updateTour } from "../services/tours-r130";

const ChecklistBody = z.object({ action: z.enum(["mark", "dismiss", "resume", "celebrated"]), step: z.string().max(40).optional() });
const ResetBody = z.object({ tourId: z.string().max(80).nullable().optional() });

export function toursRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/me", async (c) => c.json(await toursMe(c.var.deps, c.var.auth)))
    .post("/checklist", async (c) => c.json(await updateChecklist(c.var.deps, c.var.auth, await parseBody(c, ChecklistBody))))
    .post("/progress", async (c) => c.json(await recordProgress(c.var.deps, c.var.auth, await parseBody(c, ProgressInput))))
    .get("/admin", async (c) => c.json(await listTours(c.var.deps, c.var.auth)))
    .post("/admin", async (c) => c.json(await createTour(c.var.deps, c.var.auth, await parseBody(c, TourInput))))
    .get("/admin/:id", async (c) => c.json(await getTour(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/admin/:id", async (c) => c.json(await updateTour(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, TourPatch))))
    .delete("/admin/:id", async (c) => c.json(await deleteTour(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/admin/reset/:userId", async (c) => c.json(await resetProgress(c.var.deps, c.var.auth, c.req.param("userId"), (await parseBody(c, ResetBody)).tourId)));
}
