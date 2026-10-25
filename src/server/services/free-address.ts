/**
 * Free addresses (round 17, plan horizon 1 item 1).
 *
 * A workspace with no domain of its own can take an address on the deployment's shared,
 * Multies-owned domain (FREE_MAIL_DOMAIN, multies.si on production), for example
 * ada.acme@multies.si. Mail to it arrives through the same Email Worker as every other
 * domain (the catch-all on the shared domain routes to this deployment, signed with the
 * platform workspace's inbound key) and mail from it goes out through the same sender.
 *
 * The shared domain is one row owned by the platform workspace ("org_platform"), the same
 * row that hosts agent inboxes for workspaces without a domain. It is already verified with
 * the outbound provider (it is the system sender's domain), so it is never registered again
 * and free users never spend the provider's per-account domain slots.
 */
import { and, eq } from "drizzle-orm";
import type { AuthContext, Deps } from "../context";
import { aliases, domains, mailboxes, organizations } from "../db/schema";
import { encryptSecret, generateDkimKeyPair, newId, randomToken } from "../lib/crypto";
import { badRequest, conflict, HttpError } from "../lib/errors";
import { assertCanCreate, getPlan } from "./plans";

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
]);

const LOCAL_RE = /^[a-z0-9](?:[a-z0-9.-]{1,38}[a-z0-9])$/;

/** Checks a requested local part. Returns the reason it can't be used, or null. */
export function freeLocalPartProblem(local: string): string | null {
  if (!LOCAL_RE.test(local)) return "Use 3 to 40 lowercase letters, numbers, dots or dashes, starting and ending with a letter or number.";
  if (/[.-]{2}/.test(local)) return "Dots and dashes can't sit next to each other.";
  if (RESERVED_LOCAL_PARTS.has(local) || RESERVED_LOCAL_PARTS.has(local.replace(/[.-]/g, ""))) return "That name is kept for Multies itself. Try your name, or your name and your team.";
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

/** Claims a free address for the signed in person's workspace. */
export async function claimFreeAddress(deps: Deps, auth: AuthContext, input: { localPart: string; displayName?: string }) {
  const domainName = deps.config.freeMail.domain;
  if (!domainName) throw new HttpError(404, "free_mail_off", "Free addresses aren't offered on this server. Add your own domain instead.");
  const org = await deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
  if (!org || org.isDemo) throw new HttpError(403, "free_mail_demo", "Sample workspaces can't take a real address. Create a free account first.");
  if (!auth.emailVerified) throw new HttpError(403, "email_unverified", "Confirm your email first, then take your free address.");
  if (org.suspendedAt) throw new HttpError(403, "workspace_suspended", "This workspace is suspended.");
  const local = input.localPart.trim().toLowerCase();
  const problem = freeLocalPartProblem(local);
  if (problem) throw badRequest(problem);
  await assertCanCreate(deps.db, auth.orgId, "mailboxes");
  const domain = await ensurePlatformDomain(deps, domainName);
  const address = `${local}@${domain.name}`;
  const [m, a] = await Promise.all([
    deps.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.address, address)).get(),
    deps.db.select({ id: aliases.id }).from(aliases).where(eq(aliases.address, address)).get(),
  ]);
  if (m || a) throw conflict(`${address} is taken. Try another, for example with your team's name.`);
  const plan = await getPlan(deps.db, auth.orgId);
  const id = newId("mbx");
  const displayName = (input.displayName?.trim() || auth.name || local).slice(0, 120);
  await deps.db.insert(mailboxes).values({ id, orgId: auth.orgId, domainId: domain.id, localPart: local, address, displayName, quotaMb: plan.limits.storagePerMailboxMb });
  return (await deps.db.select().from(mailboxes).where(eq(mailboxes.id, id)).get())!;
}
