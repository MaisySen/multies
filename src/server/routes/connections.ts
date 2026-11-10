import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context";
import { parseBody, requireAuth } from "../middleware";
import { HttpError, tooMany } from "../lib/errors";
import { RateLimiter } from "../lib/rate-limit";
import { audit } from "../services/audit";
import {
  connectEnabled, connectionFor, createConnection, listConnections, openableConnections, reconnect, removeConnection, testConnection,
} from "../services/connect";
import { ConnectFailed } from "../services/connect/problems";
import { setBackfillPaused, syncAndChain, syncConnection } from "../services/connect/sync";
import { LIVE_WINDOW_SECONDS, localLiveMail, type LiveMode } from "../services/connect/live";
import { listFolders, setFolderSync } from "../services/connect/folders";
import { directOAuthRoutes } from "./direct-social";
import { oauthAvailable, oauthFinish, oauthStart, type OAuthProvider } from "../services/connect/oauth";
import { PRESET_ORDER } from "@/shared/mail-connect";

const server = z.object({
  host: z.string().trim().max(253).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  security: z.enum(["tls", "starttls"]).optional(),
}).optional();

const connectBody = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(512),
  preset: z.enum(PRESET_ORDER as [string, ...string[]]).optional(),
  username: z.string().trim().max(320).optional(),
  displayName: z.string().trim().max(100).optional(),
  imap: server,
  smtp: server,
});

/** A failed connection test answers 422 with the problem, in words a person can act on. */
function failed(problem: ConnectFailed["problem"]) {
  return new HttpError(422, problem.code, problem.message, { step: problem.step });
}

