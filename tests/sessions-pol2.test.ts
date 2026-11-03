import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeTestApp, Client } from "./helpers";

/** POL2 (HQ MB-345): the Devices card read. Better Auth's list answers 403 once a session is past its fresh window. */
let ctx: Awaited<ReturnType<typeof makeTestApp>>;
beforeEach(async () => { ctx = await makeTestApp(); });
afterEach(() => { vi.useRealTimers(); });

describe("devices list (POL2, HQ MB-345)", () => {
  it("lists only my own sessions, still 200 after the fresh window, with no tokens", async () => {
    const a = new Client(ctx.app);
    await a.signup("dev-a@example.com");
    const a2 = new Client(ctx.app);
    await a2.call("POST", "/api/auth/sign-in/email", { email: "dev-a@example.com", password: "a-strong-password" }, { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1" });
    const b = new Client(ctx.app);
    await b.signup("dev-b@example.com");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 20 * 60_000 });
    expect((await a.get("/api/auth/list-sessions")).status).toBe(403); // the cause: Better Auth's fresh window
    const mine = await a.get("/api/account/sessions");
    expect(mine.status).toBe(200);
    expect(mine.body.sessions).toHaveLength(2);
    expect(mine.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(JSON.stringify(mine.body)).not.toMatch(/token/i);
    const theirs = await b.get("/api/account/sessions");
    expect(theirs.body.sessions).toHaveLength(1);
    const theirIds = theirs.body.sessions.map((s: { id: string }) => s.id);
    expect(mine.body.sessions.some((s: { id: string }) => theirIds.includes(s.id))).toBe(false);
  });

  it("signs out my other device, 404 for another person's session, 400 for this one, 401 signed out", async () => {
    const a = new Client(ctx.app);
    await a.signup("rev-a@example.com");
    const a2 = new Client(ctx.app);
    await a2.call("POST", "/api/auth/sign-in/email", { email: "rev-a@example.com", password: "a-strong-password" });
    const b = new Client(ctx.app);
    await b.signup("rev-b@example.com");
    const list = (await a.get("/api/account/sessions")).body.sessions as { id: string; current: boolean }[];
    const other = list.find((s) => !s.current)!;
    const self = list.find((s) => s.current)!;
    const bId = ((await b.get("/api/account/sessions")).body.sessions as { id: string }[])[0].id;
    expect((await a.post(`/api/account/sessions/${bId}/revoke`, {})).status).toBe(404);
    expect((await b.get("/api/account/me")).status).toBe(200);
    expect((await a.post(`/api/account/sessions/${self.id}/revoke`, {})).status).toBe(400);
    expect((await a.post(`/api/account/sessions/${other.id}/revoke`, {})).status).toBe(200);
    expect((await a2.get("/api/account/me")).status).toBe(401);
    expect((await a.get("/api/account/me")).status).toBe(200);
    const anon = new Client(ctx.app);
    expect((await anon.get("/api/account/sessions")).status).toBe(401);
    expect((await anon.post(`/api/account/sessions/${other.id}/revoke`, {})).status).toBe(401);
  });
});
