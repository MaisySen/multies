import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { saveDraftSchema, sendMessageSchema, updateMessageSchema } from "@/shared/schemas";
import type { Folder } from "@/shared/mail";
import { attachments, mailboxes, messages } from "../db/schema";
import { audit } from "../services/audit";
import { sendMessage } from "../services/mail/send";
import { storeMessage } from "../services/mail/store";
import { deleteMessagesPermanently, getMessage, getThread, listMessages, mailboxOverview, presentMessage } from "../services/mail/mailbox-view";
import { badRequest, notFound, tooMany } from "../lib/errors";
import { fromB64 } from "../lib/crypto";
import { RateLimiter } from "../lib/rate-limit";

const folderParam = z.enum(["inbox", "sent", "drafts", "archive", "spam", "trash", "starred"]).optional();

export function mailRoutes() {
  const sendLimiter = new RateLimiter(30, 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/overview", async (c) => c.json({ mailboxes: await mailboxOverview(c.var.deps.db, c.var.auth.orgId) }))
    .get("/messages", async (c) => {
      const folder = folderParam.safeParse(c.req.query("folder") || undefined);
      if (!folder.success) throw badRequest("Unknown folder.");
      const result = await listMessages(c.var.deps.db, c.var.auth.orgId, {
        mailboxId: c.req.query("mailboxId") || undefined,
        folder: folder.data as Folder | "starred" | undefined,
        search: c.req.query("q") || undefined,
        cursor: c.req.query("cursor") || undefined,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined,
      });
      return c.json(result);
    })
    .get("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"));
      if (!m.isRead) await db.update(messages).set({ isRead: true }).where(and(eq(messages.threadId, m.threadId), eq(messages.mailboxId, m.mailboxId)));
      if (m.folder === "drafts") {
        const draft = presentMessage(m);
        return c.json({ message: draft, thread: [draft] });
      }
      const thread = await getThread(db, c.var.auth.orgId, m);
      return c.json({ message: thread.find((t) => t.id === m.id), thread });
    })
    .patch("/messages/:id", async (c) => {
      const patch = await parseBody(c, updateMessageSchema);
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"));
      if (patch.folder && (m.folder === "sent" || m.folder === "drafts")) throw badRequest("Sent messages and drafts can only be deleted.");
      await db.update(messages).set(patch).where(eq(messages.id, m.id));
      return c.json({ ok: true });
    })
    .post("/messages/bulk", async (c) => {
      const { ids, action } = await parseBody(c, z.object({
        ids: z.array(z.string()).min(1).max(500),
        action: z.enum(["read", "unread", "star", "unstar", "archive", "inbox", "spam", "trash", "delete"]),
      }));
      const { db } = c.var.deps;
      const rows = await db.select().from(messages).where(and(eq(messages.orgId, c.var.auth.orgId), inArray(messages.id, ids)));
      const own = rows.map((r) => r.id);
      if (!own.length) return c.json({ updated: 0 });
      const set: Partial<typeof messages.$inferInsert> = {
        read: { isRead: true }, unread: { isRead: false }, star: { isStarred: true }, unstar: { isStarred: false },
        archive: { folder: "archive" as const }, inbox: { folder: "inbox" as const }, spam: { folder: "spam" as const }, trash: { folder: "trash" as const }, delete: {},
      }[action];
      if (action === "delete") await deleteMessagesPermanently(db, rows);
      else await db.update(messages).set(set).where(inArray(messages.id, own));
      return c.json({ updated: own.length });
    })
    .delete("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"));
      if (m.folder === "trash" || m.folder === "drafts") await deleteMessagesPermanently(db, [m]);
      else await db.update(messages).set({ folder: "trash" }).where(eq(messages.id, m.id));
      return c.json({ ok: true, permanent: m.folder === "trash" || m.folder === "drafts" });
    })
    .get("/attachments/:id", async (c) => {
      const { db } = c.var.deps;
      const a = await db.select({ a: attachments, orgId: messages.orgId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(eq(attachments.id, c.req.param("id"))).get();
      if (!a || a.orgId !== c.var.auth.orgId || a.a.contentB64 === null) throw notFound("Attachment");
      return new Response(fromB64(a.a.contentB64), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${a.a.filename.replace(/["\\\r\n]/g, "_")}"`,
          "x-content-type-options": "nosniff",
          "cache-control": "private, no-store",
        },
      });
    })
    .post("/send", async (c) => {
      const { auth, deps } = c.var;
      if (!sendLimiter.take(auth.userId)) throw tooMany("You're sending very fast. Wait a moment.");
      const input = await parseBody(c, sendMessageSchema);
      const result = await sendMessage(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "message.sent", targetType: "message", targetId: result.messageId, metadata: { recipients: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].length }, ip: c.var.ip });
      return c.json(result, 201);
    })
    .post("/drafts", async (c) => {
      const input = await parseBody(c, saveDraftSchema);
      const { auth, deps } = c.var;
      const mb = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
      if (!mb) throw notFound("Mailbox");
      if (input.id) await deps.db.delete(messages).where(and(eq(messages.id, input.id), eq(messages.mailboxId, mb.id), eq(messages.folder, "drafts")));
      const id = await storeMessage(deps.db, {
        orgId: auth.orgId, mailboxId: mb.id, folder: "drafts",
        from: { address: mb.address, name: mb.displayName },
        to: input.to.map((address) => ({ address })), cc: (input.cc ?? []).map((address) => ({ address })), bcc: (input.bcc ?? []).map((address) => ({ address })),
        subject: input.subject, text: input.text, html: input.html, date: deps.now(), isRead: true,
      });
      return c.json({ id }, 201);
    });
}
