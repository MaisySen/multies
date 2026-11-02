/**
 * R126 People (flag PEOPLE_R126): /api/people. Signed in workspace members only (sessions; project guests, portal users,
 * keys and agents never reach it); vv8k answers 404. Admin only writes are checked in the service. Never cached.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import {
  addAway, assertPeopleOpen, assetsCsv, assignAsset, assignRun, createAsset, deleteAsset, deleteAway, deleteTemplate, getAsset, getProfile,
  listAssets, listAway, listStaff, listTemplates, removeRun, saveTemplate, updateAsset, updateProfile,
} from "../services/people-r126";

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
};

export function peopleRoutes() {
  const writes = new RateLimiter(300, 15 * 60_000); // per person; plenty for real use, stops a runaway script
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (c.var.apiKeyOrg) throw new HttpError(404, "not_found", "Page not found.");
      await assertPeopleOpen(c.var.deps, c.var.auth);
      if (c.req.method !== "GET" && !writes.take(`${c.var.auth.orgId}:${c.var.auth.userId}`)) throw new HttpError(429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/staff", async (c) => c.json({ people: await listStaff(c.var.deps, c.var.auth), me: c.var.auth.userId, isAdmin: c.var.auth.role !== "member" }))
    .get("/staff/:userId", async (c) => c.json(await getProfile(c.var.deps, c.var.auth, c.req.param("userId"))))
    .patch("/staff/:userId", async (c) => c.json(await updateProfile(c.var.deps, c.var.auth, c.req.param("userId"), await body(c))))
    .get("/away", async (c) => c.json({ away: await listAway(c.var.deps, c.var.auth, { from: c.req.query("from"), to: c.req.query("to") }) }))
    .post("/staff/:userId/away", async (c) => c.json(await addAway(c.var.deps, c.var.auth, c.req.param("userId"), await body(c)), 201))
    .delete("/away/:id", async (c) => c.json(await deleteAway(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/templates", async (c) => c.json({ templates: await listTemplates(c.var.deps, c.var.auth) }))
    .post("/templates", async (c) => c.json(await saveTemplate(c.var.deps, c.var.auth, await body(c)), 201))
    .put("/templates/:id", async (c) => c.json(await saveTemplate(c.var.deps, c.var.auth, await body(c), c.req.param("id"))))
    .delete("/templates/:id", async (c) => c.json(await deleteTemplate(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/staff/:userId/runs", async (c) => c.json(await assignRun(c.var.deps, c.var.auth, c.req.param("userId"), await body(c))))
    .delete("/runs/:id", async (c) => c.json(await removeRun(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/assets", async (c) => c.json({ assets: await listAssets(c.var.deps, c.var.auth) }))
    .get("/assets.csv", async (c) => {
      const csv = await assetsCsv(c.var.deps, c.var.auth);
      return c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="assets.csv"' });
    })
    .post("/assets", async (c) => c.json(await createAsset(c.var.deps, c.var.auth, await body(c)), 201))
    .get("/assets/:id", async (c) => c.json(await getAsset(c.var.deps, c.var.auth, c.req.param("id"))))
    .patch("/assets/:id", async (c) => c.json(await updateAsset(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .post("/assets/:id/assign", async (c) => c.json(await assignAsset(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .delete("/assets/:id", async (c) => c.json(await deleteAsset(c.var.deps, c.var.auth, c.req.param("id"))));
}
