import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R118: Social P2b end to end on the local test network (E2E_SOCIAL_TEST=1 turns it on for the local server only):
 * inbox happy path (reply, note, assign, saved reply, done), error paths (closed window, a reply turned down), empty
 * states, account health (pinned, planned post warning, bell), analytics, phone width, and shots with axe when
 * SHOTS_DIR is set.
 */
let visitor = 0;
const ip = () => `10.218.${test.info().workerIndex % 200}.${++visitor}`;
const DIR = process.env.SHOTS_DIR;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}

async function setup(page: Page, origin: string, opts: { posts?: boolean } = {}) {
  const headers = { origin };
  const cfg = await (await page.request.get("/api/config")).json() as { socialTestNetwork?: boolean };
  test.skip(!cfg.socialTestNetwork, "needs E2E_SOCIAL_TEST=1");
  expect((await page.request.post("/api/social/test-network", { headers })).status()).toBe(201);
  if (opts.posts !== false) {
    for (const text of ["Spring range is here. Come and see it this Saturday.", "Workshop recap: thanks to everyone who came."]) {
      expect((await page.request.post("/api/social/posts", { headers, data: { text, targets: [{ accountId: "direct:testnet" }] } })).status()).toBe(201);
    }
  }
  return headers;
}

async function axe(page: Page, tag: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${tag}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}

test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
});

test("inbox: reply, note, assign, saved reply and done", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await setup(page, new URL(baseURL!).origin);
  await page.goto("/app/social/inbox");
  await expect(page.getByTestId("social-inbox")).toBeVisible();
  // The first open pulls from the networks on its own.
  await expect(page.getByText("Jordan Lee")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("inbox-tab-open")).toContainText("6");

  // A saved reply, made once and used in the reply box.
  await page.getByTestId("inbox-saved").click();
  await page.getByLabel("Name").fill("Workshop");
  await page.getByLabel("Reply", { exact: true }).fill("Hi {name}, yes it is on. See you Saturday!");
  await page.getByRole("button", { name: "Add saved reply" }).click();
  await expect(page.getByTestId("saved-replies-list")).toContainText("Workshop");
  await page.keyboard.press("Escape");

  await page.getByText("Jordan Lee").first().click();
  await expect(page.getByTestId("inbox-thread")).toBeVisible();
  await expect(page.getByTestId("inbox-window")).toContainText("Reply within");
  await page.getByTestId("inbox-saved-pick").selectOption({ label: "Workshop" });
  await expect(page.getByTestId("inbox-text")).toHaveValue("Hi Jordan, yes it is on. See you Saturday!");
  await page.getByTestId("inbox-send").click();
  await expect(page.getByTestId("inbox-reply")).toContainText("Sent by");

  await page.getByRole("tab", { name: "Internal note" }).click();
  await page.getByTestId("inbox-text").fill("Booked two spots for them.");
  await page.getByTestId("inbox-send").click();
  await expect(page.getByTestId("inbox-note")).toContainText("Booked two spots");

  await expect(page.getByTestId("inbox-assign")).not.toHaveValue("");
  await page.getByTestId("inbox-assign").selectOption("");
  await expect(page.getByText("Unassigned").first()).toBeVisible();
  await page.getByTestId("inbox-task").click();
  await expect(page.getByRole("link", { name: "Open task" })).toBeVisible();
  await page.getByTestId("inbox-done").click();
  await expect(page.getByTestId("inbox-reopen")).toBeVisible();
  await page.getByTestId("inbox-tab-done").click();
  await expect(page.getByTestId("inbox-list")).toContainText("Jordan Lee");
});

test("inbox: closed window, a reply turned down, and phone width", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await setup(page, new URL(baseURL!).origin, { posts: false });
  await page.goto("/app/social/inbox");
  await expect(page.getByText("Priya Patel")).toBeVisible({ timeout: 15_000 });
  await page.getByText("Priya Patel").click();
  await expect(page.getByTestId("inbox-list")).toBeHidden();
  await expect(page.getByTestId("inbox-cant-reply")).toContainText("Reply window closed");
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(page.getByTestId("inbox-list")).toBeVisible();
  await page.getByText("Mia Chen").click();
  await page.getByTestId("inbox-text").fill("Please FAIL this");
  await page.getByTestId("inbox-send").click();
  await expect(page.getByTestId("inbox-reply")).toHaveAttribute("data-status", "failed");
  await expect(page.getByTestId("inbox-reply")).toContainText("turned the reply down");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test("empty states without accounts", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/social/inbox");
  await expect(page.getByTestId("inbox-empty-accounts")).toBeVisible({ timeout: 15_000 });
  await page.goto("/app/social/analytics");
  await expect(page.getByTestId("analytics-empty")).toBeVisible();
});

