/**
 * R110 Ask (flag ASK_R110, shown in Tools as ask_r110): /api/ask. People signed in only (project guests and keys never reach it).
 * Every answer is built from items the asker can open, at question time; history is private to its person.
 */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { HttpError } from "../lib/errors";
import {
  askQuestion, askState, decideCard, deletePrompt, deleteThread, getThread, listPrompts, listThreads, savePrompt, saveToDoc,
} from "../services/ask-r110";
import { meaningSearch } from "../services/ask-td1"; // TD1

const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

export function askRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => { if (!c.var.deps.config.askR110) throw new HttpError(404, "not_found", "Page not found."); c.header("Cache-Control", "private, no-store"); await next(); })
    .get("/state", async (c) => c.json(await askState(c.var.deps, c.var.auth)))
    // TD1: meaning search across the items the asker can open (no answer, no Ask cap used). 404 while ASK_TD1 is off.
    .get("/search", async (c) => {
      if (!c.var.deps.config.askTd1) throw new HttpError(404, "not_found", "Page not found.");
      return c.json(await meaningSearch(c.var.deps, c.var.auth, c.req.query("q")));
    })
    .post("/", async (c) => c.json(await askQuestion(c.var.deps, c.var.auth, await body(c))))
    .get("/threads", async (c) => c.json({ threads: await listThreads(c.var.deps, c.var.auth, c.req.query("q")) }))
    .get("/threads/:id", async (c) => c.json(await getThread(c.var.deps, c.var.auth, c.req.param("id"))))
    .delete("/threads/:id", async (c) => c.json(await deleteThread(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/cards/:id/apply", async (c) => c.json({ card: await decideCard(c.var.deps, c.var.auth, c.req.param("id"), "apply", await body(c)) }))
    .post("/cards/:id/dismiss", async (c) => c.json({ card: await decideCard(c.var.deps, c.var.auth, c.req.param("id"), "dismiss") }))
    .post("/messages/:id/doc", async (c) => { const body = (await c.req.json().catch(() => ({}))) as { share?: unknown }; return c.json(await saveToDoc(c.var.deps, c.var.auth, c.req.param("id"), { share: body?.share })); })
    .get("/prompts", async (c) => c.json(await listPrompts(c.var.deps, c.var.auth)))
    .post("/prompts", async (c) => c.json(await savePrompt(c.var.deps, c.var.auth, await body(c))))
    .delete("/prompts/:id", async (c) => c.json(await deletePrompt(c.var.deps, c.var.auth, c.req.param("id"))));
}
