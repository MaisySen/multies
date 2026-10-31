import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R97 notification centre: Mail per category, how mail arrives (as it happens or a digest), quiet hours in your own
 * time zone, pause and resume, the status line on Notifications, a failed save rolling back, phone width and one
 * person's settings never reaching another. With SHOTS_DIR set it saves the UX gate shots and checks axe.
 */
const DIR = process.env.SHOTS_DIR;
let n = 0;

async function signup(page: Page, name = "Nora Notify") {
  const id = `${Date.now().toString(36)}${++n}`;
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(`r97-${id}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\//, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
  // The page scrolls inside the app frame: a second shot shows the delivery cards.
  const cards = page.getByTestId("quiet-hours");
  if (await cards.count()) {
    await cards.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${DIR}/${name}-cards.png` });
  }
}
async function axe(page: Page, where: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((x) => x.target).join(" | ")}`);
}
const sw = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

test("R97 mail, digest, quiet hours, pause and resume", async ({ page }) => {
  test.setTimeout(150_000);
  await signup(page);
  await page.goto("/app/settings/notifications");
  await expect(page.getByRole("columnheader", { name: "Mail" })).toBeVisible();
  // Mail is off everywhere by default, so nothing changes until the person chooses.
  await expect(sw(page, "Mentions by mail")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("mail-delivery")).toContainText("Turn on Mail for at least one category");
  await sw(page, "Mentions by mail").click();
  await expect(sw(page, "Mentions by mail")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("mail-delivery")).not.toContainText("Turn on Mail for at least one category");

  // A daily digest at a time of my choosing.
  await page.getByTestId("digest-frequency").selectOption("daily");
  await expect(page.getByTestId("digest-time")).toBeVisible();
  await page.getByTestId("digest-time").fill("07:30");
  await page.getByTestId("digest-frequency").selectOption("weekly");
  await page.getByTestId("digest-weekday").selectOption("5");

  // Quiet hours in my own zone, weeknights only.
  await sw(page, "Use quiet hours").click();
  await page.getByTestId("quiet-start").fill("21:00");
  await page.getByRole("button", { name: "Saturday", exact: true }).click();
  await page.getByRole("button", { name: "Sunday", exact: true }).click();
  await page.getByTestId("delivery-zone").selectOption("Asia/Tokyo");
  await expect(page.getByTestId("delivery-zone")).toHaveValue("Asia/Tokyo");

  // It all survives a reload.
  await page.reload();
  await expect(sw(page, "Mentions by mail")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("digest-frequency")).toHaveValue("weekly");
  await expect(page.getByTestId("digest-weekday")).toHaveValue("5");
  await expect(page.getByTestId("digest-time")).toHaveValue("07:30");
  await expect(page.getByTestId("quiet-start")).toHaveValue("21:00");
  await expect(page.getByRole("button", { name: "Sunday", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Monday", exact: true })).toHaveAttribute("aria-pressed", "true");
  const saved = await (await page.request.get("/api/notifications/settings")).json();
  expect(saved.delivery).toMatchObject({ timezone: "Asia/Tokyo", digest: { frequency: "weekly", time: "07:30", weekday: 5 }, quiet: { enabled: true, start: "21:00", days: [1, 2, 3, 4, 5] } });
  expect(saved.settings.mention.mail).toBe(true);
  const errors = [await axe(page, "settings 1280 light")];
  await shot(page, "r97-settings-1280-light");

  // Pause from the Notifications page; the status line says so and Resume brings alerts back.
  await page.goto("/app/notifications");
  await expect(page.getByTestId("alert-status")).toHaveCount(0);
  await page.getByTestId("pause-alerts").click();
  await page.getByRole("menuitem", { name: "For 1 hour" }).click();
  await expect(page.getByTestId("alert-status")).toContainText("Alerts paused until");
  errors.push(await axe(page, "notifications paused 1280 light"));
  await shot(page, "r97-paused-1280-light");
  await page.goto("/app/settings/notifications");
  await expect(page.getByTestId("pause-card")).toContainText("Paused until");
  await page.goto("/app/notifications");
  await page.getByTestId("alert-status").getByRole("button", { name: "Resume" }).click();
  await expect(page.getByTestId("alert-status")).toHaveCount(0);
  expect(errors.flat()).toEqual([]);
});

test("R97 a failed save rolls the switch back and says so", async ({ page }) => {
  test.setTimeout(90_000);
  await signup(page, "Fay Failure");
  await page.goto("/app/settings/notifications");
  await expect(sw(page, "Approvals by mail")).toHaveAttribute("aria-checked", "false");
  await page.route("**/api/notifications/settings", (route) => route.request().method() === "PUT"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }) })
    : route.continue());
  await sw(page, "Approvals by mail").click();
  await expect(sw(page, "Approvals by mail")).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
  await page.unroute("**/api/notifications/settings");
  // A bad value from an old client is refused by the server, not saved.
  const bad = await page.request.put("/api/notifications/settings", { data: { delivery: { quiet: { start: "7pm" } } } });
  expect(bad.status()).toBe(422);
});

test("R97 settings are per person, and the phone layout fits", async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await signup(page, "Pia Phone");
  expect((await page.request.put("/api/notifications/settings", { data: { delivery: { pause: "3h" }, settings: { comment: { mail: true } } } })).ok()).toBeTruthy();
  // Someone else starts clean.
  const other = await browser.newContext({ baseURL });
  const op = await other.newPage();
  await signup(op, "Otto Other");
  const theirs = await (await op.request.get("/api/notifications/settings")).json();
  expect(theirs.delivery.pausedUntil).toBeNull();
  expect(theirs.settings.comment.mail).toBe(false);
  await other.close();

  // Phone width: short headers, no sideways scroll, every switch reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/notifications");
  await expect(page.getByRole("columnheader", { name: "Inbox" })).toBeVisible();
  await expect(page.getByTestId("pause-card")).toContainText("Paused until");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const box = await sw(page, "Status changes by mail").boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  const errors = [await axe(page, "settings 390 light")];
  await shot(page, "r97-settings-390-light");
  await page.goto("/app/notifications");
  await expect(page.getByTestId("alert-status")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await shot(page, "r97-paused-390-light");

  // Dark and Forest, both widths.
  await page.emulateMedia({ colorScheme: "dark" });
  for (const [w, h] of [[390, 844], [1280, 860]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/app/settings/notifications");
    await sw(page, "Use quiet hours").click();
    await expect(page.getByTestId("quiet-start")).toBeAttached();
    errors.push(await axe(page, `settings ${w} dark`));
    await shot(page, `r97-settings-${w}-dark`);
    await sw(page, "Use quiet hours").click();
    await page.goto("/app/notifications");
    errors.push(await axe(page, `notifications ${w} dark`));
    await shot(page, `r97-paused-${w}-dark`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  for (const [w, h] of [[1280, 860], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/app/settings/notifications");
    await page.getByTestId("digest-frequency").selectOption("weekly");
    await expect(page.getByTestId("digest-weekday")).toBeAttached();
    errors.push(await axe(page, `settings ${w} forest`));
    await shot(page, `r97-settings-${w}-forest`);
    await page.goto("/app/notifications");
    await shot(page, `r97-paused-${w}-forest`);
  }
  expect(errors.flat()).toEqual([]);
});
