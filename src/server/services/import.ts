/**
 * Importing old mail from Gmail, Outlook or any IMAP server.
 *
 * Multies queues the job; a runner you host (deploy/import-runner: Docker, imapflow) claims it
 * with IMPORT_RUNNER_TOKEN, reads the old mailbox over IMAP with an app password, and posts each
 * message back here, where it is stored like any other mail (and copied to the mail server for
 * IMAP when that is on). The app password is encrypted at rest and wiped when the job ends.
 */
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { importJobs, mailboxes, messages } from "../db/schema";
import { conflict, HttpError, notFound } from "../lib/errors";
import { decryptSecret, encryptSecret, newId, safeEqual } from "../lib/crypto";
import { audit } from "./audit";
import { getPlan } from "./plans";
import { parseMime } from "./mail/mime";
import { storeMessage } from "./mail/store";
import { mirrorInbound } from "./mailserver";
import type { Folder } from "@/shared/mail";

export const IMPORT_PROVIDERS = {
  gmail: { host: "imap.gmail.com", port: 993, label: "Gmail or Google Workspace", help: "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords." },
  outlook: { host: "outlook.office365.com", port: 993, label: "Outlook or Microsoft 365", help: "Use an app password from account.microsoft.com/security. Some Microsoft 365 workspaces turn IMAP off; your admin can turn it on." },
  imap: { host: "", port: 993, label: "Another IMAP server", help: "Use the IMAP server name and an app password from your provider." },
} as const;
export type ImportProvider = keyof typeof IMPORT_PROVIDERS;

export function importEnabled(deps: Deps) { return !!deps.config.importRunnerToken; }

function assertEnabled(deps: Deps) {
  if (!importEnabled(deps)) throw new HttpError(404, "import_off", "Importing isn't switched on for this Multies yet.");
}

const present = (j: typeof importJobs.$inferSelect) => ({
  id: j.id, mailboxId: j.mailboxId, provider: j.provider, sourceHost: j.sourceHost, sourceUser: j.sourceUser, status: j.status,
  messagesDone: j.messagesDone, messagesTotal: j.messagesTotal, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt,
});

export async function createImport(deps: Deps, auth: AuthContext, input: { mailboxId: string; provider: ImportProvider; sourceUser: string; appPassword: string; sourceHost?: string; sourcePort?: number }) {
  assertEnabled(deps);
  const mb = await deps.db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  const p = IMPORT_PROVIDERS[input.provider];
  const host = (input.provider === "imap" ? input.sourceHost : p.host)?.trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) throw new HttpError(422, "validation_failed", "Enter the IMAP server name, for example imap.example.com.");
  const running = await deps.db.select({ id: importJobs.id }).from(importJobs).where(and(eq(importJobs.mailboxId, mb.id), inArray(importJobs.status, ["queued", "running"]))).get();
  if (running) throw conflict("An import into this mailbox is already under way.");
  const id = newId("imp");
  await deps.db.insert(importJobs).values({
    id, orgId: auth.orgId, mailboxId: mb.id, provider: input.provider, sourceHost: host, sourcePort: input.sourcePort ?? p.port,
    sourceUser: input.sourceUser.trim(), secretEnc: await encryptSecret(deps.config.appSecret, input.appPassword), createdByUserId: auth.userId || null,
  });
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: "import.started", targetType: "mailbox", targetId: mb.id, metadata: { from: input.sourceUser, provider: input.provider } });
  return present((await deps.db.select().from(importJobs).where(eq(importJobs.id, id)).get())!);
}

export async function listImports(deps: Deps, orgId: string) {
  return (await deps.db.select().from(importJobs).where(eq(importJobs.orgId, orgId)).orderBy(desc(importJobs.createdAt)).limit(50)).map(present);
}

export async function cancelImport(deps: Deps, auth: AuthContext, id: string) {
  const j = await deps.db.select().from(importJobs).where(and(eq(importJobs.id, id), eq(importJobs.orgId, auth.orgId))).get();
  if (!j) throw notFound("Import");
  if (j.status === "queued" || j.status === "running") {
    await deps.db.update(importJobs).set({ status: "cancelled", secretEnc: null, finishedAt: deps.now() }).where(eq(importJobs.id, id));
  }
  return present((await deps.db.select().from(importJobs).where(eq(importJobs.id, id)).get())!);
}

// ---------------------------------------------------------------- runner side

export function assertRunner(deps: Deps, header: string | undefined) {
  const token = deps.config.importRunnerToken;
  const given = header?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token || !given || !safeEqual(given, token)) throw new HttpError(401, "unauthorized", "Runner token missing or wrong.");
}

