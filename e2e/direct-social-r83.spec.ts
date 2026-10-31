import { test, expect, type Page } from "@playwright/test";

/**
 * R83: TikTok and Threads through our own sign in, against the local stand in (TIKTOK_API_BASE https://tiktok.mock and
 * THREADS_API_BASE https://threads.mock in playwright.config.ts; the stand in skips the consent page). Connect TikTok,
 * post a video with TikTok's posting rules (creator shown, audience picked, consent text), see it in the list; connect
 * Threads, post, see it; disconnect with the confirm step.
 */
let visitor = 0;
const ip = () => `10.183.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]] as const) {
  test(`own TikTok and Threads: connect, post, list, disconnect (${label})`, async ({ page, context }) => {
    test.setTimeout(120_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: w, height: h });
    await demo(page);
    await page.goto("/app/settings/apps/social");
    const box = page.getByTestId("direct-accounts");
    await expect(box).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "TikTok and Threads" })).toBeVisible();

    // TikTok: connect (the stand in comes straight back), then the account shows.
    await page.getByTestId("direct-connect-tiktok").click();
    await expect(page).toHaveURL(/\/app\/settings\/apps\/social$/);
    await expect(page.getByText("TikTok is connected.")).toBeVisible();
    await expect(page.getByTestId("direct-tiktok")).toContainText("@multiesdemo");

    // Post a video: the form reads creator info, needs an audience, and shows the consent text.
    await page.getByTestId("direct-post-tiktok").click();
    await expect(page.getByTestId("tiktok-creator")).toContainText("Multies Demo");
    await expect(page.getByTestId("tiktok-consent")).toContainText("Music Usage Confirmation");
    await page.getByTestId("tiktok-file").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(4096, 1) });
    await page.getByLabel("Caption").fill(`Hello from Multies ${label}`);
    await expect(page.getByTestId("tiktok-post-submit")).toBeDisabled();
    await page.getByTestId("tiktok-privacy").selectOption("SELF_ONLY");
    // Branded content can't be private: Only me is turned off once it is picked.
    await page.getByRole("switch", { name: "Disclose video content" }).click();
    await expect(page.getByText("Pick at least one, or turn disclosure off.")).toBeVisible();
    await page.getByLabel(/Your brand/).check();
    await expect(page.getByText("Promotional content")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByTestId("tiktok-post-submit").click();
    await expect(page.getByText(/Sent to TikTok/)).toBeVisible();
    await expect(page.getByTestId("tiktok-video-list")).toContainText(`Hello from Multies ${label}`);

    // Threads: connect, see the profile, post, see the post.
    await page.getByTestId("direct-connect-threads").click();
    await expect(page.getByText("Threads is connected.")).toBeVisible();
    await expect(page.getByTestId("threads-profile-name")).toHaveText("Multies Demo");
    await page.getByTestId("direct-post-threads").click();
    await page.getByLabel("Post", { exact: true }).fill(`First Threads post ${label}`);
    await page.getByTestId("threads-post-submit").click();
    await expect(page.getByText("Posted to Threads.")).toBeVisible();
    await expect(page.getByTestId("threads-post-list")).toContainText(`First Threads post ${label}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    // Disconnect TikTok with the confirm step.
    await page.getByTestId("direct-disconnect-tiktok").click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByText("TikTok is disconnected.")).toBeVisible();
    await expect(page.getByTestId("direct-connect-tiktok")).toBeVisible();
    await page.getByTestId("direct-disconnect-threads").click();
    await page.getByRole("dialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("direct-connect-threads")).toBeVisible();
  });
}
