/**
 * Round 22 (R22.4b): saved replies in the web app (cookie session), mounted at /api/mail/snippets.
 * The same service backs the REST API (v1-r22-snippets.ts) and the MCP tools (mcp-r22-snippets.ts).
 * Guests have no workspace session, so they get 401.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { createSnippet, deleteSnippet, getSnippet, listSnippets, renderSnippetFor, updateSnippet } from "../services/suite/snippets";
import { SNIPPET_BODY_MAX, SNIPPET_NAME_MAX, SNIPPET_SUBJECT_MAX } from "@/shared/snippets";

// R52: query schemas built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const Q_MAIL_SNIPPETS_1 = z.object({ q: z.string().max(200).optional() });

export const SnippetCreate = z.object({
  name: z.string().min(1).max(SNIPPET_NAME_MAX * 2),
  body: z.string().min(1).max(SNIPPET_BODY_MAX + 1000),
  shortcut: z.string().max(40).nullable().optional(),
  subject: z.string().max(SNIPPET_SUBJECT_MAX * 2).nullable().optional(),
  shared: z.boolean().optional(),
});
export const SnippetPatch = SnippetCreate.partial();
export const SnippetRender = z.object({
  threadId: z.string().min(1).max(200).nullable().optional(),
  to: z.string().max(2000).nullable().optional(),
  mailboxId: z.string().min(1).max(100).nullable().optional(),
});

export function mailSnippetRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { q } = parseQuery(c, Q_MAIL_SNIPPETS_1);
      return c.json(await listSnippets(c.var.deps, c.var.auth, { q }));
    })
    .post("/", async (c) => c.json({ snippet: await createSnippet(c.var.deps, c.var.auth, await parseBody(c, SnippetCreate)) }, 201))
    .get("/:id", async (c) => c.json({ snippet: await getSnippet(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ snippet: await updateSnippet(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SnippetPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteSnippet(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/:id/render", async (c) => c.json(await renderSnippetFor(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SnippetRender))));
}
