import { emitEvent } from "../developer/webhooks";
import { suppressedAmong } from "../deliverability/suppressions";
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../../context";
import { domains, mailboxes, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { badRequest, HttpError, notFound, planLimit } from "../../lib/errors";
import type { SendMessageInput } from "@/shared/schemas";
import { getOrg, getPlan } from "../plans";
import { deliverInbound, isHosted, logDelivery, sentToday } from "./delivery";
import { OutboundError } from "./outbound";
import { storeMessage } from "./store";
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
}

/** Sends a message from one of the org's mailboxes. Internal recipients are delivered directly. */
export async function sendMessage(deps: Deps, auth: AuthContext, input: SendMessageInput, extra: SendExtras = {}): Promise<SendResult> {
  const { db } = deps;
  const mb = await db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.orgId, auth.orgId))).get();
  if (!mb) throw notFound("Mailbox");
  if (mb.status !== "active") throw badRequest("This mailbox is suspended.");
  const domain = (await db.select().from(domains).where(eq(domains.id, mb.domainId)).get())!;
  const org = await getOrg(db, auth.orgId);
  if (domain.status !== "verified" && !org.isDemo) {
    throw new HttpError(409, "domain_unverified", `Verify ${domain.name} before sending from it, so your mail isn't rejected as spoofed.`);
  }

  const recipients = [...new Set([...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])].map((a) => a.toLowerCase()))];
  const plan = await getPlan(db, auth.orgId);
  const used = await sentToday(db, auth.orgId, deps.now());
  if (used + recipients.length > plan.limits.dailySends) {
    throw planLimit(`Daily sending limit reached (${plan.limits.dailySends} recipients on ${plan.name}). It resets at midnight UTC.`);
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
      const detail = err instanceof OutboundError ? err.message : "The email provider could not be reached.";
      for (const address of external) {
        await logDelivery(db, { orgId: auth.orgId, messageId: sentId, direction: "outbound", fromAddress: mb.address, toAddress: address, subject: input.subject, status: "failed", provider: deps.outbound.name, detail });
        result.external.push({ address, status: "failed", detail });
      }
    }
  }
  await emitEvent(deps, auth.orgId, "message.sent", {
    id: sentId, mailboxId: mb.id, from: mb.address, to: input.to, cc: input.cc ?? [], subject: input.subject,
    recipients: [...result.internal.map((address) => ({ address, status: "delivered" })), ...result.external],
  });
  return result;
}
