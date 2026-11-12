import { mirrorInbound } from "../mailserver";
import { emitEvent } from "../developer/webhooks";
import { ingestDmarcAttachments } from "../deliverability/dmarc";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import type { DB } from "../../db";
import { aliases, deliveries, domains, mailboxes, messages } from "../../db/schema";
import { newId } from "../../lib/crypto";
import type { ParsedEmail } from "./mime";
import { storeMessage } from "./store";
import { OutboundError } from "./outbound";
import { getOrg, getPlan } from "../plans";
import { recentOutboundStats, recordAbuse, scoreOutbound, SPAM_HOLD_AT } from "../abuse";
import { decide, externalSentToday, guardConfig, newSenderCap, providerSentToday, sendingOff } from "./send-guard-r34";
import { notifyAgentsOfInbound } from "../agents";
import { operatorDecision } from "../suite/operator-inbox";
import { isBulkMail } from "@/shared/mail-splits";
import { isWithheld, NOT_FORWARDED_TO_AGENT, storedAuth, withoutSecrets, type PlatformMark } from "../agents/platform-mail";
import { makeSnippet } from "./mime";

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
  // PRIV1b (P36): only a domain whose owner proved it in DNS routes inside the platform. A pending or failed
  // claim (anyone can add any name) would otherwise catch password resets, invites and other customers' mail.
  // Platform, operator and sample rows are stored verified. No domain is returned, so nothing is logged to the claimant.
  // PRIV1b (integration M1): a domain once proved keeps routing when a later re-check fails (an SPF edit, DNS drift):
  // the re-check keeps verifiedAt, and bouncing every message of a live workspace is worse than the drift.
  if (domain.status !== "verified" && !domain.verifiedAt) return { kind: "none" };
  const mailbox = await db.select().from(mailboxes).where(eq(mailboxes.address, addr)).get();
  // A connected mailbox (an address at another provider) sits on the shared connected row, not this domain: mail for it goes out over the internet.
  if (mailbox && mailbox.domainId === domain.id) return { kind: "mailbox", mailbox, domain };
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
  /**
   * AIS1 (row 32): set only by the platform's own senders (system-mail.ts "system", the bounce notice "notice"); never
   * from anything in the message. Stored as `platform` in authResults so agents and apps never get the system mail's
   * text, codes or links (agents/platform-mail.ts).
   */
  platformMail?: PlatformMark;
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
  // R106: a forward to the workspace receipts address becomes draft expenses for the member who sent it.
  if (deps.config.expensesR106 && /^receipts\./i.test(rcpt)) {
    const { receiveReceiptMail } = await import("../expenses/expenses");
    const r = await receiveReceiptMail(deps, { rcpt, fromAddress: d.email.from?.address ?? d.envelopeFrom, subject: d.email.subject ?? null, dmarcFail: d.email.authResults?.dmarc === "fail", attachments: d.email.attachments });
    if (r.handled) return { accepted: r.accepted, code: r.accepted ? 250 : 550, reason: r.reason, storedIn: [], forwardedTo: [] };
  }
  // R26 (DF-18): the company domain's listed addresses go only to the operator workspace; its other addresses stay closed.
  const op = operatorDecision(deps.config, rcpt);
  if (op?.kind === "closed") return { accepted: false, code: 550, reason: `No mailbox for ${rcpt}.`, storedIn: [], forwardedTo: [] };
  const route = await routeRecipient(db, rcpt);
  const subject = d.email.subject;
  const orgOf = (r: RecipientRoute) => (r.kind === "none" ? r.domain?.orgId : r.domain.orgId);
  if (op && orgOf(route) !== op.orgId) return { accepted: false, code: 550, reason: `No mailbox for ${rcpt}.`, storedIn: [], forwardedTo: [] };

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
    // Storage is pooled across the workspace (plan storage plus storage packs).
    const [plan, pooled] = await Promise.all([
      getPlan(db, mb.orgId),
      db.select({ n: sql<number>`coalesce(sum(${mailboxes.usedBytes}), 0)` }).from(mailboxes).where(eq(mailboxes.orgId, mb.orgId)).get(),
    ]);
    if (Number(pooled?.n ?? 0) + d.sizeBytes > plan.limits.storageMb * 1024 * 1024) {
      await logDelivery(db, { orgId: mb.orgId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "rejected", provider: d.via, detail: "Workspace storage is full" });
      return { accepted: false, code: 552, reason: "The workspace's storage is full.", storedIn: [], forwardedTo: [] };
    }
    const spam = d.email.authResults.dmarc === "fail";
    // AIS1 (row 32): the platform's own mail keeps its text for people, but its preview loses links and codes and
    // agents get neither (the From rule also catches system mail that went out and came back in).
    const withheld = isWithheld(d.platformMail, d.email.from?.address ?? "", deps.config.systemFrom.address);
    const messageId = await storeMessage(db, {
      bodyStore: deps.bodyStore, orgId: mb.orgId,
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
      authResults: storedAuth(d.email.authResults, d.platformMail),
      attachments: d.email.attachments,
      sizeBytes: d.sizeBytes,
      isBulk: isBulkMail(d.email.headers ?? {}, d.email.from.address), // R31: split inbox
      ...(withheld ? { snippet: makeSnippet(withoutSecrets(d.email.text ?? "")) } : {}),
    });
    await logDelivery(db, { orgId: mb.orgId, messageId, direction: "inbound", fromAddress: d.envelopeFrom, toAddress: rcpt, subject, status: "delivered", provider: d.via, detail: spam ? "Filed as spam (DMARC fail)" : `Delivered to ${mb.address}` });
    if (d.raw) await mirrorInbound(deps, mb.id, d.raw, { spam });
    if (d.email.attachments.length && /dmarc|report/i.test(`${d.email.subject ?? ""} ${mb.localPart}`)) {
      await ingestDmarcAttachments(deps, mb.orgId, d.email.attachments);
    }
    // Agents that can read this mailbox get an event (stream and poll), and the webhook
    // carries the parsed message: new text without quoted history, codes and links.
    const stored = await db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, messageId)).get();
    const agentsNotified = await notifyAgentsOfInbound(deps, mb, { id: messageId, threadId: stored?.threadId ?? "", from: d.email.from, subject: d.email.subject ?? "", text: d.email.text ?? "", html: d.email.html, withheld });
    await emitEvent(deps, mb.orgId, "message.received", {
      id: messageId, mailboxId: mb.id, to: mb.address, from: d.email.from, subject: d.email.subject ?? "", folder: spam ? "spam" : "inbox", sizeBytes: d.sizeBytes,
      threadId: stored?.threadId, latestText: agentsNotified.parsed.latestText, codes: agentsNotified.parsed.codes, links: agentsNotified.parsed.links, agentIds: agentsNotified.agentIds,
    });
    const { onMailStored } = await import("../suite/hooks");
    await onMailStored(deps, {
      orgId: mb.orgId, mailboxId: mb.id, messageId, threadId: stored?.threadId ?? "", direction: "inbound", folder: spam ? "spam" : "inbox",
      from: d.email.from, to: d.email.to, cc: d.email.cc, subject: d.email.subject ?? "", date: d.email.date ?? deps.now(),
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
    // PRIV1b (P38): a hosted destination is delivered inside only when it is in the alias's own workspace, and the
    // nested route keeps that workspace as its signer. Another workspace's address goes out as a normal forward.
    const destRoute = await routeRecipient(db, dest);
    if (destRoute.kind !== "none" && destRoute.domain.orgId === alias.orgId) {
      const r = await deliverInbound(deps, { ...d, rcptTo: dest, requireOrgId: alias.orgId }, depth + 1, seen);
      result.storedIn.push(...r.storedIn);
      result.forwardedTo.push(...r.forwardedTo);
    } else {
      external.push(dest);
    }
  }
  // AIS1 (row 32): the platform's own mail is never forwarded out to an address that reaches an AI agent (another
  // workspace's agent inbox, an alias or a catch-all to one): that copy would come back in without its mark. Reads only,
  // and only for the platform's own mail.
  if (external.length && isWithheld(d.platformMail, d.email.from?.address ?? "", deps.config.systemFrom.address)) {
    const { agentAddress } = await import("../agents/agent-address");
    const keep: string[] = [];
    for (const to of external) {
      if (!(await agentAddress(db, to))) { keep.push(to); continue; }
      await logDelivery(db, { orgId: alias.orgId, direction: "outbound", fromAddress: alias.address, toAddress: to, subject, status: "rejected", provider: deps.outbound.name, detail: NOT_FORWARDED_TO_AGENT });
    }
    external.splice(0, external.length, ...keep);
  }
  // PRIV1b (P39): a forward is outbound mail from the workspace, so it passes the same gates as send.ts.
  // PRIV1b (integration S1): a failed check refuses the forward but keeps the copies already stored, so the MTA does not retry and store them twice.
  const refused = external.length ? await forwardRefusal(deps, alias.orgId, route.domain, d.email, external.length)
    .catch((err) => { deps.reportError?.(err, { where: "alias.forward_guard" }); return "Forward check failed"; }) : null;
  if (refused) {
    for (const to of external) {
      await logDelivery(db, { orgId: alias.orgId, direction: "outbound", fromAddress: alias.address, toAddress: to, subject, status: "rejected", provider: deps.outbound.name, detail: refused });
    }
    external.length = 0;
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

/** PRIV1b (P39): why an alias may not forward `count` recipients now (suspended, sending off or paused, unverified
 * domain, over the plan cap, the R34 new sender limit or the shared headroom, or spam), or null. Refusals are logged,
 * never queued: the sender's MTA gets a bounce.
 * PRIV1b (P39 trade-off): anyone who mails a forwarding alias spends the workspace's daily cap, as the manager decided
 * forwards count like sends; a refused forward bounces to the envelope sender. A separate per-alias cap would avoid
 * both and is left for later. */
async function forwardRefusal(deps: Deps, orgId: string, domain: typeof domains.$inferSelect, email: ParsedEmail, count: number): Promise<string | null> {
  const [org, plan, used] = await Promise.all([getOrg(deps.db, orgId), getPlan(deps.db, orgId), sentToday(deps.db, orgId, deps.now())]);
  if (org.suspendedAt) return "Workspace is suspended";
  if (sendingOff(org) && !org.isDemo) return "Sending is turned off for this workspace";
  const { sendingPausedForPayment } = await import("../billing/dunning"); // lazy: dunning pulls in the mail templates
  if (sendingPausedForPayment(org, deps.now())) return "Sending is paused for payment";
  if (domain.status !== "verified" && !domain.verifiedAt) return `${domain.name} is not verified`; // the routeRecipient rule (integration M1)
  // PRIV1b (P39): the same R34 guard as send.ts (plan cap, new sender limit, shared headroom), refused instead of queued.
  const cfg = guardConfig(deps);
  const ext = org.isDemo ? 0 : count; // a demo workspace only has the plan cap, as in send.ts
  const ageDays = (deps.now().getTime() - new Date(org.createdAt).getTime()) / 86_400_000;
  const recent = ext ? await recentOutboundStats(deps, orgId) : null;
  const verdict = decide({
    cfg, used, cap: org.sendCapDaily ?? plan.limits.dailySends, recipients: count, external: ext,
    underReview: org.sendCapDaily !== null && org.sendCapDaily < plan.limits.dailySends,
    externalUsed: ext ? await externalSentToday(deps, orgId) : 0,
    newCap: recent ? newSenderCap(cfg, ageDays, recent) : null,
    providerUsed: ext && cfg.providerDailyCap > 0 ? await providerSentToday(deps) : 0,
  });
  if (!verdict.ok) return verdict.reason.replace(/ Queued until tomorrow.*$/, "");
  if (recent) {
    const spam = scoreOutbound({ subject: email.subject ?? "", text: email.text ?? "", html: email.html, recipients: count, workspaceAgeDays: ageDays, recent });
    if (spam.score >= SPAM_HOLD_AT) {
      // PRIV1b (P39, review M1): an outsider wrote this message, so it is logged under its own kind and never counts
      // toward the workspace's auto-suspension (abuse.ts maybeAutoSuspend counts "outbound_held" only).
      await recordAbuse(deps, orgId, "forward_held", spam.score, spam.reasons.join("; "));
      return "Held by the spam filter";
    }
  }
  return null;
}

/** Recipients sent today (UTC) by an org. This is what the plan's daily limit counts. */
export async function sentToday(db: DB, orgId: string, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const row = await db.select({ n: sql<number>`count(*)` }).from(deliveries).where(and(
    eq(deliveries.orgId, orgId),
    eq(deliveries.direction, "outbound"),
    inArray(deliveries.status, ["sent", "queued", "delivered", "forwarded"]), // PRIV1b (P39): alias forwards count too
    gte(deliveries.createdAt, start),
  )).get();
  return Number(row?.n ?? 0);
}

export { logDelivery };
