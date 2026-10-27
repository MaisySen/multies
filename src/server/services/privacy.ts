/**
 * Privacy rights: data export (APP 12 access, GDPR Articles 15 and 20) and account
 * deletion (GDPR Article 17). Exports are machine readable: JSON for records, CSV for
 * the audit log and members, JSON Lines for mail, packed into a streamed ZIP (fflate)
 * so a large workspace never has to fit in memory.
 */
import { Zip, ZipDeflate } from "fflate";
import Papa from "papaparse";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import {
  accounts, aliases, apiKeys, appPasswords, attachments, auditLogs, domains, invitations, mailboxAccess, mailboxes,
  members, messages, organizations, sessions, suppressions, twoFactors, users, webhookEndpoints,
} from "../db/schema";
import { HttpError, forbidden } from "../lib/errors";
import { audit, redactAuditRow } from "./audit";
import { cancelForDeletion } from "./billing";
import { inIds } from "../lib/sql-chunks";
import { EXPORT_README, writeWorkData, type ZipSink } from "./data-move/export";
import { toMboxEntry } from "./data-move/formats";

const PAGE = 200;
const enc = new TextEncoder();
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Everything Multies holds about one person, outside the mail of their workspaces. */
export async function personalData(deps: Deps, userId: string) {
  const { db } = deps;
  const u = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!u) throw new HttpError(404, "not_found", "Account not found.");
  const [accs, sess, mships, tf, access, actions] = await Promise.all([
    db.select({ provider: accounts.providerId, createdAt: accounts.createdAt }).from(accounts).where(eq(accounts.userId, userId)),
    db.select({ createdAt: sessions.createdAt, expiresAt: sessions.expiresAt, ipAddress: sessions.ipAddress, userAgent: sessions.userAgent }).from(sessions).where(eq(sessions.userId, userId)),
    db.select({ workspace: organizations.name, workspaceId: organizations.id, role: members.role, joinedAt: members.createdAt })
      .from(members).innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, userId)),
    db.select({ id: twoFactors.id }).from(twoFactors).where(eq(twoFactors.userId, userId)).get(),
    db.select({ mailbox: mailboxes.address, grantedAt: mailboxAccess.createdAt }).from(mailboxAccess).innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId)).where(eq(mailboxAccess.userId, userId)),
    db.select({ at: auditLogs.createdAt, action: auditLogs.action, workspaceId: auditLogs.orgId, ip: auditLogs.ip }).from(auditLogs).where(eq(auditLogs.actorUserId, userId)).orderBy(asc(auditLogs.createdAt)).limit(5000),
  ]);
  return {
    exportedAt: deps.now().toISOString(),
    profile: { id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, image: u.image, createdAt: iso(u.createdAt), lastLoginMethod: u.lastLoginMethod ?? null },
    security: { twoFactorEnabled: !!tf, signInMethods: accs.map((a) => ({ provider: a.provider, linkedAt: iso(a.createdAt) })) },
    sessions: sess.map((s) => ({ ...s, createdAt: iso(s.createdAt), expiresAt: iso(s.expiresAt) })),
    workspaces: mships.map((m) => ({ ...m, joinedAt: iso(m.joinedAt) })),
    sharedMailboxAccess: access.map((a) => ({ ...a, grantedAt: iso(a.grantedAt) })),
    activity: actions.map((a) => ({ ...a, at: iso(a.at) })),
    notes: "Mail in your workspaces is exported by a workspace owner or admin from Settings, General, Export workspace data. Passwords and secrets are stored as hashes or encrypted and are never exported.",
  };
}

/** Audit log rows for a workspace in a date range, oldest first. */
export async function auditRows(deps: Deps, orgId: string, from?: Date, to?: Date) {
  const rows = await deps.db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).orderBy(asc(auditLogs.createdAt)).limit(50_000);
  return rows
    .filter((r) => (!from || r.createdAt >= from) && (!to || r.createdAt <= to))
    .map((r) => redactAuditRow({ at: iso(r.createdAt), action: r.action, actor: r.actorEmail ?? "", actorUserId: r.actorUserId ?? "", targetType: r.targetType ?? "", targetId: r.targetId ?? "", ip: r.ip ?? "", metadata: r.metadata ?? "" }));
}

