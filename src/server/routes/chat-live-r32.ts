/**
 * Round 32 live chat in the app (cookie session): the typing beat. The socket itself is
 * GET /api/chat/live, served by the entries (worker.ts, node.ts) before the app (see realtime/).
 */
import { Hono } from "hono";
import type { AppEnv } from "../context";
import { requireAuth } from "../middleware";
import { sendTyping } from "../realtime/typing";

export function chatLiveR32Routes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .post("/channels/:id/typing", async (c) => c.json(await sendTyping(c.var.deps, c.var.auth, c.req.param("id"))));
}
