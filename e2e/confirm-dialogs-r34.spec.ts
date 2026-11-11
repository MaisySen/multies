import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R34 (MB-192): deleting a doc goes through the themed confirm, not the browser's box. The dialog names the doc,
 * Esc backs out and hands focus back to the button, and the red confirm deletes it.
 */
let visitor = 0;
const ip = () => `10.134.${test.info().workerIndex % 200}.${++visitor}`;

test("delete a doc through the themed confirm dialog", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, colorScheme: "light", timezoneId: "UTC", extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Dee Lete", email: `dee-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const made = await page.request.post("/api/docs", { data: { title: "Q4 plan", text: "Targets for the quarter." }, headers });
  expect(made.status(), await made.text()).toBe(201);
  const doc = (await made.json()).doc as { id: string };
  // A browser dialog would fail the test: none may open.
  page.on("dialog", (d) => { throw new Error(`browser dialog opened: ${d.message()}`); });

  await page.goto(`/app/docs/${doc.id}`);
  const del = page.getByRole("button", { name: "Delete doc" }).first();
  await expect(del).toBeVisible();
  await del.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Delete the doc Q4 plan?" })).toBeVisible();
  // The confirm is the red button and has focus, so Enter would confirm; Esc backs out.
  await expect(dialog.getByRole("button", { name: "Delete doc" })).toBeFocused();
  if (!process.env.E2E_BASE_URL) {
    const dir = `${SHOTS_ROOT}/multies-r34`;
    mkdirSync(dir, { recursive: true });
    await page.waitForTimeout(300); // let the open animation settle
    await page.screenshot({ path: `${dir}/dialogs-confirm-delete-doc.png` });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(del).toBeFocused();
  expect((await page.request.get(`/api/docs/${doc.id}`)).status()).toBe(200);

  await del.click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete doc" }).click();
  await expect(page).toHaveURL(/\/app\/docs\/?$/);
  expect((await page.request.get(`/api/docs/${doc.id}`)).status()).toBe(404);
  await ctx.close();
});
