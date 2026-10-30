import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Round 12 end to end: pin a chat message and see it in the channel's pinned bar, write a doc
 * template from scratch and make a doc from it, and the dashboard's People stat with AI agents
 * counted apart.
 */
test.describe.configure({ mode: "serial" });
let ctx: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  if (!process.env.E2E_BASE_URL) await ctx.setExtraHTTPHeaders({ "x-forwarded-for": `10.92.${test.info().workerIndex % 200}.1` });
  page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
});
test.afterAll(async () => { await ctx?.close(); });

test("chat: pin a message and find it in the pinned bar, then unpin it", async () => {
  await page.goto("/app/chat");
  await expect(page).toHaveURL(/\/app\/chat\/chn_/);
  const box = page.getByTestId("chat-composer");
  await box.fill("House rules: be kind, write things down.");
  await box.press("Enter");
  const msg = page.getByRole("region", { name: /^Messages in / }).getByTestId("chat-message").filter({ hasText: "House rules" });
  await expect(msg).toBeVisible();
  await msg.hover();
  await msg.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Pin to channel" }).click();
  const bar = page.getByTestId("pinned-bar");
  await expect(bar).toContainText("House rules");
  await expect(msg.getByTestId("pinned-label")).toContainText("Pinned by");
  await bar.getByRole("button", { name: "1 pinned" }).click();
  await bar.getByRole("button", { name: /^Unpin the message from/ }).click();
  await expect(bar).toHaveCount(0);
});

test("templates: write a doc template from scratch and make a doc from it", async () => {
  await page.goto("/app/templates");
  await expect(page.getByTestId("template-card").filter({ hasText: "Meeting notes" })).toBeVisible();
  await page.getByRole("button", { name: "New template" }).click();
  const d = page.getByRole("dialog", { name: "New template" });
  await d.getByLabel("Kind").selectOption("doc");
  await d.getByLabel("Template name (optional)").fill("Release note");
  await d.getByLabel("Doc title").fill("Release note");
  await d.getByLabel("Body").fill("# What changed\n- New pinned messages\n# Fixes\n- None");
  await d.getByRole("button", { name: "Save template" }).click();
  const card = page.getByTestId("template-card").filter({ hasText: "Release note" });
  await expect(card).toContainText("doc");
  await card.getByRole("button", { name: "Use template" }).click();
  const use = page.getByRole("dialog", { name: /Use "Release note"/ });
  await use.getByLabel("Doc title (optional)").fill("Release 1.8.0");
  await use.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/app\/docs\/doc_/);
  await expect(page.getByText("New pinned messages")).toBeVisible();
});

test("dashboard: People counts humans against seats and AI agents apart", async () => {
  const origin = new URL(page.url()).origin;
  const r = await page.request.post("/api/team/agents", { headers: { origin }, data: { name: "QA", title: "Quality", bio: "An AI agent that tests every release." } });
  expect(r.status()).toBe(201);
  await page.goto("/app");
  const note = page.getByTestId("stat-note");
  await expect(note).toContainText(/AI agents?, no seat used/);
});
