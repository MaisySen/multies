import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Round 9: no serious or critical axe findings on the pages that had them (the task and deal
 * boards, where the draggable card was a button wrapping other buttons; the timesheet and the
 * legal tables, which scrolled without being focusable), at desktop and phone sizes.
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.90.${test.info().workerIndex % 200}.${++visitor}` });
});

for (const size of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
  test(`boards, timesheet and legal tables have no serious axe findings (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/login");
    await page.getByRole("button", { name: "Explore a demo workspace" }).click();
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
    await expect.poll(async () => ((await (await page.request.get("/api/tasks")).json()).tasks ?? []).length, { timeout: 15_000 }).toBeGreaterThan(5);
    // The sample seed's second part (docs, deals, fields, forms) lands a moment after the tasks.
    await expect.poll(async () => {
    await page.request.post("/api/account/demo/seed", { headers: { origin: new URL(page.url()).origin } }).catch(() => null);
    return ((await (await page.request.get("/api/docs")).json().catch(() => ({}))).docs ?? []).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    const projects = (await (await page.request.get("/api/projects")).json()).projects as { id: string; name: string }[];
    const project = projects.find((p) => p.name === "Blue Harbor move")!;
    for (const path of [`/app/tasks?project=${project.id}&view=board`, "/app/deals", "/app/time", "/privacy"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const { violations } = await new AxeBuilder({ page }).analyze();
      const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${path}: ${v.id} ${v.nodes[0]?.target}`);
      expect(bad).toEqual([]);
    }
  });
}
