/**
 * Tools P2 (16, 17): the Files view (smart folders of mail attachments) and the attachment index switch.
 *   GET  /api/attachment-files/folders            folder counts for the caller's mailboxes (flag folders)
 *   GET  /api/attachment-files?folder=&q=&cursor= one folder's attachments, newest first, or a search inside them (flag folders)
 *   PUT  /api/attachment-files/:attachmentId/folder  move one to another folder; kept from then on (flag folders)
 *   GET  /api/attachment-files/settings           the workspace's indexing switch and OCR language (flag index)
 *   PUT  /api/attachment-files/settings           admins: turn indexing off (deletes the index) or on, set the OCR language (flag index)
 * Mounted at /api/attachment-files (not /api/files, which is the task and doc file routes).
 * Every route needs the workspace's Tools switch on (like /api/tools) and follows the caller's mailbox scope
 * exactly as mail does. Reads attachment_text and the joined message rows in the main database and, for a
 * search, attachment_fts in the index database (deps.indexDb).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAdmin, requireAuth } from "../middleware";
import { HttpError, notFound } from "../lib/errors";
import { audit } from "../services/audit";
import { mailboxScope } from "../services/team";
import { readToolState, toolsOnFor } from "../services/tools/usage";
import { requireToolFeature, toolFeatureOn } from "../services/tools/features";
import { folderCounts, listFolder, moveToFolder, readIndexSettings, searchAttachmentText, writeIndexSettings, type AttachmentHit } from "../services/tools/attachment-index";
import { ATTACHMENT_FOLDERS, INDEX_OCR_LANGS, isAttachmentFolder, type AttachmentFolder, type FileItem } from "@/shared/attachment-folders";

async function toolsOn(c: Context<AppEnv>) {
  const s = await readToolState(c.var.deps.db, c.var.auth.orgId, c.var.deps.now());
  if (!s || !toolsOnFor(s)) throw notFound("Page");
}

const toItem = (r: AttachmentHit): FileItem => ({
  attachmentId: r.attachment_id, filename: r.filename, sizeBytes: Number(r.size_bytes), folder: isAttachmentFolder(r.class) ? r.class : "other", manual: Number(r.class_manual) === 1,
  messageId: r.message_id, threadId: r.thread_id, mailboxId: r.mailbox_id, subject: r.subject || "(no subject)",
  from: r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address, date: new Date(Number(r.date)).toISOString(),
  url: `/app/mail?mailbox=${encodeURIComponent(r.mailbox_id)}&folder=${encodeURIComponent(r.folder)}&m=${encodeURIComponent(r.message_id)}&attachment=${encodeURIComponent(r.attachment_id)}`,
  ...(r.snip ? { snippet: r.snip.replace(/\s+/g, " ").trim().slice(0, 200) } : {}),
});

const PAGE = 50;
const cursorOf = (r: { date: number; id: number }) => `${Number(r.date)}.${Number(r.id)}`;
function readCursor(raw: string | undefined): { date: number; id: number } | undefined {
  const m = /^(\d{1,15})\.(\d{1,15})$/.exec(raw ?? "");
  return m ? { date: Number(m[1]), id: Number(m[2]) } : undefined;
}

const settingsBody = z.object({ on: z.boolean().optional(), lang: z.enum(INDEX_OCR_LANGS.map((l) => l.id) as [string, ...string[]]).optional() }).strict();
const moveBody = z.object({ folder: z.enum(ATTACHMENT_FOLDERS) }).strict();

export function attachmentIndexRoutes() {
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/settings", async (c) => {
      requireToolFeature(c, "index");
      await toolsOn(c);
      const s = await readIndexSettings(c.var.deps.db, c.var.auth.orgId);
      const langs = toolFeatureOn(c, "ocr_langs") ? INDEX_OCR_LANGS : INDEX_OCR_LANGS.filter((l) => l.id === "eng");
      return c.json({ ...s, langs });
    })
    .put("/settings", requireAdmin, async (c) => {
      requireToolFeature(c, "index");
      await toolsOn(c);
      const body = await parseBody(c, settingsBody);
      if (body.lang && body.lang !== "eng" && !toolFeatureOn(c, "ocr_langs")) throw new HttpError(422, "validation_failed", "Only English is available for now.");
      const { deps, auth } = c.var;
      const before = await readIndexSettings(deps.db, auth.orgId);
      const r = await writeIndexSettings(deps, auth.orgId, body, deps.now());
      if (before.on !== r.on) {
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: r.on ? "tools.index_turned_on" : "tools.index_turned_off", metadata: r.on ? {} : { deleted_now: r.purged }, ip: c.var.ip });
      }
      return c.json({ on: r.on, lang: r.lang });
    })
    .get("/folders", async (c) => {
      requireToolFeature(c, "folders");
      await toolsOn(c);
      const { deps, auth } = c.var;
      const [scope, s] = await Promise.all([mailboxScope(deps.db, auth), readIndexSettings(deps.db, auth.orgId)]);
      const r = await folderCounts(deps.db, auth.orgId, scope, deps.now().getTime());
      return c.json({ folders: r.folders, indexing: { on: s.on, indexed: r.indexed, waiting: r.waiting } });
    })
    .get("/", async (c) => {
      requireToolFeature(c, "folders");
      await toolsOn(c);
      const { deps, auth } = c.var;
      const folderRaw = c.req.query("folder");
      const folder: AttachmentFolder | undefined = folderRaw ? (isAttachmentFolder(folderRaw) ? folderRaw : undefined) : undefined;
      if (folderRaw && !folder) throw new HttpError(422, "validation_failed", "Unknown folder.");
      const q = (c.req.query("q") ?? "").trim().slice(0, 100);
      const scope = await mailboxScope(deps.db, auth);
      if (q) {
        // The search box in the Files view: the same full text search as the command menu, optionally within one folder.
        if (!toolFeatureOn(c, "index")) throw notFound("Page");
        const before = /^\d{1,15}$/.test(c.req.query("cursor") ?? "") ? Number(c.req.query("cursor")) : undefined;
        const rows = await searchAttachmentText(deps, auth.orgId, scope, q, { limit: PAGE, folder, beforeId: before });
        return c.json({ items: rows.map(toItem), next: rows.length === PAGE ? String(rows[rows.length - 1].id) : null });
      }
      if (!folder) throw new HttpError(422, "validation_failed", "Choose a folder or type a search.");
      const rows = await listFolder(deps.db, auth.orgId, scope, folder, { limit: PAGE, before: readCursor(c.req.query("cursor")) });
      return c.json({ items: rows.map(toItem), next: rows.length === PAGE ? cursorOf(rows[rows.length - 1]) : null });
    })
    .put("/:attachmentId/folder", async (c) => {
      requireToolFeature(c, "folders");
      await toolsOn(c);
      const { deps, auth } = c.var;
      const body = await parseBody(c, moveBody);
      const scope = await mailboxScope(deps.db, auth);
      const ok = await moveToFolder(deps.db, auth.orgId, scope, c.req.param("attachmentId"), body.folder, deps.now());
      if (!ok) throw notFound("Attachment");
      return c.json({ ok: true, folder: body.folder });
    });
}
