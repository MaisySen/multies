import { emitEvent } from "./developer/webhooks";
import { audit } from "./audit";
import { and, asc, count, eq, like, lt, ne, or, isNull, sql } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { aliases, domains, mailboxes, organizations } from "../db/schema";
import { encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { conflict, HttpError, notFound } from "../lib/errors";
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
export const SENDING_ERROR_COPY = "We couldn't turn on sending for this domain yet. We'll try again when you check DNS.";

export function sendingState(providerStatus: string) {
  if (providerStatus.startsWith(QUEUED_PREFIX)) {
    return {
      status: "queued" as const,
      detail: "Waiting for a sending slot with our email service. Your domain is saved and receives mail, and mail inside Multies works. Sending to outside addresses starts by itself when a slot frees up, usually without anything to do on your side.",
    };
  }
  // R40 (MB-206): never the provider's raw words (they were wrong for a new domain and ended in a double full
  // stop); those stay in the server log and the stored status.
  return {
    status: providerStatus.startsWith("error:") ? "error" as const : providerStatus === "verified" ? "verified" as const : "pending" as const,
    detail: providerStatus.startsWith("error:") ? SENDING_ERROR_COPY : null,
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

export const DEMO_DOMAINS_OFF = "Domains are off in the demo. Sign up to add your own domain.";

/** PRIV1b (P40): the demo keeps its sample domain; it can neither add a domain nor remove the sample. */
async function assertNotDemo(db: DB, orgId: string) {
  const org = await db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, orgId)).get();
  if (org?.isDemo) throw new HttpError(403, "demo_domains_off", DEMO_DOMAINS_OFF);
}

/** `dkimKey` reuses an existing key pair (sandbox domains share one, skipping RSA key generation).
 * `sample` marks the demo's own sample domain, the one domain a demo workspace may hold. */
export async function createDomain(deps: Deps, orgId: string, name: string, opts: { dkimKey?: { publicKeyB64: string; privateKeyPem: string }; sample?: boolean } = {}) {
  const { db, config } = deps;
  // R26 (DF-18): the company domain in the operator workspace is the deployment's own and is not a plan add-on.
  const operatorDomain = isOperatorDomainRow(config, { orgId, name });
  assertDomainAllowed(config, orgId, name);
  // PRIV1b (P40): a demo (anonymous) adds no domains; only the demo seeder adds its sample domain, flagged explicitly.
  if (!opts.sample) await assertNotDemo(db, orgId);
  if (!operatorDomain) await assertCanCreate(db, orgId, "domains");
  const existing = await db.select().from(domains).where(eq(domains.name, name)).get();
  if (existing) {
    throw conflict(existing.orgId === orgId
      ? `${name} is already in this workspace.`
      : `${name} is connected to another workspace. If it isn't verified there, it is released ${DOMAIN_CLAIM_DAYS} days after it was added; if you own it, you can also contact support to claim it.`);
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
  // PRIV1b (P40): a demo's sample domain is stored verified and has no real DNS; a check must not demote it either.
  const pinned = isOperatorDomainRow(deps.config, d)
    || !!(await deps.db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, d.orgId)).get())?.isDemo;
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
  await assertNotDemo(db, orgId); // PRIV1b (P40)
  await db.delete(domains).where(eq(domains.id, d.id));
  // Free the provider's slot too (its plan counts domains), and hand it to the next domain waiting. Best effort.
  if (deps && d.providerDomainId) {
    await removeProviderDomain(deps, d.providerDomainId);
    await retryQueuedProviderDomains(deps).catch((err) => deps.reportError?.(err, { where: "domains.retryQueued" }));
  }
  return d;
}

/** Round 2: a claim never verified is released after this many days when nothing was put on it. */
export const DOMAIN_CLAIM_DAYS = 14;

/**
 * Round 2 (PRIV1b domain claims): a domain name is unique across the service (domains_name_uq), so a workspace that adds
 * a domain it never verifies holds the name from its real owner. Releases, a few a pass, claims that were never verified
 * (verified_at is null), are older than DOMAIN_CLAIM_DAYS and have no mailbox and no alias (so no mail either). The
 * platform's shared domain, the operator's company domain and demo workspaces are left alone. Each release is audited
 * in the workspace that held it. Returns the names released.
 */
export async function releaseStaleDomainClaims(deps: Deps, limit = 25): Promise<string[]> {
  const cutoff = new Date(deps.now().getTime() - DOMAIN_CLAIM_DAYS * 86_400_000);
  const rows = await deps.db.select({ d: domains }).from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.orgId))
    .where(and(
      isNull(domains.verifiedAt), ne(domains.status, "verified"), lt(domains.createdAt, cutoff),
      eq(organizations.isDemo, false), ne(domains.orgId, "org_platform"),
      deps.config.operatorInbox.domain ? ne(domains.name, deps.config.operatorInbox.domain) : undefined,
      sql`not exists (select 1 from ${mailboxes} m where m.domain_id = ${domains.id})`,
      sql`not exists (select 1 from ${aliases} a where a.domain_id = ${domains.id})`,
    ))
    .orderBy(asc(domains.createdAt)).limit(limit).all();
  const released: string[] = [];
  for (const { d } of rows) {
    // Checked again in the delete, so a mailbox added since the read keeps the claim.
    const gone = await deps.db.delete(domains).where(and(eq(domains.id, d.id), isNull(domains.verifiedAt),
      sql`not exists (select 1 from ${mailboxes} m where m.domain_id = ${d.id})`, sql`not exists (select 1 from ${aliases} a where a.domain_id = ${d.id})`)).returning({ id: domains.id });
    if (!gone.length) continue;
    released.push(d.name);
    if (d.providerDomainId) await removeProviderDomain(deps, d.providerDomainId).catch((err) => deps.reportError?.(err, { where: "domains.releaseClaim" }));
    await audit(deps.db, { orgId: d.orgId, actorUserId: null, action: "domain.claim_released", targetType: "domain", targetId: d.id, metadata: { name: d.name, days: DOMAIN_CLAIM_DAYS } }).catch(() => undefined);
  }
  if (released.length) {
    deps.log?.info("domains.claims_released", { count: released.length });
    if (rows.some((r) => r.d.providerDomainId)) await retryQueuedProviderDomains(deps).catch((err) => deps.reportError?.(err, { where: "domains.retryQueued" }));
  }
  return released;
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
