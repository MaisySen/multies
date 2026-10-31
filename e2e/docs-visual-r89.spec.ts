import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * R89: whiteboards, diagrams, mind map mode and Present in Docs.
 * Flows: make a whiteboard and draw; two sessions draw at once and both see both; a diagram with an error that is
 * then fixed; a mind map edit lands in the doc; Present and move through the slides with notes; a guest sees boards
 * and diagrams read only; the retro board template opens as a whiteboard.
 */
let visitor = 0;
const ip = () => `10.189.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(browser: Browser, width = 1280, height = 860) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width, height }, timezoneId: "UTC", colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { ctx, page, headers, base, tag };
}

async function drawBox(page: Page, tool: "rectangle" | "ellipse" | "diamond", x: number, y: number) {
  const host = page.getByTestId("board-host").first();
  await expect(host).toBeVisible({ timeout: 30_000 });
  await host.locator(`[data-testid="toolbar-${tool}"]`).click();
  const canvas = host.locator("canvas.excalidraw__canvas.interactive");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + x, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + 60, box.y + y + 40, { steps: 6 });
  await page.mouse.move(box.x + x + 120, box.y + y + 80, { steps: 6 });
  await page.mouse.up();
}

const count = (page: Page) => page.getByTestId("board-host").first();
const sceneCount = async (page: Page, id: string) => {
  const d = (await (await page.request.get(`/api/docs/${id}`)).json()).doc as { content: { content: { type: string; attrs?: { scene?: string } }[] } };
  const wb = d.content.content.find((b) => b.type === "whiteboard");
  return wb ? (JSON.parse(wb.attrs?.scene ?? "[]") as { isDeleted?: boolean }[]).filter((e) => !e.isDeleted).length : -1;
};

test("whiteboard: create, draw, autosave, export, and two sessions drawing at once", async ({ browser }) => {
  test.setTimeout(240_000);
  const { ctx, page } = await signUp(browser);
  await page.goto("/app/docs");
  await page.getByTestId("new-whiteboard").click();
  await expect(page).toHaveURL(/\/app\/docs\/[^/?]+$/);
  const id = page.url().split("/").pop()!;
  await expect(page.locator("[data-doc-kind=whiteboard]")).toBeVisible();
  await drawBox(page, "rectangle", 120, 120);
  await expect(count(page)).toHaveAttribute("data-element-count", "1");
  await expect.poll(() => sceneCount(page, id), { timeout: 20_000 }).toBe(1);

  // Export
  const [png] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as PNG" }).click()]);
  expect(png.suggestedFilename()).toMatch(/\.png$/);

  // A second session on the same board: both draw at the same moment, nobody's stroke is lost.
  const other = await ctx.newPage();
  await other.goto(`/app/docs/${id}`);
  await expect(count(other)).toHaveAttribute("data-element-count", "1", { timeout: 30_000 });
  await Promise.all([drawBox(page, "ellipse", 300, 140), drawBox(other, "diamond", 140, 300)]);
  await expect(count(page)).toHaveAttribute("data-element-count", "3", { timeout: 15_000 });
  await expect(count(other)).toHaveAttribute("data-element-count", "3", { timeout: 15_000 });
  await expect.poll(() => sceneCount(page, id), { timeout: 20_000 }).toBe(3);
  // The list marks it as a whiteboard; a reload keeps all three.
  await other.close();
  await page.reload();
  await expect(count(page)).toHaveAttribute("data-element-count", "3", { timeout: 30_000 });
  await ctx.close();
});

test("diagram: template, an error on its line, then fixed, no crash", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, headers } = await signUp(browser);
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Flow", text: "Intro." }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toContainText("Intro.");
  await editor.click();
  await editor.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/flowch");
  await page.keyboard.press("Enter");
  const block = page.getByTestId("diagram-block");
  await expect(block.locator("[data-testid=diagram-preview] svg")).toBeVisible({ timeout: 30_000 });
  // Break it: an arrow to nowhere on a new last line.
  const src = block.getByTestId("diagram-source");
  await src.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("  B -->");
  await expect(block.getByTestId("diagram-error")).toBeVisible({ timeout: 15_000 });
  await expect(block.locator("[data-error-line=true]")).toHaveCount(1);
  await expect(block.locator("[data-testid=diagram-preview] svg")).toBeVisible(); // the last good drawing stays
  await page.keyboard.type(" Z[Fixed]");
  await expect(block.getByTestId("diagram-error")).toHaveCount(0, { timeout: 15_000 });
  await expect(block.locator("[data-testid=diagram-preview] svg")).toContainText("Fixed");
  // Saved as text in the doc.
  await expect.poll(async () => ((await (await page.request.get(`/api/docs/${doc.id}`)).json()).doc.text as string), { timeout: 20_000 }).toContain("Z[Fixed]");
  await ctx.close();
});

test("mind map: an edit in the map is written into the doc", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, headers } = await signUp(browser);
  const content = { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Goals" }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Grow sign ups" }] }] }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Risks" }] },
  ] };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Plan", content }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}?mode=mindmap`);
  const map = page.getByTestId("mindmap");
  await expect(map.getByTestId("mindmap-node")).toHaveCount(4);
  await map.getByTestId("mindmap-node").filter({ hasText: "Grow sign ups" }).click();
  await page.keyboard.press("Enter"); // a sibling
  await page.getByTestId("mindmap-input").fill("Cut churn");
  await page.keyboard.press("Enter");
  await map.getByTestId("mindmap-node").filter({ hasText: "Risks" }).click();
  await page.keyboard.press("Tab"); // a child
  await page.getByTestId("mindmap-input").fill("Late launch");
  await page.keyboard.press("Enter");
  await expect(map.getByTestId("mindmap-node")).toHaveCount(6);
  // The doc is the source: switch back and read it there.
  await page.getByTestId("doc-mode").getByRole("button", { name: "Doc" }).click();
  const editor = page.locator(".ProseMirror").first();
  await expect(editor.locator("li", { hasText: "Cut churn" })).toBeVisible();
  await expect(editor.locator("li", { hasText: "Late launch" })).toBeVisible();
  await expect.poll(async () => ((await (await page.request.get(`/api/docs/${doc.id}`)).json()).doc.text as string), { timeout: 20_000 }).toMatch(/Cut churn[\s\S]*Risks[\s\S]*Late launch/);
  // Export
  await page.getByTestId("doc-mode").getByRole("button", { name: "Mind map" }).click();
  const [svg] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download as SVG" }).click()]);
  expect(svg.suggestedFilename()).toMatch(/mind map\.svg$/);
  await ctx.close();
});

