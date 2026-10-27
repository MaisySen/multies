import { emitEvent } from "./developer/webhooks";
import { and, asc, count, eq, like, lt, ne, or, isNull } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { aliases, domains, mailboxes, organizations } from "../db/schema";
import { encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { conflict, notFound } from "../lib/errors";
import { assertDomainAllowed, isOperatorDomainRow } from "./suite/operator-inbox";
import { expectedRecords, runDnsChecks } from "./dns/checks";
import { assertCanCreate } from "./plans";
import { QUEUED_PREFIX, refreshProviderDomain, registerProviderDomain, removeProviderDomain } from "./mail/provider-domains";
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
    // Outbound and provider-MX inbound for this domain: null when it was never registered with the provider.
    sending: d.providerStatus ? sendingState(d.providerStatus) : null,
  };
}

/**
 * The domain's sending state for the app. "queued" means the provider had no free domain slot:
 * the domain is kept and still receives mail, mail between Multies addresses works, and it is
 * registered by itself when a slot frees up. Mail is never sent under another domain's name.
 */
export function sendingState(providerStatus: string) {
  if (providerStatus.startsWith(QUEUED_PREFIX)) {
    return {
      status: "queued" as const,
      detail: "Waiting for a sending slot with our email service. Your domain is saved and receives mail, and mail inside Multies works. Sending to outside addresses starts by itself when a slot frees up, usually without anything to do on your side.",
    };
  }
  return {
    status: providerStatus.startsWith("error:") ? "error" as const : providerStatus === "verified" ? "verified" as const : "pending" as const,
    detail: providerStatus.startsWith("error:") ? providerStatus.slice(6).trim() : null,
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
  // R26 (DF-18): the company domain in the operator workspace is the deployment's own and is not a plan add-on.
  const operatorDomain = isOperatorDomainRow(config, { orgId, name });
  assertDomainAllowed(config, orgId, name);
  if (!operatorDomain) await assertCanCreate(db, orgId, "domains");
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
  // R26: the company domain in the operator workspace is the deployment's own: verified, no provider registration.
  if (operatorDomain) Object.assign(row, { status: "verified", verifiedAt: deps.now(), lastCheckedAt: deps.now(), providerStatus: "verified" });
  await db.insert(domains).values(row);
  // Customer domains are registered with the outbound provider straight away, so the setup page
  // shows the provider's DKIM, return path and receiving MX. Sample and platform domains are not.
  if (!opts.dkimKey && orgId !== "org_platform" && !operatorDomain) {
    const p = await registerProviderDomain(deps, name);
    if (p) await db.update(domains).set(p).where(eq(domains.id, row.id!));
  }
  return getDomain(db, orgId, row.id);
}

/** Runs a live DNS check and persists the outcome. Returns the report and whether status changed. */
export async function verifyDomain(deps: Deps, d: DomainRow) {
  const now = deps.now();
  // R26: the operator's company domain is set up by the deployment; a check shows the records but never demotes it.
  const pinned = isOperatorDomainRow(deps.config, d);
  // Ask the provider to look again first, so the records checked below are its latest ones.
  // Only domains that went through provider registration (created since round 13) are refreshed.
  const p = !pinned && (d.providerDomainId || d.providerStatus) ? await refreshProviderDomain(deps, d) : null;
  if (p && (p.providerRecords || p.providerStatus !== d.providerStatus)) {
    const next = { ...p, providerRecords: p.providerRecords ?? d.providerRecords, providerDomainId: p.providerDomainId ?? d.providerDomainId };
    await deps.db.update(domains).set(next).where(eq(domains.id, d.id));
    d = { ...d, ...next };
  }
  const report = await runDnsChecks(deps.dns, d, deps.config, now);
  const hadLookupErrors = report.records.some((r) => r.status === "error");
  let status: DomainRow["status"] = d.status;
  if (pinned) status = d.status;
  else if (report.verified) status = "verified";
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
      // The deployment's shared domain (free addresses) is set up once by the operator, not by these records.
      ne(domains.orgId, "org_platform"),
      // R26: nor is the company domain (support@ and security@), held by the operator workspace.
      deps.config.operatorInbox.domain ? ne(domains.name, deps.config.operatorInbox.domain) : undefined,
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
  await retryQueuedProviderDomains(deps).catch((err) => deps.reportError?.(err, { where: "domains.retryQueued" }));
  return results;
}

/**
 * Domains waiting for a sending slot (the provider's plan allows a fixed number of domains per
 * account). The oldest one is offered the next free slot: on each maintenance pass and right after
 * a domain leaves Multies. One read when nothing waits; one provider call and one write per try.
 */
export async function retryQueuedProviderDomains(deps: Deps, limit = 1) {
  const waiting = await deps.db.select().from(domains).where(like(domains.providerStatus, `${QUEUED_PREFIX}%`)).orderBy(asc(domains.createdAt)).limit(limit);
  let registered = 0;
  for (const d of waiting) {
    const p = await registerProviderDomain(deps, d.name);
    if (!p) continue;
    // Still no slot: leave the row as it is (no write).
    if (p.providerStatus?.startsWith(QUEUED_PREFIX)) break;
    await deps.db.update(domains).set(p).where(eq(domains.id, d.id));
    if (!p.providerStatus?.startsWith("error:")) registered++;
  }
  return { waiting: waiting.length, registered };
}

/** How many customer domains wait for a sending slot (status page and the domain list). */
export async function queuedDomainCount(db: DB) {
  const r = await db.select({ n: count() }).from(domains).where(like(domains.providerStatus, `${QUEUED_PREFIX}%`)).get();
  return r?.n ?? 0;
}

export async function deleteDomain(db: DB, orgId: string, id: string, deps?: Deps) {
  const d = await getDomain(db, orgId, id);
  await db.delete(domains).where(eq(domains.id, d.id));
  // Free the provider's slot too (its plan counts domains), and hand it to the next domain waiting. Best effort.
  if (deps && d.providerDomainId) {
    await removeProviderDomain(deps, d.providerDomainId);
    await retryQueuedProviderDomains(deps).catch((err) => deps.reportError?.(err, { where: "domains.retryQueued" }));
  }
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
