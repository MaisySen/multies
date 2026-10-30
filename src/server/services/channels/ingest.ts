/**
 * C1: what a verified webhook delivery does to the database. Runs after the route has answered Meta 200.
 *
 * D1 cost per inbound message (measured in tests/channels-ingest.test.ts): one read to skip a duplicate (Meta
 * resends for up to 7 days), one upsert of the workspace's daily counter, one conversation upsert and one
 * message insert. Statuses (sent, delivered, read, failed) are one guarded UPDATE each, never a downgrade.
 * Files are fetched straight away (Meta's links expire within minutes) and stored like mail attachments:
 * inline up to MEDIA_INLINE_MAX, the body store above it when one is configured, otherwise kept as a name only.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Deps } from "../../context";
import { msgChannels, msgConversations, msgMessages, usageCounters } from "../../db/schema";
import { newId, toB64 } from "../../lib/crypto";
import type { InboundMessage, StatusUpdate, WebhookBatch } from "./provider";
import { adapterFor, credentialsOf, type ChannelRow } from "./registry";

/** Files at or under this size stay on the message row (base64). Larger ones need the body store. */
export const MEDIA_INLINE_MAX = 512 * 1024;
export const INBOUND_METRIC = "chat_in";

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

const SNIPPET: Record<string, string> = { image: "Photo", video: "Video", audio: "Voice message", document: "File", sticker: "Sticker", location: "Location", contacts: "Contact", reaction: "Reaction", unsupported: "Message" };
export const snippetOf = (kind: string, text: string) => (text.trim() ? text.replace(/\s+/g, " ").trim().slice(0, 160) : (SNIPPET[kind] ?? "Message"));

const RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4, received: 0 };

export interface IngestResult { stored: number; duplicates: number; statuses: number; unknownEndpoint: number; overCap: boolean }

export async function ingestBatches(deps: Deps, batches: WebhookBatch[]): Promise<IngestResult> {
  const res: IngestResult = { stored: 0, duplicates: 0, statuses: 0, unknownEndpoint: 0, overCap: false };
  if (!batches.length) return res;
  const endpointIds = [...new Set(batches.map((b) => b.endpointId))].slice(0, 50);
  const rows = await deps.db.select().from(msgChannels).where(and(inArray(msgChannels.externalId, endpointIds), eq(msgChannels.status, "active")));
  for (const b of batches) {
    const ch = rows.find((r) => r.externalId === b.endpointId && (r.provider === b.family || (b.family === "whatsapp" && r.provider === "mock")));
    if (!ch) { res.unknownEndpoint++; continue; }
    for (const m of b.messages) {
      const r = await ingestMessage(deps, ch, m);
      if (r === "duplicate") res.duplicates++; else { res.stored++; if (r === "over") res.overCap = true; }
    }
    for (const s of b.statuses) res.statuses += await applyStatus(deps, ch.id, s);
  }
  return res;
}

/** Counts one inbound message against the workspace's day; answers the new count (one upsert). */
async function countInbound(deps: Deps, orgId: string, now: Date): Promise<number> {
  const r = await deps.db.insert(usageCounters).values({ orgId, period: utcDay(now), metric: INBOUND_METRIC, count: 1 })
    .onConflictDoUpdate({ target: [usageCounters.orgId, usageCounters.period, usageCounters.metric], set: { count: sql`${usageCounters.count} + 1` } })
    .returning({ count: usageCounters.count }).get();
  return r?.count ?? 1;
}

