import { assertNotPaymentPaused, maybeUsageAlert } from "../billing/dunning";
import { emitEvent } from "../developer/webhooks";
import { suppressedAmong } from "../deliverability/suppressions";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { domains, mailboxes, mailSchedules, messages } from "../../db/schema";
import { assertOpen, canOpen } from "../mail-access-priv1a";
import type { DB } from "../../db";
import { decide, externalSentToday, guardConfig, newSenderCap, nextUtcMidnight, providerSentToday, sendingOff, SENDING_OFF_MESSAGE } from "./send-guard-r34";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound, planLimit } from "../../lib/errors";
import type { SendMessageInput } from "@/shared/schemas";
import { addonHint, getOrg, getPlan } from "../plans";
import { deliverInbound, isHosted, logDelivery, sentToday } from "./delivery";
import { OutboundError } from "./outbound";
import { storeMessage } from "./store";
import { pixelUrl, trackingToken, withPixel } from "./read-status";
import { enqueue } from "../jobs";
import type { DeliverJobPayload } from "./deliver-job";
import "./deliver-job";
import { countNewRecipients, maybeAutoSuspend, recentOutboundStats, recordAbuse, scoreOutbound, SPAM_FLAG_AT, SPAM_HOLD_AT } from "../abuse";
import type { ParsedAttachment } from "./mime";

/** Most recipients one message from a free address can have. */
export const FREE_MAX_RECIPIENTS = 10;

export interface SendResult {
  /** Empty when the message was queued (R34): see `queued`. */
  messageId: string;
  /** R34: held until midnight UTC by a sending limit, with the reason (Outbox shows it). */
  queued?: { id: string; dueAt: string; reason: string };
  internal: string[];
  external: { address: string; status: "sent" | "queued" | "failed"; detail?: string }[];
}

/** Extras for messages that arrive pre-built (SMTP submission, the REST API). */
export interface SendExtras {
  messageIdHeader?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: ParsedAttachment[];
  /** The agent that wrote this message (agent API keys, MCP, or an approved agent draft). */
  agentId?: string;
  /** R27: the From display name, instead of the mailbox's (auth email hooks set a sender name). */
  fromName?: string;
  /** R34: refuse over a sending limit instead of queueing (callers that can't hold a message). */
  noQueue?: boolean;
  /** R34: an operator's "Send anyway" on a queued message: skips the guard (never the kill switch). */
  overrideCap?: boolean;
  /** R109: extra headers for bulk mail (List-Unsubscribe, List-Unsubscribe-Post). */
  headers?: Record<string, string>;
}

/** R34: holds a person's message until midnight UTC as a scheduled send that carries the reason. */
async function queueUntilTomorrow(deps: Deps, auth: AuthContext, input: SendMessageInput, reason: string, recipients: string[]): Promise<SendResult> {
  const dueAt = nextUtcMidnight(deps.now());
  const id = newId("msch");
  // PRIV1b (P11): as a sent draft, only the sender's own draft (or one nobody owns) leaves Drafts.
  if (input.draftId) await deps.db.delete(messages).where(and(eq(messages.id, input.draftId), eq(messages.mailboxId, input.mailboxId), eq(messages.folder, "drafts"), or(isNull(messages.sentByUserId), eq(messages.sentByUserId, auth.userId))));
  // Essential write: the held message itself (one row), so nothing is lost.
  await deps.db.insert(mailSchedules).values({
    id, orgId: auth.orgId, mailboxId: input.mailboxId, userId: auth.userId || null, kind: "send", dueAt, createdAt: deps.now(),
    payload: JSON.stringify({ via: "person", input: { ...input, draftId: undefined }, apiKeyId: (auth as { apiKeyId?: string }).apiKeyId, held: reason }),
  });
  return { messageId: "", internal: [], external: recipients.map((address) => ({ address, status: "queued" as const, detail: reason })), queued: { id, dueAt: dueAt.toISOString(), reason } };
}

/**
 * PRIV1b (P10): what a send needs on a personal mailbox. Send as (and the owner) may write to anyone. Below that, a
 * reply share only answers: inReplyToId must be a message (not a draft) in this mailbox, and every recipient must
 * already be in that thread. Used by Send, drafts and Send later, before anything is written. Team mailboxes pass.
 */
