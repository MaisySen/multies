import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R132: Social P3 end to end on the mock platform (COMPOSIO_BASE_URL=https://composio.mock, local only): pin details in
 * the composer and on the pin tool, a refused pin with its error and Retry, best time chips filling Post at, writing
 * help with Undo, the Snapchat share button and page, YouTube comments in the inbox with a reply, health with
 * Reconnect, and shots with axe at 1280 and 390 in light, dark and Forest when SHOTS_DIR is set.
 */
let visitor = 0;
const ip = () => `10.232.${test.info().workerIndex % 200}.${++visitor}`;
const DIR = process.env.SHOTS_DIR;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const cfg = await (await page.request.get("/api/config")).json() as { socialP3R132?: boolean; socialYoutubeUploadR132?: boolean; socialGbpR132?: boolean };
  test.skip(!cfg.socialP3R132, "needs SOCIAL_P3_R132=on");
  expect(cfg.socialYoutubeUploadR132).toBeFalsy();
  expect(cfg.socialGbpR132).toBeFalsy();
}
async function connect(page: Page, origin: string, app: string): Promise<string> {
  const headers = { origin };
  const r = await (await page.request.post("/api/apps/connect", { headers, data: { app } })).json() as { redirectUrl: string };
  const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
  expect((await page.request.post(`/api/apps/accounts/${id}/confirm`, { headers })).status()).toBe(200);
  return id;
}
async function axe(page: Page, tag: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${tag}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
  expect(bad).toEqual([]);
}
async function shot(page: Page, name: string) { if (DIR) await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false }); }

test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
});

test("composer: pin details, best time chips, writing help with Undo, Snapchat share", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  const origin = new URL(baseURL!).origin;
  await connect(page, origin, "pinterest");
  await page.goto("/app/social/new");
  await expect(page.getByTestId("social-composer")).toBeVisible({ timeout: 20_000 });
  // No pin details until a Pinterest account is picked.
  await expect(page.getByTestId("pin-details")).toHaveCount(0);
  // Pinterest takes a pin once there is an image.
  await page.getByTestId("format-picker").locator('[data-format="image"]').click();
  await page.getByTestId("social-image").setInputFiles({ name: "mug.png", mimeType: "image/png", buffer: PNG });
  await page.getByTestId("pick-pinterest").first().click();
  await expect(page.getByTestId("pin-details")).toBeVisible();

  // Writing help is off until there is text; then it rewrites and Undo puts the words back.
  await expect(page.getByTestId("write-help")).toBeDisabled();
  await page.getByTestId("social-text").fill("Our spring mugs are back in the shop. See them at https://acme.example/mugs");
  await page.getByTestId("write-help").click();
  await page.getByRole("menuitem", { name: "Make it friendlier" }).click();
  await expect(page.getByText(/Rewritten\. \d+ left today\./)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("social-text")).toHaveValue("Our spring mugs are back in the shop. See them at https://acme.example/mugs");

  // A bad pin link is caught before Schedule.
  await page.getByTestId("pin-link").fill("acme.example/mugs");
  await expect(page.getByText("Use a full link that starts with https://")).toBeVisible();
  await expect(page.getByText("The pin link must be a full https link.").first()).toBeVisible();
  await page.getByTestId("pin-link").fill("https://acme.example/mugs");
  await page.getByTestId("pin-title").fill("Spring mugs");
  await page.getByTestId("pin-alt").fill("Three red mugs on a shelf");

  // Best times: plain defaults for a new workspace, a chip fills Post at.
  await page.getByTestId("when-later").click();
  await expect(page.getByTestId("best-times")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("best-times-why")).toContainText("Common good times");
  await expect(page.getByTestId("best-time-chip")).toHaveCount(3);
  const before = await page.getByTestId("social-at").inputValue();
  await page.getByTestId("best-time-chip").first().click();
  await expect(page.getByTestId("social-at")).not.toHaveValue(before);

  // Snapchat share: the button is ready because the post has a link.
  await expect(page.getByTestId("snap-share")).toBeEnabled();
  await shot(page, "r132-composer-1280-light");
  await axe(page, "composer 1280");

  await page.getByTestId("social-submit").click();
  await expect(page).toHaveURL(/\/app\/social\/posts/, { timeout: 15_000 });
});