async function ingestMessage(deps: Deps, ch: ChannelRow, m: InboundMessage): Promise<"stored" | "duplicate" | "over"> {
  // Read, not a write: Meta's retries of a delivery we already stored cost nothing more.
  const dup = await deps.db.select({ id: msgMessages.id }).from(msgMessages).where(and(eq(msgMessages.channelId, ch.id), eq(msgMessages.externalId, m.externalId))).get();
  if (dup) return "duplicate";
  const now = deps.now();
  const count = await countInbound(deps, ch.orgId, now);
  const over = count > deps.config.channels.dailySoftCap;

  // Over the soft cap the text still lands (nothing is lost) but files are no longer copied.
  let media: { name: string; type: string; size: number; b64: string | null; key: string | null } | null = null;
  if (m.media) {
    const name = (m.media.filename || `${m.kind}${extFor(m.media.mimeType)}`).slice(0, 255);
    media = { name, type: (m.media.mimeType ?? "application/octet-stream").slice(0, 128), size: 0, b64: null, key: null };
    if (!over) {
      try {
        const file = await adapterFor(deps, ch.provider).fetchMedia(await credentialsOf(deps, ch), m.media);
        if (file) {
          media.type = file.contentType.slice(0, 128);
          media.size = file.bytes.byteLength;
          if (file.bytes.byteLength <= MEDIA_INLINE_MAX) media.b64 = toB64(file.bytes);
          else if (deps.bodyStore) {
            media.key = `chat-media/${ch.orgId}/${newId("cm")}`;
            await deps.bodyStore.put(media.key, file.bytes, file.contentType);
          }
        }
      } catch (err) {
        deps.log?.warn?.("channels.media_fetch_failed", { channelId: ch.id, error: String((err as Error).message ?? err) });
      }
    }
  }

  const date = m.date.getTime() > now.getTime() + 300_000 ? now : m.date;
  const snippet = snippetOf(m.kind, m.text);
  const name = (m.contactName ?? "").slice(0, 200);
  const conv = await deps.db.insert(msgConversations).values({
    id: newId("cv"), orgId: ch.orgId, channelId: ch.id, contactExternalId: m.from, contactName: name || m.from,
    snippet, lastMessageAt: date, lastInboundAt: date, unreadCount: 1, status: "open", createdAt: now,
  }).onConflictDoUpdate({
    target: [msgConversations.channelId, msgConversations.contactExternalId],
    set: {
      snippet: sql`CASE WHEN ${msgConversations.lastMessageAt} <= ${date.getTime()} THEN ${snippet} ELSE ${msgConversations.snippet} END`,
      lastMessageAt: sql`MAX(${msgConversations.lastMessageAt}, ${date.getTime()})`,
      lastInboundAt: sql`MAX(COALESCE(${msgConversations.lastInboundAt}, 0), ${date.getTime()})`,
      unreadCount: sql`${msgConversations.unreadCount} + 1`,
      // A customer writing again reopens a done conversation.
      status: sql`CASE WHEN ${msgConversations.status} = 'done' THEN 'open' ELSE ${msgConversations.status} END`,
      ...(name ? { contactName: name } : {}),
    },
  }).returning({ id: msgConversations.id }).get();

  await deps.db.insert(msgMessages).values({
    id: newId("cm"), orgId: ch.orgId, channelId: ch.id, conversationId: conv!.id, direction: "in", externalId: m.externalId,
    kind: m.kind, text: m.text, delivery: "received", date, createdAt: now,
    mediaName: media?.name ?? null, mediaType: media?.type ?? null, mediaSize: media?.size || null, mediaB64: media?.b64 ?? null, mediaKey: media?.key ?? null,
  }).onConflictDoNothing();
  return over ? "over" : "stored";
}

async function applyStatus(deps: Deps, channelId: string, s: StatusUpdate): Promise<number> {
  const rank = RANK[s.delivery];
  const r = await deps.db.update(msgMessages).set({ delivery: s.delivery, error: s.error })
    .where(and(eq(msgMessages.channelId, channelId), eq(msgMessages.externalId, s.externalId), eq(msgMessages.direction, "out"),
      // Never downgrade (Meta can deliver "delivered" after "read"); a failure always lands.
      s.delivery === "failed" ? undefined : sql`(CASE ${msgMessages.delivery} WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 9 END) < ${rank}`))
    .run();
  return Number((r as { changes?: number; meta?: { changes?: number } }).changes ?? (r as { meta?: { changes?: number } }).meta?.changes ?? 0);
}

function extFor(mime?: string) {
  if (!mime) return "";
  const m: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "application/pdf": ".pdf" };
  return m[mime.split(";")[0].trim()] ?? "";
}
