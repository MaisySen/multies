import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * R41 join helper: before and after screenshots for the invite landing, where an invited person lands after
 * signing up, and the greeting for someone whose provider name is an email. Local identity provider only.
 * SHOTS_PHASE=before|after, SHOTS_DIR=/home/user/tab/files/multies-r41. Asserts nothing about the new flow.
 */
const BASE = `http://localhost:${process.env.E2E_IDP_PORT ?? "8790"}`;
const PHASE = process.env.SHOTS_PHASE ?? "after";
const DIR = process.env.SHOTS_DIR ?? "/tmp/join-r41-shots";
test.skip(!!process.env.E2E_BASE_URL || !process.env.SHOTS_PHASE, "local shots only");

const views = [
  { device: "desktop", viewport: { width: 1280, height: 800 } },
  { device: "phone", viewport: { width: 390, height: 844 } },
] as const;

async function idpRoute(page: Page, email: string, name?: string) {
  await page.route("https://idp.multies.test/**", async (route) => {
    const url = new URL(route.request().url());
    const code = Buffer.from(JSON.stringify({ nonce: url.searchParams.get("nonce"), email, ...(name ? { name } : {}) })).toString("base64url");
    await route.fulfill({ status: 302, headers: { location: `${url.searchParams.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` } });
  });
}

async function signIn(browser: Browser, email: string, name?: string, opts: { colorScheme?: "light" | "dark"; viewport?: { width: number; height: number } } = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, colorScheme: opts.colorScheme ?? "light", viewport: opts.viewport ?? { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await idpRoute(page, email, name);
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Multies" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  return { ctx, page };
}

async function shot(page: Page, what: string, device: string, scheme: string) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${DIR}/join-${PHASE}-${what}-${device}-${scheme}.png`, type: "png" });
}

test("join shots", async ({ browser }) => {
  test.setTimeout(240_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const headers = { origin: BASE };
  const tokens: string[] = [];
  const owners: Awaited<ReturnType<typeof signIn>>[] = [];
  for (let i = 0; i < 4; i++) {
    // The free plan has 3 seats: one owner per two invites.
    if (i % 2 === 0) {
      const o = await signIn(browser, `olive${i}-${tag}@example.com`, "Olive Owner");
      await o.page.request.patch(`${BASE}/api/account/preferences`, { data: { timezone: "UTC", locale: "en" }, headers });
      expect((await o.page.request.patch(`${BASE}/api/org`, { data: { name: `Harbor ${tag}` }, headers })).status()).toBe(200);
      owners.push(o);
    }
    const owner = owners[owners.length - 1];
    const inv = await owner.page.request.post(`${BASE}/api/team/invites`, { data: { email: `sam${i}-${tag}@example.com`, role: "member" }, headers });
    expect(inv.status(), await inv.text()).toBe(201);
    tokens.push((await inv.json()).link.split("/invite/")[1]);
  }
  let i = 0;
  for (const v of views) for (const scheme of ["light", "dark"] as const) {
    // 1. The invite landing, signed out.
    const ctx = await browser.newContext({ baseURL: BASE, colorScheme: scheme, viewport: v.viewport });
    const page = await ctx.newPage();
    const email = `sam${i}-${tag}@example.com`;
    await idpRoute(page, email, email);
    await page.goto(`/invite/${tokens[i]}`);
    await expect(page.getByRole("heading", { name: `Join Harbor ${tag}` })).toBeVisible();
    await shot(page, "invite-landing", v.device, scheme);
    // 2. Where the invited person lands after signing up (provider name is the email, as the hosted page sends it).
    await page.getByRole("link", { name: "Create your account" }).or(page.getByRole("button", { name: /Create your account|Sign up and join/ })).first().click();
    if (/\/signup/.test(page.url())) await page.getByRole("button", { name: "Sign up with email" }).click();
    await page.waitForURL(/\/(app|invite)/, { timeout: 20_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await shot(page, "landed", v.device, scheme);
    await ctx.close();
    i++;
  }
  // 3. The greeting for a person whose provider name is their email.
  for (const v of views) for (const scheme of ["light", "dark"] as const) {
    const email = `qa.tester+qa3p${tag}${v.device[0]}${scheme[0]}@example.com`;
    const p = await signIn(browser, email, email, { colorScheme: scheme, viewport: v.viewport });
    if (v.device === "desktop" && scheme === "light") await shot(p.page, "welcome-name", v.device, scheme);
    await p.page.request.patch(`${BASE}/api/account/preferences`, { data: { timezone: "UTC", locale: "en" }, headers });
    await p.page.goto("/app/my-work");
    await expect(p.page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await shot(p.page, "greeting", v.device, scheme);
    await p.ctx.close();
  }
  for (const o of owners) await o.ctx.close();
});
