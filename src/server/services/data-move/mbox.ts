/**
 * R40 mbox upload in Move your data. The browser reads the .mbox file (Gmail Takeout, Apple Mail and most mail apps
 * export it), splits it into messages and posts them here in small batches with an Idempotency-Key each. The server
 * only stores: every message goes through the same store step as the IMAP import (storeImportedRaw), so threading,
 * the duplicate check by Message-ID and the storage limit all apply.
 *
 * CPU (free plan, 10 ms a request): a batch is at most MBOX_BATCH messages and MBOX_BATCH_BYTES of mail, so one request
 * parses a few small messages and nothing more. D1 per batch: 1 read of the run row (primary key), 1 storage read
 * (mailboxes org index), 1 duplicate read per message (messages_mailbox_msgid_idx), the message writes as for any mail
 * (essential), and 1 update of the run row (essential: the history and progress read it).
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { dataMoves, mailboxes } from "../../db/schema";
import { HttpError, forbidden, notFound } from "../../lib/errors";
import { newId } from "../../lib/crypto";
import { audit } from "../audit";
import { storageRoom, storeImportedRaw } from "../import";
import { assertMailboxAccess } from "../team";
import { assertWritable, type SuiteActor } from "../suite/common";
import { base64Bytes } from "../work-import/parse";
import { notifyMoveEnded, presentMove } from "./service";

export const MBOX_BATCH = 3; // R40 lead: 3, not 10, after prod hit the free plan CPU limit (parsing is server CPU)
export const MBOX_BATCH_BYTES = 192 * 1024;
/** The largest .mbox file the page reads, stated in the page too. */
export const MBOX_MAX_FILE_MB = 200;

export interface MboxBatchInput {
  mailboxId: string;
  moveId?: string | null;
  fileName?: string;
  total: number;
  folder?: string;
  /** Each message as raw MIME in base64 (bytes kept exactly, whatever the charset). */
  messages: string[];
  last?: boolean;
}

type Counts = { stored: number; duplicates: number; unreadable: number };

export async function importMboxBatch(deps: Deps, actor: SuiteActor, input: MboxBatchInput) {
  assertWritable(actor);
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace owners and admins can import mail.");
  if (input.messages.length > MBOX_BATCH) throw new HttpError(422, "validation_failed", `Send at most ${MBOX_BATCH} messages at a time.`);
  const mb = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, actor.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  await assertMailboxAccess(deps.db, { userId: actor.userId, orgId: actor.orgId, role: actor.role ?? "member" }, input.mailboxId);
  const raws = input.messages.map((m) => base64Bytes(m));
  const bytes = raws.reduce((n, r) => n + r.byteLength, 0);
  if (bytes > MBOX_BATCH_BYTES + deps.config.maxMessageBytes) throw new HttpError(413, "too_large", "That batch is too big. Send fewer messages at a time.");

  const now = deps.now();
  let m = input.moveId ? await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, input.moveId), eq(dataMoves.orgId, actor.orgId))).get() : undefined;
  if (input.moveId && !m) throw notFound("Import");
  if (m && m.source !== "mail:mbox") throw new HttpError(422, "validation_failed", "That run is not a mail import.");
  if (m && m.status !== "running") throw new HttpError(409, "conflict", "This import has finished. Start a new one.");
  if (!m) {
    const id = newId("mov");
    // Essential write: the run row the history and progress read.
    await deps.db.insert(dataMoves).values({ id, orgId: actor.orgId, kind: "import", source: "mail:mbox", fileName: input.fileName?.slice(0, 255) ?? null, status: "running",
      total: Math.max(0, Math.min(input.total, 1_000_000)), done: 0, createdByUserId: actor.userId || null, createdByEmail: actor.email || null, createdAt: now, updatedAt: now });
    await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email || null, action: "data.import_started", targetType: "data_move", targetId: id, metadata: { kind: "mail", source: "mbox", mailboxId: input.mailboxId } });
    m = (await deps.db.select().from(dataMoves).where(eq(dataMoves.id, id)).get())!;
  }

  const counts: Counts = { stored: 0, duplicates: 0, unreadable: 0, ...(safeJson(m.counts) as Partial<Counts>) };
  // R41: what this run stored, so Undo removes exactly those messages and nothing else.
  const created = safeJson(m.created) as { messages?: string[] };
  const made: string[] = [];
  const room = await storageRoom(deps, actor.orgId);
  let used = room.used;
  let error: string | null = null;
  for (const raw of raws) {
    if (!raw.byteLength || raw.byteLength > deps.config.maxMessageBytes * 3) { counts.unreadable++; continue; }
    try {
      const r = await storeImportedRaw(deps, { orgId: actor.orgId, mailboxId: input.mailboxId, raw, folder: input.folder ?? "INBOX", seen: true, pooledBytes: used, limitBytes: room.limit });
      if (r.stored) { counts.stored++; used += r.bytes; made.push(r.id); } else counts.duplicates++;
    } catch (e) {
      if (e instanceof HttpError && e.code === "storage_full") { error = e.message; break; }
      counts.unreadable++;
    }
  }
  const done = counts.stored + counts.duplicates + counts.unreadable;
  const status: "failed" | "done" | "running" = error ? "failed" : input.last ? "done" : "running";
  const createdJson = JSON.stringify({ ...created, mailboxId: input.mailboxId, messages: [...(created.messages ?? []), ...made] });
  // Essential write: one update of the run row per batch (last_step_at lets the scheduled pass find a run left behind).
  await deps.db.update(dataMoves).set({ done, counts: JSON.stringify(counts), created: createdJson, status, error, updatedAt: deps.now(), lastStepAt: deps.now(), ...(status !== "running" ? { finishedAt: deps.now() } : {}) }).where(eq(dataMoves.id, m.id));
  if (status !== "running") await audit(deps.db, { orgId: actor.orgId, actorUserId: actor.userId || null, actorEmail: actor.email || null, action: error ? "data.import_failed" : "data.import_finished", targetType: "data_move", targetId: m.id, metadata: counts });
  const after = { ...m, done, counts: JSON.stringify(counts), created: createdJson, status, error, updatedAt: deps.now() };
  if (status === "done") await notifyMoveEnded(deps, after, "done");
  if (error) throw new HttpError(413, "storage_full", error, { moveId: m.id, counts });
  return { move: presentMove(after), counts };
}

/** Stops a mail import part way (the page's Cancel). What was stored stays. */
export async function stopMbox(deps: Deps, actor: SuiteActor, moveId: string) {
  if (actor.role !== "owner" && actor.role !== "admin") throw forbidden("Only workspace owners and admins can import mail.");
  const m = await deps.db.select().from(dataMoves).where(and(eq(dataMoves.id, moveId), eq(dataMoves.orgId, actor.orgId))).get();
  if (!m || m.source !== "mail:mbox") throw notFound("Import");
  if (m.status === "running") {
    // Essential write: the run ends as stopped.
    await deps.db.update(dataMoves).set({ status: "stopped", updatedAt: deps.now(), finishedAt: deps.now() }).where(eq(dataMoves.id, m.id));
  }
  return { move: presentMove({ ...m, status: m.status === "running" ? "stopped" : m.status }) };
}

function safeJson(s: string | null | undefined) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
