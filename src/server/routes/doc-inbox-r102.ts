/**
 * R102 Smart document inbox (DOC_INBOX_R102, needs FILES_PLUS_R101): Files > Documents.
 *   GET    /api/doc-inbox/list?view=&q=&cursor=        documents the caller can open, with counts per tab
 *   GET    /api/doc-inbox/items/:id                    one document: detected fields, the text found, rules applied
 *   PATCH  /api/doc-inbox/items/:id                    { type?, sender?, docDate?, dueDate?, amount?, gst?, paid?, checked? } (edit access)
 *   POST   /api/doc-inbox/items/:id/read               read again (edit access)
 *   POST   /api/doc-inbox/items/:id/apply-rules        run the rules on it now (edit access)
 *   POST   /api/doc-inbox/add                          { itemId } a drive file added before Documents was on (edit access)
 *   POST   /api/doc-inbox/from-mail                    { attachmentId } copies a mail attachment into the caller's My files (mailbox owner only)
 *   POST   /api/doc-inbox/check                        { ids, on? } mark checked
 *   GET    /api/doc-inbox/rules                        the workspace's rules (members read them)
 *   POST   /api/doc-inbox/rules | PUT /rules/:id | DELETE /rules/:id | POST /rules/order    owners and admins only
 *   GET    /api/doc-inbox/mailboxes                    mailboxes whose attachments the caller may add
 *   GET    /api/doc-inbox/folders                      Team folders a rule can file into
 * Workspace session only, like /api/drive (project guests and the client portal have their own sessions and no drive).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import {
  addDriveFile, addFromMail, addableMailboxes, checkDocs, createRule, deleteRule, docInboxOn, getDoc, listDocs, listRules, readAgain, reorderRules, ruleFolders, rulesNow, updateDoc, updateRule,
} from "../services/suite/doc-inbox";
import { DOC_LIMITS, DOC_MATCH, DOC_TYPES, isDocView } from "@/shared/doc-inbox";

const Id = z.string().min(1).max(80);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const Cents = z.number().int().min(0).max(99_999_999_99).nullable();
const Patch = z.object({
  type: z.enum(DOC_TYPES).nullable().optional(), sender: z.string().max(400).nullable().optional(), docDate: Day.optional(), dueDate: Day.optional(),
  amount: Cents.optional(), gst: Cents.optional(), paid: z.boolean().optional(), checked: z.boolean().optional(),
}).strict();
const Rule = z.object({
  name: z.string().max(400), match: z.enum(DOC_MATCH), pattern: z.string().max(1000), caseSensitive: z.boolean().optional(),
  setTags: z.array(z.string().max(80)).max(40).optional(), setSender: z.string().max(400).nullable().optional(), setType: z.enum(DOC_TYPES).nullable().optional(),
  setFolderId: z.string().max(80).nullable().optional(), enabled: z.boolean().optional(),
}).strict();

const actor = (c: Context<AppEnv>) => c.var.auth;

export function docInboxRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .use("*", async (c, next) => {
      if (!c.var.deps.config.filesPlus || !docInboxOn(c.var.deps)) throw notFound("Page");
      await next();
    })
    .get("/list", async (c) => {
      const view = c.req.query("view") ?? "check";
      if (!isDocView(view)) throw new HttpError(422, "validation_failed", "Unknown view.");
      const cursor = Number(c.req.query("cursor") ?? "0");
      return c.json(await listDocs(c.var.deps, actor(c), view, { q: c.req.query("q") ?? "", cursor: Number.isFinite(cursor) ? cursor : 0 }));
    })
    .get("/items/:id", async (c) => c.json(await getDoc(c.var.deps, actor(c), c.req.param("id"))))
    .patch("/items/:id", async (c) => c.json(await updateDoc(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, Patch))))
    .post("/items/:id/read", async (c) => c.json(await readAgain(c.var.deps, actor(c), c.req.param("id"))))
    .post("/items/:id/apply-rules", async (c) => c.json(await rulesNow(c.var.deps, actor(c), c.req.param("id"))))
    .post("/add", async (c) => c.json(await addDriveFile(c.var.deps, actor(c), (await parseBody(c, z.object({ itemId: Id }).strict())).itemId)))
    .post("/from-mail", async (c) => c.json(await addFromMail(c.var.deps, actor(c), (await parseBody(c, z.object({ attachmentId: Id }).strict())).attachmentId)))
    .post("/check", async (c) => { const b = await parseBody(c, z.object({ ids: z.array(Id).min(1).max(DOC_LIMITS.page), on: z.boolean().optional() }).strict()); return c.json(await checkDocs(c.var.deps, actor(c), b.ids, b.on ?? true)); })
    .get("/rules", async (c) => c.json({ rules: await listRules(c.var.deps, actor(c)) }))
    .post("/rules", async (c) => c.json({ rule: await createRule(c.var.deps, actor(c), await parseBody(c, Rule)) }))
    .put("/rules/:id", async (c) => c.json({ rule: await updateRule(c.var.deps, actor(c), c.req.param("id"), await parseBody(c, Rule)) }))
    .delete("/rules/:id", async (c) => c.json(await deleteRule(c.var.deps, actor(c), c.req.param("id"))))
    .post("/rules/order", async (c) => c.json({ rules: await reorderRules(c.var.deps, actor(c), (await parseBody(c, z.object({ ids: z.array(Id).max(DOC_LIMITS.rules) }).strict())).ids) }))
    .get("/mailboxes", async (c) => c.json({ ids: await addableMailboxes(c.var.deps.db, actor(c)) }))
    .get("/folders", async (c) => c.json({ folders: await ruleFolders(c.var.deps, actor(c)) }));
}