export async function assertSendLevel(db: DB, who: Pick<AuthContext, "userId" | "orgId" | "role">, mb: { id: string; personal: boolean | null }, input: { inReplyToId?: string | null; to?: string[]; cc?: string[]; bcc?: string[] }) {
  if (!mb.personal) return;
  if (!input.inReplyToId) return assertOpen(db, who, mb.id, "send");
  if (await canOpen(db, who, mb.id, "send")) return;
  await assertOpen(db, who, mb.id, "reply");
  const refuse = () => new HttpError(403, "share_level", "This mailbox was shared with you to reply only, so you can only answer the people in the thread. Ask its owner.");
  const parent = await db.select({ threadId: messages.threadId, folder: messages.folder }).from(messages)
    .where(and(eq(messages.id, input.inReplyToId), eq(messages.mailboxId, mb.id), eq(messages.orgId, who.orgId))).get();
  if (!parent || parent.folder === "drafts") throw refuse();
  const rcpts = [...(input.to ?? []), ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!rcpts.length) return;
  const rows = await db.select({ from: messages.fromAddress, to: messages.to, cc: messages.cc, bcc: messages.bcc, replyTo: messages.replyTo }).from(messages)
    .where(and(eq(messages.mailboxId, mb.id), eq(messages.threadId, parent.threadId), ne(messages.folder, "drafts"))).limit(200);
  const seen = new Set<string>();
  const list = (raw: string) => { try { for (const a of JSON.parse(raw) as { address?: string }[]) if (a?.address) seen.add(a.address.toLowerCase()); } catch { /* bad row: adds nobody */ } };
  for (const r of rows) {
    seen.add(r.from.toLowerCase());
    if (r.replyTo) seen.add(r.replyTo.toLowerCase());
    list(r.to); list(r.cc); list(r.bcc);
  }
  if (rcpts.some((a) => !seen.has(a))) throw refuse();
}

