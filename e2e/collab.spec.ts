import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Doc co-editing: two browser windows signed into the same demo workspace open one doc,
 * each sees the other's typing and presence, the doc row keeps the merged text, and a
 * change made through the API reaches the open editors.
 */
let visitor = 0;
const ip = () => `10.79.${test.info().workerIndex % 200}.${++visitor}`;

async function twoWindows(browser: Browser) {
  const first = await browser.newContext({ extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const a = await first.newPage();
  await a.goto("/login");
  await a.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(a).toHaveURL(/\/app/);
  const second = await browser.newContext({ storageState: await first.storageState(), extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const b = await second.newPage();
  return { a, b, close: async () => { await first.close(); await second.close(); } };
}

const body = (p: Page) => p.getByRole("textbox", { name: "Doc body" });

test("two windows co-edit one doc", async ({ browser }) => {
  test.setTimeout(60_000);
  const { a, b, close } = await twoWindows(browser);
  const doc = (await (await a.request.post("/api/docs", { data: { title: "Launch plan", text: "Agenda" } })).json()).doc;

  await a.goto(`/app/docs/${doc.id}`);
  await b.goto(`/app/docs/${doc.id}`);
  // The saved text seeds the room once, not once per window.
  await expect(body(a).locator("p")).toHaveCount(1);
  await expect(body(a)).toContainText("Agenda");
  await expect(body(b).locator("p")).toHaveCount(1);
  await expect(body(b)).toContainText("Agenda");
  await expect(a.getByTestId("collab-peer")).toHaveCount(1);
  await expect(b.getByTestId("collab-peer")).toHaveCount(1);

  await body(a).click();
  await a.keyboard.press("End");
  await a.keyboard.type(" for Friday");
  await expect(body(b)).toContainText("Agenda for Friday");

  await body(b).click();
  await b.keyboard.press("Control+End");
  await b.keyboard.press("Enter");
  await b.keyboard.type("Ben: book the room");
  await expect(body(a)).toContainText("Ben: book the room");

  // One window saves the merged text to the doc row, for search, agents and the API.
  await expect.poll(async () => (await (await a.request.get(`/api/docs/${doc.id}`)).json()).doc.text, { timeout: 10_000 })
    .toBe("Agenda for Friday\nBen: book the room");

  // An agent rewrites the doc through the API: the open editors load it, the room does not overwrite it.
  const now = (await (await a.request.get(`/api/docs/${doc.id}`)).json()).doc;
  const patched = await a.request.patch(`/api/docs/${doc.id}`, { data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Rewritten by an agent" }] }] }, version: now.version } });
  expect(patched.ok()).toBe(true);
  // (The text check skips the other person's caret label, which sits inside the editor.)
  await expect(body(a)).toContainText("Rewritten by an agent", { timeout: 20_000 });
  await expect(body(b)).toContainText("Rewritten by an agent");
  await expect(body(a)).not.toContainText("Agenda");
  await expect(body(b)).not.toContainText("Agenda");
  await a.waitForTimeout(1500);
  expect((await (await a.request.get(`/api/docs/${doc.id}`)).json()).doc.text).toBe("Rewritten by an agent");
  await close();
});

test("the collab socket refuses a doc from outside the workspace", async ({ page }) => {
  await page.goto("/login");
  const status = await page.evaluate(() => new Promise<string>((resolve) => {
    const ws = new WebSocket(`${location.origin.replace("http", "ws")}/api/docs/doc_not_yours/collab`);
    ws.onopen = () => resolve("open");
    ws.onerror = () => resolve("refused");
  }));
  expect(status).toBe("refused");
});
