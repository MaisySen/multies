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
const PNG = "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";

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
  await page.request.post("/api/social/posts", { headers, data: { text: "Weekend opening hours: 9 to 5 on Saturday, closed Sunday.", targets: [{ accountId: ids.reddit, target: "r/closed_group" }, { accountId: ids.linkedin }] } });
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
