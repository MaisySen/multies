import { test, expect, type Page } from "@playwright/test";

/**
 * T1G (T1-8): when the server fails, pages say so plainly with Retry instead of loading skeletons forever,
 * Retry brings the page back once the server answers, and data already on screen stays when a refresh fails.
 * Demo workspace, made up data; the failures are mocked in the browser, nothing is broken on the server.
 */
async function demo(page: Page) {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  return origin;
}

/** Every API read answers 500 while `state.fail` is on (the sign in and account check still answer, as in T1). */
async function failReads(page: Page, state: { fail: boolean }, status = 500) {
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (!state.fail || req.method() !== "GET" || /\/api\/(auth\/|account\/me$|health$)|version|branding/.test(path)) return route.continue();
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code: status === 503 ? "unreachable" : "internal", message: "Something went wrong on our side." } }) });
  });
}

const errorShown = (page: Page) => page.getByTestId("load-error").or(page.getByTestId("load-error-strip")).first();
const retryButtons = (page: Page) => page.getByTestId("load-error-retry").or(page.getByTestId("load-error-strip-retry"));

const PAGES: [string, string][] = [["Tasks", "/app/tasks"], ["Contacts", "/app/contacts"], ["Files", "/app/files"], ["Docs", "/app/docs"], ["Chat", "/app/chat"], ["Home", "/app"]];

for (const [name, path] of PAGES) {
  test(`${name}: a server failure shows Couldn't load this with Retry, and Retry recovers`, async ({ page }) => {
    test.setTimeout(60_000);
    await demo(page);
    const state = { fail: true };
    await failReads(page, state, name === "Chat" ? 503 : 500);
    await page.goto(path);
    await expect(errorShown(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Couldn't load this").first()).toBeVisible();
    await expect(retryButtons(page).first()).toBeVisible();
    // The offline banner is for a lost connection only; a server failure does not show it.
    await expect(page.getByTestId("offline-banner")).toHaveCount(0);

    state.fail = false;
    for (let i = 0; i < 4 && (await retryButtons(page).count()) > 0; i++) {
      await retryButtons(page).first().click().catch(() => undefined);
      await page.waitForTimeout(1500);
    }
    await expect(page.getByTestId("load-error")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("load-error-strip")).toHaveCount(0, { timeout: 15_000 });
    // W4: Home widgets below the fold read only once scrolled near (Time to bill, TD4, is now the last one): bring each into view.
    for (const w of await page.locator('main [data-testid^="widget-"]').all()) await w.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(page.locator("main .skeleton")).toHaveCount(0, { timeout: 15_000 });
  });
}

test("Chat: a refresh that fails keeps the messages already on screen", async ({ page }) => {
  test.setTimeout(60_000);
  await demo(page);
  const state = { fail: false };
  await failReads(page, state);
  await page.goto("/app/chat");
  const general = page.getByRole("link", { name: /general/i }).first();
  if (await general.isVisible().catch(() => false)) await general.click();
  const box = page.getByRole("textbox", { name: /message/i }).first();
  await box.fill("T1G kept on screen");
  await box.press("Enter");
  await expect(page.getByTestId("chat-message").filter({ hasText: "T1G kept on screen" })).toBeVisible({ timeout: 15_000 });
  state.fail = true;
  await page.waitForTimeout(12_000); // the message list refreshes every few seconds; these refreshes fail
  await expect(page.getByTestId("chat-message").filter({ hasText: "T1G kept on screen" })).toBeVisible();
  await expect(page.getByTestId("load-error")).toHaveCount(0);
});
