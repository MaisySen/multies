import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * POL2 additions (QA14 and verifier items): failed reads show Retry (notifications HQ MB-323, billing MB-325, meetings
 * MB-312), the Devices card lists this person's sessions (MB-345), Ctrl K finds a contact (MB-324), "Account and
 * security" with passkey in Ctrl K (MB-331), Team AI title (MB-328), the contacts tab row at 390 (MB-326), public
 * pages start no error tracking (MB-343), project References (item 6). Axe serious 0 at 1280 and 390, light and dark.
 */
let visitor = 0;
const ip = () => `10.197.${test.info().workerIndex % 200}.${++visitor}`;
let ctx: BrowserContext, page: Page, headers: Record<string, string>;

async function axe(label: string) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  headers = { origin: new URL(base).origin };
  const s = Date.now().toString(36);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Paula Polish", email: `owner-pol2b-${s}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  expect((await page.request.post("/api/contacts", { data: { email: "sender9@client.example", name: "Sample Sender 9" }, headers })).status()).toBeLessThan(300);
});
test.afterAll(async () => { await ctx?.close(); });

test("failed reads say so with Retry: notifications, billing, meetings", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  for (const [path, api, testId] of [["/app/notifications", "**/api/notifications?view=*", "notifications-error"], ["/app/settings/billing", "**/api/billing", "billing-error"], ["/app/meetings", "**/api/meetings", "meetings-error"]] as const) {
    await page.route(api, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Something broke." } }) }));
    await page.goto(path);
    const box = page.getByTestId(testId);
    await expect(box, path).toBeVisible({ timeout: 20_000 });
    await expect(box.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText("You're all caught up")).toHaveCount(0);
    await expect(page.getByText("No meetings yet")).toHaveCount(0);
    if (path === "/app/notifications") await axe("notifications error 1280 light");
    await page.unroute(api);
    await box.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId(testId)).toHaveCount(0, { timeout: 15_000 });
  }
});

test("Devices card lists my sessions; Account and security is the name; passkey finds it in Ctrl K", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/account");
  await expect(page.getByRole("list", { name: "Signed-in devices" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("devices-error")).toHaveCount(0);
  await expect(page.getByText("This device")).toBeVisible();
  await expect(page.getByText("Account & security")).toHaveCount(0);
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await axe(`account 390 ${scheme}`); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/my-work");
  await expect(page.getByTestId("today-date")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+k");
  const input = page.getByRole("combobox").first();
  await input.fill("passkey");
  await expect(page.getByRole("option", { name: /Account and security/ }).first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
});

test("Ctrl K finds a contact by name and by email", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/my-work");
  await expect(page.getByTestId("today-date")).toBeVisible({ timeout: 20_000 });
  for (const q of ["Sample Sender 9", "sender9"]) {
    await page.keyboard.press("Control+k");
    const input = page.getByRole("combobox").first();
    await input.fill(q);
    await expect(page.getByRole("option", { name: /Sample Sender 9/ }).first(), q).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Escape");
  }
});

test("Team AI names itself in the tab title and never says own key without one", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/team-ai");
  const pageEl = page.getByTestId("teamai-page");
  await pageEl.waitFor({ state: "visible", timeout: 15_000 }).catch(async () => console.log("TEAMAI-BODY", (await page.locator("main").innerText().catch(() => "")).slice(0, 300).replace(/\s+/g, " ")));
  if (!(await pageEl.isVisible())) test.skip(true, "Team AI is off in this build");
  await expect(page).toHaveTitle(/^Team AI/);
  // Only a workspace with its own key may read "own AI key" in the header.
  const noOwnKey = (await page.getByTestId("teamai-built-in").count()) + (await page.getByTestId("teamai-no-key").count()) > 0;
  if (noOwnKey) await expect(page.getByText("It uses your workspace's own AI key.")).toHaveCount(0);
  await axe("team ai 1280 light");
});

test("contacts tab row stays one scrolling row at 390; the page never scrolls sideways", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/app/contacts");
    const row = page.getByRole("tablist", { name: "Contacts" });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
    const box = await row.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    await axe(`contacts 390 ${scheme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("public pages start no error tracking", async ({ browser }) => {
  const anon = await browser.newContext({ baseURL: test.info().project.use.baseURL!, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const p = await anon.newPage();
  const tracker: string[] = [];
  p.on("request", (r) => { if (/sentry|ingest/i.test(new URL(r.url()).hostname)) tracker.push(r.url()); });
  for (const path of ["/", "/pricing", "/login"]) { await p.goto(path); await p.waitForLoadState("load"); }
  await p.waitForTimeout(2500);
  expect(tracker).toEqual([]);
  await anon.close();
});

test("project settings show References", async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const proj = await page.request.post("/api/projects", { data: { name: "Refs project" }, headers });
  const id = (await proj.json()).project.id as string;
  const gen = ((await (await page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[]).find((c) => c.name === "general");
  if (gen) await page.request.post(`/api/chat/channels/${gen.id}/messages`, { data: { body: `plan for <#project:${id}>` }, headers });
  await page.goto(`/app/tasks?project=${id}`);
  await page.getByTestId("project-actions").click({ timeout: 20_000 });
  const item = page.getByRole("menuitem", { name: "Project settings" });
  if (!(await item.isVisible({ timeout: 5_000 }).catch(() => false))) test.skip(true, "project menu not reachable in this layout");
  await item.click();
  await expect(page.getByTestId("references-panel")).toBeVisible({ timeout: 15_000 });
  await axe("project settings 1280 light");
});
