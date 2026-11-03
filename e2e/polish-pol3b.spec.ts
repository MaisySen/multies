import { test, expect, type Page } from "@playwright/test";

/**
 * POL3 items: the My Work greeting groups its counts (HQ MB-350), keys typed on Row while the row is made land in the
 * new row (HQ MB-314), the error report tunnel answers on our own origin and refuses a foreign envelope (item 6).
 */
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(page: Page, name = "Gita Group") {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const email = `${name.split(" ")[0].toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { headers };
}

test("My Work greeting groups large counts (MB-350)", async ({ page }) => {
  const { headers } = await signUp(page);
  void headers;
  // One item due today in the My Work read so the greeting speaks; the counts carry the large totals.
  await page.route("**/api/my-work**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.dueToday = [{ id: "t1", title: "Send the weekly numbers", subtitle: "Task", url: "/app/tasks", at: null }];
    await route.fulfill({ response: res, json: body });
  });
  await page.route("**/api/counts**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.tasks = { ...body.tasks, dueToday: 1500, overdue: 0 };
    await route.fulfill({ response: res, json: body });
  });
  await page.goto("/app/my-work");
  await expect(page.getByText("1,500 due today", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/\b1500 due today/)).toHaveCount(0);
  await page.unroute("**/api/counts**");
  await page.route("**/api/counts**", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.tasks = { ...body.tasks, dueToday: 1500, overdue: 1204 };
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(page.getByText("1,204 overdue and 1,500 due today.", { exact: false })).toBeVisible({ timeout: 20_000 });
});

test("Row keeps focus while the row is made, and keys typed meanwhile fill the new row (MB-314)", async ({ page }) => {
  const { headers } = await signUp(page, "Tara Tables");
  const t = (await (await page.request.post("/api/tables", { data: { title: "Jobs board", template: "jobs" }, headers })).json()).table.id as string;
  await page.goto(`/app/docs/${t}`);
  await expect(page.getByTestId("add-row")).toBeVisible({ timeout: 20_000 });
  // Slow the row create so the keys land in the gap a disabled button used to drop to the page.
  await page.route(`**/api/tables/${t}/rows`, async (route) => { if (route.request().method() === "POST") await new Promise((r) => setTimeout(r, 900)); await route.continue(); });
  await page.getByTestId("add-row").click();
  await page.keyboard.type("Typed in the gap");
  await expect(page.getByTestId("add-row")).toBeFocused();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-testid="table-grid"]')), { timeout: 15_000 }).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("table-grid")).toContainText("Typed in the gap", { timeout: 15_000 });
});

test("error report tunnel lives on our origin and refuses what is not ours (item 6)", async ({ page }) => {
  const base = test.info().project.use.baseURL!;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const env = `${JSON.stringify({ dsn: "https://k@o1.ingest.sentry.io/1" })}\n{"type":"event"}\n{}\n`;
  const r = await page.request.post("/api/monitoring/tunnel", { data: env, headers: { "content-type": "text/plain;charset=UTF-8", origin: new URL(base).origin } });
  // Locally no DSN is set (404); on a deployed site a foreign DSN is refused (400). Never 2xx, never forwarded.
  expect([400, 404]).toContain(r.status());
  const big = await page.request.post("/api/monitoring/tunnel", { data: "x".repeat(210_000), headers: { "content-type": "text/plain;charset=UTF-8" } });
  expect([404, 413]).toContain(big.status());
  const res = await page.request.get("/app/my-work");
  expect(res.headers()["content-security-policy"] ?? "").not.toContain("monitoring");
});
