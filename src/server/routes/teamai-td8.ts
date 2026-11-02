/**
 * TD8 Team AI (flag TEAMAI_TD8): /api/team-ai. Signed in workspace members only (sessions; API keys, agents, project
 * guests and portal users never reach it); flag off, another workspace or vv8k answers 404. Admin only writes are checked
 * in the service. Never cached. Request and answer bodies are never logged.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import {
  acceptMemory, addMemory, assertTeamAiOpen, createInstruction, createRoutine, deleteInstruction, deleteMemory, deleteRoutine, deleteRun, getRun, listInstructions,
  listMemory, listRoutines, listRuns, postDraft, runRoutineNow, teamAiState, tryInstruction, updateInstruction, updateMemory, updateRoutine,
} from "../services/teamai-td8";

const body = async (c: Context<AppEnv>) => {
  const b = (await c.req.json().catch(() => null)) as unknown;
  return (b && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
};

export function teamAiRoutes() {
  const writes = new RateLimiter(200, 15 * 60_000); // per person; plenty for real use, stops a runaway script
  const runs = new RateLimiter(20, 10 * 60_000); // Run now and Try: each one is a call on the workspace's own key
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (c.var.apiKeyOrg) throw new HttpError(404, "not_found", "Page not found.");
      await assertTeamAiOpen(c.var.deps, c.var.auth);
      const who = `${c.var.auth.orgId}:${c.var.auth.userId}`;
      if (c.req.method !== "GET" && !writes.take(who)) throw new HttpError(429, "rate_limited", "Too many changes. Wait a few minutes and try again.");
      if (c.req.method === "POST" && /\/run$/.test(c.req.path) && !runs.take(who)) throw new HttpError(429, "rate_limited", "Too many runs. Wait a few minutes and try again.");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/state", async (c) => c.json(await teamAiState(c.var.deps, c.var.auth)))
    .get("/memory", async (c) => c.json({ memory: await listMemory(c.var.deps, c.var.auth) }))
    .post("/memory", async (c) => c.json(await addMemory(c.var.deps, c.var.auth, await body(c)), 201))
    .patch("/memory/:id", async (c) => c.json(await updateMemory(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .post("/memory/:id/accept", async (c) => c.json(await acceptMemory(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/memory/:id", async (c) => c.json(await deleteMemory(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/instructions", async (c) => c.json({ instructions: await listInstructions(c.var.deps, c.var.auth) }))
    .post("/instructions", async (c) => c.json(await createInstruction(c.var.deps, c.var.auth, await body(c)), 201))
    .patch("/instructions/:id", async (c) => c.json(await updateInstruction(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .delete("/instructions/:id", async (c) => c.json(await deleteInstruction(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/instructions/:id/run", async (c) => c.json(await tryInstruction(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/routines", async (c) => c.json({ routines: await listRoutines(c.var.deps, c.var.auth) }))
    .post("/routines", async (c) => c.json(await createRoutine(c.var.deps, c.var.auth, await body(c)), 201))
    .patch("/routines/:id", async (c) => c.json(await updateRoutine(c.var.deps, c.var.auth, c.req.param("id"), await body(c))))
    .delete("/routines/:id", async (c) => c.json(await deleteRoutine(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/routines/:id/run", async (c) => c.json(await runRoutineNow(c.var.deps, c.var.auth, c.req.param("id"))))
    .get("/runs", async (c) => c.json(await listRuns(c.var.deps, c.var.auth, { before: c.req.query("before"), limit: c.req.query("limit") })))
    .get("/runs/:id", async (c) => c.json(await getRun(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/runs/:id", async (c) => c.json(await deleteRun(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/runs/:id/post", async (c) => c.json(await postDraft(c.var.deps, c.var.auth, c.req.param("id"), await body(c))));
}
