import { optionalWritesPaused } from "../services/write-budget";
import { exportWorkspace, personalData } from "../services/privacy";
import { Hono } from "hono";
import { z } from "zod";
import { and, count, eq, gt, isNotNull, like, ne, notLike, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import type { DB } from "../db";
import { parseBody, requireAuth } from "../middleware";
import { accounts, invitations, members, organizations, sessions, users } from "../db/schema";
import { deleteAuth0User, resendAuth0Verification, sendAuth0PasswordReset } from "../services/auth0-management";
import { beforeUserDelete } from "../services/privacy";
import { HttpError, notFound, tooMany } from "../lib/errors";
import { authFor, providersAnswer } from "../auth";
import { verifyPassword } from "../lib/crypto";
import { DbRateLimitStore, RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";
import { peekOrgCached } from "../services/plans";
import { IsolateCache } from "../lib/isolate-cache";
import { CHECK_DEMO_DAILY_CAP, CHECK_DEMO_SLUG_PREFIX, createDemoWorkspace, isInternalCheck } from "../services/demo";
import { runDueJobs } from "../services/jobs";
import { createWorkspace, deleteWorkspace, listWorkspaces, switchWorkspace } from "../services/team";
import { markWorkspace } from "../auth/workspace-mark";
import { cleanLocale, isCountry, isTimeZone } from "@/shared/locale";
import { autoWorkspaceName } from "@/shared/person-name";

/**
 * Product-level account endpoints. Sign-up, sign-in, sessions, 2FA, password reset
 * and email verification are Better Auth's, served under /api/auth.
 */
const FRESH_SESSION_MS = 15 * 60_000;

/** True when the person existed before the workspace finished onboarding (DF-21). */
export function personPredates(createdAt: Date | null | undefined, onboardedAt: unknown): boolean {
  if (!createdAt || typeof onboardedAt !== "string") return false;
  const done = Date.parse(onboardedAt);
  return Number.isFinite(done) && createdAt.getTime() < done;
}

const readOrgMeta = (raw: string | null | undefined): Record<string, unknown> => {
  try { return raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { return {}; }
};
const zone = z.string().max(64).refine(isTimeZone, "Unknown time zone.");
const localeTag = z.string().max(35).transform((v, ctx) => {
  const clean = cleanLocale(v);
  if (!clean) { ctx.addIssue({ code: "custom", message: "Unknown language." }); return z.NEVER; }
  return clean;
});
const onboardingSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(100),
  timezone: zone,
  locale: localeTag,
  company: z.string().trim().max(100).optional(),
  country: z.string().refine(isCountry, "Pick a country from the list.").optional(),
  workspaceTimezone: zone.optional(),
});
const preferencesSchema = z.object({ timezone: zone.optional(), locale: localeTag.optional() });

/**
 * R39 (MB-202): invitations waiting for this person's own confirmed address, in workspaces they are not in
 * yet. A teammate who signed up from an invite (or confirmed their email later) lands in their own empty
 * workspace; the app shows these as a "Join" banner so the invite isn't lost. Only once the address is
 * confirmed: an unconfirmed account proves nothing about the address. One read (at most 5 rows).
 */
async function myPendingInvites(deps: AppEnv["Variables"]["deps"], auth: AppEnv["Variables"]["auth"]) {
  if (!auth.emailVerified || !auth.email) return [];
  const rows = await deps.db.select({ id: invitations.id, orgId: invitations.organizationId, orgName: organizations.name, role: invitations.role, inviter: users.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(and(eq(invitations.email, auth.email.toLowerCase()), eq(invitations.status, "pending"), gt(invitations.expiresAt, deps.now())))
    .limit(5);
  if (!rows.length) return [];
  const mine = new Set((await deps.db.select({ orgId: members.organizationId }).from(members).where(eq(members.userId, auth.userId))).map((m) => m.orgId));
  return rows.filter((r) => !mine.has(r.orgId)).map((r) => ({ token: r.id, organization: { name: r.orgName }, role: (r.role ?? "member") as "admin" | "member", invitedBy: r.inviter }));
}

/*
 * R41 (MB-199 CPU): the person's own preferences, whether they have a password and their pending invites, in one
 * query plus the invites read, kept per isolate for a few seconds (lib/isolate-cache.ts). The app shell reads /me
 * on every page load and every write by this person drops the copy (app.ts), so their own change shows at once.
 * Only for a confirmed address: an unconfirmed person is always read afresh (they are waiting on that email).
 */
type MeExtras = { prefs: { timezone: string | null; locale: string | null; createdAt: Date | null } | undefined; hasPassword: boolean; pendingInvites: Awaited<ReturnType<typeof myPendingInvites>> };
const meCopy = new IsolateCache<MeExtras>(15_000);
async function meExtras(deps: AppEnv["Variables"]["deps"], auth: AppEnv["Variables"]["auth"]): Promise<MeExtras> {
  const key = `${auth.userId}:${auth.orgId}`;
  const hit = auth.emailVerified ? meCopy.get(key) : undefined;
  if (hit) return hit;
  const hasPw = deps.db.select({ one: sql<number>`1` }).from(accounts)
    .where(and(eq(accounts.userId, auth.userId), eq(accounts.providerId, "credential"), isNotNull(accounts.password))).limit(1);
  const [row, pendingInvites] = await Promise.all([
    deps.db.select({ timezone: users.timezone, locale: users.locale, createdAt: users.createdAt, hasPassword: sql<number>`exists ${hasPw}` }).from(users).where(eq(users.id, auth.userId)).get(),
    myPendingInvites(deps, auth),
  ]);
  const out: MeExtras = { prefs: row ? { timezone: row.timezone, locale: row.locale, createdAt: row.createdAt } : undefined, hasPassword: !!Number(row?.hasPassword ?? 0), pendingInvites };
  if (auth.emailVerified) meCopy.set(key, out);
  return out;
}

export function accountRoutes() {
  const resendLimiter = new RateLimiter(3, 10 * 60_000);
  const resetLinkLimiter = new RateLimiter(3, 10 * 60_000);
  const demoLimiter = new RateLimiter(5, 60 * 60_000);
  // R76 (M1): our checks keep a burst limit too, in their own bucket so they never eat a visitor's.
  const checkDemoLimiter = new RateLimiter(10, 60 * 60_000);
  // R40 deploy 3 (MB-220): a per IP daily cap on new demos, counted in the database so every isolate shares it
  // (the limiter above is per isolate). An address the server cannot see (local tools) is not capped.
  let demoDb: () => DB = () => { throw new Error("no database yet"); };
  const demoDayStore = new DbRateLimitStore(() => demoDb());
  demoDayStore.init({ windowMs: 24 * 3600_000 });
  demoDayStore.prefix = "rl:demo-day:";
  return new Hono<AppEnv>()
    .get("/providers", (c) => {
      // idp: the one sign in and sign up page (Universal Login). password: the app's own form.
      return c.json(providersAnswer(c.var.deps.config));
    })
    /** Opens a sandbox workspace with sample data. Only when DEMO_MODE is on. */
    .post("/demo", async (c) => {
      if (!c.var.deps.config.demoEnabled) throw notFound("Demo");
      // R74 (MB-271): our own smoke and QA checks are marked and never use up the visitors' daily demos.
      const check = await isInternalCheck(c.var.deps.config.qaCheckToken, c.req.header("x-multies-check"), c.var.deps.now().getTime());
      if (!(check ? checkDemoLimiter : demoLimiter).take(c.var.ip)) throw tooMany();
      // A new demo costs about 2,000 D1 rows over its life (create, seed and purge; D1 counts each index).
      // It is the first writer to stop when the account's daily D1 budget runs low.
      if (await optionalWritesPaused(c.var.deps)) {
        return c.json({ error: { code: "demo_paused", message: "The demo is resting for today. Create a free account instead, or try the demo again tomorrow." } }, 503);
      }
      if (check) {
        // R76 (M1): checks have their own daily allowance (CHECK_DEMO_DAILY_CAP), counted the same cheap way.
        const since = new Date(c.var.deps.now().getTime() - 24 * 3600_000);
        const made = await c.var.deps.db.select({ n: count() }).from(organizations)
          .where(and(eq(organizations.isDemo, true), gt(organizations.createdAt, since), like(organizations.slug, `${CHECK_DEMO_SLUG_PREFIX}%`))).get();
        if ((made?.n ?? 0) >= CHECK_DEMO_DAILY_CAP) {
          return c.json({ error: { code: "check_demo_limit", message: "Internal checks have used today's demo allowance." } }, 429);
        }
      }
      const cap = c.var.deps.config.demoDailyLimit;
      if (cap > 0 && !check) {
        // One cheap read: each demo writes a few hundred rows, and the database has a daily write budget.
        const since = new Date(c.var.deps.now().getTime() - 24 * 3600_000);
        const made = await c.var.deps.db.select({ n: count() }).from(organizations)
          .where(and(eq(organizations.isDemo, true), gt(organizations.createdAt, since), notLike(organizations.slug, `${CHECK_DEMO_SLUG_PREFIX}%`))).get();
        if ((made?.n ?? 0) >= cap) {
          return c.json({ error: { code: "demo_paused", message: "The demo is resting for today. Create a free account instead, or try the demo again tomorrow." } }, 503);
        }
      }
      const ip = c.var.ip;
      const perIp = c.var.deps.config.demoPerIpDaily;
      if (perIp > 0 && ip && !ip.startsWith("unknown") && !check) {
        const db = c.var.deps.db;
        demoDb = () => db;
        const { totalHits } = await demoDayStore.increment(ip);
        if (totalHits > perIp) {
          return c.json({ error: { code: "demo_limit", message: "You've opened the demo a few times today. Create a free account to keep going, or try the demo again tomorrow." } }, 429);
        }
      }
      const { headers } = await createDemoWorkspace(c.var.deps, { check });
      for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
      return c.json({ ok: true }, 201);
    })
    /**
     * Seeds the demo's sample tasks, docs and deals. The app calls it straight after opening a
     * demo. It runs in its own request because the seed and the workspace together make more
     * queries than one Workers invocation may.
     */
    .post("/demo/seed", requireAuth, async (c) => {
      const org = await c.var.deps.db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, c.var.auth.orgId)).get();
      if (!org?.isDemo) throw notFound("Demo");
      const r = await runDueJobs(c.var.deps, 1, { types: ["demo.seed_suite"], orgId: c.var.auth.orgId });
      return c.json({ ok: true, ran: r.ran });
    })
    /**
     * Sends the email verification link again for a password account at the identity provider.
     * Always answers the same, so it never tells anyone whether an address has an account.
     */
    .post("/resend-verification", async (c) => {
      const { email } = await parseBody(c, z.object({ email: z.string().trim().toLowerCase().email("Enter the email you signed up with.").max(254) }));
      if (!resendLimiter.take(`${c.var.ip}|${email}`)) throw tooMany();
      const mgmt = c.var.deps.config.auth.auth0Management;
      if (!mgmt) throw new HttpError(503, "resend_unavailable", `Resending isn't available right now. Email ${c.var.deps.config.supportEmail} and we'll confirm your address.`);
      try {
        await resendAuth0Verification(mgmt, email);
      } catch (err) {
        c.var.deps.log?.error("account.resend_verification_failed", { error: String(err) });
        throw new HttpError(502, "resend_failed", "We couldn't send the email just now. Try again in a minute.");
      }
      return c.json({ ok: true });
    })
    /**
     * Emails a password reset link from the identity provider (one click on the sign in and
     * Forgot password pages). Sign in moved to a new identity tenant on 25 October 2026, so a
     * password set before then no longer works there; this is how those people set a new one.
     * Always answers the same, so it never tells anyone whether an address has an account.
     */
    .post("/password-reset-link", async (c) => {
      const { email } = await parseBody(c, z.object({ email: z.string().trim().toLowerCase().email("Enter the email you sign in with.").max(254) }));
      if (!resetLinkLimiter.take(`${c.var.ip}|${email}`)) throw tooMany();
      const idp = c.var.deps.config.auth.auth0;
      if (!idp) throw new HttpError(503, "reset_unavailable", "Password resets for this sign in aren't available here. Use Forgot password on the sign in page.");
      try {
        await sendAuth0PasswordReset(idp, email);
      } catch (err) {
        c.var.deps.log?.error("account.password_reset_link_failed", { error: String(err) });
        throw new HttpError(502, "reset_failed", "We couldn't send the email just now. Try again in a minute.");
      }
      return c.json({ ok: true });
    })
    .use("*", requireAuth)
    .get("/me", async (c) => {
      const { auth } = c.var;
      // R40 deploy 3: a workspace that is already onboarded (that never goes back) is read from the short per
      // isolate copy (services/plans.ts); one that is not yet onboarded is always read fresh, so finishing
      // onboarding in another isolate can never show the onboarding again.
      const cachedOrg = peekOrgCached(auth.orgId);
      const [org, extras] = await Promise.all([
        cachedOrg && readOrgMeta(cachedOrg.metadata).onboardedAt ? cachedOrg : c.var.deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get(),
        meExtras(c.var.deps, auth),
      ]);
      const prefs = extras.prefs;
      const onboardedAt = readOrgMeta(org?.metadata).onboardedAt;
      const workspaceOnboarded = !!onboardedAt;
      // DF-21: a person who already runs an onboarded workspace (its owner or an admin), or who was
      // in it before it was onboarded, is not asked for their name and zone again (for example after
      // a sign in move gives them a new sign in identity). They use the workspace zone until they
      // set their own in Settings.
      const established = workspaceOnboarded && (auth.role !== "member" || personPredates(prefs?.createdAt, onboardedAt));
      return c.json({
        user: { id: auth.userId, email: auth.email, name: auth.name, emailVerified: !!auth.emailVerified, twoFactor: !!auth.twoFactor, platformAdmin: auth.platformRole === "admin", timezone: prefs?.timezone ?? (established ? org?.timezone ?? null : null), locale: prefs?.locale ?? null },
        organization: org ? { id: org.id, name: org.name, plan: org.plan, isDemo: org.isDemo, role: auth.role, timezone: org.timezone, country: org.country, requireSso: org.requireSso, onboarded: workspaceOnboarded } : null,
        // A short onboarding once per person (their zone and language), plus the workspace's name, country and zone for its owner or admins.
        onboarding: {
          needed: !!org && !org.isDemo && !prefs?.timezone && !established,
          workspace: !!org && !org.isDemo && !workspaceOnboarded && auth.role !== "member",
        },
        session: { loginMethod: auth.loginMethod ?? "email", ssoBlocked: !!auth.ssoBlocked },
        hasPassword: extras.hasPassword,
        pendingInvites: extras.pendingInvites,
      });
    })
    .post("/onboarding", async (c) => {
      const input = await parseBody(c, onboardingSchema);
      const { auth, deps } = c.var;
      const org = await deps.db.select().from(organizations).where(eq(organizations.id, auth.orgId)).get();
      if (!org) throw notFound("Workspace");
      await deps.db.update(users).set({ name: input.name, timezone: input.timezone, locale: input.locale }).where(eq(users.id, auth.userId));
      // The workspace's own name, country and zone: its owner or admins, once (later changes are in Settings).
      // R56 (MB-248): with no company typed, a workspace still on its sign up name ("ada's workspace", or one
      // made from a raw email before R56) is renamed after the name the person just gave, once.
      const firstOnboarding = !readOrgMeta(org.metadata).onboardedAt;
      const rename = input.company || (firstOnboarding && /'s workspace$/.test(org.name) && org.name !== autoWorkspaceName(input.name) ? autoWorkspaceName(input.name) : null);
      if (auth.role !== "member" && !org.isDemo && (rename || input.country || input.workspaceTimezone)) {
        await deps.db.update(organizations).set({
          ...(rename ? { name: rename } : {}),
          ...(input.country ? { country: input.country } : {}),
          timezone: input.workspaceTimezone ?? input.timezone,
          metadata: JSON.stringify({ ...readOrgMeta(org.metadata), onboardedAt: deps.now().toISOString() }),
        }).where(eq(organizations.id, org.id));
      }
      await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "account.onboarded", metadata: { timezone: input.timezone, locale: input.locale, country: input.country ?? null }, ip: c.var.ip });
      return c.json({ ok: true });
    })
    .patch("/preferences", async (c) => {
      const input = await parseBody(c, preferencesSchema);
      const { auth, deps } = c.var;
      await deps.db.update(users).set({ ...(input.timezone ? { timezone: input.timezone } : {}), ...(input.locale ? { locale: input.locale } : {}) }).where(eq(users.id, auth.userId));
      return c.json({ ok: true });
    })
    .get("/workspaces", async (c) => {
      return c.json({ workspaces: await listWorkspaces(c.var.deps.db, c.var.auth.userId), currentId: c.var.auth.orgId });
    })
    .post("/workspaces", async (c) => {
      const { name } = await parseBody(c, z.object({ name: z.string().trim().min(1, "Give the workspace a name.").max(100) }));
      const { auth, deps } = c.var;
      const id = await createWorkspace(deps, auth, c.req.raw.headers, name);
      await audit(deps.db, { orgId: id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.created", metadata: { name }, ip: c.var.ip });
      markWorkspace(c, id);
      return c.json({ id }, 201);
    })
    .post("/workspaces/:id/switch", async (c) => {
      const { auth, deps } = c.var;
      const workspace = await switchWorkspace(deps, auth, c.req.raw.headers, c.req.param("id"));
      if (workspace.id !== auth.orgId) {
        await audit(deps.db, { orgId: workspace.id, actorUserId: auth.userId, actorEmail: auth.email, action: "workspace.switched", metadata: { from: auth.orgId }, ip: c.var.ip });
      }
      markWorkspace(c, workspace.id);
      return c.json({ ok: true, workspace });
    })
    // Privacy: a copy of everything held about the signed-in person (JSON download).
    .get("/export", async (c) => {
      const data = await personalData(c.var.deps, c.var.auth.userId);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="multies-account-${data.exportedAt.slice(0, 10)}.json"`, "cache-control": "no-store" },
      });
    })
    // Privacy: the whole workspace as a streamed ZIP (owners and admins).
    .get("/workspace/export", async (c) => {
      const stream = exportWorkspace(c.var.deps, c.var.auth);
      const day = c.var.deps.now().toISOString().slice(0, 10);
      return new Response(stream, {
        headers: { "content-type": "application/zip", "content-disposition": `attachment; filename="multies-workspace-${day}.zip"`, "cache-control": "no-store" },
      });
    })
    /**
     * Deletes the signed-in person's account (App Store and Google Play require an in-app
     * path; the phone app and the /delete-account page call this). Workspaces where they are
     * the only member go with them, mail included. Body: { confirm: "DELETE", password? }.
     */
    .delete("/", async (c) => {
      const { auth, deps } = c.var;
      const body = await parseBody(c, z.object({ confirm: z.string().max(20).optional(), password: z.string().max(200).optional() }));
      if (body.confirm !== "DELETE") throw new HttpError(400, "confirm_required", "Type DELETE to confirm.");
      const cred = await deps.db.select({ password: accounts.password }).from(accounts)
        .where(and(eq(accounts.userId, auth.userId), eq(accounts.providerId, "credential"))).get();
      // A demo visitor never chose a password (the demo flow sets a random one) and cannot
      // sign in again, so their sandbox goes on the confirm word alone.
      const orgs = await deps.db.select({ isDemo: organizations.isDemo }).from(members)
        .innerJoin(organizations, eq(organizations.id, members.organizationId)).where(eq(members.userId, auth.userId));
      const demoOnly = orgs.length > 0 && orgs.every((o) => o.isDemo);
      if (cred?.password && !demoOnly) {
        if (!body.password) throw new HttpError(400, "password_required", "Enter your password to confirm.");
        if (!(await verifyPassword(body.password, cred.password))) throw new HttpError(403, "wrong_password", "That password is incorrect.");
      }
      const mine = await deps.db.select({ orgId: members.organizationId, role: members.role }).from(members).where(eq(members.userId, auth.userId));
      const blocking: string[] = [];
      let alone = 0;
      for (const m of mine) {
        const others = await deps.db.select({ role: members.role }).from(members)
          .where(and(eq(members.organizationId, m.orgId), ne(members.userId, auth.userId)));
        if (!others.length) alone++;
        else if (m.role === "owner" && !others.some((o) => o.role === "owner")) {
          const org = await deps.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.orgId)).get();
          blocking.push(org?.name ?? m.orgId);
        }
      }
      if (blocking.length) {
        return c.json({ error: { code: "transfer_ownership_first", message: `You are the only owner of ${blocking.join(", ")}, which has other members. Make someone else an owner first.` }, workspaces: blocking }, 409);
      }
      if (demoOnly) {
        const out = await authFor(deps).api.signOut({ headers: c.req.raw.headers, asResponse: true });
        await beforeUserDelete(deps, auth.userId);
        await deps.db.delete(users).where(eq(users.id, auth.userId));
        for (const cookie of out.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
        return c.json({ ok: true, deletedWorkspaces: alone });
      }
      // A person who signs in only through the identity provider has no password to confirm with, so the
      // session itself must be recent. Checked before anything is deleted, so a stale session changes nothing.
      if (!cred?.password) {
        const s = await deps.db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, auth.sessionId)).get();
        if (!s || deps.now().getTime() - new Date(s.createdAt).getTime() > FRESH_SESSION_MS) {
          throw new HttpError(403, "reauth_required", "For your safety, sign in again to confirm it's you, then delete your account within 15 minutes.");
        }
      }
      // The sign in at the identity provider goes first: if it can't be removed, nothing is deleted and the person can retry.
      const idp = await deps.db.select({ accountId: accounts.accountId }).from(accounts)
        .where(and(eq(accounts.userId, auth.userId), eq(accounts.providerId, "auth0"))).all();
      const mgmt = deps.config.auth.auth0Management;
      if (idp.length && mgmt) {
        try {
          for (const a of idp) await deleteAuth0User(mgmt, a.accountId);
        } catch (err) {
          deps.log?.error("account.idp_delete_failed", { user: auth.userId, error: String(err) });
          throw new HttpError(502, "idp_delete_failed", `Your sign in couldn't be removed just now, so nothing was deleted. Try again in a minute, or email ${deps.config.supportEmail}.`);
        }
      } else if (idp.length) {
        deps.log?.warn("account.idp_delete_skipped", { user: auth.userId, reason: "no Auth0 management client configured" });
      }
      const res = await authFor(deps).api.deleteUser({ headers: c.req.raw.headers, body: cred?.password ? { password: body.password } : {}, asResponse: true });
      if (!res.ok) {
        if (res.status === 401 || res.status === 400) throw new HttpError(403, "reauth_required", "Sign in again to confirm it's you, then retry.");
        throw new HttpError(500, "delete_failed", "Your account could not be deleted. Try again, or contact support.");
      }
      for (const cookie of res.headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
      return c.json({ ok: true, deletedWorkspaces: alone });
    })
    .delete("/workspace", async (c) => {
      const { auth, deps } = c.var;
      const { password } = await parseBody(c, z.object({ password: z.string().max(200).optional() }));
      const { remaining } = await deleteWorkspace(deps, auth, c.req.raw.headers, password);
      return c.json({ ok: true, remaining });
    });
}
