import { Hono, type Context } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { parseBody, parseQuery, requireAuth } from "../middleware";
import { saveDraftSchema, sendMessageSchema, updateMessageSchema } from "@/shared/schemas";
import type { Folder } from "@/shared/mail";
import { attachments, idempotencyKeys, mailboxes, messages } from "../db/schema";
import { audit } from "../services/audit";
import { assertSendLevel, sendMessage } from "../services/mail/send";
import { toolFilesAsAttachments } from "../services/tools/attach"; // Tools P2
import { attachmentBytes, storeMessage } from "../services/mail/store";
import { assertNotHeld } from "../services/mail/archive-r111"; // R111: legal holds
import { deleteMessagesPermanently, getMessage, getThread, listMessages, mailboxOverview, presentMessage } from "../services/mail/mailbox-view";
import { badRequest, notFound, tooMany } from "../lib/errors";
import { fromB64 } from "../lib/crypto";
import { COMPOSE_ATTACH_MAX_BYTES, COMPOSE_ATTACH_MAX_FILES, formatMb } from "@/shared/tools-automation";

/** Tools P2: a send from the composer may carry files (base64). */
const sendWithFilesSchema = sendMessageSchema.extend({
  attachments: z.array(z.object({ filename: z.string().min(1).max(200), contentType: z.string().max(200).default("application/octet-stream"), data: z.string().max(Math.ceil(COMPOSE_ATTACH_MAX_BYTES * 1.4)) })).max(COMPOSE_ATTACH_MAX_FILES).optional(),
});

