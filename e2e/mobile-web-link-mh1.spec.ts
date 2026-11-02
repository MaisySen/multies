import { test, expect, type Browser } from "@playwright/test";

/**
 * MH1 (MOBILE_WEB_LINK): the phone app, signed in, asks for a one time code and opens the web app in its
 * in app browser already signed in. Reused codes land on sign in; a next outside the web app lands on /app.
 */
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function phoneApp(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const email = `mh1-${uniq()}@acme.io`;
  expect((await ctx.request.post("/api/auth/sign-up/email", { data: { name: "Ada Phone", email, password: "a-strong-password" } })).status()).toBe(200);
  expect((await ctx.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" } })).status()).toBe(200);
  const mint = async () => {
    const r = await ctx.request.post("/api/auth/mobile/web-link");
    expect(r.status(), await r.text()).toBe(200);
    const body = (await r.json()) as { code: string; expires_in: number };
    expect(body.expires_in).toBe(60);
    return body.code;
  };
  return { ctx, email, mint };
}

async function inAppBrowser(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width: 390, height: 844 } });
  return { ctx, page: await ctx.newPage() };
}

test.describe("MH1 app to web sign in handoff", () => {
  test("a code from the app opens the web app signed in, once", async ({ browser, baseURL }) => {
    const phone = await phoneApp(browser, baseURL!);
    const code = await phone.mint();

    const web = await inAppBrowser(browser, baseURL!);
    await web.page.goto(`/auth/mobile/web?code=${code}&next=${encodeURIComponent("/app/my-work")}`);
    await expect(web.page).toHaveURL(/\/app\/my-work/);
    const me = await web.ctx.request.get("/api/account/me");
    expect(me.status()).toBe(200);
    expect(JSON.stringify(await me.json())).toContain(phone.email);

    // The same code a second time, in another browser: sign in page, not signed in.
    const again = await inAppBrowser(browser, baseURL!);
    await again.page.goto(`/auth/mobile/web?code=${code}&next=/app/my-work`);
    await expect(again.page).toHaveURL(/\/login/);
    expect((await again.ctx.request.get("/api/account/me")).status()).toBe(401);
    await Promise.all([phone.ctx.close(), web.ctx.close(), again.ctx.close()]);
  });

  test("the redeem answer is a no store, no referrer redirect", async ({ browser, baseURL }) => {
    const phone = await phoneApp(browser, baseURL!);
    const code = await phone.mint();
    const web = await inAppBrowser(browser, baseURL!);
    const res = await web.ctx.request.get(`/auth/mobile/web?code=${code}&next=/app/docs`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/app/docs");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    expect(res.headers()["cache-control"]).toBe("no-store");
    expect(res.headers()["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers()["content-security-policy"]).not.toContain("'unsafe-eval'");
    await Promise.all([phone.ctx.close(), web.ctx.close()]);
  });

  test("a next outside the web app lands on /app, signed in", async ({ browser, baseURL }) => {
    const phone = await phoneApp(browser, baseURL!);
    const code = await phone.mint();
    const web = await inAppBrowser(browser, baseURL!);
    await web.page.goto(`/auth/mobile/web?code=${code}&next=${encodeURIComponent("//evil.example/app/x")}`);
    const url = new URL(web.page.url());
    expect(url.origin).toBe(new URL(baseURL!).origin);
    expect(url.pathname.startsWith("/app")).toBe(true);
    expect((await web.ctx.request.get("/api/account/me")).status()).toBe(200);
    await Promise.all([phone.ctx.close(), web.ctx.close()]);
  });

  test("signed out, the app cannot get a code", async ({ request }) => {
    expect((await request.post("/api/auth/mobile/web-link")).status()).toBe(401);
  });
});
