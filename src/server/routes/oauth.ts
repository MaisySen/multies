/**
 * OAuth for the MCP endpoint (round 20). Public endpoints (metadata, registration, token, revoke) take
 * no cookies, answer CORS, and are rate limited per IP; the consent step uses the signed in session.
 * See services/developer/oauth.ts.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { audit } from "../services/audit";
import {
  OAuthError, approve, authorizationServerMetadata, checkAuthorizeRequest, deny, listGrants, protectedResourceMetadata, registerClient, revokeGrant, revokeToken, token, workspacesFor,
  type AuthorizeRequest,
} from "../services/developer/oauth";
import { writeBudget } from "../services/write-budget";
import { HttpError } from "../lib/errors";
import { ssoBlocks } from "../auth/session";

/** Every `scope` value, so `scope=mcp:read&scope=mcp:write` is not collapsed to one word. */
function authorizeQuery(c: Context<AppEnv>): AuthorizeRequest {
  const q = { ...c.req.query() } as AuthorizeRequest;
  const scopes = c.req.queries("scope");
  if (scopes?.length) q.scope = scopes.join(" ");
  return q;
}

const origin = (c: Context<AppEnv>) => {
  const u = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? u.protocol.slice(0, -1);
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? u.host;
  return `${proto}://${host}`;
};

/** Form or JSON bodies: OAuth clients send application/x-www-form-urlencoded; some send JSON. */
async function readParams(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const text = (await c.req.text()).slice(0, 20_000);
  if (type === "application/json") {
    try {
      const o = JSON.parse(text || "{}") as Record<string, unknown>;
      return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string")) as Record<string, string>;
    } catch { throw new OAuthError(400, "invalid_request", "Malformed JSON body."); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

const oauthErr = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof OAuthError) return c.json(e.body(), e.status as 400);
  throw e;
};

const publicCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "authorization", "mcp-protocol-version"], maxAge: 86400 });

/** /.well-known metadata, mounted at the app root. */
export function oauthWellKnownRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", publicCors);
  const prm = (c: Context<AppEnv>) => c.json(protectedResourceMetadata(origin(c)), 200, { "cache-control": "public, max-age=3600" });
  const asm = (c: Context<AppEnv>) => c.json(authorizationServerMetadata(origin(c)), 200, { "cache-control": "public, max-age=3600" });
  r.get("/oauth-protected-resource", prm);
  r.get("/oauth-protected-resource/*", prm);
  r.get("/oauth-authorization-server", asm);
  r.get("/oauth-authorization-server/*", asm);
  // Some clients look for OpenID metadata first; the same document answers.
  r.get("/openid-configuration", asm);
  return r;
}

/** /api/oauth: registration, token, revoke (public) and the consent step (session). */
export function oauthRoutes() {
  const r = new Hono<AppEnv>();
  r.use("/register", publicCors);
  r.use("/token", publicCors);
  r.use("/revoke", publicCors);

  r.post("/register", async (c) => {
    try {
      const level = (await writeBudget(c.var.deps)).level;
      if (level === "shed") return c.json({ error: "temporarily_unavailable", error_description: "Registration is paused for today. Try again tomorrow." }, 503);
      let body: unknown;
      try { body = JSON.parse((await c.req.text()).slice(0, 20_000) || "{}"); } catch { throw new OAuthError(400, "invalid_client_metadata", "Send the client metadata as JSON."); }
      return c.json(await registerClient(c.var.deps, (body ?? {}) as Record<string, unknown>), 201);
    } catch (e) { return oauthErr(c, e); }
  });

  r.post("/token", async (c) => {
    try {
      const params = await readParams(c);
      return c.json(await token(c.var.deps, params), 200, { "cache-control": "no-store", pragma: "no-cache" });
    } catch (e) { return oauthErr(c, e); }
  });

  r.post("/revoke", async (c) => {
    try {
      const params = await readParams(c);
      if (params.token) await revokeToken(c.var.deps, params.token);
      return c.body(null, 200);
    } catch (e) { return oauthErr(c, e); }
  });

  // Consent: what the sign in page shows.
  r.get("/authorize", requireAuth, async (c) => {
    const q = authorizeQuery(c);
    try {
      const req = await checkAuthorizeRequest(c.var.deps, q);
      const workspaces = (await workspacesFor(c.var.deps, c.var.auth.userId)).filter((w) => !w.suspendedAt)
        // PRIV1b (P41): say up front which workspaces this sign in can't connect, instead of a 403 after Allow.
        .map((w) => ({ id: w.id, name: w.name, role: w.role, ssoRequired: ssoBlocks(w.requireSso, w.role, c.var.auth.loginMethod) }));
      let redirectHost = req.redirectUri;
      try { const u = new URL(req.redirectUri); redirectHost = u.host || `${u.protocol}//`; } catch { /* checked already */ }
      return c.json({ client: { name: req.client.name, uri: req.client.clientUri }, redirectHost, requestedScope: req.requestedScope, workspaces, activeOrgId: c.var.auth.orgId, user: { name: c.var.auth.name, email: c.var.auth.email } });
    } catch (e) {
      if (e instanceof OAuthError) return c.json({ error: { code: e.error, message: e.description } }, 400);
      throw e;
    }
  });

  r.post("/authorize", requireAuth, async (c) => {
    const input = await parseBody(c, z.object({
      decision: z.enum(["allow", "deny"]), orgId: z.string().max(64).optional(), scope: z.enum(["read", "full"]).default("full"),
      request: z.record(z.string(), z.string().max(4000)),
    }));
    const { deps, auth } = c.var;
    try {
      if (input.decision === "deny") return c.json(await deny(deps, input.request));
      const out = await approve(deps, auth, input.request, { orgId: input.orgId ?? auth.orgId, scope: input.scope }, origin(c));
      await audit(deps.db, { orgId: out.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "oauth.connected", targetType: "oauth_grant", targetId: out.grantId, metadata: { scope: out.scope }, ip: c.var.ip });
      return c.json({ redirectTo: out.redirectTo });
    } catch (e) {
      if (e instanceof OAuthError) throw new HttpError(400, e.error, e.description);
      throw e;
    }
  });

  // Settings, Developers: connected AI apps.
  r.get("/grants", requireAuth, async (c) => c.json({ grants: await listGrants(c.var.deps, c.var.auth) }));
  r.delete("/grants/:id", requireAuth, async (c) => {
    const { deps, auth } = c.var;
    const g = await revokeGrant(deps, auth, c.req.param("id"));
    await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "oauth.disconnected", targetType: "oauth_grant", targetId: g.id, ip: c.var.ip });
    return c.json({ ok: true });
  });
  return r;
}
