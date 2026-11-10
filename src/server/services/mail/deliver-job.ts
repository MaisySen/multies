/**
 * Retries outbound mail that a provider could not take (outage, rate limit, timeout).
 * The sent copy is already in the sender's Sent folder; this job re-reads it and
 * hands it to the provider again, updating the delivery log. When retries run out
 * the delivery is marked failed and the sender gets a non-delivery notice in their
 * inbox, as a mail server would send.
 */
import { and, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { attachments, deliveries, domains, mailboxes, messages } from "../../db/schema";
import { attachmentBytes } from "./store";
import { PermanentJobError, RetryableJobError, registerJob } from "../jobs";
import { deliverInbound } from "./delivery";
import { OutboundError } from "./outbound";
import { inIds } from "../../lib/sql-chunks";

/** Attachments to send, from the database or the body store. */
async function outboundAttachments(atts: { filename: string; contentType: string; contentB64: string | null; storageKey: string | null }[], deps: Deps) {
  const out = [];
  for (const a of atts) {
    const content = await attachmentBytes(a, deps.bodyStore);
    if (content) out.push({ filename: a.filename, contentType: a.contentType, content });
  }
  return out;
}

export interface DeliverJobPayload {
  orgId: string;
  messageId: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

async function load(deps: Deps, p: DeliverJobPayload) {
  const m = await deps.db.select().from(messages).where(and(eq(messages.id, p.messageId), eq(messages.orgId, p.orgId))).get();
  if (!m) throw new PermanentJobError("The sent message no longer exists.");
  const mb = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, m.mailboxId)).get();
  if (!mb || mb.status !== "active") throw new PermanentJobError("The sending mailbox is gone or suspended.");
  const atts = m.hasAttachments ? await deps.db.select().from(attachments).where(eq(attachments.messageId, m.id)) : [];
  return { m, mb, atts };
}

/**
 * The Message-ID for a sent copy that has none stored: the message id on the sending mailbox's domain
 * (<msg_x@acme.com>), or on the app's own mail domain when the mailbox address has no usable domain.
 */
export function fallbackMessageId(id: string, mailboxAddress: string, systemFrom: string): string {
  const domainOf = (a: string) => {
    const d = a.slice(a.lastIndexOf("@") + 1).trim().toLowerCase();
    return a.includes("@") && /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(d) ? d : null;
  };
  return `<${id}@${domainOf(mailboxAddress) ?? domainOf(systemFrom) ?? "localhost"}>`;
}

const all = (p: DeliverJobPayload) => [...p.to, ...p.cc, ...p.bcc];

export async function runDeliver(deps: Deps, payload: unknown) {
  const p = payload as DeliverJobPayload;
  const { m, mb, atts } = await load(deps, p);
  // A connected mailbox retries through its own provider's SMTP, like its first try.
  const { connectionForMailbox } = await import("../connect");
  const conn = await connectionForMailbox(deps, mb.id);
  // PRIV1b (P58): a retry from a connected mailbox whose connection was removed never falls back to the platform outbound.
  if (!conn) {
    const { CONNECTED_DOMAIN } = await import("../connect");
    const d = await deps.db.select({ name: domains.name }).from(domains).where(eq(domains.id, mb.domainId)).get();
    if (d?.name === CONNECTED_DOMAIN) throw new PermanentJobError(`${mb.address} is no longer connected, so it can't send.`);
  }
  const outbound = conn ? (await import("../connect/outbound")).connectionOutbound(deps, conn) : deps.outbound;
  // R31: a retry carries the same open image as the first try, when the message has one.
  const { existingToken, pixelUrl, withPixel } = await import("./read-status");
  const openToken = await existingToken(deps, m.id);
  const html = openToken ? withPixel(m.html ?? undefined, m.text, pixelUrl(deps.config.appUrl, openToken)) : m.html ?? undefined;
  try {
    const res = await outbound.send({
      from: { address: mb.address, name: mb.displayName }, to: p.to, cc: p.cc, bcc: p.bcc,
      subject: m.subject, text: m.text, html, messageId: m.messageIdHeader ?? fallbackMessageId(m.id, mb.address, deps.config.systemFrom.address),
      inReplyTo: m.inReplyTo ?? undefined, references: m.references ?? undefined, replyTo: m.replyTo ?? undefined,
      attachments: await outboundAttachments(atts, deps),
    });
    await deps.db.update(deliveries).set({ status: res.status, provider: res.provider, providerMessageId: res.providerMessageId ?? null, detail: res.detail ?? "Delivered after a retry." })
      .where(and(eq(deliveries.messageId, m.id), eq(deliveries.status, "delayed"), inIds(deliveries.toAddress, all(p))));
  } catch (err) {
    if (err instanceof OutboundError && !err.retryable) throw new PermanentJobError(err.message);
    throw new RetryableJobError(err instanceof Error ? err.message : "Send failed");
  }
}

export async function onDeliverDead(deps: Deps, payload: unknown, _job: unknown, error: string) {
  const p = payload as DeliverJobPayload;
  const m = await deps.db.select().from(messages).where(eq(messages.id, p.messageId)).get();
  await deps.db.update(deliveries).set({ status: "failed", detail: `Gave up after retries: ${error}` })
    .where(and(eq(deliveries.messageId, p.messageId), eq(deliveries.status, "delayed"), inIds(deliveries.toAddress, all(p))));
  if (!m) return;
  const mb = await deps.db.select().from(mailboxes).where(eq(mailboxes.id, m.mailboxId)).get();
  if (!mb) return;
  const text = [
    `Your message "${m.subject || "(no subject)"}" could not be delivered to:`,
    "",
    ...all(p).map((a) => `  ${a}`),
    "",
    `We kept trying for about two days. The last error was: ${error}`,
    "",
    "Nothing else needs doing on your side for other recipients. You can send it again from your Sent folder.",
  ].join("\n");
  // PRIV1b (AR1): pass only while the system address's domain is not a workspace claim short of verified (as send.ts
  // does for workspace senders). A name no workspace holds is the deployment's own mail domain.
  const sysDomain = await deps.db.select({ status: domains.status }).from(domains).where(eq(domains.name, (deps.config.systemFrom.address.split("@")[1] ?? "").toLowerCase())).get();
  const ok = !sysDomain || sysDomain.status === "verified";
  await deliverInbound(deps, {
    envelopeFrom: deps.config.systemFrom.address, rcptTo: mb.address, sizeBytes: text.length, via: "internal",
    email: {
      messageId: `<ndr.${m.id}@${deps.config.systemFrom.address.split("@")[1] ?? "localhost"}>`,
      from: { address: deps.config.systemFrom.address, name: "Mail Delivery" }, to: [{ address: mb.address }], cc: [],
      subject: `Undeliverable: ${m.subject || "(no subject)"}`, text, date: deps.now(), attachments: [],
      authResults: ok ? { spf: "pass", dkim: "pass", dmarc: "pass" } : { spf: "none", dkim: "none", dmarc: "none" }, headers: { "auto-submitted": "auto-replied" },
      inReplyTo: m.messageIdHeader ?? undefined,
    },
  });
}

registerJob("mail.deliver", runDeliver, onDeliverDead);
