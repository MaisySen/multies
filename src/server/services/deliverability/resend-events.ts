/**
 * Delivery events from Resend (delivered, bounced, complained, delayed). Resend signs
 * its webhooks with Svix, which follows the Standard Webhooks spec, so the same
 * standardwebhooks library verifies them.
 */
import { and, eq } from "drizzle-orm";
import { Webhook } from "standardwebhooks";
import type { Deps } from "../../context";
import { deliveries } from "../../db/schema";
import { HttpError } from "../../lib/errors";
import { emitEvent } from "../developer/webhooks";
import { suppress } from "./suppressions";
import { fetchReceivedEmail } from "../mail/provider-domains";
import { parseMime } from "../mail/mime";
import { deliverInbound } from "../mail/delivery";

interface ResendEvent {
  type: string;
  created_at?: string;
  data: {
    email_id?: string;
    to?: string[] | string;
    from?: string;
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    failed?: { reason?: string };
  };
}

export function verifyResendWebhook(secret: string, body: string, headers: Headers): ResendEvent {
  const h = (n: string) => headers.get(`webhook-${n}`) ?? headers.get(`svix-${n}`) ?? "";
  try {
    return new Webhook(secret).verify(body, { "webhook-id": h("id"), "webhook-timestamp": h("timestamp"), "webhook-signature": h("signature") }) as ResendEvent;
  } catch {
    throw new HttpError(401, "bad_signature", "Webhook signature did not verify.");
  }
}

const STATUS: Record<string, "delivered" | "bounced" | "complained" | "delayed" | "failed" | "suppressed" | undefined> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.delivery_delayed": "delayed",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
};

/** A bounce is permanent unless the provider says it is transient. */
const isHardBounce = (b: ResendEvent["data"]["bounce"]) => !b?.type || /permanent|hard/i.test(b.type);

/**
 * Mail that arrived through the provider's receiving MX (a customer domain whose DNS is not on
 * Cloudflare). The webhook carries metadata only, so the raw message is fetched and delivered
 * exactly like mail from the Cloudflare Email Worker.
 */
async function receiveFromProvider(deps: Deps, emailId: string) {
  const got = await fetchReceivedEmail(deps, emailId);
  if (!got) return { handled: false as const };
  if (got.raw.byteLength > deps.config.maxMessageBytes) return { handled: true as const, received: 0, rejected: got.recipients.length };
  const email = await parseMime(got.raw);
  let received = 0;
  for (const rcptTo of got.recipients) {
    const r = await deliverInbound(deps, { envelopeFrom: got.from, rcptTo, email, sizeBytes: got.raw.byteLength, via: "resend", raw: got.raw });
    if (r.accepted) received++;
  }
  return { handled: true as const, received, rejected: got.recipients.length - received };
}

export async function handleResendEvent(deps: Deps, event: ResendEvent) {
  if (event.type === "email.received" && event.data.email_id) return receiveFromProvider(deps, event.data.email_id);
  const status = STATUS[event.type];
  const emailId = event.data.email_id;
  if (!status || !emailId) return { handled: false as const };
  const recipients = (Array.isArray(event.data.to) ? event.data.to : event.data.to ? [event.data.to] : []).map((a) => a.toLowerCase());
  const rows = await deps.db.select().from(deliveries).where(and(eq(deliveries.providerMessageId, emailId), eq(deliveries.direction, "outbound")));
  const targets = rows.filter((r) => !recipients.length || recipients.includes(r.toAddress.toLowerCase()));
  const detail = event.data.bounce?.message ?? event.data.failed?.reason ?? (status === "complained" ? "The recipient marked this as spam." : null);
  for (const r of targets) {
    // Delivered never overwrites a worse outcome that arrived first.
    if (status === "delivered" && (r.status === "bounced" || r.status === "complained")) continue;
    await deps.db.update(deliveries).set({ status, detail: detail ?? r.detail }).where(eq(deliveries.id, r.id));
    if (status === "complained") {
      await suppress(deps.db, r.orgId, r.toAddress, "complaint", detail ?? undefined);
    } else if (status === "bounced" && isHardBounce(event.data.bounce)) {
      await suppress(deps.db, r.orgId, r.toAddress, "hard_bounce", detail ?? undefined);
    }
    if (status === "bounced" || status === "complained") {
      await emitEvent(deps, r.orgId, status === "bounced" ? "message.bounced" : "message.complained", {
        id: r.messageId, to: r.toAddress, from: r.fromAddress, subject: r.subject, detail, bounceType: event.data.bounce?.type ?? null,
      });
    }
  }
  return { handled: true as const, updated: targets.length };
}