export function connectionRoutes() {
  // Each test signs in to a real provider: a few an hour per person keeps this from being used to try passwords.
  const tests = new RateLimiter(10, 15 * 60_000);
  const syncs = new RateLimiter(6, 60_000);
  // The open app beats every 10 seconds and pokes once a minute; a few spare for tabs and focus changes.
  const beats = new RateLimiter(20, 60_000);
  const pokes = new RateLimiter(4, 60_000);
  const guard = (userId: string) => { if (!tests.take(userId)) throw tooMany("Too many tries in a short time. Wait a few minutes, then try again."); };
  const run = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (err) { if (err instanceof ConnectFailed) throw failed(err.problem); throw err; }
  };
  return new Hono<AppEnv>()
    .use("*", requireAuth)
    .get("/", async (c) => c.json({
      enabled: connectEnabled(c.var.deps),
      oauth: oauthAvailable(c.var.deps),
      connections: await listConnections(c.var.deps, c.var.auth),
    }))
    /**
     * Live mail heartbeat (round 19), sent while Multies is open. `poke` opens or extends each
     * connection's live window; every beat answers each connection's synced count, so the app
     * refreshes the list as soon as new mail is in. Reads only.
     */
    .post("/live", async (c) => {
      const { deps, auth } = c.var;
      if (!beats.take(auth.userId)) throw tooMany("Too many live checks. Slow down a little.");
      const b = await parseBody(c, z.object({ poke: z.boolean().optional(), wait: z.number().int().min(0).max(25_000).optional(), since: z.number().int().min(0).optional() }));
      // PRIV1b (P46): only connections this person can open, then the cap (an older connection of their own still gets live mail).
      let list = (await openableConnections(deps, auth)).filter((x) => ["active", "error", "syncing"].includes(x.status)).slice(0, 5);
      const modes = new Map<string, LiveMode>();
      if (b.poke && deps.config.mailConnect.enabled && deps.config.mailConnect.live && pokes.take(auth.userId)) {
        const touch = deps.liveMail ?? ((id: string, sec: number) => localLiveMail(deps).touch(id, sec));
        await Promise.all(list.map(async (x) => {
          try { modes.set(x.id, (await touch(x.id, LIVE_WINDOW_SECONDS)).mode); } catch (err) {
            deps.log?.warn("mail_live.poke_failed", { connection: x.id, error: (err as Error).message });
          }
        }));
      }
      // A long poll: wait for any live window to store new mail, then answer the new counts.
      // `since` is the count the app last saw: when mail came in between two heartbeats, answer at once.
      const stampNow = list.reduce((n, x) => n + x.messagesSynced, 0);
      if (b.wait && list.length && deps.config.mailConnect.enabled && deps.config.mailConnect.live && (b.since === undefined || b.since === stampNow)) {
        const wait = deps.liveWait ?? ((id: string, ms: number) => localLiveMail(deps).waitForMail(id, ms));
        const stored = await Promise.race([
          ...list.map((x) => wait(x.id, b.wait!).then((v) => (v ? true : new Promise<boolean>(() => {})))),
          new Promise<boolean>((r) => setTimeout(() => r(false), b.wait)),
        ]);
        if (stored) list = (await openableConnections(deps, auth)).filter((x) => list.some((y) => y.id === x.id));
      }
      return c.json({
        live: deps.config.mailConnect.live,
        connections: list.map((x) => ({ id: x.id, mode: modes.get(x.id) ?? null, messagesSynced: x.messagesSynced, lastSyncAt: x.lastSyncAt, status: x.status })),
        stamp: list.reduce((n, x) => n + x.messagesSynced, 0),
      }, 200, { "cache-control": "no-store" });
    })
    .post("/test", async (c) => {
      guard(c.var.auth.userId);
      const b = await parseBody(c, connectBody);
      return c.json(await run(() => testConnection(c.var.deps, b as never)));
    })
    .post("/", async (c) => {
      guard(c.var.auth.userId);
      const b = await parseBody(c, connectBody);
      const { deps, auth } = c.var;
      const connection = await run(() => createConnection(deps, auth, b as never));
      // The first pass runs now so the inbox has mail when the person opens it; the rest follows on its own.
      const first = deps.dispatchMailSync ? deps.dispatchMailSync(connection.id) : syncAndChain(deps, connection.id);
      const work = first.catch((err) => deps.log?.warn("mail_sync.first_failed", { connection: connection.id, error: (err as Error).message }));
      // Workers keep the pass running after the answer; Node (no execution context) waits for it.
      let waitUntil: ((p: Promise<unknown>) => void) | undefined;
      try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
      if (waitUntil) waitUntil(work); else await work;
      const fresh = (await openableConnections(deps, auth)).find((x) => x.id === connection.id) ?? connection;
      return c.json({ connection: fresh }, 201);
    })
    .post("/:id/sync", async (c) => {
      const { deps, auth } = c.var;
      if (!syncs.take(auth.userId)) throw tooMany("Syncing already. Give it a minute.");
      const conn = await connectionFor(deps, auth, c.req.param("id"), "run"); // PRIV1b (P14)
      const result = await syncConnection(deps, conn.id, { force: true });
      // R57: when more is waiting (new or older mail), the following passes run on their own.
      if (result.more && !result.skipped) {
        const chainMs = deps.config.mailConnect.chainMs;
        const next: Promise<unknown> = deps.dispatchMailSync
          ? deps.dispatchMailSync(conn.id).catch(() => undefined)
          : chainMs > 0 ? new Promise((res) => setTimeout(res, chainMs)).then(() => syncAndChain(deps, conn.id)).catch(() => undefined) : Promise.resolve();
        try { c.executionCtx.waitUntil(next); } catch { void next; }
      }
      const fresh = (await openableConnections(deps, auth)).find((x) => x.id === conn.id);
      return c.json({ result: { stored: result.stored, more: result.more, error: result.error ?? null, skipped: result.skipped ?? null }, connection: fresh });
    })
    // R57: pause or resume copying older mail (new mail keeps coming either way).
    .post("/:id/backfill", async (c) => {
      const { deps, auth } = c.var;
      const b = await parseBody(c, z.object({ paused: z.boolean() }));
      const conn = await connectionFor(deps, auth, c.req.param("id"), "run"); // PRIV1b (P14)
      await setBackfillPaused(deps, conn.id, b.paused);
      if (!b.paused && deps.dispatchMailSync) { try { c.executionCtx.waitUntil(deps.dispatchMailSync(conn.id).catch(() => undefined)); } catch { /* Node: the next scheduled pass */ } }
      const fresh = (await openableConnections(deps, auth)).find((x) => x.id === conn.id);
      return c.json({ connection: fresh });
    })
    // Round 19: the provider's folders, and which of the person's own folders sync.
    .get("/:id/folders", async (c) => {
      const refresh = c.req.query("refresh") === "1";
      if (refresh) guard(c.var.auth.userId);
      return c.json(await run(() => listFolders(c.var.deps, c.var.auth, c.req.param("id"), { refresh })));
    })
    .put("/:id/folders", async (c) => {
      const b = await parseBody(c, z.object({ path: z.string().min(1).max(500), sync: z.boolean() }));
      const { deps, auth } = c.var;
      const out = await setFolderSync(deps, auth, c.req.param("id"), b.path, b.sync);
      if (b.sync) {
        const work = (deps.dispatchMailSync ? deps.dispatchMailSync(c.req.param("id")) : syncConnection(deps, c.req.param("id"))).catch(() => undefined);
        let waitUntil: ((p: Promise<unknown>) => void) | undefined;
        try { const ctx = c.executionCtx; waitUntil = ctx.waitUntil.bind(ctx); } catch { waitUntil = undefined; }
        if (waitUntil) waitUntil(work); else await work;
      }
      return c.json(out);
    })
    .put("/:id", async (c) => {
      guard(c.var.auth.userId);
      const b = await parseBody(c, z.object({ password: z.string().min(1).max(512), username: z.string().trim().max(320).optional(), imap: server, smtp: server }));
      return c.json({ connection: await run(() => reconnect(c.var.deps, c.var.auth, c.req.param("id"), b as never)) });
    })
    .delete("/:id", async (c) => c.json(await removeConnection(c.var.deps, c.var.auth, c.req.param("id"))))
    .route("/", directOAuthRoutes()) // R83: TikTok and Threads sign in, before the mail providers
    .get("/oauth/:provider/start", async (c) => {
      const p = c.req.param("provider") as OAuthProvider;
      if (p !== "google" && p !== "microsoft") throw new HttpError(404, "not_found", "No such provider.");
      return c.redirect(await oauthStart(c.var.deps, c.var.auth, p));
    })
    .get("/oauth/:provider/callback", async (c) => {
      const p = c.req.param("provider") as OAuthProvider;
      if (p !== "google" && p !== "microsoft") throw new HttpError(404, "not_found", "No such provider.");
      const back = (q: Record<string, string>) => c.redirect(`/app/settings/apps/mail?${new URLSearchParams(q)}`);
      const code = c.req.query("code");
      const state = c.req.query("state");
      if (!code || !state) return back({ error: c.req.query("error") === "access_denied" ? "You cancelled the sign in." : "The sign in didn't finish." });
      const { deps, auth } = c.var;
      try {
        const done = await oauthFinish(deps, auth, p, code, state);
        const conn = await createConnection(deps, auth, { email: done.email, password: done.refreshToken, preset: done.preset }, { secret: done.refreshToken, authKind: "oauth" });
        await audit(deps.db, { orgId: auth.orgId, actorUserId: auth.userId, actorEmail: auth.email, action: "mailbox.oauth_connected", targetType: "mailbox", targetId: conn.mailboxId, metadata: { provider: p } });
        if (deps.dispatchMailSync) await deps.dispatchMailSync(conn.id).catch(() => undefined);
        return back({ connected: conn.email });
      } catch (err) {
        return back({ error: err instanceof HttpError ? err.message : "The sign in didn't finish. Try again." });
      }
    });
}
