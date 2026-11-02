import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * F13b fixes (items 4 to 8 of the F13 brief): one Retry recovers every failed read on Tasks (MB-320), Log time opens
 * on its first field (MB-305), New task stays in My Work and lands on My Day with focus (MB-306), My Day has an add
 * box (MB-307), the contract interview gets the full width (MB-309), tab rows never widen the page at 390 and show
 * their active tab (MB-294, MB-310, MB-319), and the layout menu is called Layout (MB-316).
 */
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function demo(page: Page, path = "/app/my-work") {
  await page.goto("/login");
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/account/demo", { headers: { origin } });
  expect(r.ok(), await r.text()).toBe(true);
  await page.goto(path);
}
const serious = async (page: Page) => (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("Tasks: one Retry recovers the page and the Projects sidebar (MB-320)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page, "/app/my-work");
  const fail = (route: import("@playwright/test").Route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) });
  await page.route(/\/api\/projects(\?|$)/, fail);
  await page.route(/\/api\/tasks(\?|$)/, fail);
  await page.goto("/app/tasks");
  await expect(page.getByTestId("load-error-retry").first()).toBeVisible({ timeout: 20_000 });
  await page.unroute(/\/api\/projects(\?|$)/);
  await page.unroute(/\/api\/tasks(\?|$)/);
  await page.getByTestId("load-error-retry").first().click();
  await expect(page.getByTestId("load-error")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("load-error-inline")).toHaveCount(0);
});