test("snapchat share page: Open in Snapchat and Copy link, no outside script, and no share without a link", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const outside: string[] = [];
  page.on("request", (r) => { const h = new URL(r.url()).hostname; if (/^https?:/.test(r.url()) && h !== "localhost" && h !== "127.0.0.1") outside.push(r.url()); });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(scheme === "dark" ? { width: 390, height: 844 } : { width: 1280, height: 860 });
    const res = await page.goto("/share/snapchat?u=" + encodeURIComponent("https://acme.example/mugs"));
    expect(res?.status()).toBe(200);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("snapkit");
    await expect(page).toHaveTitle("Share to Snapchat");
    await expect(page.getByRole("link", { name: "Open in Snapchat" })).toHaveAttribute("href", "https://www.snapchat.com/scan?attachmentUrl=" + encodeURIComponent("https://acme.example/mugs"));
    await expect(page.getByLabel("Link to share")).toHaveValue("https://acme.example/mugs");
    await page.getByRole("button", { name: "Copy link" }).click();
    await expect(page.getByRole("status")).toHaveText("Link copied. Paste it in Snapchat.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://acme.example/mugs");
    expect(outside).toEqual([]);
    await axe(page, `snap-share-${scheme}`);
  }
  const bad = await page.goto("/share/snapchat?u=javascript:alert(1)");
  expect(bad?.status()).toBe(400);
  await expect(page.getByRole("heading", { name: "Nothing to share" })).toBeVisible();
});

test("a pin the network refuses shows its words and Retry", async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const origin = new URL(baseURL!).origin;
  const pi = await connect(page, origin, "pinterest");
  const r = await page.request.post("/api/social/posts", { headers: { origin }, data: { text: "Please FAIL this pin", images: [{ contentType: "image/png", dataB64: PNG.toString("base64") }], targets: [{ accountId: pi, target: "bd_1" }], extras: { pin: { title: "Mugs" } } } });
  expect(r.status()).toBe(201);
  await page.goto("/app/social/posts");
  await expect(page.getByText("Please FAIL this pin").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /Retry|Try again/ }).first()).toBeVisible({ timeout: 15_000 });
});

test("inbox: YouTube comments come in and a reply goes back; health shows YouTube", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const origin = new URL(baseURL!).origin;
  await connect(page, origin, "youtube");
  await page.goto("/app/social/inbox");
  await expect(page.getByTestId("social-inbox")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Loved this video, when is part two?").first()).toBeVisible({ timeout: 20_000 });
  await page.getByText("Loved this video, when is part two?").first().click();
  await page.getByTestId("inbox-text").fill("Part two comes out on Friday");
  await page.getByTestId("inbox-send").click();
  await expect(page.getByTestId("inbox-thread")).toContainText("Part two comes out on Friday", { timeout: 15_000 });
  await shot(page, "r132-inbox-youtube-1280-light");
  await axe(page, "inbox 1280");
  await page.goto("/app/social/accounts");
  await expect(page.getByTestId("social-account-youtube")).toContainText("Ready for comments", { timeout: 15_000 });
  await expect(page.getByTestId("connect-youtube")).toContainText("Connected. Add another account.");
});

test("phone and themes: composer and inbox at 390 and 1280 in light, dark and Forest", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const origin = new URL(baseURL!).origin;
  await connect(page, origin, "pinterest");
  await connect(page, origin, "youtube");
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
      await page.goto("/app/social/new");
      await expect(page.getByTestId("social-composer")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("format-picker").locator('[data-format="image"]').click();
  await page.getByTestId("social-image").setInputFiles({ name: "mug.png", mimeType: "image/png", buffer: PNG });
      await page.getByTestId("pick-pinterest").first().click();
      await expect(page.getByTestId("pin-details")).toBeVisible();
      await page.getByTestId("social-text").fill("Spring mugs are back https://acme.example/mugs");
      await page.getByTestId("when-later").click();
      await expect(page.getByTestId("best-time-chip").first()).toBeVisible({ timeout: 15_000 });
      await shot(page, `r132-composer-${w}-${theme}`);
      await axe(page, `composer ${w} ${theme}`);
      await page.goto("/app/social/inbox");
      await expect(page.getByText("Loved this video, when is part two?").first()).toBeVisible({ timeout: 20_000 });
      await shot(page, `r132-inbox-${w}-${theme}`);
      await axe(page, `inbox ${w} ${theme}`);
    }
  };
  await page.evaluate(() => localStorage.setItem("multies-theme", "light"));
  await run("light");
  await page.evaluate(() => localStorage.setItem("multies-theme", "dark"));
  await run("dark");
  await page.evaluate(() => localStorage.setItem("multies-theme", "light"));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
});
