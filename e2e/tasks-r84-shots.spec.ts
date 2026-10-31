import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R84: screenshots and the accessibility check for Tasks (UX gate items 6, 9 and 10). Runs only with SHOTS_DIR set.
 * PHASE=before takes the list and the task panel as they were; PHASE=after takes the same screens plus pinned view tabs,
 * a grouped list, the task page, tags, workspace fields and the bulk bar, at 1280 and 390, light and dark, and Forest.
 */
const DIR = process.env.SHOTS_DIR;
const PHASE = process.env.PHASE ?? "after";
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.184.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("tasks screenshots and axe", async ({ page, context, baseURL }) => {
  test.setTimeout(900_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/tasks?view=list&project=");
  await expect(page.locator("[data-task-id]").first()).toBeVisible({ timeout: 20_000 });
  let first: { id: string; ref: string } | undefined;
  for (let i = 0; i < 10 && !first; i++) {
    first = ((await (await page.request.get("/api/tasks")).json()) as { tasks?: { id: string; ref: string }[] }).tasks?.[0];
    if (!first) await page.waitForTimeout(500);
  }
  if (!first) throw new Error("no demo task");
  const bad: string[] = [];

  if (PHASE === "after") {
    // Seed: tags with colours, two people on a task, a workspace field and a pinned shared view.
    const headers = { origin };
    const people = ((await (await page.request.get("/api/tasks/assignees")).json()) as { assignees: { id: string; type: string }[] }).assignees.filter((p) => p.type === "member");
    await page.request.post("/api/tasks/tags", { headers, data: { name: "launch", color: "#2563eb" } });
    await page.request.post("/api/tasks/tags", { headers, data: { name: "client", color: "#16a34a" } });
    await page.request.patch(`/api/tasks/${first.id}`, { headers, data: { labels: ["launch", "client"], assignees: people.slice(0, 2).map((p) => p.id), notes: "Ship the **launch** checklist.\n\n- Final copy\n- Photos\n\nAsk @Olive before Friday." } });
    await page.request.post("/api/fields/workspace", { headers, data: { name: "Client", type: "select", options: [{ label: "Acme" }, { label: "Globex" }] } });
    await page.request.post("/api/tasks/views", { headers, data: { name: "By priority", view: "list", filters: { group: "priority", sort: "due" }, shared: true, pinned: true } });
    await page.request.post("/api/tasks/views", { headers, data: { name: "My week", view: "list", filters: { assignee: "me", group: "due" }, pinned: true } });
  }

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h, dev] of [[1280, 860, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/tasks?view=list&project=");
      await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
      await shot(page, `tasks-${PHASE}-list-${dev}-${scheme}`);
      expect(await noSideways(page)).toBe(true);
      bad.push(...await axe(page, `${scheme} ${w} list`));
      await page.goto(`/app/tasks?view=list&task=${first.id}`);
      await page.waitForTimeout(600);
      await shot(page, `tasks-${PHASE}-panel-${dev}-${scheme}`);
      bad.push(...await axe(page, `${scheme} ${w} panel`));
      if (PHASE !== "after") continue;
      await page.goto("/app/tasks?view=list&group=assignee");
      await expect(page.getByTestId("group-header").first()).toBeVisible();
      await shot(page, `tasks-after-grouped-${dev}-${scheme}`);
      expect(await noSideways(page)).toBe(true);
      bad.push(...await axe(page, `${scheme} ${w} grouped`));
      await page.goto(`/app/tasks/${first.ref}`);
      await expect(page.getByTestId("task-page")).toBeVisible();
      await shot(page, `tasks-after-page-${dev}-${scheme}`);
      expect(await noSideways(page)).toBe(true);
      bad.push(...await axe(page, `${scheme} ${w} page`));
      await page.goto("/app/tasks?view=list&manage=tags");
      await expect(page.getByRole("dialog", { name: "Tags" })).toBeVisible();
      await shot(page, `tasks-after-tags-${dev}-${scheme}`);
      bad.push(...await axe(page, `${scheme} ${w} tags`));
      await page.goto("/app/tasks?view=list&manage=fields");
      await expect(page.getByRole("dialog", { name: "Workspace fields" })).toBeVisible();
      await shot(page, `tasks-after-fields-${dev}-${scheme}`);
      bad.push(...await axe(page, `${scheme} ${w} fields`));
    }
  }

  if (PHASE === "after") {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/app/tasks?view=list&project=");
    await page.getByRole("button", { name: "Saved views" }).click();
    await page.getByRole("menuitem", { name: "Save as new view" }).click();
    await expect(page.getByRole("dialog", { name: "Save view" })).toBeVisible();
    await shot(page, "tasks-after-saveview-desktop-light");
    bad.push(...await axe(page, "save view dialog"));
    await page.keyboard.press("Escape");
    // The bulk bar with the new actions.
    const rows = page.locator("[data-task-id]");
    await rows.nth(0).click({ modifiers: ["Shift"] }).catch(() => undefined);
    await page.getByRole("checkbox").nth(1).check().catch(() => undefined);
    await page.getByRole("checkbox").nth(2).check().catch(() => undefined);
    await shot(page, "tasks-after-bulk-desktop-light");

    // One brand theme.
    await page.goto("/app/settings/branding");
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    for (const [path, name] of [["/app/tasks?view=list&group=priority", "grouped"], [`/app/tasks/${first.ref}`, "page"]] as const) {
      await page.goto(path);
      await page.waitForTimeout(700);
      await shot(page, `tasks-after-${name}-desktop-forest`);
      bad.push(...await axe(page, `forest ${name}`));
    }
  }
  expect(bad).toEqual([]);
});