export const toCsv = (rows: Record<string, unknown>[]) => Papa.unparse(rows, { quotes: false, newline: "\r\n" });

function requireWorkspaceAdmin(auth: AuthContext) {
  if (auth.role !== "owner" && auth.role !== "admin") throw forbidden("Only workspace owners and admins can export workspace data.");
}

/**
 * Streams a ZIP of the whole workspace: settings, members, domains, mailboxes, aliases,
 * integrations (no secrets), the audit log, and every message with its attachments.
 */
export function exportWorkspace(deps: Deps, auth: AuthContext, opts: { onDone?: (counts: Record<string, number>) => Promise<void> } = {}): ReadableStream<Uint8Array> {
  requireWorkspaceAdmin(auth);
  const { db } = deps;
  const orgId = auth.orgId;
  let zip: Zip;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      zip = new Zip((err, chunk, final) => {
        if (err) { controller.error(err); return; }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      const add = (name: string, data: string) => {
        const f = new ZipDeflate(name, { level: 6 });
        zip.add(f);
        f.push(enc.encode(data), true);
      };
      try {
        const org = await db.select().from(organizations).where(eq(organizations.id, orgId)).get();
        if (!org) throw new HttpError(404, "not_found", "Workspace not found.");
        const [mem, doms, boxes, als, hooks, keys, pw, inv, sup] = await Promise.all([
          db.select({ email: users.email, name: users.name, role: members.role, joinedAt: members.createdAt }).from(members).innerJoin(users, eq(users.id, members.userId)).where(eq(members.organizationId, orgId)),
          db.select().from(domains).where(eq(domains.orgId, orgId)),
          db.select().from(mailboxes).where(eq(mailboxes.orgId, orgId)),
          db.select().from(aliases).where(eq(aliases.orgId, orgId)),
          db.select({ url: webhookEndpoints.url, events: webhookEndpoints.events, enabled: webhookEndpoints.enabled, createdAt: webhookEndpoints.createdAt }).from(webhookEndpoints).where(eq(webhookEndpoints.orgId, orgId)),
          db.select({ name: apiKeys.name, prefix: apiKeys.prefix, scope: apiKeys.scope, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.orgId, orgId)),
          db.select({ name: appPasswords.name, mailboxId: appPasswords.mailboxId, createdAt: appPasswords.createdAt }).from(appPasswords).where(eq(appPasswords.orgId, orgId)),
          db.select({ email: invitations.email, role: invitations.role, status: invitations.status, expiresAt: invitations.expiresAt }).from(invitations).where(eq(invitations.organizationId, orgId)),
          db.select().from(suppressions).where(eq(suppressions.orgId, orgId)),
        ]);
        const { stripeCustomerId: _c, stripeSubscriptionId: _s, ...settings } = org;
        add("workspace.json", JSON.stringify({
          exportedAt: deps.now().toISOString(), exportedBy: auth.email, workspace: settings,
          domains: doms.map(({ dkimPrivateKeyEnc: _k, ...d }) => d), mailboxes: boxes, aliases: als,
          webhooks: hooks, apiKeys: keys, appPasswords: pw, invitations: inv, suppressions: sup,
          format: "Mail is in mail/<address>.jsonl, one message per line with its attachments in base64. The audit log and members are also CSV files.",
        }, null, 2));
        add("members.csv", toCsv(mem.map((m) => ({ ...m, joinedAt: iso(m.joinedAt) }))));
        add("audit-log.csv", toCsv(await auditRows(deps, orgId)));
        add("README.txt", EXPORT_README);
        // R38: tasks, projects, docs, calendar, contacts and chat (JSON, CSV, Markdown, ICS, vCard).
        const sink: ZipSink = { file(name) { const f = new ZipDeflate(name, { level: 6 }); zip.add(f); return { push: (t: string) => f.push(enc.encode(t)), end: () => f.push(new Uint8Array(0), true) }; } };
        const counts = await writeWorkData(deps, orgId, sink);
        let mailCount = 0;

        for (const box of boxes) {
          const file = new ZipDeflate(`mail/${box.address}.jsonl`, { level: 6 });
          zip.add(file);
          let cursor = "";
          for (;;) {
            const page = await db.select().from(messages)
              .where(and(eq(messages.mailboxId, box.id), cursor ? gt(messages.id, cursor) : undefined))
              .orderBy(asc(messages.id)).limit(PAGE);
            if (!page.length) break;
            const atts = await db.select().from(attachments).where(inIds(attachments.messageId, page.map((m) => m.id)));
            const lines = page.map((m) => JSON.stringify({
              ...m, to: JSON.parse(m.to), cc: JSON.parse(m.cc), bcc: JSON.parse(m.bcc),
              attachments: atts.filter((a) => a.messageId === m.id).map(({ messageId: _m, ...a }) => a),
            })).join("\n") + "\n";
            file.push(enc.encode(lines));
            mailCount += page.length;
            cursor = page[page.length - 1]!.id;
            if (page.length < PAGE) break;
          }
          file.push(new Uint8Array(0), true);
          // R38: the same mailbox as mbox, which desktop mail apps import directly.
          const mbox = new ZipDeflate(`mail/${box.address}.mbox`, { level: 6 });
          zip.add(mbox);
          let c2 = "";
          for (;;) {
            const page = await db.select({ id: messages.id, fromAddress: messages.fromAddress, fromName: messages.fromName, to: messages.to, cc: messages.cc, subject: messages.subject, text: messages.text, html: messages.html, messageIdHeader: messages.messageIdHeader, inReplyTo: messages.inReplyTo, createdAt: messages.createdAt })
              .from(messages).where(and(eq(messages.mailboxId, box.id), c2 ? gt(messages.id, c2) : undefined)).orderBy(asc(messages.id)).limit(PAGE);
            if (!page.length) break;
            mbox.push(enc.encode(page.map((m) => toMboxEntry(m)).join("")));
            c2 = page[page.length - 1]!.id;
            if (page.length < PAGE) break;
          }
          mbox.push(new Uint8Array(0), true);
        }
        counts.messages = mailCount;
        await audit(db, { orgId, actorUserId: auth.userId || null, actorEmail: auth.email || null, action: "workspace.exported", metadata: counts });
        await opts.onDone?.(counts);
        zip.end();
      } catch (err) {
        deps.reportError?.(err, { where: "exportWorkspace" });
        controller.error(err);
      }
    },
    cancel() { zip?.terminate(); },
  });
}

