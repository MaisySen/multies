import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R98 search (SEARCH_R98=on in the e2e server): typo tolerance, instant top hits, filters by click, by typed words and
 * by keyboard, empty and error states, and what a member, an admin and a project guest can find. SHOTS_DIR writes shots
 * at 1280 and 390 in light, dark and Forest, and axe runs on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person, admin: Person, guestCtx: BrowserContext;
let projectId = "", taskId = "";

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
async function join(browser: Browser, email: string, name: string, role: "member" | "admin") {
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email, role }, headers: owner.headers })).json();
  const p = await person(browser, email, name);
  await confirmEmail(p.page.request, email);
  expect((await p.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: p.headers })).status()).toBe(200);
  return p;
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  owner = await person(browser, `ada-${tag}@example.com`, "Ada Owner");
  member = await join(browser, `ben-${tag}@example.com`, "Ben Mate", "member");
  admin = await join(browser, `cy-${tag}@example.com`, "Cy Admin", "admin");
  const post = (path: string, data: unknown) => owner.page.request.post(path, { data, headers: owner.headers }).then((r) => r.json());
  projectId = (await post("/api/projects", { name: "Kestrel" })).project.id;
  taskId = (await post("/api/tasks", { title: "Quarterly kestrel review", projectId, notes: "numbers for the board" })).task.id;
  await post("/api/docs", { title: "Kestrel brief", text: "what the kestrel site needs", projectId });
  await post("/api/contacts", { email: "kim@kestrel.example", name: "Kim Kestrel" });
  for (let i = 1; i <= 14; i++) await post("/api/tasks", { title: `Kestrel follow up number ${i} with a long title that keeps going so it has to be cut on a phone`, projectId });
  const channels = (await (await owner.page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  const general = channels.find((c) => c.name === "general")!.id;
  await post(`/api/chat/channels/${general}/messages`, { body: "osprey picnic is public" });
  const board = (await post("/api/chat/channels", { name: "board", private: true })).channel.id;
  await post(`/api/chat/channels/${board}/messages`, { body: "osprey acquisition is private" });
  const inv = await post("/api/guests", { projectId, email: `guest-${tag}@client.example`, name: "Gia Guest" });
  const base = test.info().project.use.baseURL!;
  guestCtx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  expect((await guestCtx.request.post("/api/guest/accept", { data: { token: String(inv.inviteUrl).split("/g/")[1] }, headers: { origin: new URL(base).origin } })).status()).toBe(200);
});
test.afterAll(async () => { for (const c of [owner?.ctx, member?.ctx, admin?.ctx, guestCtx]) await c?.close(); });

const palette = (page: Page) => page.getByRole("dialog", { name: "Command menu" });
async function openSearch(page: Page, q: string) {
  if (!/\/app/.test(page.url())) await page.goto("/app/tasks");
  const dialog = palette(page);
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await dialog.getByRole("combobox").fill(q);
  return dialog;
}
async function closeMenu(page: Page) { if (await palette(page).isVisible()) await page.keyboard.press("Escape"); await expect(palette(page)).toBeHidden(); }
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const results = (d: ReturnType<typeof palette>) => d.locator("[data-testid=search-result], [data-testid=search-top-hit]");

test("a typo still finds the task, says what it searched for, and Enter opens it", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  const d = await openSearch(page, "kestrl reveiw");
  await expect(results(d).filter({ hasText: "Quarterly kestrel review" }).first()).toBeVisible({ timeout: 10_000 });
  await expect(d.getByTestId("search-corrected")).toContainText("kestrel review");
  // Strict: only the words as typed.
  await d.getByRole("button", { name: /Search for “kestrl reveiw” instead/ }).click();
  await expect(d.getByTestId("search-result")).toHaveCount(0);
  await d.getByRole("combobox").fill("quarterly kestrel");
  await expect(results(d).first()).toContainText("Quarterly kestrel review", { timeout: 10_000 });
  await d.getByRole("combobox").press("Enter");
  await expect(page).toHaveURL(new RegExp(`task=${taskId}`));
  await closeMenu(page);
});

test("filters by chip, by Alt and a number, by typed words, and Backspace takes the last one off", async () => {
  const page = owner.page;
  const d = await openSearch(page, "kestrel");
  const bar = page.getByTestId("search-filters");
  await expect(bar).toBeVisible();
  await page.keyboard.press("Alt+4"); // Docs
  await expect(bar.getByTestId("search-type-docs")).toHaveAttribute("aria-checked", "true");
  const urls = () => results(d).evaluateAll((els) => els.map((e) => e.getAttribute("data-url") ?? ""));
  await expect.poll(async () => { const u = await urls(); return u.length > 0 && u.every((x) => x.includes("/app/docs/")); }, { timeout: 10_000 }).toBe(true);
  await d.getByRole("combobox").fill("");
  await expect(bar.getByTestId("search-type-docs")).toHaveAttribute("aria-checked", "true");
  await d.getByRole("combobox").press("Backspace");
  await expect(bar).toBeHidden();
  await d.getByRole("combobox").fill("kestrel");
  await expect(bar.getByTestId("search-type-all")).toHaveAttribute("aria-checked", "true");
  await d.getByRole("combobox").fill("type:tasks in:kestrel follow");
  await expect(bar.getByTestId("search-type-tasks")).toHaveAttribute("aria-checked", "true");
  await expect(bar.getByTestId("search-filter-project")).toHaveAttribute("aria-label", "Project: Kestrel");
  await expect(results(d).first()).toContainText("Kestrel follow up", { timeout: 10_000 });
  await d.getByRole("combobox").fill("kestrel from:nobody");
  await expect(page.getByTestId("search-filter-problem")).toHaveText("No person called nobody");
  // Person chip by click: Ben made none of these.
  await d.getByRole("combobox").fill("kestrel");
  await bar.getByTestId("search-filter-person").click();
  await page.getByRole("listbox", { name: "Person" }).getByRole("option", { name: "Ben Mate" }).click();
  await expect(bar.getByTestId("search-filter-person")).toHaveAttribute("aria-label", "Person: Ben Mate");
  await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("search-empty").getByRole("button", { name: "Clear filters" }).click();
  await expect(bar.getByTestId("search-filter-person")).toHaveAttribute("aria-label", "Person: Anyone");
  // Keyboard only: Tab to the Date chip, open it, pick with the arrows, Esc closes just the list.
  const date = bar.getByTestId("search-filter-date");
  await date.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox", { name: "Date" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(date).toHaveAttribute("aria-label", "Date: Today");
  await date.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Date" })).toBeHidden();
  await expect(d).toBeVisible();
  await bar.getByTestId("search-clear-filters").click();
  await expect(results(d).first()).toBeVisible({ timeout: 10_000 });
  await closeMenu(page);
});

