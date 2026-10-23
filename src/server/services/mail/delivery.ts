import { mirrorInbound } from "../mailserver";
import { emitEvent } from "../developer/webhooks";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import type { DB } from "../../db";
import { aliases, deliveries, domains, mailboxes } from "../../db/schema";
import { newId } from "../../lib/crypto";
import type { ParsedEmail } from "./mime";
import { storeMessage } from "./store";
import { OutboundError } from "./outbound";

export type RecipientRoute =
  | { kind: "mailbox"; mailbox: typeof mailboxes.$inferSelect; domain: typeof domains.$inferSelect }
  | { kind: "alias"; alias: typeof aliases.$inferSelect; domain: typeof domains.$inferSelect }
  | { kind: "none"; domain?: typeof domains.$inferSelect };

/** `hello+news@acme.io` → `hello@acme.io` (sub-addressing). */
export function baseAddress(address: string): string {
  const [local, domain] = address.toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

export function domainOf(address: string): string {
  return address.toLowerCase().split("@")[1] ?? "";
}

/** Decides where mail for `address` goes on this platform. */
export async function routeRecipient(db: DB, address: string): Promise<RecipientRoute> {
  const addr = baseAddress(address);
  const domain = await db.select().from(domains).where(eq(domains.name, domainOf(addr))).get();
  if (!domain) return { kind: "none" };
  const mailbox = await db.select().from(mailboxes).where(eq(mailboxes.address, addr)).get();
  if (mailbox) return { kind: "mailbox", mailbox, domain };
  const alias = await db.select().from(aliases).where(and(eq(aliases.address, addr), eq(aliases.enabled, true))).get();
  if (alias) return { kind: "alias", alias, domain };
  if (domain.catchAllMailboxId) {
    const catchAll = await db.select().from(mailboxes).where(eq(mailboxes.id, domain.catchAllMailboxId)).get();
    if (catchAll) return { kind: "mailbox", mailbox: catchAll, domain };
  }
  return { kind: "none", domain };
}

export async function isHosted(db: DB, address: string): Promise<boolean> {
  return (await routeRecipient(db, address)).kind !== "none";
}

export interface InboundDelivery {
  /** SMTP envelope sender. */
  envelopeFrom: string;
  /** One envelope recipient. */
  rcptTo: string;
  email: ParsedEmail;
  sizeBytes: number;
  /** Provider label for the delivery log, e.g. `cloudflare` or `internal`. */
  via: string;
  /** If set, the recipient domain must belong to this org (signed webhooks). */
  requireOrgId?: string;
  /** The raw message, when the provider handed it over; copied to mail app accounts. */
  raw?: Uint8Array;
}

export interface InboundResult {
  accepted: boolean;
  /** SMTP-style code for the upstream MTA / Email Worker. */
  code: 250 | 450 | 550 | 552;
  reason: string;
  storedIn: string[];
  forwardedTo: string[];
}

const MAX_ALIAS_DEPTH = 5;

async function logDelivery(db: DB, row: Omit<typeof deliveries.$inferInsert, "id">) {
  await db.insert(deliveries).values({ id: newId("dlv"), ...row });
}

/**
 * Delivers one inbound message to one recipient: into a mailbox, through an alias
 * (to internal mailboxes and/or external forwards), or to the domain's catch-all.
 */
export async function deliverInbound(deps: Deps, d: InboundDelivery, depth = 0, seen = new Set<string>()): Promise<InboundResult> {
  const { db } = deps;
  const rcpt = baseAddress(d.rcptTo);
  const route = await routeRecipient(db, rcpt);
  const subject = d.email.subject;
  const orgOf = (r: RecipientRoute) => (r.kind === "none" ? r.domain?.orgId : r.domain.orgId);

  if (d.requireOrgId && orgOf(route) && orgOf(route) !== d.requireOrgId) {
    return { accepted: false, code: 550, reason: "Recipient domain is not managed by this signing key.", storedIn: [], forwardedTo: [] };
  }
  if (route.kind === "none") {
    if (route.domain) {
      await logDelivery(db, { orgId: route.domain.orgId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "rejected", provider: d.via, detail: "No such mailbox or alias" });
    }
    return { accepted: false, code: 550, reason: `No mailbox for ${rcpt}.`, storedIn: [], forwardedTo: [] };
  }

  if (route.kind === "mailbox") {
    const mb = route.mailbox;
    if (mb.status !== "active") {
      await logDelivery(db, { orgId: mb.orgId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "rejected", provider: d.via, detail: "Mailbox suspended" });
      return { accepted: false, code: 550, reason: "Mailbox is suspended.", storedIn: [], forwardedTo: [] };
    }
    if (mb.usedBytes + d.sizeBytes > mb.quotaMb * 1024 * 1024) {
      await logDelivery(db, { orgId: mb.orgId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "rejected", provider: d.via, detail: "Mailbox over quota" });
      return { accepted: false, code: 552, reason: "Mailbox is full.", storedIn: [], forwardedTo: [] };
    }
    const spam = d.email.authResults.dmarc === "fail";
    const messageId = await storeMessage(db, {
      orgId: mb.orgId,
      mailboxId: mb.id,
      folder: spam ? "spam" : "inbox",
      messageIdHeader: d.email.messageId,
      inReplyTo: d.email.inReplyTo,
      references: d.email.references,
      from: d.email.from,
      to: d.email.to,
      cc: d.email.cc,
      replyTo: d.email.replyTo,
      subject: d.email.subject,
      text: d.email.text,
      html: d.email.html,
      date: d.email.date,
      authResults: d.email.authResults,
      attachments: d.email.attachments,
      sizeBytes: d.sizeBytes,
    });
    await logDelivery(db, { orgId: mb.orgId, messageId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "delivered", provider: d.via, detail: spam ? "Filed as spam (DMARC fail)" : `Delivered to ${mb.address}` });
    if (d.raw) await mirrorInbound(deps, mb.id, d.raw, { spam });
    await emitEvent(deps, mb.orgId, "message.received", {
      id: messageId, mailboxId: mb.id, to: mb.address, from: d.email.from, subject: d.email.subject ?? "", folder: spam ? "spam" : "inbox", sizeBytes: d.sizeBytes,
    });
    return { accepted: true, code: 250, reason: "Delivered.", storedIn: [mb.id], forwardedTo: [] };
  }

  // Alias: fan out.
  const alias = route.alias;
  if (depth >= MAX_ALIAS_DEPTH || seen.has(alias.address)) {
    return { accepted: false, code: 550, reason: "Alias loop detected.", storedIn: [], forwardedTo: [] };
  }
  seen.add(alias.address);
  const destinations = JSON.parse(alias.destinations) as string[];
  const result: InboundResult = { accepted: false, code: 550, reason: "No destination accepted the message.", storedIn: [], forwardedTo: [] };
  const external: string[] = [];
  for (const dest of destinations) {
    if (await isHosted(db, dest)) {
      const r = await deliverInbound(deps, { ...d, rcptTo: dest, requireOrgId: undefined }, depth + 1, seen);
      result.storedIn.push(...r.storedIn);
      result.forwardedTo.push(...r.forwardedTo);
    } else {
      external.push(dest);
    }
  }
  if (external.length) {
    const fromName = d.email.from.name ? `${d.email.from.name} via ${alias.address}` : `${d.email.from.address} via ${alias.address}`;
    try {
      const sent = await deps.outbound.send({
        from: { address: alias.address, name: fromName },
        to: external,
        replyTo: d.email.replyTo ?? d.email.from.address,
        subject: d.email.subject,
        text: d.email.text,
        html: d.email.html,
        messageId: `<fwd.${newId("m")}@${route.domain.name}>`,
        references: d.email.messageId,
      });
      for (const to of external) {
        await logDelivery(db, { orgId: alias.orgId, direction: "outbound", fromAddress: alias.address, toAddress: to, subject, status: "forwarded", provider: sent.provider, providerMessageId: sent.providerMessageId ?? null, detail: sent.detail ?? `Forwarded via ${alias.address}` });
      }
      result.forwardedTo.push(...external);
    } catch (err) {
      for (const to of external) {
        await logDelivery(db, { orgId: alias.orgId, direction: "outbound", fromAddress: alias.address, toAddress: to, subject, status: "failed", provider: deps.outbound.name, detail: err instanceof Error ? err.message : String(err) });
      }
      if (!result.storedIn.length && err instanceof OutboundError && err.retryable) {
        return { ...result, code: 450, reason: "Forwarding temporarily failed; try again later." };
      }
    }
  }
  if (result.storedIn.length || result.forwardedTo.length) {
    await logDelivery(db, { orgId: alias.orgId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "delivered", provider: d.via, detail: `Alias → ${destinations.join(", ")}` });
    return { ...result, accepted: true, code: 250, reason: "Delivered." };
  }
  return result;
}

/** Recipients sent today (UTC) by an org. This is what the plan's daily limit counts. */
export async function sentToday(db: DB, orgId: string, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(
    eq(deliveries.orgId, orgId),
    eq(deliveries.direction, "outbound"),
    inArray(deliveries.status, ["sent", "queued", "delivered"]),
    gte(deliveries.createdAt, start),
  )).get();
  return Number(row?.n ?? 0);
}

export { logDelivery };
