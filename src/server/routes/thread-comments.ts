/**
 * Round 22 (R22.2): internal notes on a shared inbox thread, in the web app (cookie session). The
 * same service backs the REST API (v1-r22-comments.ts) and the MCP tools (mcp-r22-comments.ts).
 * Guests have no workspace session, so they get 401. Notes never leave the team.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { addComment, commentCounts, COMMENT_MAX, deleteComment, editComment, listComments } from "../services/mail/thread-comments";

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const Q_THREAD_COMMENTS_1 = z.object({ ids: z.string().max(5000).default("") });

export const CommentBody = z.object({
  body: z.string().min(1).max(COMMENT_MAX),
  mentions: z.array(z.string().min(1).max(254)).max(50).optional(),
  // PRIV1b (P15, review M2): the mailbox whose copy of the thread the note goes on (default: the oldest one the caller can reply in).
  mailboxId: z.string().min(1).max(64).optional(),
});

export function threadCommentRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/comment-counts", async (c) => {
      const { ids } = parseQuery(c, Q_THREAD_COMMENTS_1);
      return c.json({ counts: await commentCounts(c.var.deps, c.var.auth, ids.split(",").filter(Boolean)) });
    })
    .get("/:id/comments", async (c) => c.json(await listComments(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/comments", async (c) => c.json({ comment: await addComment(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, CommentBody)) }, 201))
    .patch("/:id/comments/:commentId", async (c) => c.json({ comment: await editComment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("commentId"), await parseBody(c, CommentBody)) }))
    .delete("/:id/comments/:commentId", async (c) => c.json(await deleteComment(c.var.deps, c.var.auth, c.req.param("id"), c.req.param("commentId"))));
}
