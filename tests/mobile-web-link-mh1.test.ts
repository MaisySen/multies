import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq, ne } from "drizzle-orm";
import { makeTestApp, Client } from "./helpers";
import { safeNext, newWebLinkCode, isWellFormedCode, webLinkIdentifier, WEB_LINK_TTL_SECONDS } from "@/server/auth/mobile-web-link";
import { scrubEvent } from "@/shared/sentry-scrub";
import { members, organizations, sessions, users, verifications } from "@/server/db/schema";
import { RATE_LIMITS } from "@/server/lib/rate-limit";
import { newId } from "@/server/lib/crypto";
import { API_CSP } from "@/server/lib/security-headers";

const ON = { MOBILE_WEB_LINK: "on" };

async function setup(env: Record<string, string> = ON) {
  const t = await makeTestApp(env);
  const phone = new Client(t.app);
  const email = await phone.signup();
  const me = (await phone.get("/api/account/me")).body;
  return { ...t, phone, email, me };
}

/** One raw request (no cookie jar), as the in app browser makes it. */
function open(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, path: string, cookie?: string) {
  return app.request(path, { headers: { host: "localhost", ...(cookie ? { cookie } : {}) }, redirect: "manual" });
}

function sessionCookie(res: Response): string | null {
  const sc = res.headers.getSetCookie().find((c) => /session_token=/.test(c));
  return sc ? sc.split(";")[0] : null;
}

afterEach(() => vi.restoreAllMocks());

describe("MH1 safe next", () => {
  it("keeps relative paths inside the web app", () => {
    expect(safeNext("/app")).toBe("/app");
    expect(safeNext("/app/docs")).toBe("/app/docs");
    expect(safeNext("/app/contacts/people?tab=all#top")).toBe("/app/contacts/people?tab=all#top");
  });
  it.each([
    ["missing", undefined], ["empty", ""], ["other path", "/admin"], ["prefix trick", "/application"], ["protocol relative", "//evil.example/app/"],
    ["double slash inside", "/app//evil.example"], ["scheme", "https://evil.example/app/x"], ["javascript scheme", "javascript:alert(1)"],
    ["backslash", "/app/\\evil.example"], ["leading backslash", "\\\\evil.example/app"], ["encoded slash", "/app/%2f%2fevil.example"],
    ["encoded backslash", "/app/%5cevil.example"], ["double encoded slash", "/app/%252f%252fevil.example"], ["tab", "/app/\tx"],
    ["newline", "/app/\nx"], ["null", "/app/\u0000x"], ["dot dot out", "/app/../admin"], ["encoded dot dot", "/app/%2e%2e/admin"],
    ["bad encoding", "/app/%zz"], ["too long", "/app/" + "a".repeat(3000)], ["not a string", 42],
  ])("refuses %s", (_name, raw) => {
    expect(safeNext(raw)).toBe("/app");
  });
});

describe("MH1 codes", () => {
  it("are 256 random bits in base64url and stored as a hash", async () => {
    const a = newWebLinkCode(), b = newWebLinkCode();
    expect(isWellFormedCode(a)).toBe(true);
    expect(a).not.toBe(b);
    const id = await webLinkIdentifier(a);
    expect(id).toMatch(/^mwl:[0-9a-f]{64}$/);
    expect(id).not.toContain(a);
    expect(WEB_LINK_TTL_SECONDS).toBe(60);
  });
});

