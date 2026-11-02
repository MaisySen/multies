import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * POL1 P1 polish (POLISH_POL1=on in the e2e server): Webinar from Meetings and Schedule (MB-318), Meetings and webinar
 * load errors with Retry (MB-312), vault and course errors in about a second, tables and courses to the trash with Undo
 * and Restore (MB-313), focus in the new row (MB-314), Kanban and New view at 390 (MB-315, MB-316), titles (MB-321),
 * Home layout error and Escape, Sites error speed and the editor's missing page. Axe at 1280 and 390, light, dark, Forest.
 */
const DIR = process.env.SHOTS_DIR;
// The service worker would answer a failed read from its cache; these tests drive the page's own error states.
test.use({ serviceWorkers: "block" });
let n = 0;
const ip = () => `10.161.${test.info().workerIndex % 200}.${++n}`;
async function signUp(page: Page, name = "Ada Owner") {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const email = `${name.split(" ")[0].toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { headers, email };
}
async function member(browser: Browser, owner: Page, headers: Record<string, string>) {
  const base = test.info().project.use.baseURL!;
  const email = `max-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const inv = await (await owner.request.post("/api/team/invites", { data: { email, role: "member" }, headers })).json();
  const ctx = await browser.newContext({ baseURL: base, serviceWorkers: "block", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const p = await ctx.newPage();
  expect((await p.request.post("/api/auth/sign-up/email", { data: { name: "Max Member", email, password: "a-strong-password" }, headers })).status()).toBe(200);
  await confirmEmail(p.request, email);
  expect([200, 410]).toContain((await p.request.post(`/api/invites/${inv.link.split("/invite/")[1]}/accept`, { headers })).status()); // the confirm step may already have taken the invite
  return p;
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.map((x) => x.target.join(" ")).slice(0, 2).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
/** QA13's outage: every API read fails except the session reads. Returns ms until the shared card shows. */
async function outage(page: Page, url: string, only?: RegExp) {
  const handler = (route: import("@playwright/test").Route) => {
    const u = route.request().url();
    if (only ? !only.test(u) : /\/api\/(auth|session|me|account|config|flags|boot)/.test(u)) return route.fallback();
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' });
  };
  await page.route(/\/api\//, handler);
  const t0 = Date.now();
  await page.goto(url);
  await expect(page.getByText("Couldn't load this").first()).toBeVisible({ timeout: 10_000 });
  const ms = Date.now() - t0;
  await page.unroute(/\/api\//, handler);
  return ms;
}
async function seed(page: Page, headers: Record<string, string>) {
  const m = (await (await page.request.post("/api/meetings", { data: { title: "Spring launch", startsAt: new Date(Date.now() + 3600_000).toISOString(), durationMin: 60 }, headers })).json()).meeting.id as string;
  const c = (await (await page.request.post("/api/courses", { data: { title: "Workplace safety" }, headers })).json()).course.id as string;
  const t = (await (await page.request.post("/api/tables", { data: { title: "Jobs board", template: "jobs" }, headers })).json()).table.id as string;
  await page.request.post("/api/sites", { data: { name: "Studio", slug: `studio-${Math.random().toString(36).slice(2, 7)}` }, headers });
  return { m, c, t };
}

test("webinar from Meetings in two steps; Meetings and webinar errors recover with Retry (MB-318, MB-312)", async ({ page }) => {
  const { headers } = await signUp(page);
  const { m } = await seed(page, headers);
  await page.goto("/app/meetings");
  await page.getByTestId("meeting-new-webinar").click();
  const dlg = page.getByRole("dialog", { name: "Schedule a webinar" });
  await expect(dlg.getByRole("switch", { name: "Make it a webinar" })).toBeChecked();
  await dlg.getByLabel("Title").fill("Product webinar");
  await shot(page, "pol1-schedule-webinar-1280-light");
  await axe(page, "schedule webinar");
  await dlg.getByRole("button", { name: "Save without inviting" }).click();
  await expect(page.getByTestId("webinar-card").getByLabel("Registration link")).toHaveValue(/\/w\/[A-Za-z0-9]+$/);
  // Schedule also offers it, off by default
  await page.goto("/app/meetings");
  await page.getByTestId("meeting-schedule").click();
  await expect(page.getByRole("dialog", { name: "Schedule a meeting" }).getByRole("switch", { name: "Make it a webinar" })).not.toBeChecked();
  await page.keyboard.press("Escape");
  // MB-312: the list fails with the shared card, Retry brings it back without a reload
  expect(await outage(page, "/app/meetings", /\/api\/(meetings|boot)/)).toBeLessThan(2500);
  await expect(page.getByTestId("meetings-error")).toBeVisible();
  await page.getByTestId("load-error-retry").click();
  await expect(page.getByTestId("meeting-row").first()).toBeVisible();
  // the webinar host page: shared card, Retry, title
  await page.request.patch(`/api/webinars/${m}`, { data: { enabled: true }, headers });
  await outage(page, `/app/meetings/${m}/webinar`, /\/api\/(webinars|meetings)/);
  await page.getByTestId("load-error-retry").first().click();
  await expect(page).toHaveTitle(/Spring launch webinar · Meetings · Multies/);
  // no provider names on the meeting page
  await page.goto(`/app/meetings/${m}`);
  await expect(page.getByTestId("recording-section")).toBeVisible();
  await expect(page.locator("main")).not.toContainText(/OpenAI|Groq/);
});

test("tables: New view stays on screen, Row puts focus in the new row, title, trash with Undo and Restore (MB-313 to 316, 321)", async ({ page }) => {
  const { headers } = await signUp(page);
  const { t } = await seed(page, headers);
  await page.goto(`/app/docs/${t}`);
  await expect(page).toHaveTitle(/^Jobs board · Docs · Multies$/);
  await expect(page.getByRole("button", { name: "New view" })).toBeVisible();
  // MB-314: Row then type
  await page.getByTestId("add-row").click();
  await expect(page.getByTestId("table-grid")).toBeFocused();
  await page.keyboard.type("Typed straight away");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("table-grid")).toContainText("Typed straight away");
  // MB-315: Kanban at 390
  await page.request.post(`/api/tables/${t}/views`, { data: { name: "Board", type: "kanban" }, headers });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("tab", { name: /Board/ }).last().click();
  await expect(page.getByTestId("kanban")).toBeVisible();
  await noHScroll(page);
  const box = await page.getByTestId("add-view").boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await shot(page, "pol1-table-kanban-390-light");
  await axe(page, "kanban 390");
  await page.setViewportSize({ width: 1280, height: 860 });
  // MB-313: More, Move to trash, Undo
  await page.getByTestId("table-more").click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("dialog")).toContainText("forms stop taking answers");
  await shot(page, "pol1-table-trash-confirm-1280-light");
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(/\/app\/docs$/);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/docs/${t}$`));
  await expect(page.getByTestId("table-doc")).toBeVisible();
  // and from Docs, Trash
  await page.request.delete(`/api/tables/${t}`, { headers });
  await page.goto("/app/docs");
  await page.getByTestId("docs-trash").click();
  await expect(page.getByTestId("doc-trash-item")).toHaveCount(1);
  await shot(page, "pol1-docs-trash-1280-light");
  await axe(page, "trash dialog");
  await page.getByRole("button", { name: "Restore Jobs board" }).click();
  await expect(page.getByTestId("doc-trash-empty")).toBeVisible();
  // a table in the trash says so on its own address
  await page.request.delete(`/api/tables/${t}`, { headers });
  await page.goto(`/app/docs/${t}`);
  await expect(page.getByText(/Doc not found|deleted or moved/).first()).toBeVisible();
});

test("courses: title, member sees no delete, trash and restore, errors in about a second (MB-313, MB-321)", async ({ page, browser }) => {
  const { headers } = await signUp(page);
  const { c } = await seed(page, headers);
  await page.goto(`/app/docs/${c}`);
  await expect(page).toHaveTitle(/^Workplace safety · Docs · Multies$/);
  await page.getByTestId("course-tab-build").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("course-tab-assign")).toBeFocused();
  await page.goto("/app/docs/learning");
  await expect(page).toHaveTitle(/^My learning · Docs · Multies$/);
  const mate = await member(browser, page, headers);
  await page.request.post(`/api/courses/${c}/lessons`, { data: { type: "text", title: "Know your exits", body: "Every floor has two exits." }, headers });
  expect((await page.request.patch(`/api/courses/${c}`, { data: { status: "published" }, headers })).status()).toBe(200);
  await mate.goto(`/app/docs/${c}`);
  await expect(mate.getByTestId("course-page")).toBeVisible();
  await expect(mate.getByTestId("course-more")).toHaveCount(0);
  await mate.context().close();
  await page.goto(`/app/docs/${c}`);
  await page.getByTestId("course-more").click();
  await page.getByRole("menuitem", { name: "Move to trash" }).click();
  await expect(page.getByRole("dialog")).toContainText("progress and certificates are kept");
  await page.getByRole("button", { name: "Move to trash" }).click();
  await expect(page).toHaveURL(/\/app\/docs$/);
  await page.goto(`/app/docs/${c}`);
  await expect(page.getByText("This course was deleted or moved")).toBeVisible();
  await page.request.post(`/api/docs/${c}/restore`, { headers });
  expect(await outage(page, `/app/docs/${c}`, /\/api\/courses/)).toBeLessThan(2500);
  await page.getByTestId("load-error-retry").click();
  await expect(page.getByTestId("course-page")).toBeVisible();
  expect(await outage(page, "/app/tools/vault", /\/api\/vault/)).toBeLessThan(2500);
  await page.getByTestId("load-error-retry").click();
  await expect(page.getByTestId("vault-setup")).toBeVisible();
});

test("Home: layout error with Retry, Escape leaves Customize; Sites error speed and a missing page", async ({ page }) => {
  const { headers } = await signUp(page);
  await seed(page, headers);
  await page.goto("/app");
  await page.getByTestId("customize-home").click();
  await expect(page.getByTestId("done-home")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("customize-home")).toBeFocused();
  await page.route(/\/api\/home-widgets$/, (r) => r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"x"}' }));
  await page.reload();
  await expect(page.getByTestId("load-error-inline").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("customize-home")).toBeDisabled();
  await page.unroute(/\/api\/home-widgets$/);
  await page.getByTestId("load-error-retry").first().click();
  await expect(page.getByTestId("customize-home")).toBeEnabled();
  expect(await outage(page, "/app/docs/sites")).toBeLessThan(1800);
  await page.goto("/app/docs/sites/doesnotexist1");
  await expect(page.getByText("This page was deleted or moved")).toBeVisible();
});

test("axe and shots: changed screens at 1280 and 390, light, dark and Forest", async ({ page }) => {
  test.setTimeout(300_000);
  const { headers } = await signUp(page);
  const { m, c, t } = await seed(page, headers);
  await page.request.patch(`/api/webinars/${m}`, { data: { enabled: true }, headers });
  const pages: [string, string][] = [["meetings", "/app/meetings"], ["meeting", `/app/meetings/${m}`], ["webinar", `/app/meetings/${m}/webinar`], ["vault", "/app/tools/vault"], ["course", `/app/docs/${c}`], ["table", `/app/docs/${t}`], ["home", "/app"], ["sites", "/app/docs/sites"], ["docs", "/app/docs"]];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [k, u] of pages) {
        await page.goto(u);
        await page.waitForLoadState("networkidle").catch(() => {});
        await noHScroll(page);
        await shot(page, `pol1-${k}-${w}-${theme}`);
        await axe(page, `${k} ${w} ${theme}`);
      }
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
