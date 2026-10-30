/**
 * C1: Meta webhooks. Verification handshake (GET hub.mode/hub.verify_token/hub.challenge), the
 * X-Hub-Signature-256 check (HMAC SHA-256 of the raw body with the app secret), and a parser from Meta's
 * documented payloads to WebhookBatch. Pure and small: the route answers 200 straight after the signature
 * check and hands the batches to ingest.ts in the background.
 *
 * Shapes: WhatsApp Cloud API "messages" field
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 * Messenger Platform and Instagram messaging webhooks (entry[].messaging[])
 *   https://developers.facebook.com/docs/messenger-platform/webhooks
 */
import { hmacSha256Hex, safeEqual } from "../../lib/crypto";
import type { ChatMessageKind } from "@/shared/channels";
import type { InboundMessage, StatusUpdate, WebhookBatch } from "./provider";

/** The secret the local test provider signs with (CHANNELS_MOCK only; never accepted in production). */
export const MOCK_APP_SECRET = "local-test-channel-secret";

export function verifyChallenge(q: { mode?: string; token?: string; challenge?: string }, verifyToken: string | undefined): string | null {
  if (q.mode !== "subscribe" || !verifyToken || !q.token || !q.challenge) return null;
  if (!safeEqual(q.token, verifyToken)) return null;
  // Meta sends a number; answer it back as plain text and nothing else.
  return /^[A-Za-z0-9_-]{1,128}$/.test(q.challenge) ? q.challenge : null;
}

/** True when `header` (sha256=<hex>) is the HMAC of `rawBody` under one of `secrets`. */
export async function verifySignature(rawBody: string, header: string | undefined, secrets: string[]): Promise<boolean> {
  if (!header || !header.startsWith("sha256=")) return false;
  const got = header.slice(7).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(got)) return false;
  for (const s of secrets) {
    if (s && safeEqual(await hmacSha256Hex(s, rawBody), got)) return true;
  }
  return false;
}

const str = (v: unknown, max = 4096): string => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** Meta timestamps are unix seconds as strings (WhatsApp) or milliseconds as numbers (Messenger). */
function when(v: unknown, fallback: Date): Date {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n < 1e12 ? n * 1000 : n);
}

const WA_MEDIA: ChatMessageKind[] = ["image", "video", "audio", "document", "sticker"];
const MAX_TEXT = 8000;

function waMessage(m: Record<string, unknown>, names: Map<string, string>, now: Date): InboundMessage | null {
  const id = str(m.id, 256), from = str(m.from, 64);
  if (!id || !from) return null;
  const type = str(m.type, 32);
  const base = { externalId: id, from, contactName: names.get(from) ?? null, date: when(m.timestamp, now), media: null as InboundMessage["media"] };
  if (type === "text") return { ...base, kind: "text", text: str(obj(m.text).body, MAX_TEXT) };
  if ((WA_MEDIA as string[]).includes(type)) {
    const md = obj(m[type]);
    return {
      ...base, kind: type as ChatMessageKind, text: str(md.caption, MAX_TEXT),
      media: { id: str(md.id, 128) || undefined, mimeType: str(md.mime_type, 128) || undefined, filename: str(md.filename, 255) || undefined, sha256: str(md.sha256, 128) || undefined },
    };
  }
  if (type === "location") {
    const l = obj(m.location);
    const label = [str(l.name, 200), str(l.address, 300)].filter(Boolean).join(", ");
    return { ...base, kind: "location", text: `${label ? `${label} ` : ""}(${str(l.latitude, 32)}, ${str(l.longitude, 32)})`.trim() };
  }
  if (type === "contacts") {
    const names2 = arr(m.contacts).map((c) => str(obj(obj(c).name).formatted_name, 200)).filter(Boolean);
    return { ...base, kind: "contacts", text: names2.length ? `Shared contact: ${names2.join(", ")}` : "Shared a contact" };
  }
  if (type === "reaction") {
    const r = obj(m.reaction);
    return { ...base, kind: "reaction", text: str(r.emoji, 32) };
  }
  if (type === "button") return { ...base, kind: "text", text: str(obj(m.button).text, MAX_TEXT) };
  if (type === "interactive") {
    const i = obj(m.interactive);
    return { ...base, kind: "text", text: str(obj(i.button_reply).title, 500) || str(obj(i.list_reply).title, 500) };
  }
  return { ...base, kind: "unsupported", text: "" };
}