describe("MH1 app to web sign in handoff", () => {
  it("answers 404 on both paths while the flag is off", async () => {
    const { app, phone } = await setup({});
    expect((await phone.post("/api/auth/mobile/web-link")).status).toBe(404);
    expect((await open(app, "/auth/mobile/web?code=" + newWebLinkCode())).status).toBe(404);
  });

  it("needs the app session to make a code", async () => {
    const { app } = await setup();
    expect((await new Client(app).post("/api/auth/mobile/web-link")).status).toBe(401);
  });

  it("signs the browser in as the same person and workspace, once, with safe headers", async () => {
    const { app, db, phone, me } = await setup();
    const r = await phone.post("/api/auth/mobile/web-link");
    expect(r.status).toBe(200);
    expect(r.body.expires_in).toBe(60);
    const code = r.body.code as string;
    expect(isWellFormedCode(code)).toBe(true);
    // Only the hash is at rest.
    const rows = await db.select().from(verifications).all();
    expect(rows.some((x) => x.identifier.includes(code) || x.value.includes(code))).toBe(false);
    const ident = await webLinkIdentifier(code);
    expect(rows.filter((x) => x.identifier === ident)).toHaveLength(1);

    const res = await open(app, `/auth/mobile/web?code=${code}&next=${encodeURIComponent("/app/docs")}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/docs");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(API_CSP);
    const sc = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    const web = await app.request("/api/account/me", { headers: { host: "localhost", cookie: sessionCookie(res)! } });
    expect(web.status).toBe(200);
    const webMe = await web.json();
    expect(webMe.user?.id ?? webMe.id).toBe(me.user?.id ?? me.id);

    // Single use.
    const again = await open(app, `/auth/mobile/web?code=${code}&next=/app/docs`);
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe("/login");
    expect(sessionCookie(again)).toBeNull();
    expect(again.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("refuses an expired code (61 s) and burns it", async () => {
    const { app, db, phone } = await setup();
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    const real = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(real + 61_000);
    const res = await open(app, `/auth/mobile/web?code=${code}`);
    expect(res.headers.get("location")).toBe("/login");
    expect(sessionCookie(res)).toBeNull();
    vi.restoreAllMocks();
    expect(await db.select().from(verifications).where(eq(verifications.identifier, await webLinkIdentifier(code))).get()).toBeUndefined();
  });

  it("burns the code on the first attempt even when that attempt fails", async () => {
    const { app, db, phone, me } = await setup();
    const userId = me.user?.id ?? me.id;
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    const member = await db.select().from(members).where(eq(members.userId, userId)).get();
    await db.delete(members).where(eq(members.id, member!.id));
    const first = await open(app, `/auth/mobile/web?code=${code}`);
    expect(first.headers.get("location")).toBe("/login");
    expect(sessionCookie(first)).toBeNull();
    await db.insert(members).values(member!);
    const second = await open(app, `/auth/mobile/web?code=${code}`);
    expect(second.headers.get("location")).toBe("/login");
    expect(sessionCookie(second)).toBeNull();
  });

  it("refuses a code bound to a person who is not in the bound workspace", async () => {
    const { app, db, phone } = await setup();
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    const other = new Client(app);
    await other.signup();
    const otherId = ((await other.get("/api/account/me")).body as { user?: { id: string }; id?: string });
    const ident = await webLinkIdentifier(code);
    const row = await db.select().from(verifications).where(eq(verifications.identifier, ident)).get();
    const bound = JSON.parse(row!.value);
    await db.update(verifications).set({ value: JSON.stringify({ ...bound, u: otherId.user?.id ?? otherId.id }) }).where(eq(verifications.identifier, ident));
    const res = await open(app, `/auth/mobile/web?code=${code}`);
    expect(res.headers.get("location")).toBe("/login");
    expect(sessionCookie(res)).toBeNull();
  });

  it("opens the bound workspace and keeps the source session's age and sign in method", async () => {
    const { app, db, phone, me } = await setup();
    const userId = me.user?.id ?? me.id;
    const appSession = await db.select().from(sessions).where(eq(sessions.userId, userId)).get();
    const boundOrg = appSession!.activeOrganizationId!;
    const old = new Date(Date.now() - 3600_000);
    await db.update(sessions).set({ createdAt: old }).where(eq(sessions.id, appSession!.id));
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    // The person then moves to another workspace on the phone; the code stays bound to the first.
    const orgB = newId("org");
    await db.insert(organizations).values({ id: orgB, name: "Other", slug: orgB });
    await db.insert(members).values({ id: newId("mem"), organizationId: orgB, userId, role: "owner" });
    await db.update(sessions).set({ activeOrganizationId: orgB, updatedAt: new Date() }).where(eq(sessions.id, appSession!.id));
    const res = await open(app, `/auth/mobile/web?code=${code}&next=/app/home`);
    expect(res.headers.get("location")).toBe("/app/home");
    const created = await db.select().from(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, appSession!.id))).get();
    expect(created!.activeOrganizationId).toBe(boundOrg);
    expect(created!.createdAt.getTime()).toBe(old.getTime());
    expect(created!.loginMethod).toBe(appSession!.loginMethod ?? "email");
  });

  it("sends a bad next to /app", async () => {
    const { app, phone } = await setup();
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    const res = await open(app, `/auth/mobile/web?code=${code}&next=${encodeURIComponent("//evil.example/app/x")}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app");
    expect(sessionCookie(res)).not.toBeNull();
  });

  it("refuses a malformed code without touching the store", async () => {
    const { app } = await setup();
    for (const bad of ["", "short", "x".repeat(44), "a".repeat(42) + "!"]) {
      const res = await open(app, `/auth/mobile/web?code=${encodeURIComponent(bad)}`);
      expect(res.headers.get("location")).toBe("/login");
    }
  });

  it("refuses an operator's view as session", async () => {
    const { db, phone, me } = await setup();
    await db.update(sessions).set({ impersonatedBy: "usr_operator" }).where(eq(sessions.userId, me.user?.id ?? me.id));
    expect((await phone.post("/api/auth/mobile/web-link")).status).toBe(403);
  });

  it("refuses a banned person", async () => {
    const { app, db, phone, me } = await setup();
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    await db.update(users).set({ banned: true }).where(eq(users.id, me.user?.id ?? me.id));
    const res = await open(app, `/auth/mobile/web?code=${code}`);
    expect(res.headers.get("location")).toBe("/login");
    expect(sessionCookie(res)).toBeNull();
  });

  it("rate limits new codes per person and redeems per address", async () => {
    const { app, phone } = await setup();
    let last = 0;
    for (let i = 0; i <= RATE_LIMITS.handoff; i++) last = (await phone.post("/api/auth/mobile/web-link")).status;
    expect(last).toBe(429);
    let lastGet = 0;
    for (let i = 0; i <= RATE_LIMITS.handoff; i++) lastGet = (await open(app, "/auth/mobile/web?code=bad")).status;
    expect(lastGet).toBe(429);
  });

  it("never writes the code into a log line", async () => {
    const { app, deps, phone } = await setup();
    const lines: string[] = [];
    const rec = (level: string) => (msg: string, fields?: Record<string, unknown>) => { lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`); };
    const logger = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"), child: () => logger };
    (deps as { log: unknown }).log = logger;
    const code = (await phone.post("/api/auth/mobile/web-link")).body.code as string;
    await open(app, `/auth/mobile/web?code=${code}&next=/app/docs`);
    await open(app, `/auth/mobile/web?code=${code}&next=/app/docs`);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(code);
  });

  it("scrubs the code from error reports", () => {
    const code = newWebLinkCode();
    const url = `https://multies.example/auth/mobile/web?code=${code}&next=/app/docs`;
    const e = scrubEvent({
      message: `failed ${url}`,
      request: { url, query_string: `code=${code}` },
      exception: { values: [{ value: `boom at ${url}` }] },
      breadcrumbs: [{ message: `nav ${url}`, data: { url, to: url } }],
      extra: { where: url },
    } as never);
    expect(JSON.stringify(e)).not.toContain(code);
  });
});
