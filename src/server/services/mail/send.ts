import { assertNotPaymentPaused, maybeUsageAlert } from "../billing/dunning";
import { emitEvent } from "../developer/webhooks";
import { suppressedAmong } from "../deliverability/suppressions";
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { domains, mailboxes, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound, planLimit } from "../../lib/errors";
import type { SendMessageInput } from "@/shared/schemas";
import { addonHint, getOrg, getPlan } from "../plans";
import { deliverInbound, isHosted, logDelivery, sentToday } from "./delivery";
import { OutboundError } from "./outbound";
import { storeMessage } from "./store";
import { enqueue } from "../jobs";
import type { DeliverJobPayload } from "./deliver-job";
import "./deliver-job";
import { maybeAutoSuspend, recentOutboundStats, recordAbuse, scoreOutbound, SPAM_FLAG_AT, SPAM_HOLD_AT } from "../abuse";
import type { ParsedAttachment } from "./mime";

export interface SendResult {
  messageId: string;
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
}

/** Sends a message from one of the org's mailboxes. Internal recipients are delivered directly. */
export async function sendMessage(deps: Deps, auth: AuthContext, input: SendMessageInput, extra: SendExtras = {}): Promise<SendResult> {
  const { db } = deps;
  const mb = await db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  if (mb.status !== "active") throw badRequest("This mailbox is suspended.");
  const domain = (await db.select().from(domains).where(eq(domains.id, mb.domainId)).get())!;
  const org = await getOrg(db, auth.orgId);
  assertNotPaymentPaused(org, deps.now());
  if (org.suspendedAt) throw new HttpError(403, "workspace_suspended", `This workspace is suspended, so it can't send mail. ${org.suspendedReason ?? ""} Contact support to review it.`.trim());
  if (domain.status !== "verified" && !org.isDemo) {
    throw new HttpError(409, "domain_unverified", `Verify ${domain.name} before sending from it, so your mail isn't rejected as spoofed.`);
  }

  const recipients = [...new Set([...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.toLowerCase()))];
  const plan = await getPlan(db, auth.orgId);
  const used = await sentToday(db, auth.orgId, deps.now());
  const cap = org.sendCapDaily ?? plan.limits.dailySends;
  if (used + recipients.length > cap) {
    throw planLimit(org.sendCapDaily !== null && org.sendCapDaily < plan.limits.dailySends
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
  const externalCount = (await Promise.all(recipients.map((r) => isHosted(db, r)))).filter((h) => !h).length;
  if (externalCount && !org.isDemo) {
    const ageDays = (deps.now().getTime() - new Date(org.createdAt).getTime()) / 86_400_000;
    const verdict = scoreOutbound({ subject: input.subject, text: input.text, html: input.html, recipients: externalCount, workspaceAgeDays: ageDays, recent: await recentOutboundStats(deps, auth.orgId) });
    if (verdict.score >= SPAM_HOLD_AT) {
      await recordAbuse(deps, auth.orgId, "outbound_held", verdict.score, verdict.reasons.join("; "));
      await maybeAutoSuspend(deps, auth.orgId, ageDays);
      throw new HttpError(422, "message_held", "This message looks like spam to our filters, so it wasn't sent. Check the reasons, edit the message and try again.", { reasons: verdict.reasons, score: verdict.score });
    }
    if (verdict.score >= SPAM_FLAG_AT) await recordAbuse(deps, auth.orgId, "outbound_flagged", verdict.score, verdict.reasons.join("; "));
  }

  const now = deps.now();
  const messageIdHeader = extra.messageIdHeader ?? `<${newId("m").slice(2)}.${now.getTime().toString(36)}@${domain.name}>`;
  const atts = extra.attachments ?? [];
  const from = { address: mb.address, name: mb.displayName };
  const toList = input.to.map((address) => ({ address }));
  const ccList = (input.cc ?? []).map((address) => ({ address }));
  const bccList = (input.bcc ?? []).map((address) => ({ address }));

  const sentId = await storeMessage(db, {
    orgId: auth.orgId, mailboxId: mb.id, folder: "sent", messageIdHeader, inReplyTo, references,
    from, to: toList, cc: ccList, bcc: bccList, subject: input.subject, text: input.text, html: input.html, date: now, isRead: true, attachments: atts,
    sentByAgentId: extra.agentId ?? null, sentByUserId: auth.userId || null, bodyStore: deps.bodyStore,
  });
  if (inReplyTo) {
    await db.update(messages).set({ isAnswered: true }).where(and(eq(messages.mailboxId, mb.id), eq(messages.messageIdHeader, inReplyTo)));
  }
  if (input.draftId) {
    await db.delete(messages).where(and(eq(messages.id, input.draftId), eq(messages.mailboxId, mb.id), eq(messages.folder, "drafts")));
  }

  const result: SendResult = { messageId: sentId, internal: [], external: [] };
  const internal: string[] = [];
  const external: string[] = [];
  for (const r of recipients) ((await isHosted(db, r)) ? internal : external).push(r);

  for (const rcpt of internal) {
    const r = await deliverInbound(deps, {
      envelopeFrom: mb.address,
      rcptTo: rcpt,
      sizeBytes: input.text.length + (input.html?.length ?? 0) + 512,
      via: "internal",
      email: {
        messageId: messageIdHeader, inReplyTo, references, from, to: toList, cc: ccList, subject: input.subject,
        text: input.text, html: input.html, date: now, attachments: atts, authResults: { spf: "pass", dkim: "pass", dmarc: "pass" }, headers: {},
      },
    });
    await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: rcpt, subject: input.subject, status: r.accepted ? "delivered" : "failed", provider: "internal", detail: r.reason });
    if (r.accepted) result.internal.push(rcpt);
    else result.external.push({ address: rcpt, status: "failed", detail: r.reason });
  }

  // Never send to addresses that hard bounced, complained, or were blocked by hand.
  const blocked = await suppressedAmong(db, auth.orgId, external);
  for (const address of blocked.keys()) {
    const detail = blocked.get(address) === "complaint" ? "Not sent: this address marked your mail as spam." : blocked.get(address) === "hard_bounce" ? "Not sent: this address bounced before." : "Not sent: this address is on your suppression list.";
    await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "suppressed", provider: "mymail", detail });
    result.external.push({ address, status: "failed", detail });
  }
  external.splice(0, external.length, ...external.filter((a) => !blocked.has(a)));

  // Sandbox workspaces never send outside MyMail: the sample data would otherwise mail
  // real-looking addresses and wait on the provider for every demo.
  if (external.length && org.isDemo) {
    for (const address of external) {
      await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "sent", provider: "demo", detail: "Sandbox workspace: shown as sent, not delivered outside MyMail." });
      result.external.push({ address, status: "sent", detail: "Sandbox workspace: not delivered outside MyMail." });
    }
    external.length = 0;
  }
  if (external.length) {
    const ext = new Set(external);
    const only = (list: string[] | undefined) => (list ?? []).map((a) => a.toLowerCase()).filter((a) => ext.has(a));
    try {
      const sent = await deps.outbound.send({
        from, to: only(input.to), cc: only(input.cc), bcc: only(input.bcc),
        subject: input.subject, text: input.text, html: input.html, messageId: messageIdHeader, inReplyTo, references,
        attachments: atts,
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
  await maybeUsageAlert(deps, org, used + recipients.length, cap).catch((err) => deps.reportError?.(err, { where: "usageAlert" }));
  await emitEvent(deps, auth.orgId, "message.sent", {
    id: sentId, mailboxId: mb.id, from: mb.address, to: input.to, cc: input.cc ?? [], subject: input.subject,
    recipients: [...result.internal.map((address) => ({ address, status: "delivered" })), ...result.external],
  });
  return result;
}