test("account health: pinned, warned on planned posts and in the bell", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const headers = await setup(page, new URL(baseURL!).origin, { posts: false });
  const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
  expect((await page.request.post("/api/social/posts", { headers, data: { text: "Saturday hours", targets: [{ accountId: "direct:testnet" }], runAt: later } })).status()).toBe(201);
  await page.goto("/app/social/accounts");
  await expect(page.getByTestId("account-caps-testnet")).toContainText("Comments");
  await page.getByTestId("test-network-signout").click();
  await expect(page.getByTestId("accounts-broken")).toContainText("Test network lost its sign in");
  await page.goto("/app/social/posts?status=scheduled");
  await expect(page.getByTestId("post-health-warning").first()).toContainText("needs a new sign in");
  await page.goto("/app/notifications");
  await expect(page.getByText("needs you to sign in again").first()).toBeVisible({ timeout: 15_000 });
  await page.goto("/app/social/accounts");
  await page.getByTestId("broken-reconnect-testnet").click();
  await expect(page.getByTestId("accounts-broken")).toBeHidden();
});

test("analytics shows results from the test network", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await setup(page, new URL(baseURL!).origin);
  await page.goto("/app/social/analytics");
  await expect(page.getByTestId("analytics-totals")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("analytics-totals")).toContainText("Posts sent");
  await expect(page.getByTestId("analytics-accounts")).toContainText("Test network");
  await expect(page.getByTestId("analytics-best")).toContainText("more times");
  await page.getByTestId("range-7").click();
  await expect(page).toHaveURL(/range=7/);
});

test("R118 screenshots and axe", async ({ page, baseURL }) => {
  test.skip(!DIR, "screenshots only with SHOTS_DIR");
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const headers = await setup(page, new URL(baseURL!).origin);
  await page.request.post("/api/social/saved-replies", { headers, data: { title: "Opening hours", body: "Hi {name}, we're open 9 to 5." } });
  await page.goto("/app/social/inbox");
  await expect(page.getByText("Jordan Lee")).toBeVisible({ timeout: 15_000 });
  const ids = await (await page.request.get("/api/social/inbox")).json() as { items: { id: string; authorName: string }[] };
  const jordan = ids.items.find((i) => i.authorName === "Jordan Lee")!.id;
  await page.request.post(`/api/social/inbox/${jordan}/notes`, { headers, data: { text: "Regular customer, booked last month too." } });
  await page.request.post(`/api/social/inbox/${jordan}/reply`, { headers, data: { text: "Hi Jordan, yes it is on. See you Saturday!" } });
  await page.request.post("/api/social/analytics/sync", { headers });
  const bad: string[] = [];
  const shoot = async (name: string, go: () => Promise<void>, tag: string) => {
    await go();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${DIR}/r118-${name}-${tag}.png` });
    bad.push(...await axe(page, `${tag} ${name}`));
  };
  const views: [string, () => Promise<void>][] = [
    ["inbox", async () => { await page.goto("/app/social/inbox"); await expect(page.getByTestId("inbox-list")).toBeVisible(); }],
    ["thread", async () => { await page.goto(`/app/social/inbox?item=${jordan}`); await expect(page.getByTestId("inbox-thread")).toBeVisible(); }],
    ["analytics", async () => { await page.goto("/app/social/analytics"); await expect(page.getByTestId("analytics-totals")).toBeVisible(); }],
    ["accounts", async () => { await page.goto("/app/social/accounts"); await expect(page.getByTestId("test-network-card")).toBeVisible(); }],
  ];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [name, go] of views) await shoot(name, go, `${w}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.request.post("/api/social/test-network/signed-out", { headers, data: { broken: true } });
  await shoot("accounts-broken", async () => { await page.goto("/app/social/accounts"); await expect(page.getByTestId("accounts-broken")).toBeVisible(); }, "1280-light");
  await shoot("posts-warning", async () => { await page.goto("/app/social/posts"); await page.waitForTimeout(300); }, "1280-light");
  await page.request.post("/api/social/test-network/signed-out", { headers, data: { broken: false } });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(500);
  for (const [w, h] of [[1280, 860], [390, 844]] as const) {
    await page.setViewportSize({ width: w, height: h });
    for (const [name, go] of views.slice(0, 3)) await shoot(name, go, `${w}-forest`);
  }
  expect(bad, bad.join("\n")).toEqual([]);
});
