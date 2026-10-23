import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../../db";
import { suppressions } from "../../db/schema";
import { newId } from "../../lib/crypto";
import { notFound } from "../../lib/errors";

export type SuppressionReason = (typeof suppressions.$inferSelect)["reason"];

export async function listSuppressions(db: DB, orgId: string, limit = 500) {
  return db.select().from(suppressions).where(eq(suppressions.orgId, orgId)).orderBy(desc(suppressions.createdAt)).limit(limit);
}

/** Adds an address (idempotent). A complaint or hard bounce replaces a manual entry's reason. */
export async function suppress(db: DB, orgId: string, address: string, reason: SuppressionReason, detail?: string) {
  const a = address.trim().toLowerCase();
  const existing = await db.select().from(suppressions).where(and(eq(suppressions.orgId, orgId), eq(suppressions.address, a))).get();
  if (existing) {
    if (existing.reason === "manual" && reason !== "manual") await db.update(suppressions).set({ reason, detail: detail ?? null }).where(eq(suppressions.id, existing.id));
    return existing.id;
  }
  const id = newId("sup");
  await db.insert(suppressions).values({ id, orgId, address: a, reason, detail: detail ?? null }).onConflictDoNothing();
  return id;
}

export async function unsuppress(db: DB, orgId: string, id: string) {
  const row = await db.select().from(suppressions).where(and(eq(suppressions.id, id), eq(suppressions.orgId, orgId))).get();
  if (!row) throw notFound("Suppressed address");
  await db.delete(suppressions).where(eq(suppressions.id, row.id));
  return row;
}

/** The subset of `addresses` that is suppressed, keyed by address. */
export async function suppressedAmong(db: DB, orgId: string, addresses: string[]) {
  if (!addresses.length) return new Map<string, SuppressionReason>();
  const rows = await db.select({ address: suppressions.address, reason: suppressions.reason }).from(suppressions)
    .where(and(eq(suppressions.orgId, orgId), inArray(suppressions.address, addresses.map((a) => a.toLowerCase()))));
  return new Map(rows.map((r) => [r.address, r.reason]));
}
