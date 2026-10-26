import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { HOST_SESSION_COOKIE, SECURE_SESSION_COOKIE, hostSessionCookie, rewriteRequestCookie, rewriteSetCookie } from "../src/server/lib/host-cookie";

function app(enabled = true) {
  const a = new Hono();
  a.use("*", hostSessionCookie(enabled));
  a.get("/seen", (c) => c.text(c.req.header("cookie") ?? ""));
  a.post("/login", (c) => {
    c.header("set-cookie", `${SECURE_SESSION_COOKIE}=tok.sig; Max-Age=2592000; Domain=multies.si; Path=/; HttpOnly; Secure; SameSite=Lax`, { append: true });
    c.header("set-cookie", "other=1; Path=/", { append: true });
    return c.json({ ok: true });
  });
  a.get("/fail", (c) => c.json({ error: true }, 401));
  return a;
}

describe("R31 __Host- session cookie", () => {
  it("hands the __Host- cookie to Better Auth under the old name and keeps other cookies", () => {
    const r = rewriteRequestCookie(`a=1; ${HOST_SESSION_COOKIE}=new.sig; ${SECURE_SESSION_COOKIE}=old.sig`);
    expect(r.header).toBe(`a=1; ${SECURE_SESSION_COOKIE}=new.sig`);
    expect(r.legacyValue).toBeNull();
  });
  it("dual read: an old __Secure- cookie alone still works and is flagged for moving", () => {
    const r = rewriteRequestCookie(`${SECURE_SESSION_COOKIE}=old.sig; b=2`);
    expect(r.header).toBe(`${SECURE_SESSION_COOKIE}=old.sig; b=2`);
    expect(r.legacyValue).toBe("old.sig");
    expect(rewriteRequestCookie(null)).toEqual({ header: null, legacyValue: null });
    expect(rewriteRequestCookie("x=1").legacyValue).toBeNull();
  });
  it("renames Set-Cookie to __Host-: Path=/, Secure, no Domain", () => {
    const out = rewriteSetCookie(`${SECURE_SESSION_COOKIE}=tok.sig; Max-Age=60; Domain=multies.si; Path=/api; HttpOnly; Secure; SameSite=Lax`);
    expect(out).toBe(`${HOST_SESSION_COOKIE}=tok.sig; Path=/; Secure; Max-Age=60; HttpOnly; SameSite=Lax`);
    expect(out.toLowerCase()).not.toContain("domain=");
    expect(rewriteSetCookie("other=1; Path=/")).toBe("other=1; Path=/");
  });
  it("the request reaching the app carries the old name", async () => {
    const res = await app().request("/seen", { headers: { cookie: `${HOST_SESSION_COOKIE}=new.sig` } });
    expect(await res.text()).toBe(`${SECURE_SESSION_COOKIE}=new.sig`);
  });
  it("a new session leaves as __Host- and expires the old name", async () => {
    const res = await app().request("/login", { method: "POST" });
    const set = res.headers.getSetCookie();
    expect(set.some((s) => s.startsWith(`${HOST_SESSION_COOKIE}=tok.sig;`))).toBe(true);
    expect(set).toContain("other=1; Path=/");
    expect(set.some((s) => s.startsWith(`${SECURE_SESSION_COOKIE}=;`) && s.includes("Max-Age=0"))).toBe(true);
    expect(set.some((s) => s.startsWith(`${SECURE_SESSION_COOKIE}=tok`))).toBe(false);
  });
  it("migrates a browser holding only the old cookie, so nobody is signed out", async () => {
    const res = await app().request("/seen", { headers: { cookie: `${SECURE_SESSION_COOKIE}=old.sig` } });
    expect(await res.text()).toBe(`${SECURE_SESSION_COOKIE}=old.sig`);
    const set = res.headers.getSetCookie();
    expect(set[0]).toMatch(new RegExp(`^${HOST_SESSION_COOKIE}=old\\.sig; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=\\d+$`));
    expect(set[1]).toContain("Max-Age=0");
  });
  it("does not migrate on an error answer, and does nothing when secure cookies are off", async () => {
    const res = await app().request("/fail", { headers: { cookie: `${SECURE_SESSION_COOKIE}=old.sig` } });
    expect(res.headers.getSetCookie()).toEqual([]);
    const dev = await app(false).request("/login", { method: "POST" });
    expect(dev.headers.getSetCookie().some((s) => s.startsWith(`${SECURE_SESSION_COOKIE}=tok`))).toBe(true);
  });
});