function waStatus(s: Record<string, unknown>, now: Date): StatusUpdate | null {
  const id = str(s.id, 256), st = str(s.status, 16);
  if (!id || !["sent", "delivered", "read", "failed"].includes(st)) return null;
  const e = obj(arr(s.errors)[0]);
  const detail = str(obj(e.error_data).details, 300) || str(e.message, 300) || str(e.title, 300);
  return { externalId: id, delivery: st as StatusUpdate["delivery"], date: when(s.timestamp, now), error: st === "failed" ? (detail || "WhatsApp could not deliver this message.") : null };
}

function messagingEvent(e: Record<string, unknown>, now: Date): InboundMessage | null {
  const msg = obj(e.message);
  const from = str(obj(e.sender).id, 64), id = str(msg.mid, 256);
  if (!from || !id || msg.is_echo === true) return null;
  const att = obj(arr(msg.attachments)[0]);
  const t = str(att.type, 32);
  const kind: ChatMessageKind = t === "image" || t === "video" || t === "audio" ? t : t === "file" ? "document" : t ? "unsupported" : "text";
  const url = str(obj(att.payload).url, 2048);
  return { externalId: id, from, contactName: null, date: when(e.timestamp, now), kind, text: str(msg.text, MAX_TEXT), media: url ? { url } : null };
}

/** Meta's payload as batches per business endpoint. Unknown objects and fields give an empty list (never a throw). */
export function parseWebhook(body: unknown, now: Date = new Date()): WebhookBatch[] {
  const root = obj(body);
  const object = str(root.object, 64);
  const out: WebhookBatch[] = [];
  for (const entryRaw of arr(root.entry).slice(0, 100)) {
    const entry = obj(entryRaw);
    if (object === "whatsapp_business_account") {
      for (const chRaw of arr(entry.changes).slice(0, 100)) {
        const ch = obj(chRaw);
        if (ch.field !== "messages") continue;
        const v = obj(ch.value);
        const endpointId = str(obj(v.metadata).phone_number_id, 64);
        if (!endpointId) continue;
        const names = new Map<string, string>();
        for (const c of arr(v.contacts)) { const co = obj(c); const wa = str(co.wa_id, 64); const n = str(obj(co.profile).name, 200); if (wa && n) names.set(wa, n); }
        const messages = arr(v.messages).slice(0, 100).map((m) => waMessage(obj(m), names, now)).filter((m): m is InboundMessage => !!m);
        const statuses = arr(v.statuses).slice(0, 100).map((s) => waStatus(obj(s), now)).filter((s): s is StatusUpdate => !!s);
        if (messages.length || statuses.length) out.push({ family: "whatsapp", endpointId, messages, statuses });
      }
    } else if (object === "page" || object === "instagram") {
      const endpointId = str(entry.id, 64);
      if (!endpointId) continue;
      const events = arr(entry.messaging).slice(0, 100).map(obj);
      const messages = events.map((e) => messagingEvent(e, now)).filter((m): m is InboundMessage => !!m);
      const statuses: StatusUpdate[] = [];
      for (const e of events) {
        const read = obj(e.read), delivery = obj(e.delivery);
        for (const mid of arr(delivery.mids)) if (str(mid)) statuses.push({ externalId: str(mid, 256), delivery: "delivered", date: when(e.timestamp, now), error: null });
        if (str(read.mid)) statuses.push({ externalId: str(read.mid, 256), delivery: "read", date: when(e.timestamp, now), error: null });
      }
      if (messages.length || statuses.length) out.push({ family: object === "page" ? "messenger" : "instagram", endpointId, messages, statuses });
    }
  }
  return out;
}
