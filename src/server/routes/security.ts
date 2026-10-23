import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { emailSchema, passwordSchema } from "@/shared/schemas";
import { audit } from "../services/audit";
import { RateLimiter } from "../lib/rate-limit";
import { tooMany } from "../lib/errors";
import {
  beginTotpSetup, completePasswordReset, confirmTotpSetup, describeResetToken, disableTotp, listSessions,
  regenerateRecoveryCodes, requestPasswordReset, revokeSession, securityOverview, sendVerificationEmail, verifyEmail,
} from "../services/security";

async function auditFor(c: { var: AppEnv["Variables"] }, action: string, metadata?: Record<string, unknown>) {
  const { auth, deps, ip } = c.var;
  await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action, metadata, ip });
}

/** Password reset, email verification, 2FA and device management. Mounted under /api/auth. */
export function securityRoutes() {
  const resetLimiter = new RateLimiter(5, 15 * 60_000);
  const verifyLimiter = new RateLimiter(5, 60 * 60_000);
  const sensitive = new RateLimiter(10, 15 * 60_000);
  return new Hono<AppEnv>()
    .post("/password/forgot", async (c) => {
      const { email } = await parseBody(c, z.object({ email: emailSchema }));
      if (!resetLimiter.take(c.var.ip) || !resetLimiter.take(`e:${email}`)) throw tooMany();
      const res = await requestPasswordReset(c.var.deps, email);
      return c.json({ ok: true, deliveryConnected: c.var.deps.outbound.name !== "log", ...(res.devLink ? { devLink: res.devLink } : {}) });
    })
    .get("/password/reset/:token", async (c) => c.json(await describeResetToken(c.var.deps.db, c.req.param("token"), c.var.deps.now())))
    .post("/password/reset", async (c) => {
      if (!resetLimiter.take(`r:${c.var.ip}`)) throw tooMany();
      const { token, password } = await parseBody(c, z.object({ token: z.string().min(10), password: passwordSchema }));
      const user = await completePasswordReset(c.var.deps.db, token, password, c.var.deps.now());
      const m = await c.var.deps.db.query.memberships.findFirst({ where: (t, { eq }) => eq(t.userId, user.id) });
      if (m) await audit(c.var.deps.db, { orgId: m.orgId, actorUserId: user.id, actorEmail: user.email, action: "auth.password_reset", ip: c.var.ip });
      return c.json({ ok: true });
    })
    .post("/verify-email", async (c) => {
      const { token } = await parseBody(c, z.object({ token: z.string().min(10) }));
      const user = await verifyEmail(c.var.deps.db, token, c.var.deps.now());
      return c.json({ ok: true, email: user.email });
    })
    .use("/security/*", requireAuth)
    .use("/sessions", requireAuth)
    .use("/sessions/*", requireAuth)
    .get("/security", requireAuth, async (c) => c.json(await securityOverview(c.var.deps.db, c.var.auth.userId)))
    .post("/security/verify-email/send", async (c) => {
      if (!verifyLimiter.take(c.var.auth.userId)) throw tooMany("You've asked for a few of these already. Check your inbox, or try again in an hour.");
      const res = await sendVerificationEmail(c.var.deps, c.var.auth.userId);
      return c.json({ ...res, deliveryConnected: c.var.deps.outbound.name !== "log" });
    })
    .post("/security/2fa/setup", async (c) => c.json(await beginTotpSetup(c.var.deps, c.var.auth.userId)))
    .post("/security/2fa/enable", async (c) => {
      if (!sensitive.take(`2fa:${c.var.auth.userId}`)) throw tooMany();
      const { code } = await parseBody(c, z.object({ code: z.string().min(6).max(12) }));
      const recoveryCodes = await confirmTotpSetup(c.var.deps, c.var.auth.userId, code);
      await auditFor(c, "auth.2fa_enabled");
      return c.json({ recoveryCodes });
    })
    .post("/security/2fa/disable", async (c) => {
      if (!sensitive.take(`2fa:${c.var.auth.userId}`)) throw tooMany();
      const { password } = await parseBody(c, z.object({ password: z.string().min(1, "Enter your password") }));
      await disableTotp(c.var.deps.db, c.var.auth.userId, password);
      await auditFor(c, "auth.2fa_disabled");
      return c.json({ ok: true });
    })
    .post("/security/2fa/recovery-codes", async (c) => {
      if (!sensitive.take(`2fa:${c.var.auth.userId}`)) throw tooMany();
      const { password } = await parseBody(c, z.object({ password: z.string().min(1, "Enter your password") }));
      const recoveryCodes = await regenerateRecoveryCodes(c.var.deps.db, c.var.auth.userId, password);
      await auditFor(c, "auth.recovery_codes_regenerated");
      return c.json({ recoveryCodes });
    })
    .get("/sessions", async (c) => c.json({ sessions: await listSessions(c.var.deps.db, c.var.auth.userId, c.var.auth.sessionId, c.var.deps.now()) }))
    .delete("/sessions/:id", async (c) => {
      await revokeSession(c.var.deps.db, c.var.auth.userId, c.req.param("id"), c.var.auth.sessionId);
      await auditFor(c, "auth.session_revoked");
      return c.json({ ok: true });
    });
}
