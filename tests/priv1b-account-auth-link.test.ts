/**
 * PRIV1b batch "account-auth", mobile web link: P20 (login CSRF: a cross site link or another person's code never
 * replaces this browser's session) and P33 a, b (a well formed code is burned even when the limiter answers 429;
 * malformed codes are refused before any database write).
 */
import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
const sessionCookie = (res: Response) => res.headers.getSetCookie().find((c) => /session_token=/.test(c) && !/max-age=0/i.test(c))?.split(";")[0] ?? null;
const open = (app: App, p: string, h: Record<string, string> = {}) => app.request(p, { headers: { host: "localhost", "cf-connecting-ip": "203.0.113.7", ...h }, redirect: "manual" });
const whoIs = async (app: App, cookie: string) => ((await (await app.request("/api/account/me", { headers: { host: "localhost", cookie } })).json()) as { user?: { id: string } }).user?.id;
const mint = async (c: Client, next = "/app/settings/apps/mail") => (await c.post("/api/auth/mobile/web-link", { next })).body.code as string;
const link = (code: string, next = "/app/settings/apps/mail") => `/auth/mobile/web?code=${code}&next=${encodeURIComponent(next)}`;

describe("PRIV1b (P20): mobile web link login CSRF", () => {
  it("a link followed from another site is refused and its code is burned", async () => {
    const t = await makeTestApp({ MOBILE_WEB_LINK: "on" });
    const attacker = new Client(t.app);
    await attacker.signup();
    const code = await mint(attacker);
    const res = await open(t.app, link(code), { "sec-fetch-site": "cross-site", referer: "https://attacker.example/" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(sessionCookie(res)).toBeNull();
    // Same site counts as another site too (a sibling subdomain).
    const code2 = await mint(attacker);
    expect(sessionCookie(await open(t.app, link(code2), { "sec-fetch-site": "same-site" }))).toBeNull();
    // Burned: the same code now finds nothing, even when opened directly.
    const again = await open(t.app, link(code), { "sec-fetch-site": "none" });
    expect(again.headers.get("location")).toBe("/login");
    expect(sessionCookie(again)).toBeNull();
  });

  it("the app's own in app browser (Sec-Fetch-Site none, or no header) still signs in", async () => {
    const t = await makeTestApp({ MOBILE_WEB_LINK: "on" });
    const phone = new Client(t.app);
    await phone.signup();
    const me = (await phone.get("/api/account/me")).body.user.id as string;
    const r = await open(t.app, link(await mint(phone)), { "sec-fetch-site": "none" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app/settings/apps/mail");
    expect(await whoIs(t.app, sessionCookie(r)!)).toBe(me);
    const r2 = await open(t.app, link(await mint(phone), "/app/meetings"));
    expect(r2.headers.get("location")).toBe("/app/meetings");
    expect(await whoIs(t.app, sessionCookie(r2)!)).toBe(me);
  });

  it("a browser signed in as someone else keeps its session and opens the page marked account=kept", async () => {
    const t = await makeTestApp({ MOBILE_WEB_LINK: "on" });
    const attacker = new Client(t.app);
    await attacker.signup();
    const victim = new Client(t.app);
    await victim.signup();
    const victimId = (await victim.get("/api/account/me")).body.user.id as string;
    const code = await mint(attacker);
    const res = await open(t.app, link(code), { cookie: victim.cookie });
    expect(res.status).toBe(302);
    // MEET fixes (12 Nov 2026): the page is kept (it was /app, which lost a meeting link) and says this browser kept its account.
    expect(res.headers.get("location")).toBe("/app/settings/apps/mail?account=kept");
    expect(sessionCookie(res)).toBeNull();
    expect(await whoIs(t.app, victim.cookie)).toBe(victimId);
    // The same person's code in their own signed in browser goes through.
    const own = await open(t.app, link(await mint(victim)), { cookie: victim.cookie });
    expect(own.headers.get("location")).toBe("/app/settings/apps/mail");
    expect(await whoIs(t.app, sessionCookie(own)!)).toBe(victimId);
  });
});

describe("PRIV1b (P33): limiter and burning", () => {
  it("junk codes write nothing; a 429 still burns a well formed code", async () => {
    const t = await makeTestApp({ MOBILE_WEB_LINK: "on" });
    const phone = new Client(t.app);
    await phone.signup();
    const before = (await (t.db as never as { all: (q: unknown) => Promise<unknown[]> }).all(sql`SELECT key FROM api_rate_limits WHERE key LIKE 'rl:handoff:%'`)).length;
    for (let i = 0; i < 25; i++) {
      const r = await open(t.app, "/auth/mobile/web?code=junk");
      expect(r.headers.get("location")).toBe("/login");
    }
    const after = (await (t.db as never as { all: (q: unknown) => Promise<unknown[]> }).all(sql`SELECT key FROM api_rate_limits WHERE key LIKE 'rl:handoff:%'`)).length;
    expect(after).toBe(before);
    const code = await mint(phone, "/app/meetings");
    // The query does see the limiter: one well formed (unknown) code from another address adds a row.
    await open(t.app, link(`B00${"x".repeat(40)}`), { "cf-connecting-ip": "198.51.100.8" });
    const seen = (await (t.db as never as { all: (q: unknown) => Promise<unknown[]> }).all(sql`SELECT key FROM api_rate_limits WHERE key LIKE 'rl:handoff:%'`)).length;
    expect(seen).toBeGreaterThan(after);
    // Fill this address's minute with well formed (unknown) codes.
    const fake = (i: number) => `A${String(i).padStart(2, "0")}${"x".repeat(40)}`;
    for (let i = 0; i < 25; i++) await open(t.app, link(fake(i)));
    const limited = await open(t.app, link(code, "/app/meetings"));
    expect(limited.status).toBe(302);
    expect(limited.headers.get("location")).toBe("/login?error=rate_limited");
    expect(sessionCookie(limited)).toBeNull();
    // Whoever reads the URL from history afterwards, from another address, gets nothing.
    const thief = await open(t.app, link(code, "/app/meetings"), { "cf-connecting-ip": "198.51.100.9" });
    expect(thief.headers.get("location")).toBe("/login");
    expect(sessionCookie(thief)).toBeNull();
  });
});
