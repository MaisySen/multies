import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../../context";
import { inboundKeys } from "../../db/schema";
import { decryptSecret, encryptSecret, hmacSha256Hex, newId, randomToken, safeEqual, sha256HexBytes } from "../../lib/crypto";
import { notFound } from "../../lib/errors";
import { deferrableWrite } from "../write-priority";

export const SIGNATURE_TOLERANCE_S = 300;

/** The exact string both sides sign. Keep in sync with email-worker/src/index.ts. */
export async function signingPayload(ts: string, from: string, to: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  return `${ts}\n${from.toLowerCase()}\n${to.toLowerCase()}\n${await sha256HexBytes(body)}`;
}

export async function createInboundKey(deps: Deps, orgId: string) {
  const id = newId("ink");
  const secret = `whsec_${randomToken(32)}`;
  await deps.db.insert(inboundKeys).values({ id, orgId, secretEnc: await encryptSecret(deps.config.appSecret, secret) });
  return { id, secret };
}

export async function listInboundKeys(deps: Deps, orgId: string) {
  return deps.db.select({ id: inboundKeys.id, createdAt: inboundKeys.createdAt, lastUsedAt: inboundKeys.lastUsedAt })
    .from(inboundKeys).where(eq(inboundKeys.orgId, orgId)).orderBy(desc(inboundKeys.createdAt));
}

export async function deleteInboundKey(deps: Deps, orgId: string, id: string) {
  const row = await deps.db.select().from(inboundKeys).where(and(eq(inboundKeys.id, id), eq(inboundKeys.orgId, orgId))).get();
  if (!row) throw notFound("Inbound key");
  await deps.db.delete(inboundKeys).where(eq(inboundKeys.id, id));
}

export type VerifyResult = { ok: true; orgId: string; keyId: string } | { ok: false; reason: string };

/** Verifies a signed delivery from the Email Worker. */
export async function verifyInboundSignature(
  deps: Deps,
  h: { keyId?: string; ts?: string; signature?: string; from?: string; to?: string },
  body: Uint8Array<ArrayBuffer>,
): Promise<VerifyResult> {
  if (!h.keyId || !h.ts || !h.signature || !h.from || !h.to) return { ok: false, reason: "Missing signature headers." };
  const age = Math.abs(deps.now().getTime() / 1000 - Number(h.ts));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_S) return { ok: false, reason: "Signature timestamp outside the allowed window." };
  const key = await deps.db.select().from(inboundKeys).where(eq(inboundKeys.id, h.keyId)).get();
  if (!key) return { ok: false, reason: "Unknown key." };
  const secret = await decryptSecret(deps.config.appSecret, key.secretEnc);
  const expected = await hmacSha256Hex(secret, await signingPayload(h.ts, h.from, h.to, body));
  if (!safeEqual(expected, h.signature.toLowerCase())) return { ok: false, reason: "Bad signature." };
  // Last used is shown to the nearest few minutes; one write per message was a write per inbound mail.
  if (!key.lastUsedAt || deps.now().getTime() - key.lastUsedAt.getTime() > 15 * 60_000) {
    await deferrableWrite(deps, "last_used", `inbound:${key.id}`, () => deps.db.update(inboundKeys).set({ lastUsedAt: deps.now() }).where(eq(inboundKeys.id, key.id))); // R32: deferrable
  }
  return { ok: true, orgId: key.orgId, keyId: key.id };
}
