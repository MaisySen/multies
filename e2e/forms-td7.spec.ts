import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * TD7 Forms pro B (FORMS_TD7=on in the e2e server; E2E_FORMS_TD7=off runs only the flag off test). Flows: start a form
 * from pasted questions, brand it with a live preview, save part of it on a phone and finish from the resume link,
 * completion counts and drop off for the owner, a password form opened by keyboard only, the closed page after the
 * answer limit, error with Retry and offline. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest; axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.197.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/td7-${name}.png` });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function visitorPage(browser: Browser, width = 390) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width, height: width === 390 ? 844 : 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage() };
}
const FIELDS = [{ id: "name", label: "Your name", type: "text", required: true }, { id: "email", label: "Email", type: "email", required: true }, { id: "msg", label: "Message", type: "textarea" }];
async function makeForm(page: Page, name: string) {
  const r = await page.request.post("/api/forms", { data: { name, target: "task", fields: FIELDS } });
  expect(r.status()).toBeLessThan(300);
  const j = await r.json();
  const form = j.form ?? j;
  return { id: form.id as string, slug: String(form.url).split("/f/")[1] };
}
const pro = (page: Page, id: string, body: unknown) => page.request.put(`/api/forms/${id}/pro`, { data: body });
async function td7On(page: Page) { return !!(await (await page.request.get("/api/config")).json()).formsTd7; }

test("start from pasted questions, brand with a live preview, save part on a phone and finish from the link", async ({ page, browser }) => {
  await demo(page);
  test.skip(!(await td7On(page)), "FORMS_TD7 is off");
  await page.goto("/app/forms");
  await page.getByRole("button", { name: "New form" }).first().click();
  await page.getByTestId("td7-import").click();
  await page.getByTestId("td7-starter-text").fill("Your name *\nEmail address *\nTeam size: Small | Medium | Large\nAnything else?");
  await expect(page.getByText("4 questions found")).toBeVisible();
  await page.getByTestId("td7-import-go").click();
  await page.getByPlaceholder("Website enquiry").fill("Volunteer signup");
  await axe(page, "new form with starter");
  await page.getByRole("dialog").getByRole("button", { name: /^(Save|Create)/ }).last().click();
  const row = page.getByTestId("form-row").filter({ hasText: "Volunteer signup" });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByTestId("td7-more").click();
  await page.getByTestId("td7-accent").selectOption("forest");
  await expect(page.getByTestId("td7-preview")).toHaveAttribute("data-brand-accent", "forest");
  await page.getByTestId("td7-save-look").click();
  await page.getByTestId("td7-tab-look").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("td7-tab-access")).toHaveAttribute("aria-selected", "true");
  await page.getByRole("switch", { name: /save and finish later/i }).click();
  await page.getByTestId("td7-save-access").click();
  await expect(page.getByText("Access saved")).toBeVisible();
  await axe(page, "form settings");
  const forms = await (await page.request.get("/api/forms")).json();
  const f = forms.forms.find((x: { name: string }) => x.name === "Volunteer signup");
  const slug = String(f.url).split("/f/")[1];
  await page.keyboard.press("Escape");

  const v = await visitorPage(browser);
  const counted: string[] = [];
  v.page.on("request", (r) => { if (r.url().includes("/events")) counted.push(r.postData() ?? ""); });
  await v.page.goto(`/f/${slug}`);
  await expect(v.page.getByTestId("td7-brand")).toHaveAttribute("data-brand-accent", "forest");
  const first = v.page.getByTestId("public-form").locator("input").first();
  await first.fill("Grace Hopper");
  await v.page.getByTestId("td7-save-later").click();
  const link = await v.page.getByTestId("td7-resume-link").getByRole("textbox", { name: "Resume link" }).inputValue();
  expect(link).toContain("#resume=");
  expect((await v.ctx.cookies()).length).toBe(0);
  await noHScroll(v.page);
  await axe(v.page, "public form with resume link");
  await shot(v.page, "public-saved-390");
  const v2 = await visitorPage(browser);
  await v2.page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(v2.page.getByText("Welcome back. Your saved answers are filled in.")).toBeVisible();
  expect(v2.page.url()).not.toContain("resume=");
  const inputs = v2.page.getByTestId("public-form").locator("input");
  await expect(inputs.first()).toHaveValue("Grace Hopper");
  await inputs.nth(1).fill("grace@example.com");
  await v2.page.getByRole("button", { name: "Send" }).click();
  await expect(v2.page.getByTestId("form-done")).toBeVisible();
  expect(counted.some((c) => c.includes("view"))).toBe(true);
  await v.ctx.close(); await v2.ctx.close();

  await page.goto("/app/forms");
  await page.getByTestId("form-row").filter({ hasText: "Volunteer signup" }).getByTestId("td7-more").click();
  await page.getByTestId("td7-tab-analytics").click();
  await expect(page.getByTestId("td7-analytics")).toContainText("Completed");
  await expect(page.getByTestId("td7-analytics")).toContainText("Drop off per question");
  await page.getByTestId("td7-tab-saved").click();
  await expect(page.getByText("No saved parts")).toBeVisible();
  await axe(page, "analytics");
});

test("password form by keyboard only, then the closed page after the answer limit", async ({ page, browser }) => {
  await demo(page);
  test.skip(!(await td7On(page)), "FORMS_TD7 is off");
  const f = await makeForm(page, "Members only");
  expect((await pro(page, f.id, { password: "Open sesame 42", settings: { responseCap: 1, closedMessage: "All places are taken." } })).status()).toBe(200);
  const v = await visitorPage(browser, 1280);
  await v.page.goto(`/f/${f.slug}`);
  await expect(v.page.getByTestId("td7-locked")).toBeVisible();
  await expect(v.page.getByTestId("public-form")).toHaveCount(0);
  await axe(v.page, "locked form");
  await shot(v.page, "locked-1280");
  await v.page.getByTestId("td7-password").focus();
  await v.page.keyboard.type("wrong one");
  await v.page.keyboard.press("Enter");
  await expect(v.page.getByRole("alert")).toContainText("That password isn't right.");
  await v.page.getByTestId("td7-password").fill("");
  await v.page.keyboard.type("Open sesame 42");
  await v.page.keyboard.press("Enter");
  await expect(v.page.getByTestId("public-form")).toBeVisible();
  await v.page.keyboard.press("Tab");
  const inputs = v.page.getByTestId("public-form").locator("input");
  await inputs.first().focus();
  await v.page.keyboard.type("Ada");
  await v.page.keyboard.press("Tab");
  await v.page.keyboard.type("ada@example.com");
  await v.page.getByRole("button", { name: "Send" }).focus();
  await v.page.keyboard.press("Enter");
  await expect(v.page.getByTestId("form-done")).toBeVisible();
  await v.ctx.close();
  const late = await visitorPage(browser);
  await late.page.goto(`/f/${f.slug}`);
  await expect(late.page.getByTestId("td7-closed")).toContainText("All places are taken.");
  await noHScroll(late.page);
  await axe(late.page, "closed form");
  await shot(late.page, "closed-390");
  const post = await late.page.request.post(`/api/public/forms/${f.slug}`, { data: { answers: { name: "Late", email: "late@example.com" }, elapsedMs: 9000 } });
  expect(post.status()).toBe(410);
  await late.ctx.close();
});

test("settings show loading, error with Retry and offline, at 1280 and 390, light, dark and Forest", async ({ page }) => {
  await demo(page);
  test.skip(!(await td7On(page)), "FORMS_TD7 is off");
  const f = await makeForm(page, "States form");
  let fail = true;
  await page.route(`**/api/forms/${f.id}/analytics`, (r) => (fail ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "internal", message: "Something went wrong." } }) }) : r.continue()));
  await page.goto("/app/forms");
  await page.getByTestId("form-row").filter({ hasText: "States form" }).getByTestId("td7-more").click();
  await page.getByTestId("td7-tab-analytics").click();
  const retry = page.getByRole("button", { name: /retry|try again/i }).first();
  await expect(retry).toBeVisible({ timeout: 15_000 });
  fail = false;
  await retry.click();
  await expect(page.getByText("No visits yet")).toBeVisible();
  await page.getByTestId("td7-tab-access").click();
  await page.context().setOffline(true);
  await page.getByTestId("td7-save-access").click();
  await expect(page.locator("[data-sonner-toaster]")).toContainText(/connect|offline|reach/i, { timeout: 15_000 });
  await page.context().setOffline(false);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByTestId("td7-tab-look").click();
      await axe(page, `look ${width} ${scheme}`);
      await shot(page, `look-${width}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.goto("/app/forms");
  await page.getByTestId("form-row").filter({ hasText: "States form" }).getByTestId("td7-more").click();
  await axe(page, "look forest");
  await shot(page, "look-1280-forest");
});

test("flag off: no form settings button and the public form is as today", async ({ page, browser }) => {
  await demo(page);
  test.skip(await td7On(page), "only with E2E_FORMS_TD7=off");
  const f = await makeForm(page, "Plain form");
  await page.goto("/app/forms");
  await expect(page.getByTestId("form-row").filter({ hasText: "Plain form" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("td7-more")).toHaveCount(0);
  expect((await page.request.get(`/api/forms/${f.id}/pro`)).status()).toBe(404);
  const v = await visitorPage(browser);
  await v.page.goto(`/f/${f.slug}`);
  await expect(v.page.getByTestId("public-form")).toBeVisible();
  await expect(v.page.getByTestId("td7-brand")).toHaveCount(0);
  await expect(v.page.getByTestId("td7-save")).toHaveCount(0);
  await v.ctx.close();
});
