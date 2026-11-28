import { test, expect, type Page } from "@playwright/test";

/**
 * MPT-11 (NAV1 slice 2): a project with Triage on and waiting items shows "N waiting in Triage" above its board.
 * The count is the project's own (another project's item does not count). The link takes keyboard focus and opens the
 * Triage page filtered to the project. Accept and decline on the Triage page refresh the count through the "triage"
 * query refresh: the test goes back in the app (no page load) inside the 15 s stale time, waits for the count read,
 * and checks the new count. Without the refresh, the old count stays and no count read happens.
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

test("a project's board shows how many items wait in its Triage, links to them, and refreshes on accept and decline", async ({ page, context }) => {
  test.setTimeout(60_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const project = (await (await page.request.post("/api/projects", { data: { name: "Client requests", key: "REQ", triage: true }, headers })).json()).project;
  const other = (await (await page.request.post("/api/projects", { data: { name: "Other work", key: "OTH", triage: true }, headers })).json()).project;
  for (const title of ["Two more mailboxes for Sydney", "Close the old Perth inbox"]) {
    expect((await page.request.post("/api/triage", { data: { title, projectId: project.id }, headers })).status()).toBe(201);
  }
  await page.request.post("/api/triage", { data: { title: "Not for this project", projectId: other.id }, headers });
  const countRead = () => page.waitForResponse((r) => r.url().includes(`/api/triage/count?projectId=${project.id}`) && r.status() === 200, { timeout: 10_000 });
  const line = page.getByTestId("triage-waiting");
  const preview = page.getByTestId("triage-preview");
  const rows = page.getByTestId("triage-list").getByTestId("triage-row");

  // The line shows the project's own count, takes keyboard focus, has a 24 px target and opens the filtered Triage page.
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto(`/app/tasks?project=${project.id}&view=board`);
  const link = line.getByRole("link", { name: "2 waiting in Triage" });
  await expect(link).toBeVisible();
  await link.focus();
  await expect(link).toBeFocused();
  const box = await link.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(24);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/app/triage\\?project=${project.id}`));
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("triage-list").getByText("Not for this project")).toHaveCount(0);

  // Accept 1 item on the Triage page, go back in the app, and the line shows 1.
  const accepted = page.waitForResponse((r) => r.url().includes("/action") && r.request().method() === "POST" && r.status() === 200);
  await preview.getByRole("button", { name: "Accept", exact: true }).click();
  await accepted;
  await expect(rows).toHaveCount(1);
  let read = countRead();
  await page.goBack();
  await read;
  await expect(line.getByRole("link", { name: "1 waiting in Triage" })).toBeVisible();

  // Decline the last item on the Triage page, go back in the app, and the line is gone after the count read.
  await line.getByRole("link", { name: "1 waiting in Triage" }).click();
  await expect(rows).toHaveCount(1);
  await preview.getByRole("button", { name: "Decline" }).click();
  const declined = page.waitForResponse((r) => r.url().includes("/decline") && r.request().method() === "POST" && r.status() === 200);
  await page.getByRole("dialog").getByRole("button", { name: "Decline" }).click();
  await declined;
  await expect(rows).toHaveCount(0);
  read = countRead();
  await page.goBack();
  await read;
  await expect(line).toHaveCount(0);
});
