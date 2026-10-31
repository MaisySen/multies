import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R88 Secure share end to end, against a local server with TOOLS_FEATURES=all (SECURE_SHARE_E2E=1).
 * A file request: make it, upload two files signed out (one in two parts), see them arrive and download one.
 * A secret link: make it, open it signed out once, then it is gone. Send securely in compose puts a link in the message.
 * SHOTS_DIR writes the page and the public pages at 1280 and 390, light, dark and Forest, and runs axe.
 */
test.skip(process.env.SECURE_SHARE_E2E !== "1", "needs a local server with Tools and secure share on");
test.describe.configure({ mode: "serial" });
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.188.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function anon(browser: Browser, w = 1280, scheme: "light" | "dark" = "light") {
  const ctx = await browser.newContext({ viewport: { width: w, height: w > 500 ? 860 : 844 }, colorScheme: scheme, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return ctx.newPage();
}

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}

const pdf = (n: number) => { const b = Buffer.alloc(n); b.write("%PDF-1.4\n"); for (let i = 9; i < n; i++) b[i] = 65 + (i % 26); return b; };

let requestUrl = "";

test("file request: make it, upload signed out (one file in two parts), see it arrive and download it", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/tools/share");
  await expect(page.getByTestId("share-tabs")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tab", { name: "Share files" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "File requests" }).click();
  await expect(page).toHaveURL(/tab=requests/);
  await expect(page.getByText("No file requests yet")).toBeVisible();
  await page.getByTestId("request-title").fill("Tax documents for 2026");
  await page.getByLabel(/Message to them/).fill("Please send last year's statements and your ID.");
  await page.getByRole("button", { name: "Documents", exact: true }).click();
  await page.getByTestId("request-create").click();
  await expect(page.getByTestId("request-made")).toBeVisible();
  requestUrl = await page.getByLabel("Request link").inputValue();
  expect(requestUrl).toMatch(/\/u\/[A-Za-z0-9_-]{43}$/);

  const pub = await anon(browser);
  const res = await pub.goto(requestUrl);
  expect(res!.status()).toBe(200);
  expect(res!.headers()["x-robots-tag"]).toContain("noindex");
  await expect(pub.getByRole("heading", { name: "Tax documents for 2026" })).toBeVisible();
  await pub.getByLabel(/Your name/).fill("Sam Client");
  await pub.locator("#file").setInputFiles([
    { name: "Statement.pdf", mimeType: "application/pdf", buffer: pdf(9 * 1024 * 1024) },
    { name: "ID scan.pdf", mimeType: "application/pdf", buffer: pdf(40_000) },
  ]);
  await expect(pub.locator("#list li")).toHaveCount(2);
  // A program is refused before it is sent.
  await pub.locator("#file").setInputFiles([{ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") }]);
  await expect(pub.locator("#list")).toContainText("setup.exe");
  await expect(pub.locator("#list")).toContainText(/can't be sent|not accepted|programs/i);
  await pub.locator("#send").click();
  await expect(pub.locator("#done")).toBeVisible({ timeout: 60_000 });
  await expect(pub.locator("#done-n")).toContainText("2 files");
  await pub.context().close();

  await page.reload();
  const row = page.getByTestId("request-row").first();
  await expect(row).toContainText("2 files");
  await row.getByRole("button", { name: "Files" }).click();
  await expect(page.getByTestId("request-file")).toHaveCount(2);
  await expect(page.getByTestId("request-file").filter({ hasText: "Statement.pdf" })).toContainText("Sam Client");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("request-file").filter({ hasText: "ID scan.pdf" }).getByRole("link", { name: "Download" }).click()]);
  expect(dl.suggestedFilename()).toBe("ID scan.pdf");
  // The notification arrived.
  const notes = await (await page.request.get("/api/notifications")).json() as { notifications?: { title: string }[]; items?: { title: string }[] };
  expect(JSON.stringify(notes)).toContain("Sam Client uploaded Statement.pdf");
});

async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}

async function sendOne(browser: Browser, url: string, who: string, file: string) {
  const pub = await anon(browser);
  await pub.goto(url);
  await pub.getByLabel(/Your name/).fill(who);
  await pub.locator("#file").setInputFiles([{ name: file, mimeType: "application/pdf", buffer: pdf(20_000) }]);
  await pub.locator("#send").click();
  await expect(pub.locator("#done")).toBeVisible({ timeout: 60_000 });
  await pub.context().close();
}

// R100 (R88 follow up): the arrival notice lands in Notifications for whoever made the request, admin or member, and opens it.
test("upload arrival notice reaches the request's owner, admin or member, and opens the request", async ({ browser }) => {
  test.setTimeout(150_000);
  const tag = Math.random().toString(36).slice(2, 8);
  const ada = await person(browser, `ada-${tag}@example.com`, "Ada Owner");
  expect((await ada.page.request.post("/api/account/onboarding", { headers: ada.headers, data: { name: "Ada Owner", timezone: "Australia/Sydney", locale: "en-AU", company: "Ada Co", workspaceTimezone: "Australia/Sydney" } })).status()).toBeLessThan(300);
  const invite = await (await ada.page.request.post("/api/team/invites", { data: { email: `ben-${tag}@example.com`, role: "member" }, headers: ada.headers })).json();
  const ben = await person(browser, `ben-${tag}@example.com`, "Ben Mate");
  await confirmEmail(ben.page.request, `ben-${tag}@example.com`);
  // Signing up with the invited address may already have joined Ada's workspace (410 invite_used); either way Ben is a member now.
  expect([200, 410]).toContain((await ben.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: ben.headers })).status());
  const made: Record<string, { id: string; url: string }> = {};
  for (const [who, p] of [["ada", ada], ["ben", ben]] as const) {
    const r = await p.page.request.post("/api/tools/requests", { headers: p.headers, data: { title: `Papers for ${who}`, message: "Please send your papers.", maxFileBytes: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, allowed: "any", keepDays: 30, expiresInDays: 14 } });
    expect(r.status(), await r.text()).toBe(201);
    made[who] = (await r.json()).request;
  }
  await sendOne(browser, made.ada.url, "Kim Client", "for-ada.pdf");
  await sendOne(browser, made.ben.url, "Lee Client", "for-ben.pdf");
  for (const [who, p, mine, other] of [["ada", ada, "for-ada.pdf", "for-ben.pdf"], ["ben", ben, "for-ben.pdf", "for-ada.pdf"]] as const) {
    await p.page.goto("/app/notifications");
    const item = p.page.getByRole("main").getByText(`New file for Papers for ${who}: ${who === "ada" ? "Kim" : "Lee"} Client uploaded ${mine}`);
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(p.page.getByRole("main")).toContainText("Secure share");
    await expect(p.page.getByRole("main").getByText(other)).toHaveCount(0);
    await item.click();
    await expect(p.page).toHaveURL(new RegExp(`/app/tools/share\\?tab=requests&request=${made[who].id}`));
  }
  await ada.ctx.close(); await ben.ctx.close();
});

