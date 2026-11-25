import { emitEvent } from "./developer/webhooks";
import { audit } from "./audit";
import { and, asc, count, eq, like, lt, ne, or, isNull, sql } from "drizzle-orm";
import type { Deps } from "../context";
import type { DB } from "../db";
import { agentMailboxAccess, aliases, authEmailHooks, domains, mailboxAccess, mailboxDelegations, mailboxes, mailConnections, mailRules, messages, organizations } from "../db/schema";
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
    // Wave 3 review Y1: released at the 45 day cap while it held mail; the name it held (its mailboxes are suspended).
    ...(d.releasedAt ? { releasedName: d.releasedName, releasedAt: d.releasedAt } : {}),
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
      : `${name} is connected to another workspace. If it isn't verified there and holds no mail, it is released ${DOMAIN_CLAIM_DAYS} days after it was added once nobody there has checked it for ${DOMAIN_CLAIM_QUIET_DAYS} days, and ${DOMAIN_CLAIM_HARD_DAYS} days after it was added in any case; if you own it, you can also contact support to claim it.`);
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
 * Wave 1 review V7: a person asked for a check (Add domain, Verify). One narrow update of the domain row, only on that
 * person's action (the Verify route is rate limited); the scheduled re-check never sets it.
 */
export async function markVerifyAttempt(deps: Deps, id: string) {
  await deps.db.update(domains).set({ verifyAttemptedAt: deps.now() }).where(eq(domains.id, id));
}

/** Wave 1 review V7: no person checked the claim's DNS for this long before it is released. */
export const DOMAIN_CLAIM_QUIET_DAYS = 7;

/**
 * Wave 2 review X7: a claim never verified is released this many days after it was added however often someone pressed
 * Verify (each press restarted the quiet period, so a squatter held the name for ever).
 */
export const DOMAIN_CLAIM_HARD_DAYS = 45;

/**
 * Wave 2 review X7: what keeps a claim (a mailbox on it that is in use), and so is never deleted with it: an AI agent's
 * inbox, received or imported mail (not a draft or anything the workspace wrote itself, which a squatter makes at will),
 * a connected mailbox, a grant or share, a mail rule, a sign-up email hook, or an AI agent's access.
 */
const mailboxKept = (m: unknown) => sql`(${m}.kind = 'agent'
  or exists (select 1 from ${messages} x where x.mailbox_id = ${m}.id and x.folder <> 'drafts' and x.sent_by_user_id is null)
  or exists (select 1 from ${mailConnections} c where c.mailbox_id = ${m}.id)
  or exists (select 1 from ${mailboxAccess} g where g.mailbox_id = ${m}.id)
  or exists (select 1 from ${mailboxDelegations} s where s.mailbox_id = ${m}.id)
  or exists (select 1 from ${mailRules} r where r.mailbox_id = ${m}.id)
  or exists (select 1 from ${authEmailHooks} h where h.mailbox_id = ${m}.id)
  or exists (select 1 from ${agentMailboxAccess} a where a.mailbox_id = ${m}.id))`;
const claimKept = (domainId: unknown) => sql`exists (select 1 from ${mailboxes} m where m.domain_id = ${domainId} and ${mailboxKept(sql.raw("m"))})`;

/**
 * Wave 3 review Y1: the non-routable name a released claim's row (and its kept mailboxes) move to. Review Z2: under
 * .invalid with an underscore label, so no workspace can add it first (domainNameSchema refuses both), and unique by id.
 */
export const releasedDomainName = (id: string) => `${id.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}._released.invalid`;

/**
 * PRIV1b (pending claims): a domain name is unique across every workspace, so the first workspace to add a name holds
 * it, and a domain it never verifies holds the name from its real owner. Releases, a few a pass, claims that were never
 * verified (verified_at is null), are older than DOMAIN_CLAIM_DAYS, had no check asked for by a person in the last
 * DOMAIN_CLAIM_QUIET_DAYS, and hold no mail. Wave 1 review V7: an empty mailbox or an alias no longer keeps the claim
 * (createMailbox and createAlias don't need a verified domain, so one of them held the name for ever); a mailbox with
 * mail in it, an AI agent's inbox, or a connected mailbox still does. The empty mailboxes and the aliases go with the
 * domain. The platform's shared domain, the operator's company domain and demo workspaces are left alone. Each release
 * is audited in the workspace that held it. Returns the names released.
 */
