/**
 * R103 Docs plus (DOCS_PLUS_R103=on):
 *   /api/docs-plus/links            GET (q, tag, clipped) list, POST save; /links/tags; PATCH and DELETE /links/:id
 *   /api/docs-plus/clip             POST save a public page as a clean doc into a collection (and the library)
 *   /api/docs-plus/docs/:id/comments GET, POST (team, or public answers by moderators)
 *   /api/docs-plus/comments/:id     PATCH (author edits; moderators show or hide), DELETE
 *   /api/docs-plus/share/:id        PUT { comments: boolean } for one doc share link
 * Guests: /api/guest/r103/docs/:id/comments (GET, POST). Visitors: POST /s/<token>/comments (see share-links routes).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { clipPage, listLinks, listTags, removeLink, saveLink, updateLink } from "../services/docs-plus/links";
import { addMemberComment, changeComment, listForMember, removeComment, setLinkComments } from "../services/docs-plus/comments";
import { COMMENT_MAX } from "@/shared/docs-plus";

const Tags = z.union([z.array(z.string().max(64)).max(30), z.string().max(800)]);
const LinkIn = z.object({ url: z.string().min(1).max(2000), title: z.string().max(300).optional(), tags: Tags.optional(), note: z.string().max(2000).optional() }).strict();
const LinkPatch = z.object({ title: z.string().max(300).optional(), tags: Tags.optional(), note: z.string().max(2000).optional() }).strict();
const ClipIn = z.object({ url: z.string().min(1).max(2000), parentId: z.string().max(80).nullable().optional(), tags: Tags.optional(), title: z.string().max(300).optional() }).strict();
const CommentIn = z.object({ body: z.string().max(COMMENT_MAX + 200), thread: z.enum(["team", "public"]).optional() }).strict();
const CommentPatch = z.object({ body: z.string().max(COMMENT_MAX + 200).optional(), status: z.enum(["visible", "hidden"]).optional() }).strict();
const ShareIn = z.object({ comments: z.boolean() }).strict();

export function docsPlusRoutes() {
  // Page reads leave the box: 30 clips and 120 saved links an hour per person (in memory, no write).
  const clipLimit = new RateLimiter(30, 60 * 60_000);
  const saveLimit = new RateLimiter(120, 60 * 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/links", async (c) => {
      const clipped = c.req.query("clipped");
      return c.json(await listLinks(c.var.deps, c.var.auth, { q: c.req.query("q") || undefined, tag: c.req.query("tag") || undefined, clipped: clipped === "1" ? true : clipped === "0" ? false : undefined }));
    })
    .get("/links/tags", async (c) => c.json({ tags: await listTags(c.var.deps, c.var.auth.orgId) }))
    .post("/links", async (c) => {
      const b = await parseBody(c, LinkIn);
      if (!saveLimit.take(c.var.auth.userId)) throw tooMany("Too many links saved in the last hour.");
      const r = await saveLink(c.var.deps, c.var.auth, b);
      return c.json(r, r.existing ? 200 : 201);
    })
    .patch("/links/:id", async (c) => c.json({ link: await updateLink(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, LinkPatch)) }))
    .delete("/links/:id", async (c) => c.json(await removeLink(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/clip", async (c) => {
      const b = await parseBody(c, ClipIn);
      if (!clipLimit.take(c.var.auth.userId)) throw tooMany("Too many pages saved in the last hour. Try again later.");
      return c.json(await clipPage(c.var.deps, c.var.auth, b), 201);
    })
    .get("/docs/:id/comments", async (c) => c.json(await listForMember(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/docs/:id/comments", async (c) => c.json({ comment: await addMemberComment(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, CommentIn)) }, 201))
    .patch("/comments/:id", async (c) => c.json({ comment: await changeComment(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, CommentPatch)) }))
    .delete("/comments/:id", async (c) => c.json(await removeComment(c.var.deps, c.var.auth, c.req.param("id"))))
    .put("/share/:id", async (c) => c.json(await setLinkComments(c.var.deps, c.var.auth, c.req.param("id"), (await parseBody(c, ShareIn)).comments)));
}