test("Log time opens on the task field, not Close (MB-305)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page, "/app/time");
  await page.getByRole("button", { name: "Log time" }).first().click();
  await expect(page.getByRole("dialog", { name: "Log time" })).toBeVisible();
  await expect(page.getByLabel("Task", { exact: true })).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`My Work at ${width}: New task stays here and lands on My Day; the add box adds (MB-306, MB-307)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    await demo(page);
    await expect(page.getByTestId("my-day-add")).toBeVisible({ timeout: 20_000 });
    const quick = `Quick ${uniq()}`;
    const box = page.getByLabel("Add a task for today");
    await box.fill(quick);
    const made1 = page.waitForResponse((r) => /\/api\/tasks(\?|$)/.test(r.url()) && r.request().method() === "POST");
    const day1 = page.waitForResponse((r) => /\/api\/my-day(\?|$)/.test(r.url()) && r.request().method() === "POST");
    await box.press("Enter");
    const r1 = await made1;
    expect(r1.status(), await r1.text()).toBeLessThan(300);
    const r2 = await day1;
    expect(r2.status(), await r2.text()).toBeLessThan(300);
    await expect(page.getByTestId("my-day-item").filter({ hasText: quick })).toBeVisible();
    await expect(box).toBeFocused();
    await expect(box).toHaveValue("");

    const made = `Made ${uniq()}`;
    await page.getByTestId("mywork-new-task").click();
    const dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Title").fill(made);
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/app\/my-work/);
    const row = page.getByTestId("my-day-item").filter({ hasText: made });
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: made })).toBeFocused();
    expect(await noSideScroll(page)).toBe(true);
    await page.waitForTimeout(800); // the Added toast finishes fading in before the contrast check
    expect(await serious(page)).toEqual([]);
  });
}

test("contract interview opens and takes the full width at 1280 (MB-309)", async ({ page }) => {
  test.skip(process.env.CONTRACTS_E2E !== "1", "needs Tools on with the stand in engine (see contracts-r108.spec.ts)");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page, "/app/tools/templates?view=contracts");
  await expect(page.getByTestId("contract-note").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("tools-rail")).toBeVisible();
  await page.getByTestId("contract-template-std-service").getByRole("button", { name: /^Start/ }).click();
  await expect(page.getByTestId("contract-step")).toBeVisible();
  await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
  await expect(page.getByTestId("tools-rail")).toHaveCount(0);
  const step = await page.getByTestId("contract-step").boundingBox();
  const preview = await page.getByTestId("contract-preview").boundingBox();
  expect(step && preview && step.x + step.width <= preview.x).toBeTruthy(); // questions and preview side by side, no overlap
  expect(await noSideScroll(page)).toBe(true);
  expect(await serious(page)).toEqual([]);
  await page.getByRole("button", { name: "Back to templates" }).click();
  await expect(page.getByTestId("tools-rail")).toBeVisible();
  expect(errors).toEqual([]);
});

test("contract interview opens at 390 with Questions and Preview tabs (MB-309)", async ({ page }) => {
  test.skip(process.env.CONTRACTS_E2E !== "1", "needs Tools on with the stand in engine (see contracts-r108.spec.ts)");
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page, "/app/tools/templates?view=contracts");
  await expect(page.getByTestId("contract-note").first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("contract-template-std-service").getByRole("button", { name: /^Start/ }).click();
  await expect(page.getByTestId("contract-step")).toBeVisible();
  await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Questions or preview" })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await serious(page)).toEqual([]);
  expect(errors).toEqual([]);
});

for (const scheme of ["light", "dark"] as const) {
  test(`tab rows at 390 ${scheme}: no side scroll, active tab in view, axe clean (MB-294, MB-310, MB-319)`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    const rows: [string, string][] = [["/app/forms?tab=reports", "forms-tabs"], ["/app/social/calendar", "social-switcher"], ["/app/files?view=docs", "docs-tab-all"]];
    for (const [path, id] of rows) {
      await page.goto(path);
      await page.waitForTimeout(800);
      expect(await noSideScroll(page), path).toBe(true);
      const row = page.getByTestId(id);
      if (!(await row.count())) continue; // a section this demo does not have
    }
    await page.goto("/app/files?view=docs");
    const nav = page.getByRole("navigation", { name: "Files" });
    if (await nav.isVisible({ timeout: 8_000 }).catch(() => false)) { // the demo has no Files unless Tools are on
      await expect(nav.locator('[aria-current="page"]')).toBeInViewport();
      expect(await noSideScroll(page)).toBe(true);
      expect(await serious(page)).toEqual([]);
    }
    await page.goto("/app/forms");
    await expect(page.getByTestId("forms-tabs")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("forms-tabs").getByRole("tab").last().focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("forms-tabs").getByRole("tab").last()).toBeInViewport();
    expect(await noSideScroll(page)).toBe(true);
    expect(await serious(page)).toEqual([]);
  });
}

// F13b (MB-309, v28 repro): the owner's top bar Create menu crashed every page at 1280 (React #130) because the Blog post
// item had no icon. Open it as the demo owner on the pages the verifier used; every item renders and nothing throws.
test("top bar Create menu opens for the owner at 1280 on My Work, Tools and Templates (MB-309)", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  // The staging QA workspace has a site, which is what adds Site page and Blog post to the owner's menu.
  await page.goto("/app/docs/sites");
  await page.getByLabel("Site name").fill("F13b studio");
  await page.getByLabel("Site address").fill(`f13b-${uniq()}`);
  await page.getByRole("button", { name: "Start a site" }).click();
  await expect(page.getByRole("tab", { name: "Blog" })).toBeVisible({ timeout: 20_000 });
  for (const path of ["/app/my-work", "/app/tools", "/app/tools/templates?view=contracts"]) {
    await page.goto(path);
    await page.getByTestId("create-menu").click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Blog post" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Site page" })).toBeVisible();
    const items = menu.getByRole("menuitem");
    for (let i = 0; i < await items.count(); i++) await expect(items.nth(i).locator("svg").first()).toBeVisible();
    await expect(page.getByText("Something went wrong on this page")).toHaveCount(0);
    expect(await serious(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test("the layout menu is called Layout (MB-316)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await expect(page.getByTestId("view-menu")).toHaveAccessibleName(/Layout/);
});

test("doc tree: a table and a course go to the trash from Page actions, with Undo (POL1 follow up)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const origin = new URL(page.url()).origin;
  const headers = { origin };
  const tTitle = `Jobs ${uniq()}`;
  const cTitle = `Safety ${uniq()}`;
  const t = await page.request.post("/api/tables", { data: { title: tTitle, template: "jobs" }, headers });
  expect(t.ok(), await t.text()).toBe(true);
  const c = await page.request.post("/api/courses", { data: { title: cTitle }, headers });
  expect(c.ok(), await c.text()).toBe(true);
  await page.goto("/app/docs");
  for (const [title, done] of [[tTitle, "Table moved to the trash"], [cTitle, "Course moved to the trash"]] as const) {
    const row = page.getByTestId(`tree-row-${title}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.hover();
    await page.getByRole("button", { name: `Page actions for ${title}` }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).last();
    await expect(dialog).toBeVisible();
    expect(await serious(page)).toEqual([]);
    await dialog.getByRole("button", { name: /trash/i }).click();
    await expect(page.getByText(done)).toBeVisible();
    await expect(page.getByTestId(`tree-row-${title}`)).toHaveCount(0);
    if (title === tTitle) {
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page).toHaveURL(/\/app\/docs\//);
      await page.goto("/app/docs");
      await expect(page.getByTestId(`tree-row-${title}`)).toBeVisible({ timeout: 20_000 });
    }
  }
});