export async function releaseStaleDomainClaims(deps: Deps, limit = 25): Promise<string[]> {
  const now = deps.now().getTime();
  const cutoff = new Date(now - DOMAIN_CLAIM_DAYS * 86_400_000);
  const quiet = new Date(now - DOMAIN_CLAIM_QUIET_DAYS * 86_400_000);
  const hard = new Date(now - DOMAIN_CLAIM_HARD_DAYS * 86_400_000);
  // Not checked by a person lately, or (X7) added more than DOMAIN_CLAIM_HARD_DAYS ago whatever the checks.
  const quietOrOld = or(isNull(domains.verifyAttemptedAt), lt(domains.verifyAttemptedAt, quiet), lt(domains.createdAt, hard));
  const releasable = (id?: string) => and(
    id ? eq(domains.id, id) : undefined,
    isNull(domains.verifiedAt), ne(domains.status, "verified"), lt(domains.createdAt, cutoff), quietOrOld,
    sql`not ${claimKept(domains.id)}`,
  );
  // Wave 3 review Y1: past DOMAIN_CLAIM_HARD_DAYS a claim never verified goes whatever is on it (a squatter can make
  // everything claimKept counts on an unverified domain). What holds mail or settings is kept, off the name.
  const hardReleasable = (id?: string) => and(
    id ? eq(domains.id, id) : undefined,
    isNull(domains.verifiedAt), ne(domains.status, "verified"), lt(domains.createdAt, hard), isNull(domains.releasedAt),
  );
  const rows = await deps.db.select({ d: domains }).from(domains)
    .innerJoin(organizations, eq(organizations.id, domains.orgId))
    .where(and(
      or(releasable(), hardReleasable()),
      eq(organizations.isDemo, false), ne(domains.orgId, "org_platform"),
      deps.config.operatorInbox.domain ? ne(domains.name, deps.config.operatorInbox.domain) : undefined,
    ))
    .orderBy(asc(domains.createdAt)).limit(limit).all();
  const released: string[] = [];
  for (const { d } of rows) {
    // Review Z2: one claim that fails to release is reported and the pass goes on to the next (it sorted first, so a
    // throw here used to stop every later pass).
    try {
      if (await releaseOneClaim(deps, d, releasable, hardReleasable)) released.push(d.name);
    } catch (err) {
      deps.reportError?.(err, { where: "domains.releaseClaim", domainId: d.id });
    }
  }
  if (released.length) {
    deps.log?.info("domains.claims_released", { count: released.length });
    if (rows.some((r) => r.d.providerDomainId)) await retryQueuedProviderDomains(deps).catch((err) => deps.reportError?.(err, { where: "domains.retryQueued" }));
  }
  return released;
}

type ClaimCheck = (id?: string) => ReturnType<typeof and>;
async function releaseOneClaim(deps: Deps, d: DomainRow, releasable: ClaimCheck, hardReleasable: ClaimCheck): Promise<boolean> {
  if (d.releasedAt === null && !(await deps.db.select({ id: domains.id }).from(domains).where(releasable(d.id)).get())) {
    return releaseKeptClaim(deps, d, hardReleasable(d.id));
  }
  // Wave 2 review X7: checked again right before the mail server accounts go (mail, a check or a grant that came in
  // since the read keeps the claim and its accounts), and once more in the delete.
  if (!(await deps.db.select({ id: domains.id }).from(domains).where(releasable(d.id)).get())) return false;
  const empty = await deps.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.domainId, d.id)).all();
  // Their mail server accounts go first (the account row cascades with the mailbox, so after the delete it is lost).
  if (empty.length) {
    const { deprovisionMailbox } = await import("./mailserver");
    for (const m of empty) await deprovisionMailbox(deps, d.orgId, m.id).catch((err: unknown) => deps.reportError?.(err, { where: "domains.releaseClaim.mailbox" }));
  }
  const gone = await deps.db.delete(domains).where(releasable(d.id)).returning({ id: domains.id });
  if (!gone.length) return false;
  if (d.providerDomainId) await removeProviderDomain(deps, d.providerDomainId).catch((err) => deps.reportError?.(err, { where: "domains.releaseClaim" }));
  await audit(deps.db, { orgId: d.orgId, actorUserId: null, action: "domain.claim_released", targetType: "domain", targetId: d.id, metadata: { name: d.name, days: DOMAIN_CLAIM_DAYS, ...(empty.length ? { emptyMailboxes: empty.length } : {}) } }).catch(() => undefined);
  return true;
}

