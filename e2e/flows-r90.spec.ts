import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R90: the automation builder. A flow from a template opens on the canvas; a flow with an approval waits for an OK on
 * Approvals and then finishes; the run log shows each step; phones get the step list with sheets. With SHOTS_DIR set
 * it also shoots the hub, editor, runs and run detail at 1280 and 390 in light and dark, and Forest at 1280, with axe.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.190.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}
async function axe(page: Page, label: string) {
  await page.locator("main").first().waitFor();
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const approvalGraph = {
  nodes: [
    { id: "t", kind: "trigger", config: { trigger: "manual" }, x: 0, y: 0 },
    { id: "p", kind: "approval", config: { note: "OK to tell the team?" }, x: 0, y: 150 },
    { id: "a", kind: "action", label: "Tell admins", config: { action: "notify", to: "admins", message: "Approved by a person" }, x: 0, y: 300 },
  ],
  edges: [{ id: "t-p", from: "t", to: "p", branch: "next" }, { id: "p-a", from: "p", to: "a", branch: "next" }],
};

test("flows: template to canvas, approval to done, run log, phone list", async ({ page, context, baseURL }) => {
  test.setTimeout(240_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  const bad: string[] = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);

  // Before: the rules page as it was (unchanged, now also the Rules tab and /app/automations/rules).
  if (DIR) {
    await page.goto("/app/automations/rules");
    await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
    await shot(page, "r90-before-automations-1280-light");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await shot(page, "r90-before-automations-390-light");
    await page.setViewportSize({ width: 1280, height: 860 });
  }

  // The rail has Automations under Agents.
  await page.goto("/app/automations");
  await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Flows" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Start from a template" })).toBeVisible();
  await shot(page, "r90-hub-empty-1280-light");

  // A template opens on the canvas, off, ready to edit.
  await page.getByRole("button", { name: /Web page changed alert/ }).click();
  await expect(page).toHaveURL(/\/app\/automations\/flows\//);
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 15_000 });
  expect(await page.locator(".react-flow__node").count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Off", { exact: true })).toBeVisible();
  await page.locator(".react-flow__node").first().click();
  await expect(page.getByLabel("What starts the flow")).toHaveValue("page_changed");
  await expect(page.getByText("1 to fix")).toBeVisible();
  await page.getByLabel("Page address").fill("https://example.com/pricing");
  await expect(page.getByText("1 to fix")).toBeHidden();
  await expect(page.getByText("Not saved")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not saved")).toBeHidden();
  await shot(page, "r90-editor-canvas-1280-light");
  bad.push(...(await axe(page, "editor 1280 light")));

  // Add a step from the panel, then remove it with undo.
  const before = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "Add step", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Wait/ }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  await expect(page.getByLabel("Wait for")).toBeVisible();
  await page.getByRole("button", { name: "Delete step" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);

  // A flow with an approval waits for an OK, then finishes.
  const created = await (await page.request.post("/api/flows", { headers: { origin }, data: { name: "Approve then tell", graph: approvalGraph } })).json();
  const id = created.flow.id as string;
  await page.goto(`/app/automations/flows/${id}`);
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page).toHaveURL(/\/app\/automations\/runs\//);
  await expect(page.getByText("This run waits for an OK")).toBeVisible();
  await shot(page, "r90-run-waiting-1280-light");
  await page.goto("/app/approvals");
  await expect(page.getByText("Automations waiting for an OK")).toBeVisible();
  await expect(page.getByText("OK to tell the team?")).toBeVisible();
  await shot(page, "r90-approvals-1280-light");
  await page.getByRole("region", { name: "Automation steps waiting for an OK" }).getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Automations waiting for an OK")).toBeHidden();
  const listRuns = async () => (await (await page.request.get(`/api/flows/runs?flowId=${id}`)).json()).runs as { id: string; status: string }[];
  await expect.poll(async () => (await listRuns())[0]?.status, { timeout: 15_000 }).toBe("succeeded");
  const runs = await listRuns();
  await page.goto(`/app/automations/runs/${runs[0].id}`);
  await expect(page.getByRole("list", { name: "Steps" }).getByText("Tell admins")).toBeVisible();
  await expect(page.getByText("Done").first()).toBeVisible();
  await page.getByText("What went in").first().click();
  await shot(page, "r90-run-detail-1280-light");
  bad.push(...(await axe(page, "run 1280 light")));

  await page.goto("/app/automations?tab=runs");
  await expect(page.getByRole("link", { name: /Approve then tell/ }).first()).toBeVisible();
  await shot(page, "r90-runs-1280-light");
  await page.goto("/app/automations");
  await shot(page, "r90-hub-1280-light");
  bad.push(...(await axe(page, "hub 1280 light")));

  // Phones: step list and a sheet, no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/automations/flows/${id}`);
  await expect(page.getByRole("list", { name: "Steps" })).toBeVisible();
  await expect(page.locator(".react-flow")).toHaveCount(0);
  expect(await noSideways(page)).toBe(true);
  await shot(page, "r90-editor-list-390-light");
  bad.push(...(await axe(page, "editor 390 light")));
  await page.getByRole("list", { name: "Steps" }).getByRole("button", { name: /Approval/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("What they are asked")).toHaveValue("OK to tell the team?");
  await shot(page, "r90-editor-sheet-390-light");
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();

  if (DIR) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [w, h] of [[1280, 860], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h });
        const tag = `${w}-${scheme}`;
        await page.goto("/app/automations"); await expect(page.getByRole("heading", { name: "Automations", level: 1 })).toBeVisible();
        if (w === 390) expect(await noSideways(page)).toBe(true);
        await shot(page, `r90-hub-${tag}`); bad.push(...(await axe(page, `hub ${tag}`)));
        await page.goto(`/app/automations/flows/${id}`); await page.waitForTimeout(600);
        await shot(page, `r90-editor-${tag}`); bad.push(...(await axe(page, `editor ${tag}`)));
        await page.goto(`/app/automations/runs/${runs[0].id}`); await expect(page.getByText("Tell admins").first()).toBeVisible();
        await shot(page, `r90-run-${tag}`); bad.push(...(await axe(page, `run ${tag}`)));
        await page.goto("/app/automations?tab=runs"); await shot(page, `r90-runs-${tag}`);
      }
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/app/settings/branding");
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    await page.goto(`/app/automations/flows/${id}`); await page.waitForTimeout(600);
    await page.locator(".react-flow__node").nth(1).click();
    await shot(page, "r90-editor-1280-forest"); bad.push(...(await axe(page, "editor forest")));
    await page.goto("/app/automations"); await shot(page, "r90-hub-1280-forest"); bad.push(...(await axe(page, "hub forest")));
  }
  expect(bad).toEqual([]);
});
