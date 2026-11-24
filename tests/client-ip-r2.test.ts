/**
 * Round 2: where a request's client address comes from. On Workers only CF-Connecting-IP (Cloudflare sets it; a client
 * can't). On Node (self host, local) forwarded headers are believed only with TRUST_PROXY; otherwise the socket's
 * address, so a client can't pick its own address to dodge per address limits or plant one in the audit log.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { and, eq } from "drizzle-orm";
import { clientIp } from "@/server/middleware";
import type { AppEnv, Deps } from "@/server/context";
import { makeTestApp, Client } from "./helpers";
import { auditLogs } from "@/server/db/schema";

const FORGED = { "cf-connecting-ip": "7.7.7.7", "x-real-ip": "8.8.8.8", "x-forwarded-for": "6.6.6.6, 10.0.0.1" };

let server: ServerType | null = null;
afterEach(() => { server?.close(); server = null; });

/** A tiny app on a real socket that answers with clientIp, for deps shaped as each runtime sets them. */
async function served(deps: Pick<Deps, "runtime" | "config">) {
  const app = new Hono<AppEnv>().use("*", async (c, next) => { c.set("deps", deps as Deps); await next(); }).get("/ip", (c) => c.text(clientIp(c)));
  const port = await new Promise<number>((ok) => { server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => ok(info.port)); });
  return async (headers: Record<string, string> = {}) => (await fetch(`http://127.0.0.1:${port}/ip`, { headers })).text();
}
const cfg = (trustProxy: boolean) => ({ auth: { trustProxy } }) as unknown as Deps["config"];

describe("Round 2: client address", () => {
  it("Node without TRUST_PROXY: forged forwarded headers are ignored, the socket address is used", async () => {
    const ip = await served({ runtime: "node", config: cfg(false) });
    expect(await ip(FORGED)).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
    expect(await ip()).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("Node with TRUST_PROXY: the proxy's forwarded address is used", async () => {
    const ip = await served({ runtime: "node", config: cfg(true) });
    expect(await ip(FORGED)).toBe("7.7.7.7");
    expect(await ip({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" })).toBe("6.6.6.6");
  });

  it("Workers: only CF-Connecting-IP, never X-Forwarded-For or X-Real-IP, whatever TRUST_PROXY says", async () => {
    const app = new Hono<AppEnv>().use("*", async (c, next) => { c.set("deps", { runtime: "workers", config: cfg(true) } as Deps); await next(); }).get("/ip", (c) => c.text(clientIp(c)));
    expect(await (await app.request("/ip", { headers: FORGED })).text()).toBe("7.7.7.7");
    expect(await (await app.request("/ip", { headers: { "x-forwarded-for": "6.6.6.6", "x-real-ip": "8.8.8.8" } })).text()).toBe("unknown");
  });

  it("the whole app on Node without TRUST_PROXY keeps a forged address out of the audit log", async () => {
    const ctx = await makeTestApp({ TRUST_PROXY: "false" });
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const orgId = (await c.get("/api/account/me")).body.organization.id as string;
    expect((await c.call("POST", "/api/developer/keys", { name: "CI" }, FORGED)).status).toBe(201);
    const row = await ctx.db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, "api_key.created"))).get();
    expect(row?.ip).not.toBe("7.7.7.7");
    expect(row?.ip).not.toBe("6.6.6.6");
    expect(row?.ip).not.toBe("8.8.8.8");
  });
});
