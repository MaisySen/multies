import { test, expect } from "@playwright/test";

/** R55 (plan idea 24): the starter gallery has a two week sprint, hiring, a launch and a support desk; using one makes the project. */
let visitor = 0;
const ip = () => `10.156.${test.info().workerIndex % 200}.${++visitor}`;

for (const size of [{ name: "desktop", width: 1280, height: 860 }, { name: "phone", width: 390, height: 844 }]) {
  test(`${size.name}: the four new starters show in Templates and the sprint one makes its project`, async ({ page, context }) => {
    test.setTimeout(90_000);
    if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/login");
    await page.getByRole("button", { name: "Explore a demo workspace" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
    await page.goto("/app/templates");
    const cards = page.getByTestId("template-card");
    for (const name of ["Two week sprint", "Hiring", "Product launch", "Support desk"]) await expect(cards.filter({ has: page.getByRole("heading", { name, exact: true }) })).toHaveCount(1);
    const sprint = cards.filter({ has: page.getByRole("heading", { name: "Two week sprint", exact: true }) });
    await expect(sprint.getByText("project, 5 tasks")).toBeVisible();
    await sprint.getByRole("button", { name: "Use template" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/tasks\?project=/, { timeout: 20_000 });
    await expect(page.getByText("Sprint planning: pick the work and agree the goal").first()).toBeVisible({ timeout: 15_000 });
  });
}
