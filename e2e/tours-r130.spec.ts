/**
 * R130 guided onboarding (TOURS_R130=on in the e2e server): the Get started checklist for an admin and a member
 * (completes itself, hide, resume from the account menu), a built in tour by keyboard only at 1280 and at 390,
 * the tour builder (create, pick an element on the page, publish to members, preview) and a member seeing it once.
 * Axe on Home with the checklist and with the tour popover open in light, dark and Forest.
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { confirmEmail } from "./support/confirm-email";

let visitor = 0;
const ip = () => `10.230.${test.info().workerIndex % 200}.${++visitor}`;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function person(browser: Browser, email: string, name: string, width = 1280, height = 900) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() }, viewport: { width, height } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
async function team(browser: Browser) {
  const owner = await person(browser, `owner-${uniq()}@acme.io`, "Olive Owner");
  const email = `max-${uniq()}@acme.io`;
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email, role: "member" }, headers: owner.headers })).json();
  const m = await person(browser, email, "Max Member");
  await confirmEmail(m.page.request, email);
  expect((await m.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: m.headers })).status()).toBe(200);
  return { admin: owner.page, member: m.page };
}
const SHOTS = process.env.R130_SHOTS || "";
async function shot(page: Page, name: string) { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); }
async function theme(page: Page, t: "light" | "dark" | "forest", back: string) {
  if (t !== "forest") { await page.emulateMedia({ colorScheme: t }); return; }
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await page.goto(back);
}
async function axe(page: Page, sel = "main") {
  const r = await new AxeBuilder({ page }).include(sel).analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}
async function openAccount(page: Page) {
  const b = page.getByTestId("sidebar-account").or(page.getByTestId("topbar-account")).filter({ visible: true }).first();
  await b.click();
}

test.describe("R130 guided onboarding", () => {
  test.setTimeout(150_000);

  test("admin checklist completes itself, hides and comes back from the account menu", async ({ browser }) => {
    const { admin } = await team(browser);
    await admin.goto("/app/my-work");
    const list = admin.getByTestId("checklist");
    await expect(list).toBeVisible({ timeout: 20_000 });
    await expect(admin.getByTestId("checklist-step-mail")).toBeVisible();
    await expect(admin.getByTestId("checklist-step-open_mail")).toHaveCount(0); // members only
    await expect(admin.getByTestId("checklist-step-invite")).toHaveAttribute("data-done", "1"); // the invite counts
    await expect(admin.getByTestId("tours-ring").filter({ visible: true })).toBeVisible();
    await shot(admin, "checklist-admin-1280-light");
    // Ctrl K ticks its step.
    await admin.getByTestId("today").click({ position: { x: 5, y: 5 } });
    await admin.keyboard.press("Control+k");
    await expect(admin.getByTestId("checklist-step-palette")).toHaveAttribute("data-done", "1", { timeout: 10_000 });
    const palette = admin.getByRole("dialog", { name: "Command menu" });
    await expect(palette).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    // Hide, then bring it back.
    await admin.getByTestId("checklist-hide").click();
    await expect(list).toHaveCount(0);
    await expect(admin.getByTestId("tours-ring")).toHaveCount(0);
    await openAccount(admin);
    await admin.getByRole("menuitem", { name: "Get started" }).click();
    const gs = admin.getByRole("dialog", { name: "Get started" });
    await expect(gs).toBeVisible();
    await expect(gs.getByTestId("checklist")).toBeVisible();
    await admin.keyboard.press("Escape");
    await expect(gs).toBeHidden();
    await expect(admin.getByTestId("checklist")).toHaveCount(1);
    await expect(admin.getByTestId("checklist")).toBeVisible();
    // Nothing on public pages.
    await admin.goto("/");
    await expect(admin.getByTestId("checklist")).toHaveCount(0);
    await expect(admin.getByTestId("tours-ring")).toHaveCount(0);
  });

  test("member gets their own list; opening Mail ticks it", async ({ browser }) => {
    const { member } = await team(browser);
    await member.goto("/app/my-work");
    await expect(member.getByTestId("checklist")).toBeVisible({ timeout: 20_000 });
    await expect(member.getByTestId("checklist-step-mail")).toHaveCount(0);
    const marked = member.waitForResponse((r) => r.url().includes("/api/tours/checklist") && r.request().method() === "POST");
    await member.getByTestId("checklist-go-open_mail").click();
    await expect(member).toHaveURL(/\/app\/mail/);
    expect((await marked).status()).toBe(200);
    await member.goto("/app/my-work");
    await expect(member.getByTestId("checklist-step-open_mail")).toHaveAttribute("data-done", "1", { timeout: 10_000 });
    await expect(member.getByRole("link", { name: "Tours" })).toHaveCount(0);
    expect((await member.request.get("/api/tours/admin")).status()).toBe(403);
  });

  for (const width of [1280, 390]) {
    test(`a built in tour by keyboard only at ${width}`, async ({ browser }) => {
      const { admin } = await team(browser);
      await admin.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await admin.goto("/app/my-work");
      await expect(admin.getByTestId("checklist")).toBeVisible({ timeout: 20_000 });
      const go = admin.getByTestId("checklist-go-tour");
      await go.focus();
      await admin.keyboard.press("Enter");
      const pop = admin.getByTestId("tour-popover");
      await expect(pop).toBeVisible({ timeout: 10_000 });
      await expect(pop).toHaveAttribute("role", "dialog");
      await expect(admin.getByTestId("tour-count")).toHaveText(/^Step 1 of \d/);
      const total = Number((await admin.getByTestId("tour-count").innerText()).match(/of (\d+)/)![1]);
      expect(total).toBeGreaterThanOrEqual(2);
      await expect(admin.getByTestId("tour-next")).toBeFocused();
      await admin.keyboard.press("ArrowRight");
      await expect(admin.getByTestId("tour-count")).toHaveText(/^Step 2 of/);
      await admin.keyboard.press("ArrowLeft");
      await expect(admin.getByTestId("tour-count")).toHaveText(/^Step 1 of/);
      for (let n = 0; n < 4; n++) { await admin.keyboard.press("Tab"); expect(await pop.evaluate((el) => el.contains(document.activeElement))).toBe(true); }
      await shot(admin, `tour-${width}-light`);
      expect(await axe(admin, '[data-testid="tour-popover"]')).toEqual([]);
      await admin.emulateMedia({ colorScheme: "dark" });
      expect(await axe(admin, '[data-testid="tour-popover"]')).toEqual([]);
      await shot(admin, `tour-${width}-dark`);
      await admin.emulateMedia({ colorScheme: "light" });
      await admin.getByTestId("tour-next").focus();
      for (let n = 1; n < total; n++) await admin.keyboard.press("Enter");
      await admin.keyboard.press("Enter"); // Done
      await expect(pop).toHaveCount(0);
      await admin.goto("/app/my-work");
      await expect(admin.getByTestId("checklist-step-tour")).toHaveAttribute("data-done", "1", { timeout: 10_000 });
      // Esc closes and focus comes back.
      await openAccount(admin);
      await admin.getByRole("menuitem", { name: "Tours" }).click();
      await admin.getByTestId("tours-start-getting_around").click();
      await expect(pop).toBeVisible({ timeout: 10_000 });
      await admin.keyboard.press("Escape");
      await expect(pop).toHaveCount(0);
    });
  }

  test("builder: create, pick an element, publish to members, preview; a member sees it once", async ({ browser }) => {
    const { admin, member } = await team(browser);
    await admin.goto("/app/settings/tours");
    await expect(admin.getByTestId("tours-settings")).toBeVisible({ timeout: 20_000 });
    await shot(admin, "builder-empty-1280-light");
    await admin.getByTestId("tours-new").click();
    await admin.getByTestId("tours-name").fill("Welcome to Tasks");
    await admin.getByTestId("tours-page").selectOption("/app/tasks");
    await admin.getByTestId("tours-create").click();
    await expect(admin.getByTestId("tour-editor")).toBeVisible();
    await admin.getByTestId("tour-add-step").click();
    await expect(admin).toHaveURL(/\/app\/tasks/);
    await expect(admin.getByTestId("tour-picker")).toBeVisible({ timeout: 10_000 });
    await shot(admin, "picker-1280-light");
    await admin.getByTestId("tour-pick-rail-tasks").click();
    await expect(admin.getByTestId("tour-editor")).toBeVisible({ timeout: 10_000 });
    await admin.getByTestId("tour-step-title-0").fill("All your work");
    await admin.getByTestId("tour-step-body-0").fill("Lists, boards and timelines live here.");
    await admin.getByTestId("tour-audience").selectOption("members");
    await admin.getByTestId("tour-save").click();
    await expect(admin.getByTestId("tour-editor-publish")).toBeEnabled();
    await shot(admin, "builder-editor-1280-light");
    expect(await axe(admin)).toEqual([]);
    await admin.getByTestId("tour-editor-publish").click();
    await expect(admin.getByTestId("tour-editor").getByText("Published")).toBeVisible();
    await admin.getByTestId("tour-editor-preview").click();
    await expect(admin.getByTestId("tour-popover")).toContainText("All your work", { timeout: 10_000 });
    await expect(admin.getByTestId("tour-count")).toContainText("Preview");
    await admin.keyboard.press("Escape");
    // The member sees it once on Tasks.
    await member.goto("/app/tasks");
    await expect(member.getByTestId("tour-popover")).toContainText("All your work", { timeout: 15_000 });
    await member.getByTestId("tour-next").click();
    await expect(member.getByTestId("tour-popover")).toHaveCount(0);
    await member.reload();
    await member.waitForTimeout(2500);
    await expect(member.getByTestId("tour-popover")).toHaveCount(0);
    // The admin (audience members) never gets it on their own.
    await admin.goto("/app/tasks");
    await admin.waitForTimeout(2500);
    await expect(admin.getByTestId("tour-popover")).toHaveCount(0);
  });

  test("axe on Home with the checklist in light, dark and Forest, at 1280 and 390", async ({ browser }) => {
    const { admin } = await team(browser);
    for (const t of ["light", "dark", "forest"] as const) {
      await theme(admin, t, "/app/my-work");
      for (const w of [1280, 390]) {
        await admin.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await admin.goto("/app/my-work");
        await expect(admin.getByTestId("checklist")).toBeVisible({ timeout: 20_000 });
        expect(await axe(admin), `${t} ${w}`).toEqual([]);
        expect(await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scroll ${t} ${w}`).toBe(true);
        await shot(admin, `checklist-${w}-${t}`);
      }
    }
  });
});
