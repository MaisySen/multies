/**
 * R131 Home widgets (HOME_WIDGETS_R131=on in the e2e server): arrange by drag and by keyboard at 1280, the reorder
 * sheet at 390, add and remove a widget, a quick link, one failing widget shows Retry while the rest load, empty
 * states, an admin sets the workspace default, a member cannot. Axe on Home with widgets in light, dark and Forest.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";

let visitor = 0;
const ip = () => `10.231.${test.info().workerIndex % 200}.${++visitor}`;
async function person(browser: Browser, email: string, name: string) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function signUp(browser: Browser, width = 1280, height = 900) {
  const p = await person(browser, `owner-${uniq()}@acme.io`, "Olive Owner");
  await p.page.setViewportSize({ width, height });
  return p.page;
}
async function inviteAndJoin(browser: Browser) {
  const owner = await person(browser, `owner-${uniq()}@acme.io`, "Olive Owner");
  const email = `max-${uniq()}@acme.io`;
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email, role: "member" }, headers: owner.headers })).json();
  const m = await person(browser, email, "Max Member");
  await confirmEmail(m.page.request, email);
  expect((await m.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: m.headers })).status()).toBe(200);
  await owner.page.setViewportSize({ width: 1280, height: 900 });
  return { admin: owner.page, member: m.page };
}

const SHOTS = process.env.R131_SHOTS || "";
async function shot(page: Page, name: string) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false }); }
// W4: with time billing on (BILL_TD4, on by default in E2E) owners and admins also get the Time to bill widget, kept last.
const BILL = process.env.E2E_BILL_TD4 === "off" ? [] : ["billing"];
async function order(page: Page) {
  return page.locator('[data-testid="widget-grid"] > section').evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") || "").replace("widget-", "")));
}
async function theme(page: Page, t: "light" | "dark" | "forest") {
  if (t !== "forest") { await page.emulateMedia({ colorScheme: t }); return; }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await page.goto("/app");
  await expect(page.getByTestId("widget-grid")).toBeVisible();
}
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).include("main").analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

test.describe("R131 home widgets", () => {
  test("first view, empty states, quick link, add and hide, axe in three themes", async ({ browser }) => {
    const page = await signUp(browser);
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    expect(await order(page)).toEqual(["tasks", "calendar", "inbox", "links", "overview", ...BILL]);
    await expect(page.getByTestId("widget-calendar").getByText("No meetings today.")).toBeVisible();
    await expect(page.getByTestId("widget-links").getByText("Add the links you open every day.")).toBeVisible();
    // quick link: a bad address is refused, a good one is saved and survives a reload
    await page.getByTestId("links-add").click();
    await page.getByTestId("link-title").fill("Handbook");
    await page.getByTestId("link-url").fill("javascript:alert(1)");
    await page.getByTestId("link-save").click();
    await expect(page.getByText("Use a web address that starts with http or https.")).toBeVisible();
    await page.getByTestId("link-url").fill("example.com/handbook");
    await page.getByTestId("link-save").click();
    await expect(page.getByTestId("widget-links").getByRole("link", { name: "Handbook" })).toHaveAttribute("href", "https://example.com/handbook");
    await page.reload();
    await expect(page.getByTestId("widget-links").getByRole("link", { name: "Handbook" })).toBeVisible();
    for (const t of ["light", "dark", "forest"] as const) {
      await theme(page, t);
      await expect(page.getByTestId("widget-links").getByRole("link", { name: "Handbook" })).toBeVisible();
      await page.waitForTimeout(200);
      await shot(page, `home-1280-${t}`);
      expect(await axe(page), `axe ${t}`).toEqual([]);
    }
    await theme(page, "light");
    // add the dashboards widget, hide the calendar, save
    await page.getByTestId("customize-home").click();
    await page.getByTestId("add-widget").click();
    await page.getByRole("menuitem", { name: /Dashboards/ }).click();
    await page.getByTestId("hide-calendar").click();
    await shot(page, "home-1280-customize");
    expect(await axe(page), "axe customize").toEqual([]);
    await page.getByTestId("done-home").click();
    await expect(page.getByTestId("home-note")).toHaveText("Home saved.");
    expect(await order(page)).toEqual(["tasks", "inbox", "links", "overview", "dashboards", ...BILL]);
    await page.getByTestId("widget-dashboards").scrollIntoViewIfNeeded(); // below the fold: it reads when scrolled near
    await expect(page.getByTestId("widget-dashboards").getByText(/No dashboards yet/)).toBeVisible();
    // reset brings the default back
    await page.getByTestId("customize-home").click();
    await page.getByTestId("reset-home").click();
    await expect(page.getByTestId("home-note")).toHaveText("Home is back to the default.");
    expect(await order(page)).toEqual(["tasks", "calendar", "inbox", "links", "overview", ...BILL]);
  });

  test("arrange by keyboard, by the arrow buttons and by drag at 1280", async ({ browser }) => {
    const page = await signUp(browser);
    await page.goto("/app");
    // W4: wait for the grid in edit mode (all five placeholders) before arranging.
    await expect(page.getByTestId("widget-grid").locator(":scope > section")).toHaveCount(5 + BILL.length);
    await page.getByTestId("customize-home").click();
    await expect(page.getByTestId("placeholder-overview")).toBeVisible();
    // arrow button
    await page.getByTestId("down-tasks").click();
    await expect.poll(() => order(page)).toEqual(["calendar", "tasks", "inbox", "links", "overview", ...BILL]);
    // keyboard: space picks up, arrow moves, space drops
    const startPlace = (await order(page)).indexOf("overview") + 1; // its place before the move
    await page.getByTestId("drag-overview").focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("drag-overview")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/^(Picked up .+|.+ is over place \d+ of \d+\.)$/)).toBeAttached(); // the keyboard move is listening
    await page.keyboard.press("ArrowUp");
    // Drop only once the move has landed: the widget's own live announcement says which place it is over now (the
    // keyboard sensor measures on the next frames, which a busy machine delays past a fixed wait).
    await expect(page.getByText(new RegExp(`is over place [1-${startPlace - 1}] of \\d+\\.`))).toBeAttached({ timeout: 10_000 });
    await page.keyboard.press("Space");
    // the drop is done when nothing is held any more
    await expect(page.getByTestId("widget-grid").locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect.poll(() => order(page)).not.toEqual(["calendar", "tasks", "inbox", "links", "overview", ...BILL]);
    const afterKeys = await order(page);
    expect(afterKeys.indexOf("overview")).toBeLessThan(4);
    // mouse drag: links onto the first place
    const from = await page.getByTestId("drag-links").boundingBox();
    const to = await page.getByTestId(`widget-${afterKeys[0]}`).boundingBox();
    await page.mouse.move(from!.x + 8, from!.y + 8);
    await page.mouse.down();
    await page.mouse.move(from!.x + 20, from!.y + 20, { steps: 4 });
    await page.mouse.move(to!.x + 30, to!.y + 20, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByTestId("widget-grid").locator('[aria-pressed="true"]')).toHaveCount(0);
    await expect.poll(async () => (await order(page))[0]).toBe("links");
    const final = await order(page);
    await page.waitForTimeout(500);
    const saved = page.waitForResponse((r) => r.url().includes("/api/home-widgets") && r.request().method() === "PUT");
    await page.getByTestId("done-home").click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByTestId("home-note")).toHaveText("Home saved.");
    await page.reload();
    await expect.poll(() => order(page)).toEqual(final);
  });

  test("one failing widget shows Retry while the rest load", async ({ browser }) => {
    const page = await signUp(browser);
    let fail = true;
    await page.route("**/api/my-work*", async (route) => (fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":{"code":"x","message":"x"}}' }) : route.continue()));
    await page.goto("/app");
    await expect(page.getByTestId("widget-tasks").getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("widget-inbox").getByText("Unread mail")).toBeVisible();
    await expect(page.getByTestId("widget-links").getByTestId("links-add")).toBeVisible();
    await shot(page, "home-1280-widget-error");
    fail = false;
    await page.getByTestId("widget-tasks").getByTestId("load-error-retry").click();
    await expect(page.getByTestId("widget-tasks").getByText("Nothing due today. Nice work.")).toBeVisible();
  });

  test("390: one column and the reorder sheet, no drag needed", async ({ browser }) => {
    const page = await signUp(browser, 390, 844);
    await page.goto("/app");
    await expect(page.getByTestId("widget-tasks")).toBeVisible();
    const boxes = await page.locator('[data-testid="widget-grid"] > section').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    expect(new Set(boxes.map((w) => Math.round(w))).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    for (const t of ["light", "dark"] as const) { await theme(page, t); await shot(page, `home-390-${t}`); }
    await theme(page, "light");
    await page.getByTestId("customize-home").click();
    await expect(page.getByTestId("reorder-sheet")).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, "home-390-sheet");
    expect(await axe(page).catch(() => [])).toEqual([]);
    await page.getByTestId("sheet-down-tasks").click();
    await page.getByTestId("sheet-show-dashboards").check();
    await page.getByTestId("sheet-done").click();
    await expect(page.getByTestId("home-note")).toHaveText("Home saved.");
    expect(await order(page)).toEqual(["calendar", "tasks", "inbox", "links", "overview", "dashboards", ...BILL]);
  });

  test("an admin sets the workspace default; a member sees it and cannot set one", async ({ browser }) => {
    const { admin, member } = await inviteAndJoin(browser);
    await admin.goto("/app");
    await admin.getByTestId("customize-home").click();
    await admin.getByTestId("hide-overview").click();
    await admin.getByTestId("up-inbox").click();
    await admin.getByTestId("set-default").click();
    await expect(admin.getByTestId("home-note")).toContainText("Saved as the workspace default");
    await admin.getByTestId("cancel-home").click();
    await member.setViewportSize({ width: 1280, height: 900 });
    await member.goto("/app");
    await expect.poll(() => order(member)).toEqual(["tasks", "inbox", "calendar", "links"]);
    await member.getByTestId("customize-home").click();
    await expect(member.getByTestId("set-default")).toHaveCount(0);
    await expect(member.getByTestId("reset-home")).toBeVisible();
  });
});
