import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R89: screenshots and the accessibility check for whiteboards, diagrams, mind map and Present, at 1280 and 390,
 * light and dark, and Forest. Runs only with SHOTS_DIR set.
 */
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.190.${test.info().workerIndex % 200}.${++visitor}`;

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("docs visual screenshots and axe", async ({ page, context, baseURL }) => {
  test.setTimeout(1_200_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  const headers = { origin };
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });

  const plan = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Where the launch stands and what comes next." }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Goals" }] },
    { type: "bulletList", content: ["Grow sign ups by a third", "Cut churn under 2 percent", "Ship mobile boards"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
    { type: "callout", attrs: { variant: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Notes: open with the sign up chart." }] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "How it flows" }] },
    { type: "diagram", content: [{ type: "text", text: "flowchart LR\n  A[Visit] --> B{Signed up?}\n  B -- Yes --> C[Onboarding]\n  B -- No --> D[Reminder mail]\n  C --> E[Active team]" }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Risks" }] },
    { type: "bulletList", content: ["Late app review", "Hiring"].map((t) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] })) },
  ] };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Launch plan", content: plan }, headers })).json()).doc as { id: string };
  const board = (await (await page.request.post("/api/templates/starter-user-flow/use", { data: {}, headers })).json()).doc as { id: string };
  const bad: string[] = [];
  const AXE_SKIP = "";

  const visit = async (name: string, url: string, ready: () => Promise<void>, dev: string, scheme: string) => {
    await page.goto(url);
    await ready();
    await shot(page, `r89-${name}-${dev}-${scheme}`);
    expect(await noSideways(page), `${name} ${dev} ${scheme} sideways`).toBe(true);
    bad.push(...await axe(page, `${scheme} ${dev} ${name}`));
  };

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h, dev] of [[1280, 860, "desktop"], [390, 844, "phone"]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await visit("doc-diagram", `/app/docs/${doc.id}`, async () => { await expect(page.getByTestId("diagram-preview").locator("svg")).toBeVisible({ timeout: 30_000 }); await page.getByTestId("diagram-block").scrollIntoViewIfNeeded(); }, dev, scheme);
      await visit("whiteboard", `/app/docs/${board.id}`, async () => { await expect(page.getByTestId("board-host")).not.toHaveAttribute("data-element-count", "0", { timeout: 30_000 }); }, dev, scheme);
      await visit("mindmap", `/app/docs/${doc.id}?mode=mindmap`, async () => { await expect(page.getByTestId("mindmap-node").first()).toBeVisible(); }, dev, scheme);
      await visit("present", `/app/docs/${doc.id}?present=1&slide=1`, async () => { await expect(page.getByTestId("slide")).toBeVisible(); }, dev, scheme);
      await page.goto(`/app/docs/${doc.id}?present=1&slide=0`);
      await expect(page.getByTestId("slide")).toBeVisible();
      await shot(page, `r89-present-title-${dev}-${scheme}`);
      await page.getByTestId("presenter-toggle").click();
      await expect(page.getByTestId("speaker-notes")).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await shot(page, `r89-presenter-${dev}-${scheme}`);
      bad.push(...await axe(page, `${scheme} ${dev} presenter`));
      await visit("docs-list", "/app/docs", async () => { await expect(page.getByTestId("doc-list")).toBeVisible(); }, dev, scheme);
    }
  }
  // Forest
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await visit("doc-diagram", `/app/docs/${doc.id}`, async () => { await expect(page.getByTestId("diagram-preview").locator("svg")).toBeVisible({ timeout: 30_000 }); await page.getByTestId("diagram-block").scrollIntoViewIfNeeded(); }, "desktop", "forest");
  await visit("mindmap", `/app/docs/${doc.id}?mode=mindmap`, async () => { await expect(page.getByTestId("mindmap-node").first()).toBeVisible(); }, "desktop", "forest");
  await visit("present-title", `/app/docs/${doc.id}?present=1`, async () => { await expect(page.getByTestId("slide")).toBeVisible(); }, "desktop", "forest");
  await visit("whiteboard", `/app/docs/${board.id}`, async () => { await expect(page.getByTestId("board-host")).not.toHaveAttribute("data-element-count", "0", { timeout: 30_000 }); }, "desktop", "forest");
  void AXE_SKIP;
  expect(bad, bad.join("\n")).toEqual([]);
});
