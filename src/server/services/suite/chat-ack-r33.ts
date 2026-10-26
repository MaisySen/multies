/**
 * Round 33: chat sends carry a client id, and the server answers with an ack that names it.
 *
 * The browser makes a client id for every message it sends: the send time in base 36 (9
 * characters, the same clock layout as sortableId) and at least 8 random characters. The
 * message id is worked out from it (the time, then a hash of workspace, author and client id),
 * so the same send made twice (a retry after a dropped connection) lands on the same row and
 * the second one returns the first message instead of writing again. No column or table is
 * needed for this, and the id still sorts by time like every other message id.
 *
 * A client id whose time is more than a day away from the server clock (a badly set device
 * clock) is not trusted for the id: that send gets an ordinary id and no dedupe.
 */
const CLIENT_ID_RE = /^[0-9a-z]{9}[0-9a-z]{8,40}$/;
export const CLIENT_ID_SKEW_MS = 24 * 60 * 60_000;

export function isClientMsgId(v: unknown): v is string {
  return typeof v === "string" && CLIENT_ID_RE.test(v);
}

/** 64 bit FNV-1a of the text, as 13 base 36 characters (sync and the same on Node and Workers). */
export function hash36(text: string) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(36).padStart(13, "0");
}

/** The message id for a client id, or null when the client id cannot be used (bad shape or clock). */
export function messageIdForClient(orgId: string, authorKey: string, clientMsgId: string | undefined | null, now: number): string | null {
  if (!isClientMsgId(clientMsgId)) return null;
  const time = clientMsgId.slice(0, 9);
  const at = parseInt(time, 36);
  if (!Number.isFinite(at) || Math.abs(at - now) > CLIENT_ID_SKEW_MS) return null;
  return `chm_${time}${hash36(`${orgId}|${authorKey}|${clientMsgId}`).slice(0, 10)}`;
}

/** What the send answers (and what a socket would carry): the client id it acknowledges and the server's id and time. */
export type ChatAck =
  | { type: "ack"; reply_to: string; ok: true; message: { id: string; ts: string }; deduped: boolean }
  | { type: "ack"; reply_to: string; ok: false; error: { code: string; message: string } };

export function ackFor(clientMsgId: string, message: { id: string; createdAt: string | Date }, deduped: boolean): ChatAck {
  const ts = typeof message.createdAt === "string" ? message.createdAt : message.createdAt.toISOString();
  return { type: "ack", reply_to: clientMsgId, ok: true, message: { id: message.id, ts }, deduped };
}
