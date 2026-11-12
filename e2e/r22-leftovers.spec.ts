import { test, expect, type Page } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * Round 22 leftovers end to end: a chat message goes to Triage from its menu, and the board groups
 * cards by epic, where dragging a card to another epic column moves it into that epic.
 */
let visitor = 0;
const ip = () => `10.122.${test.info().workerIndex % 200}.${++visitor}`;

async function owner(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return headers;
}

test("a chat message goes to Triage from its menu", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const channels = (await (await page.request.get("/api/chat/channels", { headers })).json()).channels as { id: string; name: string }[];
  const g = channels.find((c) => c.name === "general")!;
  const text = `Refund request for order ${Date.now().toString().slice(-4)}`;
  await page.request.post(`/api/chat/channels/${g.id}/messages`, { data: { body: text }, headers });
  await page.goto(`/app/chat/${g.id}`);
  const msg = page.getByTestId("chat-message").filter({ hasText: text });
  await msg.hover();
  await msg.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Send to triage" }).click();
  await expect(page).toHaveURL(/\/app\/triage/);
  await expect(page.getByTestId("triage-list").getByText(text)).toBeVisible();
});

test("the board groups by epic and a drag moves a card into another epic", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const project = (await (await page.request.post("/api/projects", { data: { name: "Mobile app", key: "APP" }, headers })).json()).project;
  const mk = async (title: string, extra: Record<string, unknown> = {}) => (await (await page.request.post("/api/tasks", { data: { title, projectId: project.id, ...extra }, headers })).json()).task;
  const checkout = await mk("Checkout", { type: "epic" });
  const onboarding = await mk("Onboarding", { type: "epic" });
  const pay = await mk("Pay button");
  const welcome = await mk("Welcome screen");
  await mk("Fix crash on launch", { type: "bug" });
  await page.request.post(`/api/epics/${checkout.id}/items`, { data: { ids: [pay.id] }, headers });
  await page.request.post(`/api/epics/${onboarding.id}/items`, { data: { ids: [welcome.id] }, headers });

  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(`/app/tasks?view=board&project=${project.id}`);
  await page.getByLabel("Group board by").selectOption("epic");
  await expect(page).toHaveURL(/group=epic/);
  const col = (name: string) => page.getByTestId(`column-${name}`);
  await expect(col("Checkout")).toContainText("Pay button");
  await expect(col("Onboarding")).toContainText("Welcome screen");
  await expect(col("No epic")).toContainText("Fix crash on launch");
  // Epics are the columns, not cards.
  await expect(page.getByTestId("board").getByText("Checkout", { exact: true })).toHaveCount(1);

  const card = col("Checkout").getByText("Pay button");
  const target = col("Onboarding");
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 20, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 120, { steps: 12 });
  await page.mouse.up();
  await expect(col("Onboarding")).toContainText("Pay button");
  await expect.poll(async () => (await (await page.request.get(`/api/tasks/${pay.id}`, { headers })).json()).task.parentId).toBe(onboarding.id);
  await page.screenshot({ path: `${SHOTS_ROOT}/multies-r22/board-by-epic.png` });
});
