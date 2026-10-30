import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * R28 (found by Haajir): POST /api/v1/docs/{id}/append adds a markdown section that the docs editor
 * shows as real headings, lists, task boxes, links and code, below what was already there; a stale
 * version is a 409.
 */
let visitor = 0;
const ip = () => `10.128.${test.info().workerIndex % 200}.${++visitor}`;

test("append markdown through the API and see it in the editor", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Writer", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const doc = (await (await page.request.post("/api/docs", { data: { title: "Pilot plan", text: "# Goals\nTwo schools on the register by December." }, headers })).json()).doc as { id: string; version: number };
  const key = (await (await page.request.post("/api/developer/keys", { data: { name: "Agent" }, headers })).json()).secret as string;
  const auth = { authorization: `Bearer ${key}` };

  const md = [
    "## Week 2", "", "Call the **Kathmandu** school and send the *printed* codes. See [the runbook](https://multies.si/docs).", "",
    "1. Import the roster", "2. Print parent codes", "", "- [x] Demo school set up", "- [ ] First real register", "", "```sh", "npm run school:setup", "```",
  ].join("\n");
  const res = await page.request.post(`/api/v1/docs/${doc.id}/append`, { data: { markdown: md, ifVersion: doc.version }, headers: auth });
  expect(res.status()).toBe(200);
  expect(res.headers()["etag"]).toBe(`"${doc.version + 1}"`);
  const stale = await page.request.post(`/api/v1/docs/${doc.id}/append`, { data: { markdown: "again", ifVersion: doc.version }, headers: auth });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.details).toEqual({ currentVersion: doc.version + 1 });

  await page.goto(`/app/docs/${doc.id}`);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor.getByRole("heading", { name: "Goals" })).toBeVisible();
  await expect(editor.locator("h2", { hasText: "Week 2" })).toBeVisible();
  await expect(editor.locator("strong", { hasText: "Kathmandu" })).toBeVisible();
  await expect(editor.locator("em", { hasText: "printed" })).toBeVisible();
  await expect(editor.locator("a[href='https://multies.si/docs']")).toHaveText("the runbook");
  await expect(editor.locator("ol > li")).toHaveCount(2);
  await expect(editor.locator("ul[data-type='taskList'] > li")).toHaveCount(2);
  await expect(editor.locator("pre code")).toHaveText("npm run school:setup");
  const shots = "/home/user/tab/files/multies-r28";
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/docs-append-markdown.png`, fullPage: false });
  await ctx.close();
});
