import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R80C: screenshots and the accessibility check for Connections (UX gate items 6 and 9). Runs only with SHOTS_DIR set:
 * the gallery and the Social posts tab at 1280 and 390, light and dark, and one brand theme (Forest), plus the empty
 * states. axe must find nothing serious or critical on either tab.
 */
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.181.${test.info().workerIndex % 200}.${++visitor}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function seed(page: Page, origin: string) {
  const headers = { origin };
  const ids: Record<string, string> = {};
  for (const app of ["linkedin", "facebook", "instagram", "reddit"]) {
    const r = await (await page.request.post("/api/apps/connect", { data: { app }, headers })).json() as { redirectUrl: string };
    const id = new URL(r.redirectUrl).searchParams.get("connected_account_id")!;
    await page.request.post(`/api/apps/accounts/${id}/confirm`, { headers });
    ids[app] = id;
  }
  await page.request.post("/api/social/posts", { headers, data: { text: "Our spring range is in store now. Come and say hello.", image: { contentType: "image/png", dataB64: PNG }, targets: [{ accountId: ids.linkedin }, { accountId: ids.facebook, target: "pg_100", targetName: "Acme Studio" }, { accountId: ids.instagram }] } });
  await page.request.post("/api/social/posts", { headers, data: { text: "FAIL Weekend opening hours", targets: [{ accountId: ids.reddit, target: "r/smallbusiness" }, { accountId: ids.linkedin }] } });
  await page.request.post("/api/social/posts", { headers, data: { text: "Friday: the new range lands. Doors open at 9.", targets: [{ accountId: ids.linkedin }, { accountId: ids.facebook, target: "pg_100", targetName: "Acme Studio" }], runAt: new Date(Date.now() + 3 * 86_400_000).toISOString() } });
  await page.waitForTimeout(600);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}

test("connections screenshots and axe", async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);

  // Empty states first.
  await page.goto("/app/settings/apps");
  await expect(page.getByTestId("apps-none")).toBeVisible();
  await shot(page, "b01-gallery-empty-1280-light");
  await page.goto("/app/settings/apps/social");
  await expect(page.getByTestId("social-empty")).toBeVisible();
  await shot(page, "b02-social-empty-1280-light");

  await seed(page, origin);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/settings/apps");
      await expect(page.getByTestId("account-linkedin")).toBeVisible();
      await shot(page, `b10-gallery-${w}-${scheme}`);
      await page.goto("/app/settings/apps/social");
      await expect(page.getByTestId("social-composer")).toBeVisible();
      await page.getByTestId("pick-facebook").getByRole("checkbox").check();
      await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
      await page.getByTestId("social-text").fill("Our spring range lands Friday. Come and see it in store.");
      await shot(page, `b20-social-${w}-${scheme}`);
      await page.getByTestId("social-posts").scrollIntoViewIfNeeded();
      await shot(page, `b21-posts-${w}-${scheme}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      for (const path of ["/app/settings/apps", "/app/settings/apps/social"]) {
        await page.goto(path);
        await page.waitForTimeout(500);
        const { violations } = await new AxeBuilder({ page }).include("main").analyze();
        const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${scheme} ${w} ${path}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
        expect(bad).toEqual([]);
      }
    }
  }

  // Search and a category at 1280.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/apps");
  await page.getByRole("button", { name: "Social", exact: true }).click();
  await shot(page, "b11-gallery-social-1280-light");
  await page.getByTestId("apps-search").fill("slack");
  await shot(page, "b12-gallery-search-1280-light");

  // One brand theme.
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto("/app/settings/apps");
  await expect(page.getByTestId("account-linkedin")).toBeVisible();
  await shot(page, "b30-gallery-1280-forest");
  await page.goto("/app/settings/apps/social");
  await page.getByTestId("pick-instagram").getByRole("checkbox").check();
  await shot(page, "b31-social-1280-forest");
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `forest: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
});
