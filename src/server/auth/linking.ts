import { and, eq } from "drizzle-orm";
import type { Deps } from "../context";
import * as schema from "../db/schema";

/**
 * Linking a provider sign in to an existing Multies account, by email.
 *
 * The rule: link only when the provider says the email is verified. No provider is trusted
 * by name, so an unverified address at the provider never reaches someone else's workspace.
 * The provider's post login policy also refuses password accounts until their email is
 * confirmed. A local account whose own email was never confirmed is linked too (the provider
 * just proved who owns the address), and then loses its password and other sessions, so a
 * person who registered someone else's address cannot keep a way in.
 */
export function accountLinkingOptions() {
  return {
    enabled: true,
    trustedProviders: [] as string[],
    requireLocalEmailVerified: false,
    allowDifferentEmails: false,
  };
}

/** Pure rule, for tests and docs: may this provider sign in attach to that existing account? */
export function mayLinkByEmail(provider: { email: string; emailVerified: boolean }, local: { email: string }): boolean {
  return provider.emailVerified && provider.email.trim().toLowerCase() === local.email.trim().toLowerCase();
}

/**
 * Runs after Better Auth links a provider account. When the existing account's email was
 * unconfirmed, the password and every other session go: only the address owner remains.
 */
export async function afterAccountLinked(db: Deps["db"], account: { userId: string; providerId: string }) {
  if (account.providerId === "credential") return;
  const user = await db.select({ emailVerified: schema.users.emailVerified }).from(schema.users).where(eq(schema.users.id, account.userId)).get();
  if (!user || user.emailVerified) return;
  await db.delete(schema.accounts).where(and(eq(schema.accounts.userId, account.userId), eq(schema.accounts.providerId, "credential")));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, account.userId));
}
