import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * P1 layout: daily tools out of Settings. Social in the rail (Planner, Posts, New post, Accounts), Agents and Settings at
 * the bottom, Settings with one sidebar, Create and P open the composer, old addresses redirect, phone drawer lists
 * Social. With SHOTS_DIR set it also saves the screenshots for the UX gate (1280 and 390, light, dark, Forest).
 */
let visitor = 0;
const ip = () => `10.182.${test.info().workerIndex % 200}.${++visitor}`;
const DIR = process.env.SHOTS_DIR;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
  await page.request.post("/api/social/posts", { headers, data: { text: "Friday: the new range lands. Doors open at 9.", targets: [{ accountId: ids.linkedin }, { accountId: ids.facebook, target: "pg_100", targetName: "Acme Studio" }], runAt: new Date(Date.now() + 2 * 86_400_000).toISOString() } });
  await page.waitForTimeout(800);
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

async function axe(page: Page, where: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}

test("P1 desktop: rail, Social pages, Create and P, one Settings sidebar, redirects", async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);

  // Empty Social first: planner and composer say what to do.
  await page.goto("/app/social");
  await expect(page.getByTestId("planner-empty")).toBeVisible();
  await shot(page, "p1-planner-empty-1280-light");
  await page.goto("/app/social/new");
  await expect(page.getByTestId("social-empty").getByRole("link", { name: "Connect an account" })).toBeVisible();

  await seed(page, new URL(baseURL!).origin);

  // The rail: Social after Docs, Agents and Settings at the bottom.
  await page.goto("/app/my-work");
  const rail = page.getByTestId("icon-rail");
  await expect(rail.getByTestId("rail-social")).toHaveText(/Social/);
  await expect(page.getByTestId("rail-bottom").getByTestId("rail-agents")).toBeVisible();
  await expect(page.getByTestId("rail-bottom").getByTestId("rail-workspace")).toHaveText(/Settings/);
  await expect(rail.getByText("Workspace", { exact: true })).toHaveCount(0);

  // Social: one click from anywhere; the planner shows the posts on their days.
  await rail.getByTestId("rail-social").click();
  await expect(page).toHaveURL(/\/app\/social$/);
  await expect(page.getByTestId("planner-grid")).toBeVisible();
  await expect(page.getByTestId("social-switcher")).toBeHidden(); // the shell sidebar switches pages at 1280
  await expect(page.getByTestId("planner-post").first()).toBeVisible();
  const side = page.getByTestId("context-sidebar");
  for (const l of ["Planner", "Posts", "Accounts"]) await expect(side.getByRole("link", { name: l, exact: true })).toBeVisible();
  await expect(side.getByTestId("sidebar-new-post")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, "p1-planner-1280-light");
  expect(await axe(page, "planner")).toEqual([]);

  // A post chip opens it in Posts.
  await page.getByTestId("planner-post").first().click();
  await expect(page).toHaveURL(/\/app\/social\/posts#post-/);
  await expect(page.getByTestId("social-post").first()).toBeVisible();

  // Posts: filters.
  await page.getByTestId("posts-filter").getByRole("button", { name: "Scheduled" }).click();
  await expect(page).toHaveURL(/status=scheduled/);
  await expect(page.getByTestId("social-post")).toHaveCount(1);
  await expect(page.getByTestId("social-post").first()).toContainText("Friday: the new range lands");
  await page.getByTestId("posts-filter").getByRole("button", { name: "All" }).click();
  await expect(page.getByTestId("social-post")).toHaveCount(3);
  await shot(page, "p1-posts-1280-light");
  expect(await axe(page, "posts")).toEqual([]);

  // Create, Social post opens the composer in Social; so does P from any page.
  await page.goto("/app/tasks");
  await page.getByTestId("create-menu").click();
  await page.getByRole("menuitem", { name: "Social post" }).click();
  await expect(page).toHaveURL(/\/app\/social\/new$/);
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("heading", { name: "Overview", level: 1 }).click();
  await page.keyboard.press("p");
  await expect(page).toHaveURL(/\/app\/social\/new$/);

  // The composer greys out what a network cannot take, with the reason.
  await expect(page.getByTestId("social-composer")).toBeVisible();
  await expect(page.getByTestId("pick-instagram")).toHaveAttribute("data-blocked", "true");
  await expect(page.getByTestId("pick-instagram").getByRole("checkbox")).toBeDisabled();
  await expect(page.getByTestId("pick-instagram").getByTestId("pick-why")).toContainText("Instagram needs an image");
  await expect(page.getByTestId("pick-linkedin")).not.toHaveAttribute("data-blocked", "true");
  await page.getByTestId("pick-linkedin").getByRole("checkbox").check();
  await page.getByTestId("social-text").fill("Our spring range lands Friday. Come and see it in store.");
  await shot(page, "p1-new-post-1280-light");
  expect(await axe(page, "new post")).toEqual([]);

  // Accounts: connected profiles with health, TikTok and Threads, Connect for each network.
  await side.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(page.getByTestId("accounts-list")).toBeVisible();
  for (const app of ["linkedin", "facebook", "instagram", "reddit"]) await expect(page.getByTestId(`social-account-${app}`)).toBeVisible();
  // W4: with SOCIAL_P3_R132 on (the E2E default) YouTube joins the five networks to connect.
  const p3 = !!(await (await page.request.get("/api/config")).json()).socialP3R132;
  const connectNames = await page.getByTestId("accounts-add").getByRole("button", { name: /^Connect / }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  expect(connectNames).toEqual(["Connect Facebook Pages", "Connect Instagram", "Connect LinkedIn", "Connect Pinterest", "Connect Reddit", ...(p3 ? ["Connect YouTube"] : [])]);
  await expect(page.getByTestId("direct-accounts")).toBeVisible();
  await shot(page, "p1-accounts-1280-light");
  expect(await axe(page, "accounts")).toEqual([]);

  // Settings: one sidebar, its own list carries Connections, Activity.
  await page.getByTestId("rail-workspace").click();
  await expect(page).toHaveURL(/\/app\/settings$/);
  await expect(page.getByTestId("context-sidebar")).toHaveCount(0);
  await expect(page.getByTestId("sidebar-toggle")).toBeHidden();
  const list = page.getByTestId("settings-rail");
  await expect(list.getByRole("link", { name: "Connections" })).toBeVisible();
  await expect(list.getByRole("link", { name: "Activity" })).toBeVisible();
  await shot(page, "p1-settings-1280-light");
  await page.goto("/app/settings/apps");
  await expect(page.getByTestId("apps-tabs").getByRole("link")).toHaveCount(3);
  await expect(page.getByTestId("social-pointer")).toBeVisible();
  await shot(page, "p1-connections-1280-light");
  await list.getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/app\/activity/);
  await expect(page.getByTestId("rail-workspace")).toHaveAttribute("aria-current", "page");

  // Agents is its own place.
  await page.getByTestId("rail-agents").click();
  await expect(page).toHaveURL(/\/app\/agents/);
  await expect(page.getByTestId("rail-agents")).toHaveAttribute("aria-current", "page");

  // Old addresses still work.
  await page.goto("/app/settings/apps/social");
  await expect(page).toHaveURL(/\/app\/social\/new$/);
  await page.goto("/app/settings/apps/social?connected=tiktok");
  await expect(page).toHaveURL(/\/app\/social\/accounts\?connected=tiktok$/);
  await page.goto("/app/social/planner");
  await expect(page).toHaveURL(/\/app\/social$/);

  // Dark and the Forest brand.
  if (DIR) {
    await page.emulateMedia({ colorScheme: "dark" });
    for (const [path, name] of [["/app/social", "planner"], ["/app/social/posts", "posts"], ["/app/social/new", "new-post"], ["/app/social/accounts", "accounts"], ["/app/settings", "settings"]] as const) {
      await page.goto(path); await shot(page, `p1-${name}-1280-dark`);
      expect(await axe(page, `${name} dark`)).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/app/settings/branding");
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    for (const [path, name] of [["/app/social", "planner"], ["/app/social/new", "new-post"], ["/app/social/accounts", "accounts"]] as const) {
      await page.goto(path); await shot(page, `p1-${name}-1280-forest`);
      expect(await axe(page, `${name} forest`)).toEqual([]);
    }
  }
});

