import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * TD6 One inbox (INBOX_TD6=on in the e2e server): a task assigned by a teammate lands in Important with its reason,
 * the keyboard only path (j k x u e s m and Escape, the Keys list), done with Undo, Done and Later views and back to inbox, move to
 * Noise remembered per source and removed from Saved choices, empty, error with Retry and offline states, flag off
 * unchanged, and SHOTS_DIR shots at 1280 and 390 in light, dark and Forest with axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.196.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string>; id: string };
let owner: Person, member: Person;

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  const me = await (await page.request.get("/api/account/me")).json();
  return { ctx, page, headers, id: me.user?.id ?? me.id };
}
async function axe(page: Page, label: string) {
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5_000 }).catch(() => {});
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const rows = (page: Page) => page.getByTestId("one-row");

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const s = Date.now().toString(36);
  owner = await person(browser, `owner-td6-${s}@example.com`, "Olive Owner");
  await owner.page.request.patch("/api/org", { data: { name: "Acme inbox" }, headers: owner.headers });
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email: `member-td6-${s}@example.com`, role: "member" }, headers: owner.headers })).json();
  member = await person(browser, `member-td6-${s}@example.com`, "Max Member");
  await confirmEmail(member.page.request, `member-td6-${s}@example.com`);
  expect((await member.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: member.headers })).status()).toBe(200);
  const projects = (await (await member.page.request.get("/api/projects")).json()).projects as { id: string }[];
  for (const title of ["Send the launch plan", "Review the pricing page"]) {
    const made = await member.page.request.post("/api/tasks", { data: { projectId: projects[0].id, title, assignee: `member:${owner.id}` }, headers: member.headers });
    expect(made.status()).toBeLessThan(300);
  }
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("assigned work lands in Important with its reason; nav and badge; keyboard only triage with Undo", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/one-inbox");
  await expect(page.getByRole("heading", { name: "One inbox" })).toBeVisible({ timeout: 20_000 });
  await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
  await expect(rows(page).first()).toContainText("Assigned to you");
  await expect(page.getByTestId("one-lane-count-important")).toHaveText("2");
  await expect(page.locator('a[href="/app/one-inbox"]').first()).toBeVisible();
  // Keyboard only: j focuses, x selects, Escape clears, u reads, e marks done, Undo brings it back.
  await page.keyboard.press("j");
  await expect(rows(page).first()).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("x");
  await expect(page.getByTestId("one-bulk")).toContainText("1 selected");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("one-bulk")).toHaveCount(0);
  await page.keyboard.press("u");
  await expect(rows(page).first()).not.toContainText("unread");
  await page.keyboard.press("e");
  await expect(rows(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(rows(page)).toHaveCount(2, { timeout: 10_000 });
  // Done view and back to inbox.
  await page.keyboard.press("j");
  await page.keyboard.press("e");
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("one-view-done").click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().hover();
  await rows(page).first().getByRole("button", { name: "Back to inbox" }).click();
  await page.getByTestId("one-view-inbox").click();
  await expect(rows(page)).toHaveCount(2);
  // s snoozes until tomorrow; it waits in Later.
  await page.keyboard.press("j");
  await page.keyboard.press("s");
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("one-view-later").click();
  await expect(rows(page)).toHaveCount(1);
  await rows(page).first().hover();
  await rows(page).first().getByRole("button", { name: "Back to inbox" }).click();
  await page.getByTestId("one-view-inbox").click();
  await expect(rows(page)).toHaveCount(2);
  // The Keys button lists the keys.
  await page.getByRole("button", { name: "Keys" }).click();
  await expect(page.getByTestId("one-keys")).toContainText("Snooze until tomorrow");
  await page.getByTestId("one-keys").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("one-keys")).toHaveCount(0);
});

test("move to Noise is remembered for the source and removed from Saved choices", async () => {
  const page = owner.page;
  await page.goto("/app/one-inbox");
  await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
  await page.keyboard.press("j");
  await page.keyboard.press("m");
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId("one-lane-noise").click();
  await expect(rows(page).filter({ hasText: "You keep these in Noise" })).toHaveCount(1);
  await page.getByRole("button", { name: "Saved choices" }).click();
  await expect(page.getByTestId("one-rules")).toContainText("A task");
  await page.getByTestId("one-rules").getByRole("button", { name: /Remove the choice/ }).click();
  await expect(page.getByTestId("one-rules")).toContainText("No saved choices yet");
  await page.getByTestId("one-lane-important").click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole("button", { name: "Saved choices" }).click();
});

test("filters by source; empty, error with Retry and offline states; flag off unchanged", async () => {
  const page = owner.page;
  await page.goto("/app/one-inbox");
  await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
  await page.getByTestId("one-source-mail").click();
  await expect(page.getByText("You are all caught up")).toBeVisible();
  await page.getByTestId("one-source-task").click();
  await expect(rows(page)).toHaveCount(2);
  await page.getByTestId("one-source-all").click();
  // Offline keeps the last list and says so.
  await owner.ctx.setOffline(true);
  await expect(page.getByTestId("one-inbox-offline")).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await owner.ctx.setOffline(false);
  await expect(page.getByTestId("one-inbox-offline")).toHaveCount(0);
  // Error with Retry.
  let fail = true;
  await page.route("**/api/one-inbox?*", (r) => (fail ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await page.goto("/app/one-inbox");
  await expect(page.getByTestId("one-inbox-error")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await page.getByTestId("load-error-retry").click();
  await expect(rows(page)).toHaveCount(2, { timeout: 20_000 });
  await page.unroute("**/api/one-inbox?*");
  // A teammate with nothing for them sees the empty state.
  await member.page.goto("/app/one-inbox");
  await expect(member.page.getByText("You are all caught up")).toBeVisible({ timeout: 20_000 });
  // Flag off: no nav entry and the page is not found; Notifications is unchanged.
  await page.route("**/api/config", async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, inboxTd6: false } }); });
  await page.goto("/app/notifications");
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('a[href="/app/one-inbox"]')).toHaveCount(0);
  await page.goto("/app/one-inbox");
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.unroute("**/api/config");
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(300_000);
  const page = owner.page;
  const views: [string, string][] = [["important", "one-lane-important"], ["noise", "one-lane-noise"]];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/one-inbox");
      await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
      for (const [name, id] of views) {
        await page.getByTestId(id).click();
        await page.waitForTimeout(200);
        await shot(page, `td6-${name}-${w}-${theme}`);
        await axe(page, `${name} ${w} ${theme}`);
      }
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(width).toBeLessThanOrEqual(w);
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.isEnabled().catch(() => false)) await save.click();
  await page.waitForTimeout(500);
  await run("forest");
});
