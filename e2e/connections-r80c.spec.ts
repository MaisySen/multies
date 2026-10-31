import { test, expect, type Page } from "@playwright/test";

/**
 * R80C: Connections end to end against the local stand in for the integration platform (COMPOSIO_BASE_URL
 * https://composio.mock in playwright.config.ts): connect LinkedIn and a Facebook page from the gallery (the stand in
 * sends the browser straight back, the way the real sign in page does), schedule a post to both, run the cron pass
 * with the test clock and see each account's result, then disconnect with the confirm step.
 */
let visitor = 0;
const ip = () => `10.180.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

/** P1 layout: a network you post to comes back to Social, Accounts, from either door. */
async function connect(page: Page, slug: string, search: string) {
  await page.getByTestId("apps-search").fill(search);
  await page.getByTestId(`app-${slug}`).getByRole("button", { name: /Connect|Add another account/ }).click();
  await expect(page).toHaveURL(/\/app\/social\/accounts(\?|$)/);
  await expect(page.getByTestId(`social-account-${slug}`).first()).toBeVisible();
}

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`connections: connect, schedule a post, see results, disconnect (${label})`, async ({ page, context, baseURL }) => {
    test.setTimeout(90_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: w, height: h });
    await demo(page);

    await page.goto("/app/settings/apps");
    await expect(page.getByTestId("apps-none")).toBeVisible();
    await expect(page.getByTestId("app-facebook")).toBeVisible();
    // Search narrows the list; no horizontal scroll at this width.
    await page.getByTestId("apps-search").fill("zzzz nothing");
    await expect(page.getByText("No apps match")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await connect(page, "linkedin", "linkedin");
    await expect(page.getByText("LinkedIn connected")).toBeVisible();
    // The second door: Connect right on Social, Accounts.
    await page.getByTestId("connect-facebook").getByRole("button", { name: "Connect Facebook Pages" }).click();
    await expect(page).toHaveURL(/\/app\/social\/accounts(\?|$)/);
    await expect(page.getByTestId("social-account-facebook").first()).toBeVisible();

    // New post: pick both accounts and a page, schedule for later.
    await page.getByTestId("new-post").first().click();
    await expect(page).toHaveURL(/\/app\/social\/new$/);
    await expect(page.getByTestId("social-composer")).toBeVisible();
    // A network that cannot take the post is greyed out with the reason (LinkedIn takes 3,000 characters).
    await page.getByTestId("social-text").fill("x".repeat(3001));
    await expect(page.getByTestId("pick-linkedin")).toHaveAttribute("data-blocked", "true");
    await expect(page.getByTestId("pick-linkedin").getByRole("checkbox")).toBeDisabled();
    await expect(page.getByTestId("pick-linkedin").getByTestId("pick-why")).toContainText("Too long for LinkedIn");
    await page.getByTestId("social-text").fill("");
    await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
    await page.getByTestId("pick-facebook").getByRole("checkbox").check();
    await expect(page.getByTestId("pick-facebook").getByRole("combobox")).toBeVisible();
    await page.getByTestId("pick-facebook").getByRole("combobox").selectOption({ label: "Acme Studio" });
    await page.getByTestId("social-text").fill("Our spring range lands Friday.");
    await page.getByRole("radio", { name: "Later" }).click();
    await page.getByTestId("social-submit").click();
    await expect(page.getByText(/Scheduled for/)).toBeVisible();
    await expect(page).toHaveURL(/\/app\/social\/posts$/); // after sending, Posts shows how it goes
    const post = page.getByTestId("social-post").first();
    await expect(post).toHaveAttribute("data-status", "scheduled");

    // The cron pass two hours from now sends it; each account shows its own result.
    const origin = { origin: new URL(baseURL!).origin };
    const r = await page.request.post("/api/social/test-clock", { data: { now: new Date(Date.now() + 2 * 3600_000).toISOString() }, headers: origin });
    expect((await r.json()).sent).toBe(1);
    await page.reload();
    await expect(page.getByTestId("social-post").first()).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("social-post").first().getByTestId("post-target")).toHaveCount(2);
    await expect(page.getByTestId("social-post").first().getByText("Posted").first()).toBeVisible();

    // Hotfix Oct 31: a refused post says the real reason in plain words, with Reconnect when that is the fix.
    await page.goto("/app/social/new");
    await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
    await page.getByTestId("social-text").fill("EXPIRED sign in check");
    await page.getByRole("radio", { name: "Now" }).click();
    await page.getByTestId("social-submit").click();
    // Oct 31: Post now opens a sheet that follows the post until each network answers.
    const sheet = page.getByTestId("posted-sheet");
    await expect(sheet).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
    await expect(page.getByRole("dialog")).toContainText("Not posted");
    await expect(sheet.getByTestId("post-target-error")).toHaveAttribute("data-code", "reconnect");
    await page.getByTestId("view-in-posts").click();
    await expect(page).toHaveURL(/\/app\/social\/posts$/);
    const failed = page.getByTestId("social-post").filter({ hasText: "EXPIRED sign in check" });
    await expect(failed).toHaveAttribute("data-status", "failed", { timeout: 15_000 });
    await expect(failed.getByTestId("post-target-error")).toHaveAttribute("data-code", "reconnect");
    await expect(failed.getByText("The sign in for this account has expired. Reconnect it, then try again.")).toBeVisible();
    await expect(failed.getByRole("button", { name: "Reconnect LinkedIn" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (process.env.SHOTS_DIR) {
      for (const scheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await failed.scrollIntoViewIfNeeded();
        await failed.screenshot({ path: `${process.env.SHOTS_DIR}/failed-post-${w}-${scheme}.png` });
      }
      await page.emulateMedia({ colorScheme: "light" });
    }

    // Oct 31: a post that went out says so right away, opens on the network, and Delete removes it there too.
    await page.goto("/app/social/new");
    await page.getByTestId("pick-facebook").getByRole("checkbox").check();
    await page.getByTestId("pick-facebook").getByRole("combobox").selectOption({ label: "Acme Studio" });
    await page.getByTestId("social-text").fill("Delete me after the check");
    await page.getByRole("radio", { name: "Now" }).click();
    await page.getByTestId("social-submit").click();
    await expect(sheet).toHaveAttribute("data-status", "done", { timeout: 15_000 });
    await expect(page.getByRole("dialog")).toContainText("Posted to Facebook");
    await expect(sheet.getByTestId("open-post")).toHaveAttribute("href", /^https:\/\/www\.facebook\.com\/\d+\/posts\//);
    await expect(page.getByTestId("social-text")).toHaveValue(""); // the composer is clear behind the sheet
    if (process.env.SHOTS_DIR) for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/posted-sheet-${w}-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("view-in-posts").click();
    await expect(page).toHaveURL(/\/app\/social\/posts$/);
    const done = page.getByTestId("social-post").filter({ hasText: "Delete me after the check" });
    await expect(done.getByTestId("open-post")).toBeVisible();
    if (process.env.SHOTS_DIR) for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/posts-${w}-${scheme}.png`, fullPage: true });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await done.getByTestId("post-delete").click();
    const confirm = page.getByRole("dialog");
    await expect(confirm).toContainText("It will also be deleted from Facebook. You can't undo this.");
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/delete-confirm-${w}-light.png` });
    await confirm.getByRole("button", { name: "Delete from Facebook" }).click();
    await expect(page.getByText("Post deleted from Facebook")).toBeVisible();
    await expect(page.locator("#posts-title")).toBeFocused(); // focus lands on the list, not the page body
    await expect(page.getByTestId("social-post").filter({ hasText: "Delete me after the check" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // Failed filter shows it; Disconnect LinkedIn on Social, Accounts, with the confirm step.
    await page.getByTestId("posts-filter").getByRole("button", { name: /Failed/ }).click();
    await expect(page.getByTestId("social-post").filter({ hasText: "EXPIRED sign in check" })).toBeVisible();
    await expect(page.getByTestId("social-post").filter({ hasText: "Our spring range" })).toHaveCount(0);
    await page.goto("/app/social/accounts");
    await page.getByRole("button", { name: "Disconnect LinkedIn" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("LinkedIn disconnected")).toBeVisible();
    await expect(page.getByTestId("social-account-linkedin")).toHaveCount(0);
    await expect(page.getByTestId("social-account-facebook")).toBeVisible();
  });
}
