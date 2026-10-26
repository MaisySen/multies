import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { saveDraftSchema, sendMessageSchema, updateMessageSchema } from "@/shared/schemas";
import type { Folder } from "@/shared/mail";
import { attachments, mailboxes, messages } from "../db/schema";
import { audit } from "../services/audit";
import { sendMessage } from "../services/mail/send";
import { attachmentBytes, storeMessage } from "../services/mail/store";
import { deleteMessagesPermanently, getMessage, getThread, listMessages, mailboxOverview, presentMessage } from "../services/mail/mailbox-view";
import { badRequest, notFound, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { idempotency } from "../lib/idempotency";
import { assertMailboxAccess, mailboxScope } from "../services/team";
import { connectionForMailbox, queueRemoteChange, type RemoteAction } from "../services/connect";
import { localFolderFor, syncConnection } from "../services/connect/sync";
import { snoozeHiddenCond } from "../services/mail/schedules";
import { checkDraftSave, ownedBy, replyTarget } from "../services/suite/thread-collab";
import { inIds } from "../lib/sql-chunks";

/** What a bulk action means at a connected mailbox's provider (services/connect, applied on the next sync). */
const BULK_REMOTE: Partial<Record<string, RemoteAction>> = { read: "seen", unread: "unseen", star: "flag", unstar: "unflag", archive: "archive", trash: "trash", spam: "spam", inbox: "inbox" };

/** The provider side of a single message edit: read, star and folder moves. */
function remoteActionsFor(patch: { isRead?: boolean; isStarred?: boolean; folder?: string }, m: { isRead: boolean; isStarred: boolean; folder: string }): RemoteAction[] {
  const out: RemoteAction[] = [];
  if (patch.isRead !== undefined && patch.isRead !== m.isRead) out.push(patch.isRead ? "seen" : "unseen");
  if (patch.isStarred !== undefined && patch.isStarred !== m.isStarred) out.push(patch.isStarred ? "flag" : "unflag");
  if (patch.folder && patch.folder !== m.folder && (patch.folder === "archive" || patch.folder === "trash" || patch.folder === "spam" || patch.folder === "inbox")) out.push(patch.folder);
  return out;
}

/** Folder moves reach the provider straight away (a pass now), so the person sees them there too. Read and star changes wait for the next pass. */
const MOVE_ACTIONS = new Set<RemoteAction>(["archive", "trash", "inbox", "spam", "move"]);

async function queueChange(c: Context<AppEnv>, rows: Parameters<typeof queueRemoteChange>[1], action: RemoteAction, opts: { dest?: string } = {}) {
  const deps = c.var.deps;
  const n = await queueRemoteChange(deps, rows, action, opts);
  if (!n || !MOVE_ACTIONS.has(action)) return n;
  const ids = new Set<string>();
  for (const mailboxId of new Set(rows.filter((r) => r.remoteBox).map((r) => r.mailboxId))) {
    const conn = await connectionForMailbox(deps, mailboxId);
    if (conn) ids.add(conn.id);
  }
  const work = Promise.all([...ids].map((id) => (deps.dispatchMailSync ? deps.dispatchMailSync(id) : syncConnection(deps, id).then(() => undefined))))
    .catch((err) => deps.log?.warn("mail_sync.push_soon_failed", { error: (err as Error).message }));
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
  if (waitUntil) waitUntil(work); else await work;
  return n;
}

const folderParam = z.enum(["inbox", "sent", "drafts", "archive", "spam", "trash", "starred"]).optional();

export function mailRoutes() {
  const sendLimiter = new RateLimiter(30, 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // The composer sends an Idempotency-Key, so a retried "Send" never sends twice.
    .use("*", idempotency((c) => `user:${c.var.auth.userId}`))
    .get("/overview", async (c) => c.json({ mailboxes: await mailboxOverview(c.var.deps.db, c.var.auth.orgId, await mailboxScope(c.var.deps.db, c.var.auth)) }))
    .get("/messages", async (c) => {
      const q = parseQuery(c, z.object({
        folder: z.preprocess((v) => v || undefined, folderParam),
        mailboxId: z.string().max(64).optional().transform((v) => v || undefined),
        /** Round 19: one of a connected mailbox's own folders at its provider ("f:<path>"). */
        remote: z.string().max(520).regex(/^f:/).optional().transform((v) => v || undefined),
        q: z.string().max(200).optional().transform((v) => v || undefined),
        cursor: z.string().max(200).optional().transform((v) => v || undefined),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      }));
      const result = await listMessages(c.var.deps.db, c.var.auth.orgId, {
        mailboxId: q.mailboxId,
        folder: q.remote ? undefined : (q.folder as Folder | "starred" | undefined),
        remote: q.remote && q.mailboxId ? q.remote : undefined,
        search: q.q,
        cursor: q.cursor,
        limit: q.limit,
        scope: await mailboxScope(c.var.deps.db, c.var.auth),
        // Round 20: a snoozed thread stays out of Inbox until its time.
        extra: q.folder === "inbox" && !q.q && !q.remote ? snoozeHiddenCond(c.var.deps.now()) : undefined,
      });
      return c.json(result);
    })
    .get("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      if (!m.isRead) {
        await db.update(messages).set({ isRead: true }).where(and(eq(messages.threadId, m.threadId), eq(messages.mailboxId, m.mailboxId)));
        await queueRemoteChange(c.var.deps, [m], "seen");
      }
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
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      if (patch.folder && (m.folder === "sent" || m.folder === "drafts")) throw badRequest("Sent messages and drafts can only be deleted.");
      await db.update(messages).set(patch).where(eq(messages.id, m.id));
      for (const action of remoteActionsFor(patch, m)) await queueChange(c, [m], action);
      return c.json({ ok: true });
    })
    .post("/messages/bulk", async (c) => {
      const { ids, action, to } = await parseBody(c, z.object({
        ids: z.array(z.string()).min(1).max(500),
        action: z.enum(["read", "unread", "star", "unstar", "archive", "inbox", "spam", "trash", "delete", "move"]),
        /** For "move": a connected mailbox's folder key ("f:<path>" for the person's own folders). Round 19. */
        to: z.string().min(1).max(520).optional(),
      }));
      if (action === "move" && !to) throw badRequest("Say which folder to move to.");
      const { db } = c.var.deps;
      const scope = await mailboxScope(db, c.var.auth);
      const rows = (await db.select().from(messages).where(and(eq(messages.orgId, c.var.auth.orgId), inIds(messages.id, ids))))
        .filter((r) => !scope || scope.includes(r.mailboxId));
      const own = rows.map((r) => r.id);
      if (!own.length) return c.json({ updated: 0 });
      const set: Partial<typeof messages.$inferInsert> = {
        read: { isRead: true }, unread: { isRead: false }, star: { isStarred: true }, unstar: { isStarred: false },
        archive: { folder: "archive" as const }, inbox: { folder: "inbox" as const }, spam: { folder: "spam" as const }, trash: { folder: "trash" as const }, delete: {}, move: {},
      }[action];
      if (action === "move") {
        // Only synced mail of connected mailboxes moves to a provider folder; the rest stays put.
        const movable = rows.filter((r) => r.remoteBox && r.remoteUid && r.folder !== "sent" && r.folder !== "drafts");
        if (movable.length) await db.update(messages).set({ folder: localFolderFor(to!) }).where(inIds(messages.id, movable.map((r) => r.id)));
        const queued = await queueChange(c, movable, "move", { dest: to });
        if (!queued) {
          // Put them back: the folder isn't one this mailbox syncs.
          for (const r of movable) await db.update(messages).set({ folder: r.folder }).where(eq(messages.id, r.id));
          throw badRequest("That folder isn't one of this mailbox's synced folders.");
        }
        return c.json({ updated: queued });
      }
      if (action === "delete") await deleteMessagesPermanently(db, rows);
      else await db.update(messages).set(set).where(inIds(messages.id, own));
      const remote = BULK_REMOTE[action];
      if (remote) await queueChange(c, rows.filter((r) => r.folder !== "sent" && r.folder !== "drafts"), remote);
      return c.json({ updated: own.length });
    })
    .delete("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      if (m.folder === "trash" || m.folder === "drafts") await deleteMessagesPermanently(db, [m]);
      else {
        await db.update(messages).set({ folder: "trash" }).where(eq(messages.id, m.id));
        await queueChange(c, [m], "trash");
      }
      return c.json({ ok: true, permanent: m.folder === "trash" || m.folder === "drafts" });
    })
    .get("/attachments/:id", async (c) => {
      const { db } = c.var.deps;
      const scope = await mailboxScope(db, c.var.auth);
      const a = await db.select({ a: attachments, orgId: messages.orgId, mailboxId: messages.mailboxId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(eq(attachments.id, c.req.param("id"))).get();
      const bytes = a && a.orgId === c.var.auth.orgId && (!scope || scope.includes(a.mailboxId)) ? await attachmentBytes(a.a, c.var.deps.bodyStore) : null;
      if (!a || !bytes) throw notFound("Attachment");
      return new Response(bytes as BodyInit, {
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
      await assertMailboxAccess(deps.db, auth, input.mailboxId);
      const result = await sendMessage(deps, auth, input);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "message.sent", targetType: "message", targetId: result.messageId, metadata: { recipients: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].length }, ip: c.var.ip });
      return c.json(result, 201);
    })
    .post("/drafts", async (c) => {
      const input = await parseBody(c, saveDraftSchema);
      const { auth, deps } = c.var;
      await assertMailboxAccess(deps.db, auth, input.mailboxId);
      const mb = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
      if (!mb) throw notFound("Mailbox");
      // Round 22: a shared draft reply. Saving over a draft somebody else took over, or one that changed
      // in another window, answers 409 instead of overwriting. The delete is the optimistic check: only
      // the first of two saves of the same draft finds it.
      let before: { threadId: string; inReplyTo: string | null } | undefined;
      if (input.id) {
        before = await checkDraftSave(deps, auth, input.id, mb.id);
        const gone = await deps.db.delete(messages).where(and(eq(messages.id, input.id), eq(messages.mailboxId, mb.id), eq(messages.folder, "drafts"), ownedBy(auth.userId))).returning({ id: messages.id });
        if (!gone.length) await checkDraftSave(deps, auth, input.id, mb.id);
      }
      // A reply draft stays in its thread, also when it is reopened from Drafts and saved again.
      const target = (await replyTarget(deps, auth, input.inReplyToId)) ?? (before ? { threadId: before.threadId, messageIdHeader: before.inReplyTo } : null);
      const id = await storeMessage(deps.db, {
        threadId: target?.threadId, inReplyTo: target?.messageIdHeader ?? undefined, sentByUserId: auth.userId,
        bodyStore: deps.bodyStore, orgId: auth.orgId, mailboxId: mb.id, folder: "drafts",
        from: { address: mb.address, name: mb.displayName },
        to: input.to.map((address) => ({ address })), cc: (input.cc ?? []).map((address) => ({ address })), bcc: (input.bcc ?? []).map((address) => ({ address })),
        subject: input.subject, text: input.text, html: input.html, date: deps.now(), isRead: true,
      });
      return c.json({ id }, 201);
    });
}
