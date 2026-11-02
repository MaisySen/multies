import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * F13 fixes on the R121 navigation (NAV_P2_R121 on): focus goes back after Customise menu, the phone menu closes on
 * Escape and on a backdrop tap, Files says Docs, Ctrl K finds People and puts pages before Ask AI, and a project guest
 * sees what it saw before R121 (its own project page, no app menu, no menu endpoint).
 */
test.skip(process.env.E2E_NAV_P2 === "off", "needs NAV_P2_R121 on");
const ip = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}`;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto("/app/my-work");
  return origin;
}
const serious = async (page: Page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => v.id);

test("Customise menu gives focus back to the View button after Done", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.getByTestId("view-menu").click();
  await page.getByRole("menuitem", { name: "Customise menu" }).click();
  await expect(page.getByTestId("customise-menu")).toBeVisible();
  await page.getByTestId("customise-done").click();
  await expect(page.getByTestId("view-menu")).toBeFocused();
});

test("phone menu closes on Escape and on a backdrop tap, focus back on More", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.getByTestId("tab-more").click();
  await expect(page.locator('[data-testid="more-sheet"]:visible')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="more-sheet"]:visible')).toBeHidden();
  await expect(page.getByTestId("tab-more")).toBeFocused();
  await page.getByTestId("tab-more").click();
  await expect(page.locator('[data-testid="more-sheet"]:visible')).toBeVisible();
  await page.getByTestId("drawer-backdrop").click({ position: { x: 375, y: 300 } });
  await expect(page.locator('[data-testid="more-sheet"]:visible')).toBeHidden();
  await expect(page.getByTestId("tab-more")).toBeFocused();
});

test("Files sits under Docs in its header", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const cfg = await (await page.request.get("/api/config")).json();
  test.skip(!(cfg.tools && (cfg.filesPlus || (cfg.toolFeatures ?? []).includes("folders"))), "this workspace has no Files");
  await page.goto("/app/files");
  await expect(page.locator("main").getByText("Files", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("main").getByText("Docs", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main").getByText("Tools", { exact: true })).toHaveCount(0);
});

test("Ctrl K: People, Mail setup and Settings open the page, Ask AI stays last", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  for (const [q, url] of [["People", /\/app\/contacts/], ["Mail setup", /\/app\/settings\/mailboxes/], ["settings", /\/app\/settings/], ["form", /\/app\/forms/]] as const) {
    await expect(page.getByTestId("rail-home")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("ControlOrMeta+k");
    const box = page.getByRole("combobox").first();
    await expect(box).toBeVisible();
    await box.fill(q);
    await page.waitForTimeout(400);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(url);
  }
});

test("a project guest sees its own project page and no app menu, as before R121", async ({ browser, page }) => {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  // A real workspace (invites and guests are off in the demo).
  const oc = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const o = oc.request;
  expect((await o.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `own-f13-${uniq()}@acme.io`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await o.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const proj = await (await o.post("/api/projects", { data: { name: "Plover" }, headers })).json();
  const projectId = proj.project?.id;
  expect(projectId, JSON.stringify(proj)).toBeTruthy();
  await o.post("/api/tasks", { data: { title: "Plover homepage copy", projectId }, headers });
  const inv = await (await o.post("/api/guests", { data: { projectId, email: `guest-${uniq()}@client.example`, name: "Gia Guest" }, headers })).json();
  expect(inv.inviteUrl, JSON.stringify(inv)).toBeTruthy();
  await oc.close();
  for (const width of [1280, 390]) {
    const ctx = await browser.newContext({ baseURL: origin, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width, height: width === 390 ? 844 : 860 } });
    expect((await ctx.request.post("/api/guest/accept", { data: { token: String(inv.inviteUrl).split("/g/")[1] }, headers })).status()).toBe(200);
    const g = await ctx.newPage();
    await g.goto("/guest");
    await expect(g.getByText("Plover").first()).toBeVisible({ timeout: 20_000 });
    await expect(g.getByTestId("icon-rail")).toHaveCount(0);
    await expect(g.getByTestId("phone-tabbar")).toHaveCount(0);
    await expect(g.getByTestId("more-sheet")).toHaveCount(0);
    expect([401, 403]).toContain((await ctx.request.get("/api/nav/menu")).status());
    expect(await serious(g)).toEqual([]);
    await ctx.close();
  }
});

test("API reference renders from our own copy under a self only script policy", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text().slice(0, 200)); });
  const outside: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (r.resourceType() === "script" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") outside.push(r.url()); });
  for (const p of ["/api/v1/reference", "/api/v1/reference.js", "/vendor/scalar-api-reference-1.76.0.js"]) {
    const r = await page.request.get(p);
    expect(r.status(), p).toBe(200);
  }
  const res = await page.goto("/api/v1/reference");
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp).toMatch(/script-src 'self';/);
  expect(csp).not.toMatch(/jsdelivr|cloudflareinsights|challenges\.cloudflare|'unsafe-eval'/);
  await page.waitForTimeout(4000);
  expect(errors).toEqual([]);
  expect(outside).toEqual([]);
  await expect(page.locator("#app").locator("*").first()).toBeAttached({ timeout: 20_000 });
  expect(await page.locator("#app").innerText()).toMatch(/\w{3,}/);
});

test("a public form still submits, with no outside script and its spam guards on", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const origin = await demo(page);
  const created = await page.request.post("/api/forms", { data: { name: "Website enquiry", target: "contact", fields: [{ label: "Name", type: "text", required: true }, { label: "Email", type: "email", required: true }] }, headers: { origin } });
  test.skip(!created.ok(), `forms not available: ${created.status()}`);
  const form = (await created.json()).form;
  const outside: string[] = [];
  page.on("request", (r) => { const u = new URL(r.url()); if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1" && r.resourceType() === "script") outside.push(r.url()); });
  const res = await page.goto(`/f/${form.slug}`);
  const csp = res!.headers()["content-security-policy"] ?? "";
  expect(csp).not.toMatch(/challenges\.cloudflare|cloudflareinsights|'unsafe-eval'/);
  await page.getByLabel("Name").fill("Priya Patel");
  await page.getByLabel("Email").fill("priya@example.org");
  await page.waitForTimeout(2600); // the time trap: a send in the first moments is treated as a bot
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/thank/i).first()).toBeVisible({ timeout: 15_000 });
  expect(outside).toEqual([]);
  expect(await serious(page)).toEqual([]);
});
