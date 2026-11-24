import { test, expect, type Page } from "@playwright/test";

/**
 * Round 2 (PR 24): on /app/triage an admin sees the projects with Triage off and can turn it on for one of them.
 * Nothing is switched by itself.
 */
let visitor = 0;
const ip = () => `10.124.${test.info().workerIndex % 200}.${++visitor}`;

async function owner(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return headers;
}

test("an admin sees projects with Triage off on the Triage page and turns it on for one", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const old = (await (await page.request.post("/api/projects", { data: { name: "Old supplier work", triage: false }, headers })).json()).project;
  await page.request.post("/api/projects", { data: { name: "Guarded payments" }, headers });
  await page.goto("/app/triage");
  const hint = page.getByTestId("triage-off-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("1 project has Triage off");
  await expect(hint).toContainText("Old supplier work");
  await expect(hint).not.toContainText("Guarded payments");
  await hint.getByRole("button", { name: "Turn on Triage for Old supplier work" }).click();
  await expect(hint).toBeHidden();
  const after = (await (await page.request.get(`/api/projects/${old.id}`)).json()).project;
  expect(after.triage).toBe(true);
});