/**
 * Runs before Better Auth deletes a user. Workspaces where the person is the only
 * member go with them (subscription cancelled, mail included). A workspace with other
 * members needs another owner first, so nobody is left locked out of their mail.
 */
export async function beforeUserDelete(deps: Deps, userId: string) {
  const { db } = deps;
  const mine = await db.select().from(members).where(eq(members.userId, userId));
  for (const m of mine) {
    const others = await db.select({ role: members.role }).from(members)
      .where(and(eq(members.organizationId, m.organizationId), ne(members.userId, userId), eq(members.kind, "human")));
    if (others.length && m.role === "owner" && !others.some((o) => o.role === "owner")) {
      const org = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.organizationId)).get();
      throw new HttpError(409, "transfer_ownership_first", `You are the only owner of ${org?.name ?? "a workspace"} and it has other members. Make someone else an owner first, or delete the workspace.`);
    }
  }
  for (const m of mine) {
    const others = await db.select({ userId: members.userId }).from(members)
      .where(and(eq(members.organizationId, m.organizationId), ne(members.userId, userId), eq(members.kind, "human")));
    if (others.length) {
      await audit(db, { orgId: m.organizationId, actorUserId: userId, action: "member.account_deleted" });
      continue;
    }
    const org = await db.select().from(organizations).where(eq(organizations.id, m.organizationId)).get();
    if (org) await cancelForDeletion(deps, org);
    await db.delete(organizations).where(eq(organizations.id, m.organizationId));
  }
}
