import { test, expect, type Page } from "@playwright/test";

/**
 * R29: opening a doc appended through the API showed "Unsaved changes" with nothing typed. In a
 * live session the room's first render counted as an edit (a flash of the label); in the single
 * editor the first click added the editor's closing empty paragraph and saved a version nobody
 * typed. Now opening and clicking changes nothing, while real typing still shows the label and saves.
 */
let visitor = 0;
const ip = () => `10.130.${test.info().workerIndex % 200}.${++visitor}`;
const STATUS = /Unsaved changes|Saving|Saved|Changed elsewhere/;

async function setup(browser: import("@playwright/test").Browser) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, timezoneId: "UTC", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Writer", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Pilot plan", text: "# Goals\nTwo schools on the register by December." }, headers })).json()).doc as { id: string; version: number };
  return { ctx, page, headers, doc };
}

/** Watches the status line and the doc saves while the page settles. */
async function watch(page: Page, ms: number) {
  const seen = new Set<string>();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    seen.add(await page.evaluate((re) => document.body.innerText.match(new RegExp(re))?.[0] ?? "-", STATUS.source));
    await page.waitForTimeout(100);
  }
  return seen;
}

async function typeAndSave(page: Page, patches: string[]) {
  const editor = page.locator(".ProseMirror").first();
  await editor.press("Control+End");
  await page.keyboard.type("Typed by hand");
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(patches.length).toBe(1);
  expect(patches[0]).toContain("Typed by hand");
}

test("an appended doc opens without Unsaved changes in a live session; typing still saves", async ({ browser }) => {
  const { ctx, page, headers, doc } = await setup(browser);
  const key = (await (await page.request.post("/api/developer/keys", { data: { name: "Agent" }, headers })).json()).secret as string;
  const md = ["## Week 2", "", "Call the **Kathmandu** school. See [the runbook](https://multies.si/docs).", "", "1. Import the roster", "2. Print parent codes", "", "- [x] Demo school set up", "- [ ] First real register", "", "```sh", "npm run school:setup", "```"].join("\n");
  const res = await page.request.post(`/api/v1/docs/${doc.id}/append`, { data: { markdown: md, ifVersion: doc.version }, headers: { authorization: `Bearer ${key}` } });
  expect(res.status()).toBe(200);
  const appended = (await res.json()).doc as { version: number };

  const patches: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && /\/api\/docs\/[^/]+$/.test(new URL(r.url()).pathname)) patches.push(r.postData() ?? ""); });
  await page.goto(`/app/docs/${doc.id}`);
  await expect(page.locator(".ProseMirror h2", { hasText: "Week 2" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("collab-presence")).toBeVisible();
  const seen = await watch(page, 2500);
  await page.locator(".ProseMirror pre").click();
  for (const s of await watch(page, 1500)) seen.add(s);
  expect([...seen]).toEqual(["Saved"]);
  expect(patches).toEqual([]);
  // The agent's next append with the version it knows still goes through.
  expect((await page.request.get(`/api/docs/${doc.id}`).then((r) => r.json())).doc.version).toBe(appended.version);

  await typeAndSave(page, patches);
  await ctx.close();
});

test("a doc written before R29 (ending in a code block) opens and clicks without a save in the single editor", async ({ browser }) => {
  const { ctx, page, headers, doc } = await setup(browser);
  // The shape R28 appends wrote: no closing empty paragraph, attributes partly missing.
  const content = { type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Goals" }] },
    { type: "orderedList", attrs: { start: 1 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Import the roster" }] }] }] },
    { type: "codeBlock", attrs: { language: "sh" }, content: [{ type: "text", text: "npm run school:setup" }] },
  ] };
  const put = await page.request.patch(`/api/docs/${doc.id}`, { data: { content, version: doc.version }, headers });
  expect(put.status()).toBe(200);
  const before = (await put.json()).doc as { version: number };

  await page.routeWebSocket(/\/collab/, (ws) => ws.close()); // no room: the single editor
  const patches: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && /\/api\/docs\/[^/]+$/.test(new URL(r.url()).pathname)) patches.push(r.postData() ?? ""); });
  await page.goto(`/app/docs/${doc.id}`);
  await expect(page.locator(".ProseMirror pre")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("collab-presence")).toHaveCount(0);
  const seen = await watch(page, 1000);
  await page.locator(".ProseMirror pre").click();
  for (const s of await watch(page, 1500)) seen.add(s);
  expect([...seen]).toEqual(["Saved"]);
  expect(patches).toEqual([]);
  expect((await page.request.get(`/api/docs/${doc.id}`).then((r) => r.json())).doc.version).toBe(before.version);

  await typeAndSave(page, patches);
  await ctx.close();
});
