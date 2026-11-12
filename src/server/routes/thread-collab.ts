/**
 * Round 22 (R22.3, R22.4) session routes for the shared inbox: live presence in a thread and
 * shared draft replies. Every route checks that the caller can open the thread (or the draft's
 * mailbox) before anything else; presence beats never write D1.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { listThreadDrafts, takeOverDraft, threadPresence, viewFor } from "../services/suite/thread-collab";

// PRIV1b (P15, review M1): mailboxId is the copy the client has open, so its room is that copy's.
const MailboxId = z.string().min(1).max(64).optional();
const Beat = z.object({ clientId: z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/), state: z.enum(["viewing", "replying"]), mailboxId: MailboxId });
const Leave = z.object({ clientId: z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/), mailboxId: MailboxId });

export function threadCollabRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // Who else is in the thread right now (everyone but the caller), and notes meant for the caller.
    .get("/:id/presence", async (c) => c.json(viewFor(await threadPresence(c.var.deps, c.var.auth, c.req.param("id"), { op: "list" }, { mailboxId: c.req.query("mailboxId")?.slice(0, 64) }), c.var.auth.userId)))
    // A heartbeat: every 15 seconds while the thread is open. Answers the same view, so one call does both.
    .post("/:id/presence", async (c) => {
      const b = await parseBody(c, Beat);
      return c.json(viewFor(await threadPresence(c.var.deps, c.var.auth, c.req.param("id"), { op: "beat", clientId: b.clientId, state: b.state }, b), c.var.auth.userId));
    })
    // Closing the thread or hiding the tab (also sent with navigator.sendBeacon).
    .post("/:id/presence/leave", async (c) => {
      const b = await parseBody(c, Leave);
      await threadPresence(c.var.deps, c.var.auth, c.req.param("id"), { op: "leave", clientId: b.clientId }, b);
      return c.json({ ok: true });
    })
    .get("/:id/drafts", async (c) => c.json({ drafts: await listThreadDrafts(c.var.deps, c.var.auth, c.req.param("id")) }))
    .post("/drafts/:draftId/take-over", async (c) => c.json(await takeOverDraft(c.var.deps, c.var.auth, c.req.param("draftId"))));
}
