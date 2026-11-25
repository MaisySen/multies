import { test, expect, type Page } from "@playwright/test";

/**
 * MPT-11 (NAV1 slice 2): a project with Triage on and 1 waiting item shows "1 waiting in Triage" above its board.
 * The count is the project's own (another project's item does not count). The link takes keyboard focus, opens the
 * Triage page filtered to the project, and the line is gone after the item is accepted.
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

test("a project's board shows how many items wait in its Triage and links to them", async ({ page, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const project = (await (await page.request.post("/api/projects", { data: { name: "Client requests", key: "REQ", triage: true }, headers })).json()).project;
  const other = (await (await page.request.post("/api/projects", { data: { name: "Other work", key: "OTH", triage: true }, headers })).json()).project;
  const item = (await (await page.request.post("/api/triage", { data: { title: "Two more mailboxes for Sydney", projectId: project.id }, headers })).json()).item;
  await page.request.post("/api/triage", { data: { title: "Not for this project", projectId: other.id }, headers });

  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(`/app/tasks?project=${project.id}&view=board`);
  const link = page.getByTestId("triage-waiting").getByRole("link", { name: "1 waiting in Triage" });
  await expect(link).toBeVisible();
  await link.focus();
  await expect(link).toBeFocused();
  const box = await link.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/app/triage\\?project=${project.id}`));
  await expect(page.getByTestId("triage-list").getByText("Two more mailboxes for Sydney")).toBeVisible();

  expect((await page.request.post(`/api/triage/${item.id}/accept`, { data: {}, headers })).status()).toBe(200);
  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  await expect(page.getByText("Two more mailboxes for Sydney").first()).toBeVisible();
  await expect(page.getByTestId("triage-waiting")).toHaveCount(0);
});