test("secret link: lock it here, open it signed out once, then it is gone", async ({ page, browser }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/tools/share?tab=secrets");
  await expect(page.getByTestId("secrets-tab")).toBeVisible();
  await page.getByTestId("secret-text").fill("Wifi: harbour-guest / Tide-4411");
  await page.getByTestId("secret-create").click();
  const link = await page.getByTestId("secret-link").inputValue();
  expect(link).toMatch(/\/x\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
  // The server never saw the key or the words.
  const list = await (await page.request.get("/api/tools/secrets")).text();
  expect(list).not.toContain("Tide-4411");
  expect(list).not.toContain(link.split("#")[1]);

  const pub = await anon(browser);
  await pub.goto(link);
  await expect(pub.getByRole("button", { name: "Show secret" })).toBeVisible();
  await expect(pub.locator("body")).not.toContainText("Tide-4411");
  await pub.getByRole("button", { name: "Show secret" }).click();
  await expect(pub.locator("#s-text")).toHaveText("Wifi: harbour-guest / Tide-4411");
  expect(new URL(pub.url()).hash).toBe("");
  const again = await anon(browser);
  const gone = await again.goto(link);
  expect(gone!.status()).toBe(410);
  await again.context().close();
  await pub.context().close();

  await page.reload();
  await expect(page.getByTestId("secret-row").first()).toContainText("Opened and deleted");
});

test("Send securely in compose swaps the selected text for a secret link", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const body = compose.getByLabel("Message");
  await body.fill("Hi Sam, the door code is 4411 and see you Monday.");
  await body.evaluate((el: HTMLTextAreaElement) => { const i = el.value.indexOf("4411"); el.setSelectionRange(i, i + 4); });
  await compose.getByTestId("compose-send-securely").click();
  const dlg = page.getByRole("dialog", { name: "Send securely" });
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("secret-text")).toHaveValue("4411");
  await dlg.getByTestId("secret-create").click();
  await expect(dlg).toBeHidden();
  const v = await body.inputValue();
  expect(v).not.toContain("4411");
  expect(v).toMatch(/the door code is Secure link \(opens once\): http\S+\/x\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43} and see you Monday\./);
});

