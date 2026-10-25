/**
 * Free addresses (round 17, plan horizon 1 item 1).
 *
 * Anyone can take a free personal address on the deployment's shared domain
 * (FREE_MAIL_DOMAIN, mail.multies.si on production), for example ada.acme@mail.multies.si.
 * Never on the root multies.si: that is the company's own domain, for staff addresses only. Mail to it arrives through the same Email Worker as every other
 * domain (the catch-all on the shared domain routes to this deployment, signed with the
 * platform workspace's inbound key) and mail from it goes out through the same sender.
 *
 * The shared domain is one row owned by the platform workspace ("org_platform"), the same
 * row that hosts agent inboxes for workspaces without a domain. It is registered once with the
 * outbound provider (one domain slot for every free user together), so free users never spend
 * the provider's per-account domain slots one by one.
 */
import { and, count, eq, gte, like, type SQL } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { aliases, auditLogs, domains, mailboxes, organizations } from "../db/schema";
import { encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { badRequest, conflict, HttpError } from "../lib/errors";
import { assertCanCreate, getPlan } from "./plans";
import { audit } from "./audit";

export const PLATFORM_ORG = "org_platform";

/**
 * Local parts nobody can take on the shared domain: role and system addresses (RFC 2142),
 * the addresses Multies itself uses, and words that would let a stranger pose as Multies.
 */
export const RESERVED_LOCAL_PARTS = new Set([
  "abuse", "accounts", "admin", "administrator", "api", "billing", "bounce", "bounces", "careers", "contact",
  "dmarc", "help", "hello", "hostmaster", "info", "legal", "mail", "mailer-daemon", "marketing", "multies",
  "news", "noc", "no-reply", "noreply", "office", "operator", "owner", "postmaster", "press", "privacy", "relay",
  "review", "root", "sales", "security", "staff", "support", "system", "team", "test", "webmaster", "www",
  "ops", "account", "finance", "payments", "payment", "invoice", "invoices", "login", "signin", "password", "verify",
  "verification", "official", "secure", "mailer", "daemon", "hr", "it", "fintex", "reply", "replies", "notifications",
]);

/** Words that may not appear anywhere in a free address, so nobody can pose as Multies or its operator. */
const BRAND_WORDS = ["multies", "fintex"];

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9.-]{1,38}[a-z0-9])$/;

/** Checks a requested local part. Returns the reason it can't be used, or null. */
export function freeLocalPartProblem(local: string): string | null {
  if (!LOCAL_RE.test(local)) return "Use 3 to 40 lowercase letters, numbers, dots or dashes, starting and ending with a letter or number.";
  if (/[.-]{2}/.test(local)) return "Dots and dashes can't sit next to each other.";
  // Kept whole, with the dots and dashes taken out ("no.reply"), or as any one part ("support.team",
  // "security-desk", "admin1"): role addresses on the shared domain must never be anyone's.
  const bare = (s: string) => s.replace(/\d+$/, "");
  const parts = local.split(/[.-]/).map(bare);
  const kept = RESERVED_LOCAL_PARTS.has(local) || RESERVED_LOCAL_PARTS.has(bare(local.replace(/[.-]/g, "")))
    || parts.some((p) => RESERVED_LOCAL_PARTS.has(p)) || BRAND_WORDS.some((w) => local.includes(w));
  if (kept) return "That name is kept for Multies itself. Try your name, or your name and your team.";
  return null;
}