/** Hands the oldest queued job (or one whose runner went quiet for 10 minutes) to a runner. */
export async function claimNext(deps: Deps) {
  const stale = new Date(deps.now().getTime() - 10 * 60_000);
  const j = await deps.db.select().from(importJobs)
    .where(sql`${importJobs.status} = 'queued' or (${importJobs.status} = 'running' and ${importJobs.heartbeatAt} < ${stale.getTime()})`)
    .orderBy(asc(importJobs.createdAt)).get();
  if (!j || !j.secretEnc) return null;
  const claimed = await deps.db.update(importJobs).set({ status: "running", claimedAt: deps.now(), heartbeatAt: deps.now() })
    .where(and(eq(importJobs.id, j.id), eq(importJobs.status, j.status))).returning({ id: importJobs.id });
  if (!claimed.length) return null;
  const mb = (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, j.mailboxId)).get())!;
  return {
    id: j.id, mailbox: mb.address, provider: j.provider,
    source: { host: j.sourceHost, port: j.sourcePort, user: j.sourceUser, password: await decryptSecret(deps.config.appSecret, j.secretEnc) },
    // Gmail's "All Mail" holds every message once; importing it alone avoids label copies.
    folders: j.provider === "gmail" ? { include: ["INBOX", "[Gmail]/Sent Mail", "[Gmail]/All Mail"], skip: ["[Gmail]/Spam", "[Gmail]/Trash", "[Gmail]/Drafts"] } : { include: [], skip: ["Junk", "Junk Email", "Spam", "Trash", "Deleted Items", "Drafts"] },
  };
}

async function runningJob(deps: Deps, id: string) {
  const j = await deps.db.select().from(importJobs).where(eq(importJobs.id, id)).get();
  if (!j) throw notFound("Import");
  if (j.status !== "running") throw conflict(`This import is ${j.status}.`);
  return j;
}

const FOLDER_MAP: [RegExp, Folder][] = [[/sent/i, "sent"], [/archive|all mail/i, "archive"], [/junk|spam/i, "spam"], [/trash|deleted/i, "trash"], [/draft/i, "drafts"]];
export function folderFor(source: string): Folder {
  if (/^inbox$/i.test(source)) return "inbox";
  return FOLDER_MAP.find(([re]) => re.test(source))?.[1] ?? "archive";
}

/** Stores one raw message from the runner. Duplicates (same Message-ID) are skipped. */
export async function importMessage(deps: Deps, id: string, raw: Uint8Array, opts: { folder: string; seen?: boolean }) {
  const j = await runningJob(deps, id);
  const email = await parseMime(raw);
  if (email.messageId) {
    const dup = await deps.db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, j.mailboxId), eq(messages.messageIdHeader, email.messageId))).get();
    if (dup) { await bump(deps, id); return { stored: false, reason: "duplicate" as const }; }
  }
  const plan = await getPlan(deps.db, j.orgId);
  const pooled = await deps.db.select({ n: sql<number>`coalesce(sum(${mailboxes.usedBytes}), 0)` }).from(mailboxes).where(eq(mailboxes.orgId, j.orgId)).get();
  if (Number(pooled?.n ?? 0) + raw.byteLength > plan.limits.storageMb * 1024 * 1024) {
    await finish(deps, id, { error: "The workspace's storage is full. Add a storage pack in Billing, then import again." });
    throw new HttpError(413, "storage_full", "The workspace's storage is full.");
  }
  const folder = folderFor(opts.folder);
  await storeMessage(deps.db, {
    bodyStore: deps.bodyStore, orgId: j.orgId, mailboxId: j.mailboxId, folder, messageIdHeader: email.messageId, inReplyTo: email.inReplyTo, references: email.references,
    from: email.from, to: email.to, cc: email.cc, replyTo: email.replyTo, subject: email.subject, text: email.text, html: email.html, date: email.date,
    isRead: opts.seen ?? true, authResults: email.authResults, attachments: email.attachments, sizeBytes: raw.byteLength,
  });
  if (folder === "inbox" || folder === "spam") await mirrorInbound(deps, j.mailboxId, raw, { spam: folder === "spam" });
  await bump(deps, id);
  return { stored: true as const, folder };
}

async function bump(deps: Deps, id: string) {
  await deps.db.update(importJobs).set({ messagesDone: sql`${importJobs.messagesDone} + 1`, heartbeatAt: deps.now() }).where(eq(importJobs.id, id));
}

export async function reportProgress(deps: Deps, id: string, p: { total?: number }) {
  await runningJob(deps, id);
  await deps.db.update(importJobs).set({ heartbeatAt: deps.now(), ...(p.total !== undefined ? { messagesTotal: p.total } : {}) }).where(eq(importJobs.id, id));
}

export async function finish(deps: Deps, id: string, r: { error?: string }) {
  const j = await deps.db.select().from(importJobs).where(eq(importJobs.id, id)).get();
  if (!j) throw notFound("Import");
  await deps.db.update(importJobs).set({ status: r.error ? "failed" : "done", error: r.error?.slice(0, 500) ?? null, secretEnc: null, finishedAt: deps.now() }).where(eq(importJobs.id, id));
  await audit(deps.db, { orgId: j.orgId, actorUserId: null, actorEmail: "import", action: r.error ? "import.failed" : "import.finished", targetType: "mailbox", targetId: j.mailboxId, metadata: { messages: j.messagesDone, ...(r.error ? { error: r.error.slice(0, 200) } : {}) } });
}

/** Wipes app passwords of jobs that ended or were abandoned more than a day ago. */
export async function pruneImports(deps: Deps) {
  const day = new Date(deps.now().getTime() - 86_400_000);
  await deps.db.update(importJobs).set({ status: "failed", error: "The import runner stopped responding.", secretEnc: null, finishedAt: deps.now() })
    .where(and(eq(importJobs.status, "running"), lt(importJobs.heartbeatAt, day)));
}
