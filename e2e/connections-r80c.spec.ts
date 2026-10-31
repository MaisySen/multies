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

async function connect(page: Page, slug: string, search: string) {
  await page.getByTestId("apps-search").fill(search);
  await page.getByTestId(`app-${slug}`).getByRole("button", { name: /Connect|Add account/ }).click();
  await expect(page).toHaveURL(/\/app\/settings\/apps(\?|$)/);
  await expect(page.getByTestId(`account-${slug}`).first()).toBeVisible();
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
    await connect(page, "linkedin", "linkedin");
    await expect(page.getByText("LinkedIn connected")).toBeVisible();
    await connect(page, "facebook", "facebook");
    // Search narrows the list; no horizontal scroll at this width.
    await page.getByTestId("apps-search").fill("zzzz nothing");
    await expect(page.getByText("No apps match")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // Social posts: pick both accounts and a page, schedule for later.
    await page.getByRole("link", { name: "Social posts" }).click();
    await expect(page.getByTestId("social-composer")).toBeVisible();
    await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
    await page.getByTestId("pick-facebook").getByRole("checkbox").check();
    await expect(page.getByTestId("pick-facebook").getByRole("combobox")).toBeVisible();
    await page.getByTestId("pick-facebook").getByRole("combobox").selectOption({ label: "Acme Studio" });
    await page.getByTestId("social-text").fill("Our spring range lands Friday.");
    await page.getByRole("radio", { name: "Later" }).click();
    await page.getByTestId("social-submit").click();
    await expect(page.getByText(/Scheduled for/)).toBeVisible();
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

    // Disconnect LinkedIn, with the confirm step.
    await page.getByRole("link", { name: "Apps", exact: true }).click();
    await page.getByRole("button", { name: "Disconnect LinkedIn" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("LinkedIn disconnected")).toBeVisible();
    await expect(page.getByTestId("account-linkedin")).toHaveCount(0);
    await expect(page.getByTestId("account-facebook")).toBeVisible();
  });
}
