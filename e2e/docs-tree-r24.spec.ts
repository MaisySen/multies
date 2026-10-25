import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R24.5 Docs tree and backlinks end to end: three pages; drag one onto another to nest it, reorder
 * with the page menu, link the parent to the child and to a task with the page link picker ([[ and
 * the toolbar button), then open the child and see "Linked from", the breadcrumbs, the task panel's
 * "Linked from docs", and that all of it stays after a reload.
 */
let visitor = 0;
const ip = () => `10.125.${test.info().workerIndex % 200}.${++visitor}`;

async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!; const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 14 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}

test("nest and reorder pages, link pages and a task, and see Linked from after a reload", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1360, height: 860 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Writer", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Spring launch", key: "SPR" }, headers })).json()).project as { id: string };
  const task = (await (await page.request.post("/api/tasks", { data: { title: "Book the launch venue", projectId: project.id }, headers })).json()).task as { id: string };
  const mk = async (title: string, text: string, parentId?: string) => (await (await page.request.post("/api/docs", { data: { title, text, parentId }, headers })).json()).doc as { id: string };
  const a = await mk("Launch plan", "Goals for the spring launch.");
  const b = await mk("Press kit", "# Press kit\nLogos, screenshots and the founder quote.\n- Logo files\n- Product screenshots\n- Founder quote");
  const c = await mk("Budget", "Venue, ads and swag.");
  await mk("Venue shortlist", "Three halls near the station.", a.id);
  const tree = async () => (await (await page.request.get("/api/docs/tree")).json()).tree as { id: string; title: string; children: { id: string; title: string }[] }[];

  await page.goto("/app/docs");
  const side = page.getByTestId("doc-tree");
  await expect(side.getByTestId("tree-row-Press kit")).toBeVisible();

  // Drag "Press kit" onto "Launch plan": it becomes a sub page.
  await drag(page, side.getByTestId("tree-row-Press kit"), side.getByTestId("tree-row-Launch plan"));
  await expect.poll(async () => (await tree()).find((n) => n.id === a.id)?.children.map((x) => x.title)).toEqual(["Venue shortlist", "Press kit"]);
  await expect(side.getByRole("group").filter({ has: page.getByTestId("tree-row-Press kit") }).first()).toBeVisible();

  // Reorder with the keyboard friendly menu: "Press kit" up above "Venue shortlist", "Budget" to the top.
  await side.getByTestId("tree-row-Press kit").hover();
  await side.getByRole("button", { name: "Page actions for Press kit" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(async () => (await tree()).find((n) => n.id === a.id)?.children.map((x) => x.title)).toEqual(["Press kit", "Venue shortlist"]);
  await side.getByTestId("tree-row-Budget").hover();
  await side.getByRole("button", { name: "Page actions for Budget" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await expect.poll(async () => (await tree()).map((n) => n.title)).toEqual(["Budget", "Launch plan"]);
  void c;

  // In "Launch plan", link to "Press kit" with [[ and to the task with the toolbar button.
  await side.getByRole("link", { name: "Launch plan" }).click();
  await expect(page.getByLabel("Doc title")).toHaveValue("Launch plan");
  const body = page.getByLabel("Doc body");
  await body.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Media needs are in the [[");
  const picker = page.getByTestId("page-link-picker");
  await expect(picker).toBeVisible();
  await page.getByLabel("Find a page or task").fill("Press");
  await expect(picker.getByRole("option", { name: /Press kit/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await page.keyboard.type("before we ship.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Next step: ");
  await page.getByRole("button", { name: "Link a page or task" }).click();
  await page.getByLabel("Find a page or task").fill("venue");
  await expect(picker.getByRole("option", { name: /Book the launch venue/ })).toBeVisible();
  await picker.getByRole("option", { name: /Book the launch venue/ }).click();
  await expect(body.getByRole("link", { name: "Press kit" })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/docs/${b.id}/backlinks`)).json()).backlinks.map((x: { title: string }) => x.title), { timeout: 25_000 }).toEqual(["Launch plan"]);
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${task.id}/backlinks`)).json()).backlinks.length, { timeout: 25_000 }).toBe(1);

  // Open "Press kit": Linked from "Launch plan", with breadcrumbs.
  await side.getByRole("link", { name: "Press kit" }).click();
  await expect(page.getByLabel("Doc title")).toHaveValue("Press kit");
  const linked = page.getByTestId("linked-from");
  await expect(linked.getByRole("link", { name: /Launch plan/ })).toBeVisible();
  await expect(linked).toContainText("Media needs are in the Press kit before we ship.");
  await expect(page.getByTestId("doc-breadcrumbs")).toContainText("Launch plan");
  mkdirSync("/home/user/tab/files/multies-r24", { recursive: true });
  await page.screenshot({ path: "/home/user/tab/files/multies-r24/docs.png" });

  // Reload: the tree, the breadcrumbs and Linked from all stay.
  await page.reload();
  await expect(page.getByTestId("linked-from").getByRole("link", { name: /Launch plan/ })).toBeVisible();
  await expect(page.getByTestId("doc-breadcrumbs")).toContainText("Launch plan");
  expect((await tree()).find((n) => n.id === a.id)?.children.map((x) => x.title)).toEqual(["Press kit", "Venue shortlist"]);

  // The task panel lists the doc that links to it.
  await page.goto(`/app/tasks?view=list&task=${task.id}`);
  await expect(page.getByTestId("task-linked-from").getByRole("link", { name: /Launch plan/ })).toBeVisible();
  await ctx.close();
});