test("P1 phone 390: drawer lists Social and Agents, pages fit, planner is a list", async ({ page, context, baseURL }) => {
  test.setTimeout(150_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await seed(page, new URL(baseURL!).origin);
  await page.goto("/app/my-work");
  await page.getByTestId("tab-more").click();
  const drawer = page.getByRole("dialog", { name: "Navigation" });
  if ((await (await page.request.get("/api/config")).json()).navP2) {
    // R121 (P2 menu): More shows section tiles; Social opens its page list.
    await expect(drawer.getByTestId("more-tile-agents")).toBeVisible();
    await drawer.getByTestId("more-tile-social").click();
    await drawer.getByRole("link", { name: "Planner" }).click();
  } else {
    await expect(drawer.getByRole("link", { name: "Agents" })).toBeVisible();
    await drawer.getByRole("link", { name: "Social" }).click();
  }
  await expect(page).toHaveURL(/\/app\/social$/);
  await expect(page.getByTestId("planner-agenda")).toBeVisible();
  await expect(page.getByTestId("planner-grid")).toBeHidden();
  await expect(page.getByTestId("planner-agenda").getByTestId("planner-post").first()).toBeVisible();
  // With no sidebar on a phone, the switcher under the title moves between Social's pages.
  const sw = page.getByTestId("social-switcher");
  await expect(sw.getByRole("link", { name: "Planner" })).toHaveAttribute("aria-current", "page");
  await sw.getByRole("link", { name: "Posts" }).click();
  await expect(page).toHaveURL(/\/app\/social\/posts$/);
  await expect(sw.getByRole("link", { name: "Posts" })).toHaveAttribute("aria-current", "page");
  await sw.getByRole("link", { name: "Accounts" }).click();
  await expect(page).toHaveURL(/\/app\/social\/accounts$/);
  // R85T: boundingBox does not wait, and the switcher is the new page's own (the old page's copy is hidden while the
  // Accounts route loads), so measure once Accounts has drawn and marks itself current.
  await expect(page.getByTestId("social-accounts")).toBeVisible();
  await expect(sw.getByRole("link", { name: "Accounts" })).toBeVisible();
  await expect(sw.getByRole("link", { name: "Accounts" })).toHaveAttribute("aria-current", "page");
  const tap = await sw.getByRole("link", { name: "Accounts" }).boundingBox();
  expect(tap && tap.height >= 44).toBe(true);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [path, name] of [["/app/social", "planner"], ["/app/social/posts", "posts"], ["/app/social/new", "new-post"], ["/app/social/accounts", "accounts"], ["/app/settings", "settings"], ["/app/settings/apps", "connections"]] as const) {
      await page.goto(path);
      await page.waitForTimeout(300);
      expect(await noSideScroll(page), `${path} ${scheme}`).toBe(true);
      await shot(page, `p1-${name}-390-${scheme}`);
      expect(await axe(page, `${name} 390 ${scheme}`)).toEqual([]);
    }
  }
  // The New post button on a phone is a full size tap target.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/social/posts");
  const box = await page.getByTestId("new-post").boundingBox();
  expect(box && box.height >= 32).toBe(true);
});
