/**
 * Wave 1 review V10: Better Auth reads the client address from x-multies-client-ip. The /api/auth handler sets it, but
 * in-process Better Auth calls (getSession in guards, sign out and delete in account.ts, team.ts) pass the request's
 * own headers, so a client could send that header and pick its address there. The app now drops it first of all.
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { CLIENT_IP_HEADER, stripClientIpHeader } from "@/server/middleware";
import { makeTestApp, Client } from "./helpers";

describe("Wave 1 review V10: a client-sent x-multies-client-ip never reaches a handler", () => {
  it("the middleware removes it and keeps the rest of the request", async () => {
    const app = new Hono().use("*", stripClientIpHeader).post("/x", async (c) => c.json({ ip: c.req.raw.headers.get(CLIENT_IP_HEADER), other: c.req.header("x-other"), body: await c.req.json() }));
    const r = await app.request("/x", { method: "POST", headers: { [CLIENT_IP_HEADER]: "1.2.3.4", "x-other": "kept", "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) });
    expect(await r.json()).toEqual({ ip: null, other: "kept", body: { a: 1 } });
  });

  it("the app installs it before everything else: a forged header changes nothing for a signed-in call", async () => {
    const ctx = await makeTestApp();
    const c = new Client(ctx.app);
    await c.signup("owner@acme.io");
    const me = await c.call("GET", "/api/account/me", undefined, { [CLIENT_IP_HEADER]: "9.9.9.9" });
    expect(me.status).toBe(200);
    const src = (await import("node:fs")).readFileSync("src/server/app.ts", "utf8");
    const first = src.indexOf("app.use(");
    expect(src.slice(first, first + 40)).toContain("stripClientIpHeader");
  });
});
