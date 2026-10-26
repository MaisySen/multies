/**
 * R31: split inbox and read status in the web app (cookie session).
 *   /api/mail/splits        the person's own Inbox splits, tabs with unread counts, rule preview
 *   /api/mail/prefs         mail settings (read status on or off)
 *   /api/mail/read-status   read status of one sent message
 *   /r/o/<token>.gif        the public open image (no session; answers the same GIF whatever happens)
 * The same services back the REST API (v1-r31-mail.ts) and MCP (mcp-r31-mail.ts).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { mailboxScope } from "../services/team";
import { createSplit, deleteSplit, getSplit, listSplits, previewSplit, reorderSplits, splitTabs, updateSplit } from "../services/mail/splits";
import { getMailPrefs, PIXEL_GIF, readStatusOf, recordOpen, setMailPrefs } from "../services/mail/read-status";
import { SplitCreate, SplitPatch, SplitPreview } from "@/shared/mail-splits";

export const SplitReorder = z.object({ ids: z.array(z.string().min(1).max(64)).max(20) });
export const MailPrefsPatch = z.object({ readStatus: z.boolean().optional() });
const MailboxQ = z.object({ mailboxId: z.string().max(64).optional().transform((v) => v || undefined) });

export function mailSplitRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => {
      const { mailboxId } = parseQuery(c, MailboxQ);
      const deps = c.var.deps;
      const scope = await mailboxScope(deps.db, c.var.auth);
      return c.json({ splits: await listSplits(deps, c.var.auth), tabs: await splitTabs(deps, c.var.auth, { mailboxId, scope }) });
    })
    .post("/", async (c) => c.json({ split: await createSplit(c.var.deps, c.var.auth, await parseBody(c, SplitCreate)) }, 201))
    .post("/preview", async (c) => {
      const body = await parseBody(c, SplitPreview);
      return c.json(await previewSplit(c.var.deps, c.var.auth, body, await mailboxScope(c.var.deps.db, c.var.auth)));
    })
    .post("/reorder", async (c) => c.json({ splits: await reorderSplits(c.var.deps, c.var.auth, (await parseBody(c, SplitReorder)).ids) }))
    .get("/:id", async (c) => c.json({ split: await getSplit(c.var.deps, c.var.auth, c.req.param("id")) }))
    .patch("/:id", async (c) => c.json({ split: await updateSplit(c.var.deps, c.var.auth, c.req.param("id"), await parseBody(c, SplitPatch)) }))
    .delete("/:id", async (c) => c.json(await deleteSplit(c.var.deps, c.var.auth, c.req.param("id"))));
}

export function mailPrefRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({ prefs: await getMailPrefs(c.var.deps, c.var.auth) }))
    .patch("/", async (c) => c.json({ prefs: await setMailPrefs(c.var.deps, c.var.auth, await parseBody(c, MailPrefsPatch)) }));
}

export function mailReadStatusRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/:id", async (c) => c.json({ readStatus: await readStatusOf(c.var.deps, c.var.auth, c.req.param("id"), await mailboxScope(c.var.deps.db, c.var.auth)) }));
}

/** The open image. Public, no session, no cookies read; never cached, never indexed. */
export function openPixelRoutes() {
  return new Hono<AppEnv>()
    .get("/:file", async (c) => {
      const file = c.req.param("file");
      const token = file.endsWith(".gif") ? file.slice(0, -4) : "";
      try {
        if (token) await recordOpen(c.var.deps, token, c.req.header("user-agent"));
      } catch (err) {
        c.var.deps.log?.warn("mail_open.record_failed", { error: (err as Error).message });
      }
      return new Response(PIXEL_GIF, {
        status: 200,
        headers: {
          "content-type": "image/gif",
          "content-length": String(PIXEL_GIF.byteLength),
          "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
          pragma: "no-cache",
          expires: "0",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex, nofollow",
          "cross-origin-resource-policy": "cross-origin",
        },
      });
    });
}