function composeAttachments(files: { filename: string; contentType: string; data: string }[]) {
  let total = 0;
  const out = files.map((f) => {
    let content: Uint8Array;
    try { content = fromB64(f.data); } catch { throw badRequest(`${f.filename} could not be read. Attach it again.`); }
    total += content.byteLength;
    return { filename: f.filename.replace(/[\r\n"\\/]/g, "_"), contentType: /^[\w.+-]+\/[\w.+-]+$/.test(f.contentType) ? f.contentType : "application/octet-stream", content };
  });
  if (total > COMPOSE_ATTACH_MAX_BYTES) throw badRequest(`Attachments can add up to ${formatMb(COMPOSE_ATTACH_MAX_BYTES)} in one email.`);
  return out;
}
import { RateLimiter } from "../lib/rate-limit";
import { idempotency } from "../lib/idempotency";
import { assertMailboxAccess, mailboxScope } from "../services/team";
import { connectionForMailbox, queueRemoteChange, type RemoteAction } from "../services/connect";
import { syncConnection } from "../services/connect/sync";
import { snoozeHiddenCond } from "../services/mail/schedules";
import { checkDraftSave, ownedBy, replyTarget } from "../services/suite/thread-collab";
import { splitCond } from "../services/mail/splits";
import { labelCond, labelsFor } from "../services/mail/rules-r85";
import { readStatusFor } from "../services/mail/read-status";
import { BULK_MAIL_ACTIONS, BULK_MAIL_MAX, runBulkMail } from "../services/mail/bulk-r32";
import { deferrableWrite } from "../services/write-priority";
import { logMailboxOpen } from "../services/mailbox-sharing-priv1a";
import { BulkJobBody, BulkPreviewBody, bodyToInput, getBulkJob, previewBulkJob, runBulkJob, stepBulkJob, undoBulkJob } from "../services/mail/bulk-job-r33"; // R33, R45 preview


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

// R52: built once per isolate, not on every request (zod schema construction is real CPU on a warm request).
const MessageListQuery = z.object({
  folder: z.preprocess((v) => v || undefined, folderParam),
  mailboxId: z.string().max(64).optional().transform((v) => v || undefined),
  /** Round 19: one of a connected mailbox's own folders at its provider ("f:<path>"). */
  remote: z.string().max(520).regex(/^f:/).optional().transform((v) => v || undefined),
  q: z.string().max(200).optional().transform((v) => v || undefined),
  cursor: z.string().max(200).optional().transform((v) => v || undefined),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /** R31: an Inbox tab, "important", "other" or a split id (services/mail/splits.ts). */
  split: z.string().max(64).regex(/^[A-Za-z0-9_-]+$/).optional().transform((v) => v || undefined),
  /** R85: threads with this label. */
  label: z.string().max(40).optional().transform((v) => v || undefined),
});

/** R111: the answer for /held-status from the idempotency row (pure, for tests). */
export function heldState(row: { state: string; status: number | null } | undefined): "sent" | "pending" | "failed" | "unknown" {
  if (!row) return "unknown";
  if (row.state === "done") return row.status !== null && row.status < 300 ? "sent" : "failed";
  // Running with a stored 5xx failed and may be retried; with no status it is in flight (or was cut off).
  return row.status !== null && row.status !== undefined ? "failed" : "pending";
}

export function mailRoutes() {
  const sendLimiter = new RateLimiter(30, 60_000);
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    // The composer sends an Idempotency-Key, so a retried "Send" never sends twice.
    .use("*", idempotency((c) => `user:${c.var.auth.userId}`))
    // R111 (undo send survives tab close): did the held send with this key reach the server? Read only, the caller's
    // own keys only (same scope as the middleware above), and no message content in the answer.
    .get("/held-status", async (c) => {
      const key = (c.req.query("key") ?? "").slice(0, 255);
      if (!/^[A-Za-z0-9_.:-]{8,255}$/.test(key)) throw badRequest("That key isn't valid.");
      const row = await c.var.deps.db.select({ state: idempotencyKeys.state, status: idempotencyKeys.responseStatus })
        .from(idempotencyKeys).where(and(eq(idempotencyKeys.scope, `user:${c.var.auth.userId}`), eq(idempotencyKeys.key, key))).get();
      return c.json({ state: heldState(row) });
    })
    // PRIV1b: each mailbox carries the viewer's level (own, send_as, reply, read, team) for the composer and menus.
    .get("/overview", async (c) => c.json({ mailboxes: await mailboxOverview(c.var.deps.db, c.var.auth.orgId, await mailboxScope(c.var.deps.db, c.var.auth), c.var.auth) }))
    .get("/messages", async (c) => {
      const q = parseQuery(c, MessageListQuery);
      // R33: the moment this list was read (server clock, as messages.created_at): a select all job leaves mail that
      // arrived after it alone, whatever the mail's own Date header says.
      const asOf = new Date().toISOString();
      // R31: split inbox. Only Inbox has tabs; elsewhere the parameter is ignored.
      const splitExtra = q.split && q.folder === "inbox" && !q.q && !q.remote ? await splitCond(c.var.deps, c.var.auth, q.split) : undefined;
      const snoozeExtra = q.folder === "inbox" && !q.q && !q.remote ? snoozeHiddenCond(c.var.deps.now()) : undefined;
      const listScope = await mailboxScope(c.var.deps.db, c.var.auth);
      const result = await listMessages(c.var.deps.db, c.var.auth.orgId, {
        mailboxId: q.mailboxId,
        folder: q.remote ? undefined : (q.folder as Folder | "starred" | undefined),
        remote: q.remote && q.mailboxId ? q.remote : undefined,
        search: q.q,
        cursor: q.cursor,
        limit: q.limit,
        scope: listScope,
        // Round 20: a snoozed thread stays out of Inbox until its time. R85: a label narrows any folder.
        extra: and(snoozeExtra, splitExtra, q.label ? labelCond(c.var.auth.orgId, q.label) : undefined),
      });
      // PRIV1a: a delegate opening someone's personal mailbox lands in its "Who opened" log (the first page only).
      // PRIV1b (P17): only a mailbox the person could open; any other id showed nothing and accuses them of nothing.
      if (q.mailboxId && !q.cursor && (!listScope || listScope.includes(q.mailboxId))) await logMailboxOpen(c.var.deps, c.var.auth, q.mailboxId, "opened_mailbox", null, c.req.raw.headers);
      // R85: labels on the page's threads (one read).
      if (result.messages.length) {
        const labels = await labelsFor(c.var.deps, c.var.auth.orgId, result.messages.map((m) => m.threadId), listScope);
        if (labels.size) result.messages = result.messages.map((m) => ({ ...m, labels: labels.get(m.threadId) ?? [] }));
      }
      // R31: Sent shows read status when the sender has it on ("Opened 2x, last 3:14 PM").
      if (q.folder === "sent" && result.messages.length) {
        const status = await readStatusFor(c.var.deps, c.var.auth.orgId, result.messages.map((m) => m.id));
        return c.json({ ...result, asOf, messages: result.messages.map((m) => ({ ...m, readStatus: status.get(m.id) ?? null })) });
      }
      return c.json({ ...result, asOf });
    })
    .get("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      let m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      // PRIV1a: someone other than the owner opening a personal mailbox's thread lands in its "Who opened" log.
      await logMailboxOpen(c.var.deps, c.var.auth, m.mailboxId, "opened_thread", m.threadId, c.req.raw.headers);
      if (m.sizeBytes < 0) {
        // R57: older synced mail kept header and snippet only: fetch its body from the provider now, once.
        const { deps } = c.var;
        try {
          if (deps.loadMailBody) await deps.loadMailBody(m.mailboxId, m.id);
          else await (await import("../services/connect/sync")).loadBody(deps, m.id);
          m = await getMessage(db, c.var.auth.orgId, m.id);
        } catch (err) {
          deps.log?.warn("mail_sync.body_failed", { message: m.id, error: (err as Error).message });
        }
      }
      if (!m.isRead) {
        // R32: read because it was opened is deferrable (services/write-priority.ts); the Mark read action is not.
        await deferrableWrite(c.var.deps, "mail_read_on_open", `${c.var.auth.userId}:${m.threadId}`, async () => {
          await db.update(messages).set({ isRead: true }).where(and(eq(messages.threadId, m.threadId), eq(messages.mailboxId, m.mailboxId)));
          await queueRemoteChange(c.var.deps, [m], "seen");
        });
      }
      if (m.folder === "drafts") {
        const draft = presentMessage(m);
        return c.json({ message: draft, thread: [draft] });
      }
      const plain = await getThread(db, c.var.auth.orgId, m);
      // R31: read status under each sent message in the thread.
      const sentIds = plain.filter((t) => t.folder === "sent").map((t) => t.id);
      const status = sentIds.length ? await readStatusFor(c.var.deps, c.var.auth.orgId, sentIds) : null;
      const thread = status ? plain.map((t) => (t.folder === "sent" ? { ...t, readStatus: status.get(t.id) ?? null } : t)) : plain;
      // R85: the thread's labels, for the reader's chips.
      const labels = (await labelsFor(c.var.deps, c.var.auth.orgId, [m.threadId], [m.mailboxId])).get(m.threadId) ?? []; // PRIV1b (P15): this copy's labels
      return c.json({ message: thread.find((t) => t.id === m.id), thread, labels });
    })
    .patch("/messages/:id", async (c) => {
      const patch = await parseBody(c, updateMessageSchema);
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      await assertMailboxAccess(db, c.var.auth, m.mailboxId, "reply"); // PRIV1a: a read only share can't change mail
      if (patch.folder && (m.folder === "sent" || m.folder === "drafts")) throw badRequest("Sent messages and drafts can only be deleted.");
      await db.update(messages).set(patch).where(eq(messages.id, m.id));
      for (const action of remoteActionsFor(patch, m)) await queueChange(c, [m], action);
      return c.json({ ok: true });
    })
    .post("/messages/bulk", async (c) => {
      const b = await parseBody(c, z.object({
        ids: z.array(z.string()).min(1).max(BULK_MAIL_MAX),
        action: z.enum(BULK_MAIL_ACTIONS),
        /** For "move": a connected mailbox's folder key ("f:<path>" for the person's own folders). Round 19. */
        to: z.string().min(1).max(520).optional(),
        /** R32: for "snooze", when it comes back (same shapes as /mail-schedules/snooze). */
        preset: z.enum(["later_today", "tomorrow", "next_week"]).optional(),
        at: z.string().max(40).optional(),
        local: z.string().max(20).optional(),
      }));
      // R32: one service for the app, v1 and MCP (services/mail/bulk-r32.ts); the app also pushes moves at once.
      return c.json(await runBulkMail(c.var.deps, c.var.auth, b, (rows, action, opts) => queueChange(c, rows, action, opts)));
    })
    // R33: "select all" as one server job (services/mail/bulk-job-r33.ts). Repeat the same body (or POST .../step) to
    // continue it; undo puts back exactly what it changed.
    // R45 (MB-137): how many a job would touch, before it runs (the "Archive older mail" sheet's count).
    .post("/bulk-jobs/preview", async (c) => { const b = await parseBody(c, BulkPreviewBody); return c.json(await previewBulkJob(c.var.deps, c.var.auth, { scope: b.scope, maxReceivedAt: b.max_received_at })); })
    .post("/bulk-jobs", async (c) => c.json(await runBulkJob(c.var.deps, c.var.auth, bodyToInput(await parseBody(c, BulkJobBody)), (rows, action, opts) => queueChange(c, rows, action, opts))))
    .get("/bulk-jobs/:id", async (c) => c.json(await getBulkJob(c.var.deps, c.var.auth, c.req.param("id"))))
    .post("/bulk-jobs/:id/step", async (c) => c.json(await stepBulkJob(c.var.deps, c.var.auth, c.req.param("id"), (rows, action, opts) => queueChange(c, rows, action, opts))))
    .post("/bulk-jobs/:id/undo", async (c) => c.json(await undoBulkJob(c.var.deps, c.var.auth, c.req.param("id"), (rows, action, opts) => queueChange(c, rows, action, opts))))
    .delete("/messages/:id", async (c) => {
      const { db } = c.var.deps;
      const m = await getMessage(db, c.var.auth.orgId, c.req.param("id"), await mailboxScope(db, c.var.auth));
      await assertMailboxAccess(db, c.var.auth, m.mailboxId, "reply"); // PRIV1a: a read only share can't delete mail
      if (m.folder === "trash" || m.folder === "drafts") { await assertNotHeld(c.var.deps, c.var.auth.orgId, [m]); await deleteMessagesPermanently(db, [m]); }
      else {
        await db.update(messages).set({ folder: "trash" }).where(eq(messages.id, m.id));
        await queueChange(c, [m], "trash");
      }
      return c.json({ ok: true, permanent: m.folder === "trash" || m.folder === "drafts" });
    })
    .get("/attachments/:id", async (c) => {
      const { db } = c.var.deps;
      const scope = await mailboxScope(db, c.var.auth);
      const a = await db.select({ a: attachments, orgId: messages.orgId, mailboxId: messages.mailboxId, threadId: messages.threadId }).from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .where(eq(attachments.id, c.req.param("id"))).get();
      const bytes = a && a.orgId === c.var.auth.orgId && (!scope || scope.includes(a.mailboxId)) ? await attachmentBytes(a.a, c.var.deps.bodyStore) : null;
      if (!a || !bytes) throw notFound("Attachment");
      // PRIV1b (P17): a download from someone's personal mailbox is an open of its thread.
      await logMailboxOpen(c.var.deps, c.var.auth, a.mailboxId, "opened_thread", a.threadId, c.req.raw.headers);
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
      // Tools P2: the composer can carry attachments (base64, COMPOSE_ATTACH_MAX_BYTES in all), passed to the send service as is.
      const { attachments: files, ...input } = await parseBody(c, sendWithFilesSchema);
      await assertMailboxAccess(deps.db, auth, input.mailboxId, input.inReplyToId ? "reply" : "send");
      // Tools P2: Tools results attached in Compose (engine tokens) and composer files (base64, e.g. after an auto rule) ride as ordinary attachments.
      const { toolFiles, ...plain } = input;
      // One limit for both kinds: 10 files and 20 MB per email.
      const fromComposer = files?.length ? composeAttachments(files) : [];
      const used = { files: fromComposer.length, bytes: fromComposer.reduce((a, f) => a + f.content.byteLength, 0) };
      const extra = [
        ...fromComposer,
        ...(toolFiles?.length ? await toolFilesAsAttachments(deps, auth, toolFiles, used) : []),
      ];
      const result = await sendMessage(deps, auth, plain, extra.length ? { attachments: extra } : {});
      // R34: a sending limit queued it until midnight UTC (202 with the reason), not sent.
      if (result.queued) return c.json(result, 202);
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "message.sent", targetType: "message", targetId: result.messageId, metadata: { recipients: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].length }, ip: c.var.ip });
      return c.json(result, 201);
    })
    .post("/drafts", async (c) => {
      const input = await parseBody(c, saveDraftSchema);
      const { auth, deps } = c.var;
      await assertMailboxAccess(deps.db, auth, input.mailboxId, input.inReplyToId ? "reply" : "send");
      const mb = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
      if (!mb) throw notFound("Mailbox");
      // PRIV1b (P10): a reply share drafts answers to the thread's own people only, as Send checks.
      await assertSendLevel(deps.db, auth, mb, input);
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