/** Lowercase ASCII letters and digits only (accents dropped), for building a suggestion. */
function plain(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A suggested free address: the person's first name and the workspace's name, for example
 * "ada.acme". Falls back to the part of their sign in email before the @.
 */
export function suggestFreeLocalPart(personName: string, workspaceName: string, email = ""): string {
  const first = plain(personName.split(/[\s@]+/)[0] ?? "") || plain(email.split("@")[0] ?? "");
  const team = plain(workspaceName.replace(/'s workspace$/i, "").replace(/\bworkspace\b/i, ""));
  const parts = [first || "me", team && team !== first ? team : ""].filter(Boolean);
  let s = parts.join(".").slice(0, 40).replace(/[.-]+$/, "");
  if (s.length < 3) s = `${s}mail`.slice(0, 40);
  if (freeLocalPartProblem(s)) s = `${s.replace(/[^a-z0-9]/g, "").slice(0, 30) || "me"}.team`;
  return s;
}

/**
 * The shared domain row, created on first use. It is marked verified with the provider and in DNS
 * because the deployment owns it and set it up once (docs/runbooks/free-addresses.md); the hourly
 * domain check skips platform domains so a record it doesn't know about can't take it down.
 */
export async function ensurePlatformDomain(deps: Deps, name: string) {
  const existing = await deps.db.select().from(domains).where(eq(domains.name, name)).get();
  if (existing) return existing;
  await deps.db.insert(organizations).values({ id: PLATFORM_ORG, name: "Multies platform", slug: "mymail-platform" }).onConflictDoNothing();
  const { publicKeyB64, privateKeyPem } = await generateDkimKeyPair();
  const id = newId("dom");
  const now = deps.now();
  await deps.db.insert(domains).values({
    id, orgId: PLATFORM_ORG, name, status: "verified", verifiedAt: now, lastCheckedAt: now,
    verificationToken: randomToken(18), dkimSelector: deps.config.mail.dkimSelector, dkimPublicKey: publicKeyB64,
    dkimPrivateKeyEnc: await encryptSecret(deps.config.appSecret, privateKeyPem), providerStatus: "verified",
  }).onConflictDoNothing();
  return (await deps.db.select().from(domains).where(eq(domains.name, name)).get())!;
}

/** Whether a domain row is the deployment's shared one (free addresses and shared agent inboxes). */
export const isPlatformDomain = (d: { orgId: string }) => d.orgId === PLATFORM_ORG;

/** What the app shows about free addresses for this person and workspace. Read only. */
export async function freeAddressInfo(deps: Deps, auth: Pick<AuthContext, "orgId" | "name" | "email">) {
  const domain = deps.config.freeMail.domain;
  if (!domain) return { enabled: false as const };
  const [org, row] = await Promise.all([
    deps.db.select({ name: organizations.name, isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, auth.orgId)).get(),
    deps.db.select({ id: domains.id }).from(domains).where(eq(domains.name, domain)).get(),
  ]);
  const taken = row
    ? await deps.db.select({ id: mailboxes.id, address: mailboxes.address, displayName: mailboxes.displayName }).from(mailboxes)
      .where(and(eq(mailboxes.orgId, auth.orgId), eq(mailboxes.domainId, row.id), eq(mailboxes.kind, "person")))
    : [];
  return {
    enabled: true as const,
    domain,
    dailySends: deps.config.freeMail.dailySends,
    available: !org?.isDemo,
    suggestion: suggestFreeLocalPart(auth.name, org?.name ?? "", auth.email),
    addresses: taken,
  };
}

/** The audit action every claim writes; the abuse limits below count these rows (reads only). */
export const CLAIM_ACTION = "free_address.claimed";

/** Free address claims allowed per person (ever), per network and per device (each per 24 hours). */
export const CLAIM_LIMITS = { perPerson: 1, perIpPerDay: 3, perDevicePerDay: 3 } as const;

/**
 * Sign up abuse limits for free addresses: one per person, a few per network and per device a day,
 * and a ceiling for the whole deployment a day (FREE_MAIL_DAILY_CLAIMS). Counted from the claim's
 * own audit rows, so the limits cost no extra writes.
 */
async function assertClaimAllowed(deps: Deps, userId: string, ctx: { ip?: string | null; deviceId?: string | null }) {
  const since = new Date(deps.now().getTime() - 24 * 3600_000);
  const claims = and(eq(auditLogs.action, CLAIM_ACTION), gte(auditLogs.createdAt, since));
  const n = async (where: SQL | undefined) => Number((await deps.db.select({ n: count() }).from(auditLogs).where(where).get())?.n ?? 0);
  const [mine, fromIp, fromDevice, today] = await Promise.all([
    n(and(eq(auditLogs.action, CLAIM_ACTION), eq(auditLogs.actorUserId, userId))),
    ctx.ip ? n(and(claims, eq(auditLogs.ip, ctx.ip))) : Promise.resolve(0),
    ctx.deviceId ? n(and(claims, like(auditLogs.metadata, `%"device":"${ctx.deviceId.replace(/[^a-zA-Z0-9-]/g, "")}"%`))) : Promise.resolve(0),
    n(claims),
  ]);
  if (mine >= CLAIM_LIMITS.perPerson) throw new HttpError(409, "free_mail_one_each", "You already have a free address. Each person gets one.");
  if (fromIp >= CLAIM_LIMITS.perIpPerDay || fromDevice >= CLAIM_LIMITS.perDevicePerDay) {
    throw new HttpError(429, "free_mail_limit", "Too many free addresses were made from this network or device today. Try again tomorrow, or add your own domain.");
  }
  if (today >= deps.config.freeMail.dailyClaims) {
    throw new HttpError(429, "free_mail_daily", "We've given out today's free addresses. Try again tomorrow, or connect your own email or domain now.");
  }
}

/**
 * A free address is never given to a second person, even after it was deleted, so mail meant for
 * the first owner (password resets, replies) can't reach someone else. Read only: the claim's audit row.
 */
async function wasClaimedBefore(deps: Deps, address: string) {
  const row = await deps.db.select({ id: auditLogs.id }).from(auditLogs)
    .where(and(eq(auditLogs.action, CLAIM_ACTION), like(auditLogs.metadata, `%"address":"${address.replace(/[%_"\\]/g, "")}"%`))).get();
  return Boolean(row);
}

/** Claims a free address for the signed in person's workspace. `ctx` carries the network and device for the abuse limits. */
export async function claimFreeAddress(deps: Deps, auth: AuthContext, input: { localPart: string; displayName?: string }, ctx: { ip?: string | null; deviceId?: string | null } = {}) {
  const domainName = deps.config.freeMail.domain;
  if (!domainName) throw new HttpError(404, "free_mail_off", "Free addresses aren't offered on this server. Add your own domain instead.");
  const org = await deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
  if (!org || org.isDemo) throw new HttpError(403, "free_mail_demo", "Sample workspaces can't take a real address. Create a free account first.");
  if (!auth.emailVerified) throw new HttpError(403, "email_unverified", "Confirm your email first, then take your free address.");
  if (org.suspendedAt) throw new HttpError(403, "workspace_suspended", "This workspace is suspended.");
  const local = input.localPart.trim().toLowerCase();
  const problem = freeLocalPartProblem(local);
  if (problem) throw badRequest(problem);
  await assertClaimAllowed(deps, auth.userId, ctx);
  await assertCanCreate(deps.db, auth.orgId, "mailboxes");
  const domain = await ensurePlatformDomain(deps, domainName);
  const address = `${local}@${domain.name}`;
  const [m, a] = await Promise.all([
    deps.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get(),
    deps.db.select({ id: aliases.id }).from(aliases).where(eq(aliases.address, address)).get(),
  ]);
  if (m || a || await wasClaimedBefore(deps, address)) throw conflict(`${address} is taken. Try another, for example with your team's name.`);
  const plan = await getPlan(deps.db, auth.orgId);
  const id = newId("mbx");
  const displayName = (input.displayName?.trim() || auth.name || local).slice(0, 120);
  await deps.db.insert(mailboxes).values({ id, orgId: auth.orgId, domainId: domain.id, localPart: local, address, displayName, quotaMb: plan.limits.storagePerMailboxMb });
  await audit(deps.db, {
    orgId: auth.orgId, actorUserId: auth.userId || null, actorEmail: auth.email, action: CLAIM_ACTION, targetType: "mailbox", targetId: id,
    metadata: { address, ...(ctx.deviceId ? { device: ctx.deviceId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64) } : {}) }, ip: ctx.ip ?? undefined,
  });
  return (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;
}
