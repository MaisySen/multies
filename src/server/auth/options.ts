/**
 * Better Auth options for Multies. Better Auth owns the app session (HttpOnly cookies,
 * rotation, revocation, two-factor, organizations and roles). People sign in through the
 * identity provider (OIDC Authorization Code with PKCE, see ./providers.ts) when it is
 * configured; the app's own password form stays available for self host and Node
 * deployments (AUTH_LOCAL_PASSWORD, see ./config.ts).
 *
 * The rest of the auth module: ./providers.ts (identity provider and social sign in),
 * ./session.ts (cookies, session lifetime, login method, provider logout), ./linking.ts
 * (linking an existing account by verified email), ./tokens.ts (ID token checks against
 * JWKS), ./mobile.ts (the mobile token exchange) and ./guards.ts (route guards).
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { admin } from "better-auth/plugins/admin";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { lastLoginMethod } from "better-auth/plugins";
import { idpPlugins, socialProviders } from "./providers";
import { instanceRateLimitStore, loginMethodFor, resolveLoginMethod, sessionOptions, cookieOptions } from "./session";
import { accountLinkingOptions, afterAccountLinked } from "./linking";
import { localPasswordEnabled } from "./config";
import { multiesAuthPlugin } from "./mobile";
import { clearFailures, lockedUntil, recordFailure } from "../services/lockout";
import { audit } from "../services/audit";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { Deps } from "../context";
import * as schema from "../db/schema";
import { hashPassword, newId, randomToken, verifyPassword } from "../lib/crypto";
import { createElement } from "react";
import { emailBrand, sendSystemEmail } from "../services/system-mail";
import { Invite as InviteEmail, Reset as ResetEmail, Verify as VerifyEmail, Welcome as WelcomeEmail } from "../emails";
import { beforeUserDelete } from "../services/privacy";
import { HttpError } from "../lib/errors";
import { getPlan } from "../services/plans";

/** Better Auth endpoints whose success is a security event worth an audit entry. */
const SECURITY_EVENTS: Record<string, string> = {
  "/change-password": "account.password_changed",
  "/set-password": "account.password_changed",
  "/two-factor/enable": "account.two_factor_enabled",
  "/two-factor/disable": "account.two_factor_disabled",
  "/two-factor/generate-backup-codes": "account.backup_codes_regenerated",
  "/revoke-session": "account.session_revoked",
  "/revoke-sessions": "account.sessions_revoked",
  "/revoke-other-sessions": "account.sessions_revoked",
  "/change-email": "account.email_change_requested",
};

const ID_PREFIX: Record<string, string> = {
  user: "usr", session: "ses", account: "acc", verification: "vrf", organization: "org",
  member: "mem", twoFactor: "tfa", rateLimit: "rl",
};

async function sendWelcome(deps: Deps, user: { email: string; name: string }) {
  if (user.email.endsWith(".test")) return;
  const first = user.name.split(" ")[0] || user.name;
  await sendSystemEmail(deps, {
    to: user.email, template: "welcome", subject: `Welcome to ${deps.config.appName}`,
    text: `Hi ${first}, your workspace is ready.\n\n1. Add your domain. We show the exact DNS records and check them for you.\n2. Create mailboxes, one per person or role, plus aliases like hello@.\n3. Use webmail, or add the account to Apple Mail, Outlook or your phone.\n\nReply to this email if you get stuck.`,
    action: { label: "Open your dashboard", url: `${deps.config.appUrl}/app` },
    element: createElement(WelcomeEmail, { brand: emailBrand(deps), name: first }),
  }).catch((err) => deps.reportError?.(err, { where: "sendWelcome" }));
}

