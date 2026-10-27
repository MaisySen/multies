import { test, expect, type Page } from "@playwright/test";

/**
 * R40 reliability (MB-200, MB-201, MB-204):
 * (a) the account check fails with an empty 503: the shell still renders, and with a saved copy a calm
 *     Reconnecting pill shows instead of a blank page;
 * (b) a create whose first answer is lost after it committed is retried with the same key: one project;
 * (c) two pages on one task: an edit in A shows in B, and a stale edit in B gets "Keep yours or use theirs".
 * SHOTS=after writes rel-after-* screenshots (desktop and phone, light and dark).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.40.${test.info().workerIndex % 200}.${++visitor}` });
});

async function demo(page: Page, width = 1280) {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.setViewportSize({ width, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function shot(page: Page, name: string) {
  if (process.env.SHOTS !== "after") return;
  for (const [w, label] of [[1280, "desktop"], [390, "phone"]] as const) {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `/home/user/tab/files/multies-r40/rel-after-${name}-${label}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
}

const empty503 = { status: 503, body: "" };

test("(a) a failed account check keeps the app on screen", async ({ page }) => {
  await demo(page);
  await page.goto("/app/my-work");
  await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible({ timeout: 20_000 });

  // Two empty 503s, then the real answer: the client retries and the shell renders with no error page.
  let fails = 0;
  await page.route("**/api/account/me", async (route) => { if (fails < 2) { fails++; await route.fulfill(empty503); } else await route.continue(); });
  await page.evaluate(() => localStorage.removeItem("multies.me.v1"));
  await page.reload();
  await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible({ timeout: 20_000 });
  expect(fails).toBe(2);
  await expect(page.getByText("Couldn't load your workspace")).toHaveCount(0);
  await page.unroute("**/api/account/me");

  // Down for good, with a saved copy: the app stays, a Reconnecting pill shows, Retry brings it back.
  let down = true;
  await page.route("**/api/account/me", async (route) => (down ? route.fulfill(empty503) : route.continue()));
  await page.reload();
  await expect(page.getByRole("link", { name: "Tasks" }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("reconnecting-pill")).toBeVisible({ timeout: 30_000 });
  await shot(page, "reconnecting");
  down = false;
  await page.getByTestId("reconnecting-pill").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("reconnecting-pill")).toHaveCount(0, { timeout: 15_000 });

  // No saved copy and still down: a calm card over the shell frame, never "signed out".
  down = true;
  await page.evaluate(() => localStorage.removeItem("multies.me.v1"));
  await page.reload();
  await expect(page.getByTestId("reconnect-screen")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/app/);
  await shot(page, "reconnect-screen");
});

test("(b) a create retried after a lost answer makes one project", async ({ page }) => {
  await demo(page);
  await page.goto("/app/tasks");
  const name = `Launch plan ${Date.now() % 100000}`;
  const keys: string[] = [];
  let first = true;
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (first) { first = false; await route.fetch(); await route.fulfill(empty503); return; } // committed, answer lost
    await route.continue();
  });
  // The tasks page opens on all tasks ("Project") or on the last project ("New project"); both open the same form.
  await page.getByRole("button", { name: /^(New project|Project)$/ }).first().click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^web-/);
  const list = await (await page.request.get("/api/projects")).json() as { projects: { name: string }[] };
  expect(list.projects.filter((p) => p.name === name)).toHaveLength(1);
});

test("(c) two pages on one task: live update and a clear conflict", async ({ page, context }) => {
  await demo(page);
  const headers = { origin: new URL(page.url()).origin };
  const task = (await (await page.request.post("/api/tasks", { headers, data: { title: "Two tab task" } })).json()).task as { id: string };
  const b = await context.newPage();
  await page.goto(`/app/tasks?task=${task.id}`);
  await b.goto(`/app/tasks?task=${task.id}`);
  const titleA = page.getByRole("dialog", { name: "Task" }).getByLabel("Title");
  const titleB = b.getByRole("dialog", { name: "Task" }).getByLabel("Title");
  await expect(titleA).toHaveValue("Two tab task", { timeout: 20_000 });
  await expect(titleB).toHaveValue("Two tab task", { timeout: 20_000 });

  // A edits; B follows without a reload.
  await titleA.fill("Edited in A");
  await titleA.blur();
  await expect(titleB).toHaveValue("Edited in A", { timeout: 10_000 });

  // B starts typing, A saves again, B's text stays; saving B reports the conflict.
  await titleB.fill("Typed in B");
  await titleA.fill("Edited in A again");
  await titleA.blur();
  await page.waitForTimeout(1500);
  await expect(titleB).toHaveValue("Typed in B");
  await titleB.blur();
  const bar = b.getByTestId("task-conflict");
  await expect(bar).toBeVisible({ timeout: 10_000 });
  await expect(bar).toContainText("Changed in another tab or by someone else");
  await shot(b, "conflict");
  await bar.getByRole("button", { name: "Keep yours" }).click();
  await expect(bar).toHaveCount(0, { timeout: 10_000 });
  await expect(titleA).toHaveValue("Typed in B", { timeout: 10_000 });
  const now = (await (await page.request.get(`/api/tasks/${task.id}`)).json()).task as { title: string };
  expect(now.title).toBe("Typed in B");
});