/** Sends a message from one of the org's mailboxes. Internal recipients are delivered directly. */
export async function sendMessage(deps: Deps, auth: AuthContext, input: SendMessageInput, extra: SendExtras = {}): Promise<SendResult> {
  const { db } = deps;
  const mb = await db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  // PRIV1a (MB-366): a personal mailbox sends only for its owner and the people it was shared with (a reply needs
  // Read and reply, new mail needs Send as). Every send path (app, phone, REST, MCP, schedules) comes through here.
  // PRIV1b (P10): a reply share answers the thread's own people only (assertSendLevel).
  await assertSendLevel(db, auth, mb, input);
  if (mb.status !== "active") throw badRequest("This mailbox is suspended.");
  // MB-61: a send that names no Reply-To uses the mailbox's default one, when it has one.
  const replyTo = input.replyTo || mb.replyTo || undefined;
  const domain = (await db.select().from(domains).where(eq(domains.id, mb.domainId)).get())!;
  const org = await getOrg(db, auth.orgId);
  assertNotPaymentPaused(org, deps.now());
  if (org.suspendedAt) throw new HttpError(403, "workspace_suspended", `This workspace is suspended, so it can't send mail. ${org.suspendedReason ?? ""} Contact support to review it.`.trim());
  // A connected mailbox (an address at another provider) sends through that provider's own SMTP.
  const { connectionForMailbox } = await import("../connect");
  const conn = await connectionForMailbox(deps, mb.id);
  if (conn?.status === "auth_failed") {
    throw new HttpError(409, "connection_auth_failed", `${mb.address} stopped accepting its password. Reconnect it in Settings, Connections, Mail accounts, then send again.`);
  }
  // PRIV1b (P40): no demo exemption. A sandbox's sample domain is stored verified; any other domain must prove itself.
  if (!conn && domain.status !== "verified") {
    throw new HttpError(409, "domain_unverified", `Verify ${domain.name} before sending from it, so your mail isn't rejected as spoofed.`);
  }

  const recipients = [...new Set([...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.toLowerCase()))];
  const plan = await getPlan(db, auth.orgId);
  const used = await sentToday(db, auth.orgId, deps.now());
  // Free addresses share one Multies domain, so they get a smaller daily allowance (FREE_MAIL_DAILY_SENDS).
  // New workspaces get a smaller allowance still for their first week, and a free address can't mass mail.
  const freeAddress = !conn && domain.orgId === "org_platform" && mb.kind === "person" && !org.isDemo;
  const newAccount = deps.now().getTime() - new Date(org.createdAt).getTime() < 7 * 86_400_000;
  const freeCap = newAccount ? Math.min(deps.config.freeMail.newAccountDailySends, deps.config.freeMail.dailySends) : deps.config.freeMail.dailySends;
  const cap = Math.min(org.sendCapDaily ?? plan.limits.dailySends, freeAddress ? freeCap : Infinity);
  if (freeAddress && recipients.length > FREE_MAX_RECIPIENTS) {
    throw badRequest(`A free address can send to up to ${FREE_MAX_RECIPIENTS} people in one message.`);
  }
  if (freeAddress && used + recipients.length > cap) {
    throw planLimit(`Free addresses can send to ${cap} recipients a day${newAccount ? " in their first week" : ""}. It resets at midnight UTC. Add your own domain to send more.`);
  }
  // R34 (MB-169): the operator's kill switch refuses at once; nothing is queued.
  if (sendingOff(org) && !org.isDemo) throw new HttpError(403, "sending_off", SENDING_OFF_MESSAGE);
  const underReview = org.sendCapDaily !== null && org.sendCapDaily < plan.limits.dailySends;
  // Agents, scheduled agent sends and callers that can't hold a message keep the old refusal (R34 queues the rest).
  if (used + recipients.length > cap && (extra.agentId || extra.noQueue)) {
    throw planLimit(underReview
      ? `This workspace can send to ${cap} recipients a day while its sending is under review. It resets at midnight UTC.`
      : `Daily sending limit reached (${cap} recipients a day). It resets at midnight UTC. ${addonHint("dailySends")}`);
  }

  let inReplyTo: string | undefined = extra.inReplyTo;
  let references: string | undefined = extra.references ?? extra.inReplyTo;
  if (input.inReplyToId) {
    const parent = await db.select().from(messages).where(and(eq(messages.id, input.inReplyToId), eq(messages.orgId, auth.orgId))).get();
    if (parent?.messageIdHeader) {
      inReplyTo = parent.messageIdHeader;
      references = [parent.references, parent.messageIdHeader].filter(Boolean).join(" ");
    }
  }

  // Spam heuristics on mail that leaves the platform (services/abuse.ts).
  const externalCount = conn ? recipients.length : (await Promise.all(recipients.map((r) => isHosted(db, r)))).filter((h) => !h).length;
  if (externalCount && !org.isDemo) {
    const ageDays = (deps.now().getTime() - new Date(org.createdAt).getTime()) / 86_400_000;
    const verdict = scoreOutbound({ subject: input.subject, text: input.text, html: input.html, recipients: externalCount, workspaceAgeDays: ageDays, recent: await recentOutboundStats(deps, auth.orgId),
      newRecipients: externalCount >= 10 ? await countNewRecipients(deps, auth.orgId, conn ? recipients : (await Promise.all(recipients.map(async (r) => ((await isHosted(db, r)) ? null : r)))).filter((r): r is string => !!r)) : 0 });
    // Free addresses share one domain's reputation, so they are held at the lower "flag" score too.
    if (verdict.score >= SPAM_HOLD_AT || (freeAddress && verdict.score >= SPAM_FLAG_AT)) {
      await recordAbuse(deps, auth.orgId, "outbound_held", verdict.score, verdict.reasons.join("; "));
      await maybeAutoSuspend(deps, auth.orgId, ageDays);
      throw new HttpError(422, "message_held", "This message looks like spam to our filters, so it wasn't sent. Check the reasons, edit the message and try again.", { reasons: verdict.reasons, score: verdict.score });
    }
    if (verdict.score >= SPAM_FLAG_AT) await recordAbuse(deps, auth.orgId, "outbound_flagged", verdict.score, verdict.reasons.join("; "));
  }

  // R34 (MB-166, MB-169): over the plan cap, the new sender limit or the shared sender headroom, the message is
  // queued until midnight UTC with the reason (services/mail/send-guard-r34.ts), never dropped.
  if (!org.isDemo && !extra.overrideCap) {
    const cfg = guardConfig(deps);
    const ext = conn ? 0 : externalCount; // a connected address sends through its own provider
    const ageDays = (deps.now().getTime() - new Date(org.createdAt).getTime()) / 86_400_000;
    const verdictCap = decide({
      cfg, used, cap, recipients: recipients.length, external: ext, underReview,
      externalUsed: ext ? await externalSentToday(deps, auth.orgId) : 0,
      newCap: ext ? newSenderCap(cfg, ageDays, await recentOutboundStats(deps, auth.orgId)) : null,
      providerUsed: ext && cfg.providerDailyCap > 0 ? await providerSentToday(deps) : 0,
    });
    if (!verdictCap.ok) {
      if (extra.agentId || extra.noQueue) throw planLimit(verdictCap.reason.replace("Queued until tomorrow.", "It resets at midnight UTC."));
      await maybeUsageAlert(deps, org, used + recipients.length, cap).catch((err) => deps.reportError?.(err, { where: "usageAlert" }));
      return queueUntilTomorrow(deps, auth, input, verdictCap.reason, recipients);
    }
  }

  const now = deps.now();
  const messageIdHeader = extra.messageIdHeader ?? `<${newId("m").slice(2)}.${now.getTime().toString(36)}@${conn ? conn.email.split("@")[1] : domain.name}>`;
  const atts = extra.attachments ?? [];
  const from = { address: mb.address, name: extra.fromName || mb.displayName };
  const toList = input.to.map((address) => ({ address }));
  const ccList = (input.cc ?? []).map((address) => ({ address }));
  const bccList = (input.bcc ?? []).map((address) => ({ address }));

  const sentId = await storeMessage(db, {
    orgId: auth.orgId, mailboxId: mb.id, folder: "sent", messageIdHeader, inReplyTo, references,
    from, to: toList, cc: ccList, bcc: bccList, replyTo, subject: input.subject, text: input.text, html: input.html, date: now, isRead: true, attachments: atts,
    sentByAgentId: extra.agentId ?? null, sentByUserId: auth.userId || null, bodyStore: deps.bodyStore,
  });
  if (inReplyTo) {
    await db.update(messages).set({ isAnswered: true }).where(and(eq(messages.mailboxId, mb.id), eq(messages.messageIdHeader, inReplyTo)));
  }
  if (input.draftId) {
    // Round 22: a draft somebody else took over stays theirs.
    await db.delete(messages).where(and(eq(messages.id, input.draftId), eq(messages.mailboxId, mb.id), eq(messages.folder, "drafts"), or(isNull(messages.sentByUserId), eq(messages.sentByUserId, auth.userId))));
  }

  {
    const sent = await db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, sentId)).get();
    const { onMailStored } = await import("../suite/hooks");
    await onMailStored(deps, { orgId: auth.orgId, mailboxId: mb.id, messageId: sentId, threadId: sent?.threadId ?? "", direction: "outbound", folder: "sent", from, to: toList, cc: ccList, subject: input.subject, date: now });
  }

  const result: SendResult = { messageId: sentId, internal: [], external: [] };
  const internal: string[] = [];
  const external: string[] = [];
  // Mail from a connected address always goes through its provider, so the Sent copy lives there too.
  for (const r of recipients) ((!conn && (await isHosted(db, r))) ? internal : external).push(r);

  // PRIV1b (P40): internal mail shows pass only for a sender domain proved in DNS. The domain_unverified throw
  // above already stops unverified senders here, so the "none" branch is a backstop in case that check moves.
  const senderAuth = domain.status === "verified" ? { spf: "pass" as const, dkim: "pass" as const, dmarc: "pass" as const } : { spf: "none" as const, dkim: "none" as const, dmarc: "none" as const };
  for (const rcpt of internal) {
    const r = await deliverInbound(deps, {
      envelopeFrom: mb.address,
      rcptTo: rcpt,
      sizeBytes: input.text.length + (input.html?.length ?? 0) + 512,
      via: "internal",
      email: {
        messageId: messageIdHeader, inReplyTo, references, from, to: toList, cc: ccList, replyTo, subject: input.subject,
        text: input.text, html: input.html, date: now, attachments: atts, authResults: senderAuth, headers: {},
      },
    });
    await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: rcpt, subject: input.subject, status: r.accepted ? "delivered" : "failed", provider: "internal", detail: r.reason });
    if (r.accepted) result.internal.push(rcpt);
    else result.external.push({ address: rcpt, status: "failed", detail: r.reason });
  }

  // R31: read status (opt in per person). Only the copy that leaves Multies carries the open image; mail
  // to people inside Multies never does. A sandbox workspace tracks too, so read status can be tried there.
  const openToken = external.length ? await trackingToken(deps, { orgId: auth.orgId, userId: auth.userId, messageId: sentId, agentId: extra.agentId ?? null }) : null;
  const outHtml = openToken ? withPixel(input.html, input.text, pixelUrl(deps.config.appUrl, openToken)) : input.html;

  // Never send to addresses that hard bounced, complained, or were blocked by hand.
  const blocked = await suppressedAmong(db, auth.orgId, external);
  for (const address of blocked.keys()) {
    const detail = blocked.get(address) === "complaint" ? "Not sent: this address marked your mail as spam." : blocked.get(address) === "hard_bounce" ? "Not sent: this address bounced before." : "Not sent: this address is on your suppression list.";
    await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "suppressed", provider: "mymail", detail });
    result.external.push({ address, status: "failed", detail });
  }
  external.splice(0, external.length, ...external.filter((a) => !blocked.has(a)));

  // Sandbox workspaces never send outside Multies: the sample data would otherwise mail
  // real-looking addresses and wait on the provider for every demo.
  if (external.length && org.isDemo) {
    for (const address of external) {
      await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "sent", provider: "demo", detail: "Sandbox workspace: shown as sent, not delivered outside Multies." });
      result.external.push({ address, status: "sent", detail: "Sandbox workspace: not delivered outside Multies." });
    }
    external.length = 0;
  }
  if (external.length) {
    const ext = new Set(external);
    const only = (list: string[] | undefined) => (list ?? []).map((a) => a.toLowerCase()).filter((a) => ext.has(a));
    try {
      const outbound = conn ? (await import("../connect/outbound")).connectionOutbound(deps, conn) : deps.outbound;
      const sent = await outbound.send({
        from, to: only(input.to), cc: only(input.cc), bcc: only(input.bcc), replyTo,
        subject: input.subject, text: input.text, html: outHtml, messageId: messageIdHeader, inReplyTo, references,
        attachments: atts, headers: extra.headers,
      });
      for (const address of external) {
        await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: sent.status, provider: sent.provider, providerMessageId: sent.providerMessageId ?? null, detail: sent.detail ?? null });
        result.external.push({ address, status: sent.status, detail: sent.detail });
      }
    } catch (err) {
      const retryable = !(err instanceof OutboundError) || err.retryable;
      if (retryable) {
        // Provider down, slow or rate limited: queue it. The job retries with backoff
        // for about two days, then sends the sender a non-delivery notice.
        const detail = "Delayed: the email provider is unavailable right now. We'll keep retrying automatically.";
        await enqueue(deps, "mail.deliver", { orgId: auth.orgId, messageId: sentId, to: only(input.to), cc: only(input.cc), bcc: only(input.bcc) } satisfies DeliverJobPayload, { orgId: auth.orgId, delayMs: 30_000 });
        for (const address of external) {
          await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "delayed", provider: deps.outbound.name, detail });
          result.external.push({ address, status: "queued", detail });
        }
      } else {
        const detail = (err as OutboundError).message;
        for (const address of external) {
          await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "failed", provider: deps.outbound.name, detail });
          result.external.push({ address, status: "failed", detail });
        }
      }
    }
  }
  const crossed = await maybeUsageAlert(deps, org, used + recipients.length, cap).catch((err) => { deps.reportError?.(err, { where: "usageAlert" }); return null; });
  // R34 (MB-166): one ops mail per workspace per day, on the first threshold it crosses that day (80% or 100%).
  if (crossed && !(org.usageAlerts ?? "").split(",").some((k) => k.startsWith(deps.now().toISOString().slice(0, 10)))) {
    const { sendSystemEmail } = await import("../system-mail");
    await sendSystemEmail(deps, {
      to: deps.config.supportEmail, orgId: auth.orgId, template: "ops-send-cap",
      subject: `${org.name} used ${crossed}% of its daily sends`,
      text: `${org.name} (${org.id}) has sent to ${used + recipients.length} of ${cap} recipients today. Over the cap, mail is queued until midnight UTC. Operator console: ${deps.config.appUrl}/app/operator`,
    } as never).catch(() => undefined);
  }
  await emitEvent(deps, auth.orgId, "message.sent", {
    id: sentId, mailboxId: mb.id, from: mb.address, to: input.to, cc: input.cc ?? [], subject: input.subject,
    recipients: [...result.internal.map((address) => ({ address, status: "delivered" })), ...result.external],
  });
  return result;
}
