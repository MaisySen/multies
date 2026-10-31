import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/** R133: the operator console, closed to a workspace member, still has its one page heading and no axe findings. */
test("R133: /app/admin closed to a member keeps a heading and is axe clean", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.133.7.${Math.floor(Math.random() * 200)}` });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
  for (const size of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await page.goto("/app/admin");
    await expect(page.getByText("This console is for platform operators")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Operator console" })).toHaveCount(1);
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => ["moderate", "serious", "critical"].includes(v.impact ?? "")).map((v) => v.id)).toEqual([]);
  }
});