export function authOptions(deps: Deps) {
  const { config, db } = deps;
  const prod = config.mode === "production";
  const localPassword = localPasswordEnabled(config);

  return {
    appName: config.appName,
    baseURL: config.appUrl,
    basePath: "/api/auth",
    secret: config.appSecret,
    // The configured app URL, plus this request's own origin (same-origin by definition;
    // cross-site requests are already refused by csrfGuard before they get here).
    trustedOrigins: async (request?: Request) => {
      const list = [config.appUrl];
      if (request) {
        const host = request.headers.get("host");
        if (host) list.push(`${new URL(request.url).protocol}//${host}`);
      }
      return list;
    },
    database: drizzleAdapter(db as never, {
      provider: "sqlite",
      transaction: false, // D1 has no interactive transactions
      schema: {
        user: schema.users, session: schema.sessions, account: schema.accounts, verification: schema.verifications,
        organization: schema.organizations, member: schema.members, invitation: schema.invitations,
        twoFactor: schema.twoFactors, rateLimit: schema.rateLimits,
      },
    }),
    advanced: {
      ...cookieOptions(prod),
      // Cloudflare sets CF-Connecting-IP and a client cannot forge it there. Forwarded headers
      // are only believed behind a proxy the operator names (TRUST_PROXY=true, self host).
      ipAddress: { ipAddressHeaders: config.auth.trustProxy ? ["x-forwarded-for", "x-real-ip"] : ["cf-connecting-ip"] },
      database: {
        // Invitation ids double as the invite link, so they get a long random token.
        generateId: ({ model }) => (model === "invitation" ? randomToken(24) : newId(ID_PREFIX[model] ?? model.slice(0, 3))),
      },
    },
    emailAndPassword: {
      // Off when the identity provider handles passwords, sign up and resets.
      enabled: localPassword,
      disableSignUp: !localPassword,
      minPasswordLength: 10,
      maxPasswordLength: 200,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      password: {
        hash: (password: string) => hashPassword(password),
        verify: ({ hash, password }: { hash: string; password: string }) => verifyPassword(password, hash),
      },
      sendResetPassword: async ({ user, url }) => {
        await sendSystemEmail(deps, {
          to: user.email,
          subject: `Reset your ${config.appName} password`,
          template: "reset", element: createElement(ResetEmail, { brand: emailBrand(deps), email: user.email, url }),
          text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nThe link works for one hour. If you didn't ask for this, ignore this email; your password stays the same.`,
          action: { label: "Choose a new password", url },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // The welcome email goes out once the address is proven, so it never lands on a typo.
      afterEmailVerification: async (user) => { await sendWelcome(deps, user); },
      autoSignInAfterVerification: true,
      expiresIn: 3 * 24 * 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        if (user.email.endsWith(".test")) return; // sandbox accounts have no real inbox
        await sendSystemEmail(deps, {
          to: user.email,
          subject: `Confirm your email for ${config.appName}`,
          template: "verify", element: createElement(VerifyEmail, { brand: emailBrand(deps), name: user.name.split(" ")[0] ?? user.name, email: user.email, url }),
          text: `Hi ${user.name.split(" ")[0]}, confirm that ${user.email} is your address so we can reach you about your account.`,
          action: { label: "Confirm email", url },
        });
      },
    },
    session: sessionOptions(),
    rateLimit: {
      enabled: true,
      // Counters live in this instance's memory (one per Workers isolate): no database write per auth request,
      // which is what used up the free daily write budget. The account lockout and the
      // identity provider's own brute force protection still hold across isolates.
      storage: "memory",
      customStorage: instanceRateLimitStore(),
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 15 * 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 10 },
        "/two-factor/verify-backup-code": { window: 60, max: 10 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
        "/mobile/exchange": { window: 60, max: 10 },
      },
    },
    hooks: {
      // Account lockout (services/lockout.ts): checked before a password sign-in.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (!email) return;
        const until = await lockedUntil(db, email, deps.now());
        if (until) {
          const mins = Math.max(1, Math.ceil((until.getTime() - deps.now().getTime()) / 60_000));
          throw new APIError("TOO_MANY_REQUESTS", {
            code: "ACCOUNT_LOCKED",
            message: `Too many failed sign-ins for this account. Try again in ${mins} minute${mins === 1 ? "" : "s"}, or reset your password.`,
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // Security events on the account go to the audit log of the person's workspace.
        const securityAction = SECURITY_EVENTS[ctx.path];
        if (securityAction) {
          const returned = ctx.context.returned;
          const userId = ctx.context.session?.user?.id ?? ctx.context.newSession?.user?.id;
          if (userId && !(returned instanceof Error)) {
            const m = await db.select().from(schema.members).where(eq(schema.members.userId, userId)).get();
            const email = ctx.context.session?.user?.email ?? ctx.context.newSession?.user?.email ?? null;
            if (m) await audit(db, { orgId: m.organizationId, actorUserId: userId, actorEmail: email, action: securityAction }).catch(() => undefined);
          }
          return;
        }
        if (ctx.path !== "/sign-in/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (!email) return;
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError && (returned.statusCode === 401 || returned.status === "UNAUTHORIZED");
        if (failed) {
          const locked = await recordFailure(db, email, deps.now());
          if (locked) {
            const user = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).get();
            // No email in logs: the user id is enough to find the account.
            deps.log?.warn("auth.account_locked", { user: user?.id ?? null });
            if (user) {
              const m = await db.select().from(schema.members).where(eq(schema.members.userId, user.id)).get();
              if (m) await audit(db, { orgId: m.organizationId, actorUserId: user.id, actorEmail: user.email, action: "account.locked", metadata: { reason: "failed_sign_ins" } });
              await sendSystemEmail(deps, {
                to: user.email, template: "security-alert",
                subject: `Sign-in to ${config.appName} paused after failed attempts`,
                text: `Someone tried to sign in to your ${config.appName} account with the wrong password several times, so password sign-in is paused for 15 minutes.\n\nIf that was you, wait and try again, or reset your password. If it wasn't, reset your password now and turn on two-factor authentication.`,
                action: { label: "Reset password", url: `${config.appUrl}/forgot-password` },
              }).catch(() => undefined);
            }
          }
        } else if (!(returned instanceof Error)) {
          await clearFailures(db, email);
        }
      }),
    },
    user: {
      deleteUser: {
        enabled: true,
        // Workspaces where the person is the only member go with them (subscription
        // cancelled, mail included); a sole owner of a shared workspace must hand it over first.
        beforeDelete: async (user) => {
          try {
            await beforeUserDelete(deps, user.id);
          } catch (err) {
            if (err instanceof HttpError) throw new APIError("CONFLICT", { message: err.message, code: err.code });
            throw err;
          }
        },
        afterDelete: async (user) => {
          deps.log?.info("account.deleted", { user: user.id });
          await sendSystemEmail(deps, {
            to: user.email, template: "account-deleted", subject: `Your ${deps.config.appName} account is deleted`,
            text: `Your ${deps.config.appName} account and the workspaces only you belonged to are deleted, including their mail. Backups that still hold this data expire within 30 days.\n\nIf you did not do this, reply to this email straight away.`,
          }).catch(() => undefined);
        },
      },
    },
    socialProviders: socialProviders(config),
    account: { accountLinking: accountLinkingOptions() },
    databaseHooks: {
      account: {
        create: {
          after: async (account) => { await afterAccountLinked(db, account); },
        },
      },
      user: {
        create: {
          // Social sign ups arrive verified, so they get the welcome straight away.
          after: async (user) => { if (user.emailVerified) await sendWelcome(deps, user); },
        },
      },
      session: {
        create: {
          // New sessions open the person's first workspace.
          before: async (session, ctx) => {
            const m = await db.select().from(schema.members).where(eq(schema.members.userId, session.userId)).get();
            return { data: { ...session, activeOrganizationId: m?.organizationId ?? null, loginMethod: loginMethodFor(ctx?.path, ctx?.params) } };
          },
        },
      },
    },
    plugins: [
      organization({
        creatorRole: "owner",
        allowUserToCreateOrganization: true,
        organizationLimit: 10,
        invitationExpiresIn: 7 * 24 * 60 * 60,
        cancelPendingInvitationsOnReInvite: true,
        // The invite link is the secret and acceptance requires signing in as the
        // invited address; email delivery may not be connected yet.
        requireEmailVerificationOnInvitation: false,
        membershipLimit: async (_user, org) => (await getPlan(db, org.id)).limits.seats,
        schema: { invitation: { additionalFields: { mailboxIds: { type: "string", required: false, input: true } } } },
        sendInvitationEmail: async (data) => {
          await sendSystemEmail(deps, {
            to: data.email, orgId: data.organization.id,
            subject: `${data.inviter.user.name} invited you to ${data.organization.name} on ${config.appName}`,
            template: "invite", element: createElement(InviteEmail, {
              brand: emailBrand(deps), inviter: data.inviter.user.name, inviterEmail: data.inviter.user.email,
              workspace: data.organization.name, role: data.role, url: `${config.appUrl}/invite/${data.id}`,
            }),
            text: `${data.inviter.user.name} (${data.inviter.user.email}) invited you to join the ${data.organization.name} workspace on ${config.appName} as ${data.role === "admin" ? "an admin" : "a member"}.\n\nThis invitation expires in 7 days.`,
            action: { label: "Accept invitation", url: `${config.appUrl}/invite/${data.id}` },
          });
        },
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation, inviter, organization: org }) => {
            const inviterRole = (await db.select().from(schema.members)
              .where(and(eq(schema.members.organizationId, org.id), eq(schema.members.userId, inviter.id))).get())?.role;
            if (invitation.role === "admin" && inviterRole !== "owner") throw new APIError("FORBIDDEN", { message: "Only the workspace owner can invite admins." });
            if (invitation.role === "owner") throw new APIError("BAD_REQUEST", { message: "Invite people as admins or members. Transfer ownership once they've joined." });
            // Seats: current members plus pending invitations.
            const plan = await getPlan(db, org.id);
            const [m, p] = await Promise.all([
              db.select({ n: count() }).from(schema.members).where(eq(schema.members.organizationId, org.id)).get(),
              db.select({ n: count() }).from(schema.invitations).where(and(eq(schema.invitations.organizationId, org.id), eq(schema.invitations.status, "pending"), ne(schema.invitations.email, invitation.email))).get(),
            ]);
            if ((m?.n ?? 0) + (p?.n ?? 0) >= plan.limits.seats) {
              throw new APIError("FORBIDDEN", { message: `Your ${plan.name} plan includes ${plan.limits.seats} seats, and they're all taken or invited. Upgrade to add more people.`, code: "PLAN_LIMIT" });
            }
            // Mailbox grants must belong to this workspace.
            const ids = invitation.role === "member" ? (JSON.parse((invitation.mailboxIds as string | undefined) ?? "[]") as string[]) : [];
            if (ids.length) {
              const found = await db.select({ id: schema.mailboxes.id }).from(schema.mailboxes)
                .where(and(eq(schema.mailboxes.orgId, org.id), inArray(schema.mailboxes.id, ids)));
              if (found.length !== new Set(ids).size) throw new APIError("BAD_REQUEST", { message: "One of those mailboxes doesn't exist in this workspace." });
            }
            return { data: { ...invitation, mailboxIds: JSON.stringify(ids) } };
          },
          afterAcceptInvitation: async ({ invitation, member }) => {
            const ids = JSON.parse((invitation.mailboxIds as string | undefined) ?? "[]") as string[];
            if (member.role !== "member" || !ids.length) return;
            const live = await db.select({ id: schema.mailboxes.id }).from(schema.mailboxes)
              .where(and(eq(schema.mailboxes.orgId, invitation.organizationId), inArray(schema.mailboxes.id, ids)));
            for (const mb of live) {
              await db.insert(schema.mailboxAccess).values({ orgId: invitation.organizationId, userId: member.userId, mailboxId: mb.id }).onConflictDoNothing();
            }
          },
        },
      }),
      twoFactor({ issuer: config.appName, backupCodeOptions: { amount: 10, length: 10 } }),
      admin({ defaultRole: "user", adminRoles: ["admin"] }),
      // Records how each person last signed in, so a workspace can require SSO. No cookie.
      lastLoginMethod({
        storeInDatabase: true,
        beforeStoreCookie: () => false,
        customResolveMethod: resolveLoginMethod,
      }),
      ...idpPlugins(config),
      multiesAuthPlugin(deps),
      ...(config.auth.breachCheck && localPassword ? [haveIBeenPwned({ customPasswordCompromisedMessage: "This password has appeared in a data breach. Please choose a different one." })] : []),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(deps: Deps) {
  return betterAuth(authOptions(deps));
}

export type Auth = ReturnType<typeof createAuth>;

const cache = new WeakMap<Deps, Auth>();
/** One Better Auth instance per app instance. */
export function authFor(deps: Deps): Auth {
  let a = cache.get(deps);
  if (!a) { a = createAuth(deps); cache.set(deps, a); }
  return a;
}
