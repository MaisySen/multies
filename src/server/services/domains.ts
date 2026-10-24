import { emitEvent } from "./developer/webhooks";
import { and, asc, count, eq, lt, ne, or, isNull } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { aliases, domains, mailboxes, organizations } from "../db/schema";
import { encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { conflict, notFound } from "../lib/errors";
import { expectedRecords, runDnsChecks } from "./dns/checks";
import { assertCanCreate } from "./plans";
import type { DnsCheckReport } from "@/shared/dns";

type DomainRow = typeof domains.$inferSelect;

export function presentDomain(d: DomainRow, deps: Deps, counts?: { mailboxes: number; aliases: number }) {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    createdAt: d.createdAt,
    verifiedAt: d.verifiedAt,
    lastCheckedAt: d.lastCheckedAt,
    dkimSelector: d.dkimSelector,
    catchAllMailboxId: d.catchAllMailboxId,
    records: expectedRecords(d, deps.config),
    lastCheck: d.lastCheck ? (JSON.parse(d.lastCheck) as DnsCheckReport) : null,
    counts: counts ?? null,
  };
}

export async function listDomains(db: DB, orgId: string) {
  // Independent reads run together: on D1 each one is a network round trip.
  const [rows, mbx, als] = await Promise.all([
    db.select().from(domains).where(eq(domains.orgId, orgId)).orderBy(asc(domains.createdAt)),
    db.select({ domainId: mailboxes.domainId, n: count() }).from(mailboxes).where(eq(mailboxes.orgId, orgId)).groupBy(mailboxes.domainId),
    db.select({ domainId: aliases.domainId, n: count() }).from(aliases).where(eq(aliases.orgId, orgId)).groupBy(aliases.domainId),
  ]);
  const m = new Map(mbx.map((r) => [r.domainId, r.n]));
  const a = new Map(als.map((r) => [r.domainId, r.n]));
  return rows.map((d) => ({ row: d, counts: { mailboxes: m.get(d.id) ?? 0, aliases: a.get(d.id) ?? 0 } }));
}

export async function getDomain(db: DB, orgId: string, id: string) {
  const d = await db.select().from(domains).where(and(eq(domains.id, id), eq(domains.orgId, orgId))).get();
  if (!d) throw notFound("Domain");
  return d;
}

/** `dkimKey` reuses an existing key pair (sandbox domains share one, skipping RSA key generation). */
export async function createDomain(deps: Deps, orgId: string, name: string, opts: { dkimKey?: { publicKeyB64: string; privateKeyPem: string } } = {}) {
  const { db, config } = deps;
  await assertCanCreate(db, orgId, "domains");
  const existing = await db.select().from(domains).where(eq(domains.name, name)).get();
  if (existing) {
    throw conflict(existing.orgId === orgId
      ? `${name} is already in this workspace.`
      : `${name} is connected to another workspace. If you own it, contact support to claim it.`);
  }
  const { publicKeyB64, privateKeyPem } = opts.dkimKey ?? await generateDkimKeyPair();
  const row: typeof domains.$inferInsert = {
    id: newId("dom"),
    orgId,
    name,
    verificationToken: randomToken(18),
    dkimSelector: config.mail.dkimSelector,
    dkimPublicKey: publicKeyB64,
    dkimPrivateKeyEnc: await encryptSecret(config.appSecret, privateKeyPem),
  };
  await db.insert(domains).values(row);
  return getDomain(db, orgId, row.id);
}

/** Runs a live DNS check and persists the outcome. Returns the report and whether status changed. */
export async function verifyDomain(deps: Deps, d: DomainRow) {
  const now = deps.now();
  const report = await runDnsChecks(deps.dns, d, deps.config, now);
  const hadLookupErrors = report.records.some((r) => r.status === "error");
  let status: DomainRow["status"] = d.status;
  if (report.verified) status = "verified";
  else if (!hadLookupErrors) status = d.status === "verified" ? "failed" : "pending";
  const verifiedAt = status === "verified" ? d.verifiedAt ?? now : d.verifiedAt;
  await deps.db.update(domains)
    .set({ lastCheck: JSON.stringify(report), lastCheckedAt: now, status, verifiedAt })
    .where(eq(domains.id, d.id));
  const changed = status !== d.status;
  if (changed && (status === "verified" || status === "failed")) {
    await emitEvent(deps, d.orgId, status === "verified" ? "domain.verified" : "domain.failed", { id: d.id, name: d.name, status });
  }
  return { report, status, changed };
}

/**
 * Re-checks domains on a schedule: ones still waiting for DNS every `staleMs`, verified ones once a day.
 * Sample workspaces are skipped: their domains are made up, and checking them only spent database writes
 * (each check writes the domain row).
 */
export async function recheckStaleDomains(deps: Deps, staleMs = 60 * 60_000, limit = 25) {
  const t = deps.now().getTime();
  const cutoff = new Date(t - staleMs);
  const verifiedCutoff = new Date(t - 24 * 3600_000);
  const rows = (await deps.db.select({ d: domains }).from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.orgId))
    .where(and(
      eq(organizations.isDemo, false),
      or(
        isNull(domains.lastCheckedAt),
        and(ne(domains.status, "verified"), lt(domains.lastCheckedAt, cutoff)),
        lt(domains.lastCheckedAt, verifiedCutoff),
      ),
    ))
    .orderBy(asc(domains.lastCheckedAt)).limit(limit)).map((r) => r.d);
  // A few at a time: each check is several DNS lookups and one update, and in a row they
  // were a long chain of round trips (Sentry MYMAIL-API-5).
  const results: ({ id: string } & Awaited<ReturnType<typeof verifyDomain>>)[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    results.push(...(await Promise.all(rows.slice(i, i + 5).map(async (d) => ({ id: d.id, ...(await verifyDomain(deps, d)) })))));
  }
  return results;
}

export async function deleteDomain(db: DB, orgId: string, id: string) {
  const d = await getDomain(db, orgId, id);
  await db.delete(domains).where(eq(domains.id, d.id));
  return d;
}

export async function setCatchAll(db: DB, orgId: string, id: string, mailboxId: string | null) {
  const d = await getDomain(db, orgId, id);
  if (mailboxId) {
    const mb = await db.select().from(mailboxes).where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.domainId, d.id))).get();
    if (!mb) throw notFound("Mailbox on this domain");
  }
  await db.update(domains).set({ catchAllMailboxId: mailboxId }).where(eq(domains.id, d.id));
  return getDomain(db, orgId, id);
}