test("shots and axe", async ({ page, browser }) => {
  test.skip(!DIR, "screenshots only with SHOTS_DIR");
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  // Something in each tab.
  await page.goto("/app/tools/share?tab=requests");
  for (const t of ["Contracts from Acme", "Photos for the brochure"]) {
    await page.getByTestId("request-title").fill(t);
    await page.getByTestId("request-create").click();
    await expect(page.getByTestId("request-made")).toBeVisible();
    if (!requestUrl) requestUrl = await page.getByLabel("Request link").inputValue();
    await page.getByRole("button", { name: "Make another request" }).click();
  }
  await page.goto("/app/tools/share?tab=secrets");
  await page.getByTestId("secret-text").fill("A password for the shots");
  await page.getByTestId("secret-pass").fill("tide");
  await page.getByTestId("secret-create").click();
  const secretUrl = await page.getByTestId("secret-link").inputValue();

  const themes = [["light", "light"], ["dark", "dark"]] as const;
  for (const [scheme] of themes) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const tab of ["files", "requests", "secrets"]) {
        await page.goto(`/app/tools/share?tab=${tab}`);
        await expect(page.getByTestId("share-page")).toBeVisible();
        await shot(page, `${tab}-${w}-${scheme}`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        if (w === 1280) await axe(page, `${tab} ${scheme}`);
      }
      await page.goto("/app/mail?compose=1");
      await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();
      await page.getByRole("dialog", { name: "New message" }).getByLabel("Message").fill("Here is the login for the portal: ");
      await page.getByTestId("compose-send-securely").click();
      await expect(page.getByRole("dialog", { name: "Send securely" })).toBeVisible();
      await shot(page, `compose-send-securely-${w}-${scheme}`);
      if (w === 1280) await axe(page, `send securely ${scheme}`);
      await page.keyboard.press("Escape");

      const pub = await anon(browser, w, scheme);
      await pub.goto(requestUrl);
      await shot(pub, `public-request-${w}-${scheme}`, true);
      if (w === 1280) await axe(pub, `public request ${scheme}`);
      await pub.goto(secretUrl.split("#")[0] + "#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
      await shot(pub, `public-secret-warning-${w}-${scheme}`, true);
      if (w === 1280) await axe(pub, `public secret ${scheme}`);
      await pub.context().close();
    }
  }
  // Forest.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 860], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const tab of ["requests", "secrets"]) {
      await page.goto(`/app/tools/share?tab=${tab}`);
      await expect(page.getByTestId("share-page")).toBeVisible();
      await shot(page, `${tab}-${w}-forest`);
    }
    await axe(page, `secrets forest ${w}`);
    const pub = await anon(browser, w);
    await pub.goto(requestUrl);
    await shot(pub, `public-request-${w}-forest`, true);
    await pub.context().close();
  }
});
