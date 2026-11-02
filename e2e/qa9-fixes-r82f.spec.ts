import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R82F: the QA9 fix round, end to end on the local server. MB-279 one home for outside apps, MB-274 the Compose
 * warning, MB-281 axe label in name, MB-282 Escape and the second skip link, MB-283 tab titles, MB-284 Connections copy
 * and flow, MB-285 hex errors and one Density, MB-275 Nepali in Ctrl K, MB-277 the seat limit message, MB-280 a light
 * first screen. Tools pieces (Split range, Convert reload, Split PDF in Ctrl K) are in tools-r82f.spec.ts.
 */
let visitor = 0;
async function asVisitor(context: BrowserContext) {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.182.${test.info().workerIndex % 200}.${++visitor}` });
}
async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function signUp(page: Page, name: string) {
  const email = `r82f-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\/my-work$/, { timeout: 20_000 });
  return email;
}
const origin = (page: Page) => ({ origin: new URL(page.url()).origin });

test.beforeEach(async ({ context }) => asVisitor(context));

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`MB-279 one Connections page with four tabs; old addresses land on their tab (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await demo(page);
    await page.goto("/app/settings/connections?new=1");
    await expect(page).toHaveURL(/\/app\/settings\/apps\/mail\?new=1$/);
    const tabs = page.getByTestId("apps-tabs");
    // Phones show the short labels so all tabs fit at 390 px. P1 layout: Social posts moved out to Social.
    const names = label === "desktop" ? ["Apps", "Mail accounts", "Webhooks"] : ["Apps", "Mail", "Webhooks"];
    for (const t of names) await expect(tabs.getByRole("link", { name: t, exact: true })).toBeVisible();
    await expect(tabs.getByRole("link", { name: /^Social/ })).toHaveCount(0);
    await expect(tabs.getByRole("link", { name: names[1], exact: true })).toHaveAttribute("aria-current", "page");
    const box = await tabs.boundingBox();
    expect(box && box.x + box.width <= w).toBe(true);
    await expect(page.getByRole("heading", { name: "Mail accounts" }).first()).toBeVisible();
    await page.goto("/app/integrations");
    await expect(page).toHaveURL(/\/app\/settings\/apps\/webhooks$/);
    await expect(page.getByTestId("webhooks-pane")).toBeVisible();
    await tabs.getByRole("link", { name: "Apps", exact: true }).click();
    await expect(page.getByTestId("apps-grid")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (label === "desktop") {
      await expect(page).toHaveTitle(/Connections · Multies$/);
      // P1 layout: Settings has one sidebar, its own list.
      await expect(page.getByTestId("context-sidebar")).toHaveCount(0);
      await expect(page.getByTestId("settings-rail").getByRole("link", { name: "Integrations" })).toHaveCount(0);
      await expect(page.getByTestId("settings-rail").getByRole("link", { name: "Connected accounts" })).toHaveCount(0);
      await expect(page.getByTestId("settings-rail").getByRole("link", { name: "Connections" })).toHaveCount(1);
    }
  });
}

test("MB-284 Social posts sends you to the Social apps; search and category survive Back and reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  // P1 layout: the old Social posts address opens the composer in Social; with nothing connected it points to Accounts.
  await page.goto("/app/settings/apps/social");
  await expect(page).toHaveURL(/\/app\/social\/new$/);
  await page.getByRole("link", { name: "Connect an account" }).click();
  await expect(page).toHaveURL(/\/app\/social\/accounts$/);
  await page.goto("/app/settings/apps?group=social");
  await expect(page.getByTestId("apps-groups").getByRole("button", { name: "Social" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("app-facebook")).toBeVisible();
  await expect(page.getByTestId("app-gmail")).toHaveCount(0);
  // Our own short line for X, not the doubled platform text.
  await page.getByTestId("apps-search").fill("twitter");
  await expect(page.getByTestId("app-twitter")).toContainText("Post to X and keep an eye on replies.");
  await expect(page).toHaveURL(/q=twitter/);
  await page.goto("/app/settings/general");
  await page.goBack();
  await expect(page.getByTestId("apps-search")).toHaveValue("twitter");
  await page.reload();
  await expect(page.getByTestId("apps-search")).toHaveValue("twitter");
  await expect(page.getByTestId("app-twitter")).toBeVisible();
});

test("MB-280 the first Connections screen loads the short list and only the logos it shows", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await page.goto("/app/settings/apps");
  await expect(page.getByTestId("apps-grid")).toBeVisible();
  await page.waitForTimeout(1200);
  const full = () => seen.filter((u) => /connections-catalog-(?!top)[\w-]+\.js/.test(u));
  expect(seen.some((u) => /connections-catalog-top/.test(u))).toBe(true);
  expect(full()).toHaveLength(0);
  const logos = seen.filter((u) => u.includes("/api/apps/logo/"));
  expect(logos.length).toBeLessThanOrEqual(16);
  await expect(page.getByTestId("apps-grid").locator("li")).toHaveCount(24);
  // Searching brings the whole catalog.
  await page.getByTestId("apps-search").fill("zoho");
  await expect.poll(() => full().length).toBeGreaterThan(0);
  await expect(page.getByTestId("apps-grid").locator("li").first()).toContainText(/Zoho/i);
});

test("MB-282 second skip link opens Create; Escape on Create and View returns focus to the button", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await demo(page);
  await page.reload();
  await expect(page.getByTestId("icon-rail")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("skip-link")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("skip-create")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: /^Task/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("create-menu")).toBeFocused();
  await page.getByTestId("view-menu").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-menu")).toBeFocused();
});

test("MB-283 every app page names itself in the tab; MB-281 no label in name findings", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const pages: [string, RegExp][] = [
    ["/app/tasks", /Tasks · Multies$/], ["/app/mail", /Mail · Multies$/], ["/app/docs", /Docs · Multies$/], ["/app/goals", /Goals · Multies$/],
    ["/app/settings/branding", /Branding · Settings · Multies$/], ["/app/settings/apps/webhooks", /Webhooks · Connections · Multies$/],
    ["/app/deals", /Deals · Multies$/], ["/app/my-work", /My Work · Multies$/],
  ];
  for (const [path, title] of pages) {
    await page.goto(path);
    await expect(page).toHaveTitle(title, { timeout: 15_000 });
  }
  for (const path of ["/app/my-work", "/app/tasks", "/app/settings/apps"]) {
    await page.goto(path);
    await expect(page.getByTestId("icon-rail")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(600);
    const { violations } = await new AxeBuilder({ page }).withRules(["label-content-name-mismatch"]).analyze();
    expect(violations.map((v) => `${path}: ${v.nodes.map((n) => n.target).join(" ")}`)).toEqual([]);
  }
});

test("MB-275 a Nepali query in Ctrl K filters the list instead of showing everything", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.getByTestId("topbar-search-entry").click();
  const input = page.getByRole("combobox").first();
  await input.fill("कार्य सूची");
  await page.waitForTimeout(700);
  // F13: nothing in the menu matches, so the only option is to ask the words as a question (Ask AI, always last).
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option").first()).toHaveText(/^Ask AI: कार्य सूची$/);
  await input.fill("settings");
  await expect(page.getByRole("option", { name: /Go to Settings/ }).first()).toBeVisible();
});

test("MB-285 a bad hex says so under the box; Density sits only in the View menu", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await page.goto("/app/settings/branding");
  const hex = page.getByLabel("Brand colour hex");
  await expect(hex).toBeVisible({ timeout: 20_000 });
  await hex.fill("zz12");
  await hex.press("Tab");
  await expect(page.getByTestId("brand-primary-error")).toContainText("Use a hex colour like");
  await expect(hex).toHaveAttribute("aria-invalid", "true");
  await hex.fill("06c");
  await hex.press("Tab");
  await expect(page.getByTestId("brand-primary-error")).toHaveCount(0);
  await expect(hex).toHaveValue("#0066cc");
  await expect(page.getByRole("radiogroup", { name: "Density" })).toHaveCount(0);
  await expect(page.getByText("Density", { exact: true })).toHaveCount(0);
  await page.getByTestId("view-menu").click();
  await expect(page.getByRole("menuitemradio", { name: "Compact" })).toBeVisible();
});

test("MB-274 Compose warns up front about an unverified domain and keeps Send off", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await signUp(page, "Uma Unverified");
  const domain = `r82f-${Date.now().toString(36)}.test`;
  const d = await page.request.post("/api/domains", { data: { name: domain }, headers: origin(page) });
  expect(d.ok()).toBe(true);
  const domainId = ((await d.json()) as { domain: { id: string } }).domain.id;
  const m = await page.request.post("/api/mailboxes", { data: { domainId, localPart: "hello", displayName: "Hello Team" }, headers: origin(page) });
  expect(m.ok(), await m.text()).toBe(true);
  await page.goto("/app/mail?compose=1");
  await page.getByRole("combobox", { name: "From" }).selectOption({ label: `Hello Team <hello@${domain}>` });
  const warn = page.getByTestId("compose-unverified");
  await expect(warn).toContainText(`${domain} isn't verified yet`);
  await page.getByRole("textbox", { name: "To" }).fill("someone@example.com");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(warn.getByRole("link", { name: "Verify domain" })).toHaveAttribute("href", `/app/domains/${domainId}`);
});

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`MB-277 at the seat limit Team says so in words (${label})`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await signUp(page, "Sam Seats");
    for (const n of [1, 2]) {
      const r = await page.request.post("/api/team/invites", { data: { email: `seat${n}-${Date.now()}@example.com`, role: "member" }, headers: origin(page) });
      expect(r.ok(), await r.text()).toBe(true);
    }
    await page.goto("/app/settings/team");
    const note = page.getByTestId("seats-full");
    await expect(note).toBeVisible({ timeout: 15_000 });
    await expect(note).toContainText("All 3 seats are in use, 2 by pending invites");
    await expect(page.getByTestId("team-invite-button")).toBeDisabled();
    await expect(page.getByTestId("team-invite-button")).toHaveAttribute("aria-describedby", "seats-full");
  });
}