test("present: slides, keys, presenter view with notes and timer", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, headers } = await signUp(browser, 1920, 1080);
  const content = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Quarterly review" }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Wins" }] },
    { type: "paragraph", content: [{ type: "text", text: "We shipped boards." }] },
    { type: "callout", attrs: { variant: "info" }, content: [{ type: "paragraph", content: [{ type: "text", text: "Notes: thank the team first." }] }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Next" }] },
    { type: "paragraph", content: [{ type: "text", text: "Mind maps." }] },
  ] };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Review", content }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}`);
  await page.getByTestId("present-button").click();
  const deck = page.getByTestId("present");
  await expect(deck).toBeVisible();
  await expect(deck.getByTestId("slide")).toContainText("Review");
  await expect(deck.getByTestId("slide")).toContainText("Quarterly review");
  await expect(deck.getByTestId("slide-number")).toHaveText("1 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(deck.getByTestId("slide")).toContainText("Wins");
  await expect(deck.getByTestId("slide")).not.toContainText("thank the team");
  await page.keyboard.press(" ");
  await expect(deck.getByTestId("slide-number")).toHaveText("3 / 3");
  await page.keyboard.press("ArrowLeft");
  await deck.getByTestId("presenter-toggle").click();
  await expect(deck.getByTestId("speaker-notes")).toHaveText("thank the team first.");
  await expect(deck.getByTestId("presenter-timer")).toHaveText(/^00:0\d$/);
  await page.keyboard.press("Escape");
  if (await deck.isVisible()) await page.keyboard.press("Escape");
  await expect(deck).toHaveCount(0);
  await ctx.close();
});

test("present on a phone: swipe moves between slides", async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page, headers } = await signUp(browser, 390, 844);
  const content = { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "One" }] },
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Two" }] },
  ] };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Phone deck", content }, headers })).json()).doc as { id: string };
  await page.goto(`/app/docs/${doc.id}?present=1`);
  const deck = page.getByTestId("present");
  await expect(deck.getByTestId("slide-number")).toHaveText("1 / 3");
  const swipe = async (from: number, to: number) => {
    await deck.dispatchEvent("pointerdown", { pointerType: "touch", clientX: from, clientY: 400, isPrimary: true });
    await deck.dispatchEvent("pointerup", { pointerType: "touch", clientX: to, clientY: 405, isPrimary: true });
  };
  await swipe(320, 80);
  await expect(deck.getByTestId("slide-number")).toHaveText("2 / 3");
  await swipe(80, 320);
  await expect(deck.getByTestId("slide-number")).toHaveText("1 / 3");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await ctx.close();
});

test("a guest sees boards and diagrams read only; templates open a whiteboard", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, headers, base, tag } = await signUp(browser);
  const project = (await (await page.request.post("/api/projects", { data: { name: `Harbour ${tag}` }, headers })).json()).project as { id: string };
  const scene = JSON.stringify([{ id: "e1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, version: 2, versionNonce: 7, isDeleted: false, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, angle: 0, seed: 1, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false }]);
  const content = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "Board below." }] },
    { type: "whiteboard", attrs: { id: "b1", scene, page: false, height: 420 } },
    { type: "diagram", content: [{ type: "text", text: "flowchart LR\n  A --> B" }] },
  ] };
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Shared plan", content, projectId: project.id }, headers })).json()).doc as { id: string };
  const invite = await (await page.request.post("/api/guests", { data: { projectId: project.id, email: `gus-${tag}@example.com` }, headers })).json();
  const guest = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const gp = await guest.newPage();
  await gp.goto(new URL(invite.inviteUrl).pathname);
  await expect(gp.getByText(`Harbour ${tag}`).first()).toBeVisible({ timeout: 20_000 });
  await gp.getByRole("button", { name: "Shared plan" }).first().click();
  await expect(gp.getByTestId("board-view-only")).toBeVisible({ timeout: 20_000 });
  await expect(gp.getByTestId("board-host")).toHaveAttribute("data-element-count", "1", { timeout: 30_000 });
  await expect(gp.locator("[data-testid=board-host] [data-testid=toolbar-rectangle]")).toHaveCount(0);
  await expect(gp.getByTestId("diagram-block").locator("[data-testid=diagram-preview] svg")).toBeVisible({ timeout: 30_000 });
  await expect(gp.getByTestId("diagram-source")).toHaveCount(0);
  await guest.close();

  // The retro board template opens as a whiteboard.
  const used = await (await page.request.post("/api/templates/starter-retro-board/use", { data: {}, headers })).json();
  await page.goto(`/app/docs/${used.doc.id}`);
  await expect(page.locator("[data-doc-kind=whiteboard]")).toBeVisible();
  await expect(count(page)).not.toHaveAttribute("data-element-count", "0", { timeout: 30_000 });
  void doc;
  await ctx.close();
});