/**
 * Wave 3 review Y1: releases a claim past the hard cap that something keeps. Empty mailboxes and every alias go; each
 * mailbox holding mail or settings stays, suspended, its address moved under the row's new non-routable name (the
 * local part is unchanged; the original name is in released_name), so no mail reaches it and the name and its
 * addresses can be added by another workspace. Mail server accounts go first. Audited. Returns whether it released.
 */
async function releaseKeptClaim(deps: Deps, d: DomainRow, still: ReturnType<typeof and>): Promise<boolean> {
  // Checked before any account goes: a claim kept and younger than the cap is left alone (it was read as soft releasable).
  if (!(await deps.db.select({ id: domains.id }).from(domains).where(still).get())) return false;
  const all = await deps.db.select({ id: mailboxes.id, localPart: mailboxes.localPart }).from(mailboxes).where(eq(mailboxes.domainId, d.id)).all();
  const keptIds = new Set((await deps.db.select({ id: sql<string>`m.id` }).from(sql`${mailboxes} m`).where(sql`m.domain_id = ${d.id} and ${mailboxKept(sql.raw("m"))}`).all()).map((r) => r.id));
  if (all.length) {
    const { deprovisionMailbox } = await import("./mailserver");
    for (const m of all) await deprovisionMailbox(deps, d.orgId, m.id).catch((err: unknown) => deps.reportError?.(err, { where: "domains.releaseClaim.mailbox" }));
  }
  const name = releasedDomainName(d.id);
  const now = deps.now();
  const moved = await deps.db.update(domains).set({ name, releasedName: d.name, releasedAt: now, catchAllMailboxId: null, providerDomainId: null, providerStatus: null, providerRecords: null })
    .where(still).returning({ id: domains.id });
  if (!moved.length) return false;
  const empty = all.filter((m) => !keptIds.has(m.id));
  for (const m of empty) await deps.db.delete(mailboxes).where(and(eq(mailboxes.id, m.id), sql`not ${mailboxKept(mailboxes)}`));
  for (const m of all.filter((x) => keptIds.has(x.id))) await deps.db.update(mailboxes).set({ status: "suspended", address: `${m.localPart}@${name}` }).where(eq(mailboxes.id, m.id));
  // Something kept since the read (mail arrived between the reads): still off the name, as a suspended mailbox.
  for (const m of await deps.db.select({ id: mailboxes.id, localPart: mailboxes.localPart, address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.domainId, d.id)).all()) {
    if (!m.address.endsWith(`@${name}`)) await deps.db.update(mailboxes).set({ status: "suspended", address: `${m.localPart}@${name}` }).where(eq(mailboxes.id, m.id));
  }
  await deps.db.delete(aliases).where(eq(aliases.domainId, d.id));
  if (d.providerDomainId) await removeProviderDomain(deps, d.providerDomainId).catch((err) => deps.reportError?.(err, { where: "domains.releaseClaim" }));
  await audit(deps.db, { orgId: d.orgId, actorUserId: null, action: "domain.claim_released", targetType: "domain", targetId: d.id, metadata: { name: d.name, days: DOMAIN_CLAIM_HARD_DAYS, hardCap: true, keptMailboxes: keptIds.size, emptyMailboxes: empty.length, renamedTo: name } }).catch(() => undefined);
  return true;
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
