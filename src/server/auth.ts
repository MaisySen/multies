/**
 * Authentication is Better Auth (https://better-auth.com): email + password, email
 * verification, password reset, TOTP two-factor with backup codes, organizations with
 * roles and invitations, session management, platform admin, and social / OIDC sign-in
 * (Google, GitHub, Auth0) that switches on when its keys are configured.
 *
 * MyMail adds only product glue: its own ID format, its email pipeline for auth
 * emails, plan-based seat limits, per-mailbox access for invited members, and the
 * PBKDF2 password hash (WebCrypto-native, so it is fast on Workers; existing users'
 * hashes keep working).
 */
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins/organization";
import { twoFactor } from "better-auth/plugins/two-factor";
import { admin } from "better-auth/plugins/admin";
import { genericOAuth, auth0 } from "better-auth/plugins/generic-oauth";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { lastLoginMethod } from "better-auth/plugins";
import { clearFailures, lockedUntil, recordFailure } from "./services/lockout";
import { audit } from "./services/audit";
import { and, count, eq, inArray, ne } from "drizzle-orm";
import type { Deps } from "./context";
import * as schema from "./db/schema";
import { hashPassword, newId, randomToken, verifyPassword } from "./lib/crypto";
import { sendSystemEmail } from "./services/system-mail";
import { beforeUserDelete } from "./services/privacy";
import { HttpError } from "./lib/errors";
import { getPlan } from "./services/plans";

const ID_PREFIX: Record<string, string> = {
  user: "usr", session: "ses", account: "acc", verification: "vrf", organization: "org",
  member: "mem", twoFactor: "tfa", rateLimit: "rl",
};

export function authOptions(deps: Deps) {
  const { config, db } = deps;
  const prod = config.mode === "production";
  const social = config.auth.social;

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
      cookiePrefix: "mymail",
      useSecureCookies: prod,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"] },
      database: {
        // Invitation ids double as the invite link, so they get a long random token.
        generateId: ({ model }) => (model === "invitation" ? randomToken(24) : newId(ID_PREFIX[model] ?? model.slice(0, 3))),
      },
    },
    emailAndPassword: {
      enabled: true,
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
          text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nThe link works for one hour. If you didn't ask for this, ignore this email; your password stays the same.`,
          action: { label: "Choose a new password", url },
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 3 * 24 * 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        if (user.email.endsWith(".test")) return; // sandbox accounts have no real inbox
        await sendSystemEmail(deps, {
          to: user.email,
          subject: `Confirm your email for ${config.appName}`,
          text: `Hi ${user.name.split(" ")[0]}, confirm that ${user.email} is your address so we can reach you about your account.`,
          action: { label: "Confirm email", url },
        });
      },
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      freshAge: 15 * 60,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 15 * 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 10 },
        "/two-factor/verify-backup-code": { window: 60, max: 10 },
        "/send-verification-email": { window: 60 * 60, max: 5 },
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
        if (ctx.path !== "/sign-in/email") return;
        const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
        if (!email) return;
        const returned = ctx.context.returned;
        const failed = returned instanceof APIError && (returned.statusCode === 401 || returned.status === "UNAUTHORIZED");
        if (failed) {
          const locked = await recordFailure(db, email, deps.now());
          if (locked) {
            deps.log?.warn("auth.account_locked", { email: email.toLowerCase() });
            const user = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).get();
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
    socialProviders: {
      ...(social.google ? { google: { clientId: social.google.clientId, clientSecret: social.google.clientSecret } } : {}),
      ...(social.github ? { github: { clientId: social.github.clientId, clientSecret: social.github.clientSecret } } : {}),
    },
    account: { accountLinking: { enabled: true, trustedProviders: ["google", "github", "auth0"] } },
    databaseHooks: {
      session: {
        create: {
          // New sessions open the person's first workspace.
          before: async (session) => {
            const m = await db.select().from(schema.members).where(eq(schema.members.userId, session.userId)).get();
            return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
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
        customResolveMethod: (ctx) => (ctx.path?.startsWith("/oauth2/callback/") ? (ctx.params?.providerId ?? ctx.path.split("/").pop() ?? null) : null),
      }),
      ...(config.auth.auth0 ? [genericOAuth({ config: [{
        ...auth0({ ...config.auth.auth0 }),
        // Auth0 database users have their email as "name"; use the nickname instead.
        mapProfileToUser: (p) => {
          const name = typeof p.name === "string" && !p.name.includes("@") ? p.name : String(p.nickname ?? String(p.email ?? "").split("@")[0]);
          return { name };
        },
      }] })] : []),
      ...(config.auth.breachCheck ? [haveIBeenPwned({ customPasswordCompromisedMessage: "This password has appeared in a data breach. Please choose a different one." })] : []),
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