test("empty and error states", async () => {
  const page = owner.page;
  const d = await openSearch(page, "zzqqxxvv");
  await expect(page.getByTestId("search-empty")).toContainText("No results for “zzqqxxvv”", { timeout: 10_000 });
  await page.route("**/api/search?*", (r) => r.fulfill({ status: 500, body: "{}" }));
  await d.getByRole("combobox").fill("osprey wings");
  await expect(page.getByTestId("search-error")).toBeVisible({ timeout: 10_000 });
  await page.unroute("**/api/search?*");
  await page.getByTestId("search-error").getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("search-error")).toBeHidden({ timeout: 10_000 });
  await closeMenu(page);
});

test("a member and an admin outside the private channel never see it; the owner does; a guest sees only their project", async () => {
  for (const [who, sees] of [[owner, 2], [member, 1], [admin, 1]] as const) {
    const d = await openSearch(who.page, "osprey");
    await expect(d.getByTestId("search-group-chat").getByTestId("search-result")).toHaveCount(sees, { timeout: 10_000 });
    if (sees === 1) await expect(d.getByText("osprey acquisition is private")).toHaveCount(0);
    await d.getByRole("combobox").fill("ospery aquisition");
    await expect(d.getByText("Searching", { exact: false })).toBeHidden({ timeout: 10_000 });
    if (sees === 1) await expect(d.getByTestId("search-result")).toHaveCount(0);
    await closeMenu(who.page);
  }
  // The guest: their project only, and never the workspace search.
  expect((await guestCtx.request.get("/api/search?q=kestrel")).status()).toBe(401);
  const g = await (await guestCtx.request.get("/api/guest/search?q=kestrl%20quartrly")).json();
  const titles = (g.groups as { items: { title: string }[] }[]).flatMap((x) => x.items.map((i) => i.title));
  expect(titles).toContain("Quarterly kestrel review");
  expect(titles.join(" ")).not.toMatch(/osprey|Kim Kestrel/);
});

test("phone width: full screen, filters scroll sideways, nothing wider than the screen", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/tasks");
  const d = await openSearch(page, "kestrel");
  await expect(page.getByTestId("search-filters")).toBeVisible();
  await page.getByTestId("search-type-tasks").tap().catch(async () => page.getByTestId("search-type-tasks").click());
  await expect(page.getByTestId("search-type-tasks")).toHaveAttribute("aria-checked", "true");
  await expect(results(d).first()).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const box = await d.boundingBox();
  expect(box && box.width).toBeGreaterThan(370);
  await closeMenu(page);
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(240_000);
  const page = owner.page;
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/tasks");
      const d = await openSearch(page, "kestrel");
      await expect(results(d).first()).toBeVisible({ timeout: 10_000 });
      await shot(page, `r98-results-${w}-${theme}`);
      await axe(page, `results ${w} ${theme}`);
      await d.getByRole("combobox").fill("kestrl type:docs");
      await expect(page.getByTestId("search-type-docs")).toHaveAttribute("aria-checked", "true");
      await expect(results(d).first()).toBeVisible({ timeout: 10_000 });
      await shot(page, `r98-typo-filter-${w}-${theme}`);
      await page.getByTestId("search-filter-project").click();
      await expect(page.getByRole("listbox", { name: "Project" })).toBeVisible();
      await shot(page, `r98-project-menu-${w}-${theme}`);
      await axe(page, `project menu ${w} ${theme}`);
      await page.keyboard.press("Escape");
      await d.getByRole("combobox").fill("zzqqxxvv");
      await page.getByTestId("search-filter-date").click();
      await page.getByRole("listbox", { name: "Date" }).getByRole("option", { name: "Past 7 days" }).click();
      await expect(page.getByTestId("search-empty")).toBeVisible({ timeout: 10_000 });
      await shot(page, `r98-empty-${w}-${theme}`);
      await axe(page, `empty ${w} ${theme}`);
      await closeMenu(page);
      await page.route("**/api/search?*", (r) => r.fulfill({ status: 500, body: "{}" }));
      await openSearch(page, "error case");
      await expect(page.getByTestId("search-error")).toBeVisible({ timeout: 10_000 });
      await shot(page, `r98-error-${w}-${theme}`);
      await axe(page, `error ${w} ${theme}`);
      await page.unroute("**/api/search?*");
      await closeMenu(page);
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
});
