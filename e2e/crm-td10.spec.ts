import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * TD10 CRM suggestions from mail, CRM keys and the single key switch, saved analyses (run with CRM_TD10=on).
 * With CRM_TD10 off the "flag off" test checks today's screens are unchanged. Mail is written straight into the local
 * e2e database (as other mail specs read it), so no outside service is involved.
 * SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest, with axe on each.
 */
const ON = process.env.CRM_TD10 === "on";
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.199.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person;
let orgId = "", mailboxId = "";

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
}
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
let seq = 0;
function mail(from: string, fromName: string, text: string, daysAgo = 1) {
  const db = new Database(path.resolve(".data/e2e.db"), { fileMustExist: true });
  try {
    const n = ++seq; const at = Date.now() - daysAgo * 86_400_000;
    db.prepare("insert into messages (id, org_id, mailbox_id, folder, thread_id, from_address, from_name, to_json, subject, text_body, snippet, date, created_at) values (?, ?, ?, 'inbox', ?, ?, ?, '[]', ?, ?, '', ?, ?)")
      .run(`msg_e2e_td10_${Date.now()}_${n}`, orgId, mailboxId, `thr_e2e_td10_${n}_${Date.now()}`, from, fromName, `Hello ${n}`, text, at, at);
  } finally { db.close(); }
}

test.describe.configure({ mode: "serial" });

test.describe("TD10 flag off", () => {
  test.skip(ON, "runs with CRM_TD10 off");
  test("today exactly: no From mail tab, no Analyses page, no CRM keys, API not found", async ({ browser }) => {
    const p = await person(browser, `off-${Date.now()}@example.com`, "Off Owner");
    await p.page.goto("/app/contacts");
    await expect(p.page.getByTestId("contacts-tab-people")).toBeVisible({ timeout: 20_000 });
    await expect(p.page.getByTestId("contacts-tab-suggestions")).toHaveCount(0);
    expect((await p.page.request.get("/api/crm-td10/suggestions")).status()).toBe(404);
    await p.page.keyboard.press("?");
    await expect(p.page.getByTestId("shortcuts-sheet")).toBeVisible();
    await expect(p.page.getByTestId("shortcuts-sheet").getByRole("region", { name: "CRM" })).toHaveCount(0);
    await expect(p.page.getByTestId("single-keys-switch")).toHaveCount(0);
    await p.page.keyboard.press("Escape");
    await p.page.goto("/app/analyses");
    await expect(p.page.getByText(/not found|doesn.t exist|can.t find/i).first()).toBeVisible({ timeout: 20_000 });
    await p.ctx.close();
  });
});

test.describe("TD10 on", () => {
  test.skip(!ON, "runs with CRM_TD10=on");
  test.beforeAll(async ({ browser }) => {
    const tag = Math.random().toString(36).slice(2, 8);
    owner = await person(browser, `cleo-${tag}@example.com`, "Cleo Owner");
    await confirmEmail(owner.page.request, `cleo-${tag}@example.com`);
    orgId = (await (await owner.page.request.get("/api/account/me")).json()).organization.id;
    const fa = await owner.page.request.post("/api/free-address", { data: { localPart: `cleo${Date.now() % 1e8}`, displayName: "Cleo" }, headers: owner.headers });
    expect(fa.status(), await fa.text()).toBe(201);
    mailboxId = (await fa.json()).mailbox.id;
    await owner.page.request.post("/api/contacts", { data: { email: "kim@harbour.example", name: "kim" }, headers: owner.headers });
    mail("sam@harbour.example", "Sam", "Thanks for the quote. Can we talk next week?\n\nKind regards,\nSam Lee\nOperations Manager | Harbour Coffee Pty Ltd\nM: +61 412 345 678");
    mail("kim@harbour.example", "Kim", "Sure, I'll call you on Friday.\n\nBest,\nKim Ng\nHead of Sales\n+61 2 9000 1111", 2);
    mail("zed@quay.example", "Zed", "Cheers,\nZed Ray\nDirector, Quay Studio", 3);
  });
  test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

  test("From mail tab: loading, list, accept by keyboard, edit, discard with Undo, nothing written before a click", async () => {
    const page = owner.page;
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto("/app/contacts?tab=suggestions");
    await expect(page.getByTestId("suggestion-row").first()).toBeVisible({ timeout: 20_000 });
    const before = await (await page.request.get("/api/contacts?q=kim")).json();
    expect(before.contacts[0].title ?? null).toBeNull(); // nothing written before a click
    const count = await page.getByTestId("suggestion-row").count();
    expect(count).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("contacts-tab-suggestions")).toContainText(/\d/);
    const row = (id: string) => page.locator(`[data-suggestion-id="${id}"]`);
    const firstId = async () => (await page.getByTestId("suggestion-row").first().getAttribute("data-suggestion-id"))!;
    // keyboard only: J focuses the first row, A accepts it
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("j");
    await expect(page.getByTestId("suggestion-row").first()).toBeFocused();
    const a1 = await firstId();
    const accepted = page.waitForResponse((r) => /\/api\/crm-td10\/suggestions\/[^/]+\/accept$/.test(r.url()));
    await page.keyboard.press("a");
    const res = await accepted;
    expect(res.status(), await res.text()).toBe(200);
    await expect(row(a1)).toHaveCount(0, { timeout: 10_000 });
    // discard and Undo
    const d1 = await firstId();
    await row(d1).getByTestId("suggestion-discard").click();
    await expect(row(d1)).toHaveCount(0);
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(row(d1)).toHaveCount(1, { timeout: 10_000 });
    // edit before saving
    const e1 = (await page.getByTestId("suggestion-edit").first().locator("xpath=ancestor::li[1]").getAttribute("data-suggestion-id"))!;
    await row(e1).getByTestId("suggestion-edit").click();
    const form = page.getByTestId("suggestion-edit-form");
    await expect(form).toBeVisible();
    await shot(page, "td10-edit-1280-light");
    await axe(page, "edit dialog");
    await form.getByTestId("suggestion-save").click();
    await expect(row(e1)).toHaveCount(0, { timeout: 10_000 });
  });

  test("error with Retry, offline note, and the empty state", async () => {
    const page = owner.page;
    await page.route("**/api/crm-td10/suggestions", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "boom", message: "Try again." } }) }));
    await page.goto("/app/contacts?tab=suggestions");
    await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
    await shot(page, "td10-error-1280-light");
    await page.unroute("**/api/crm-td10/suggestions");
    await page.getByTestId("load-error").getByRole("button").first().click();
    await expect(page.getByTestId("suggestion-row").first()).toBeVisible({ timeout: 20_000 });
    await page.context().setOffline(true);
    await expect(page.getByTestId("crm-offline")).toBeVisible();
    await shot(page, "td10-offline-1280-light");
    await page.context().setOffline(false);
    await expect(page.getByTestId("crm-offline")).toHaveCount(0);
    while (await page.getByTestId("suggestion-discard").count()) {
      const n = await page.getByTestId("suggestion-row").count();
      await page.getByTestId("suggestion-discard").first().click();
      await expect(page.getByTestId("suggestion-row")).toHaveCount(n - 1);
    }
    await expect(page.getByText("Nothing to update")).toBeVisible();
    await shot(page, "td10-empty-1280-light");
    await axe(page, "empty");
  });

  test("Analyses: templates, filters, save and share; member sees the shared one but cannot edit it", async ({ browser }) => {
    const page = owner.page;
    await page.request.post("/api/deals", { data: { title: "Fit out", value: 5000, stage: "proposal" }, headers: owner.headers });
    await page.request.post("/api/deals", { data: { title: "Beans", value: 1200, stage: "lead" }, headers: owner.headers });
    await page.goto("/app/analyses");
    await expect(page.getByTestId("template-card")).toHaveCount(4, { timeout: 20_000 });
    await expect(page.getByTestId("analysis-row")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId("analysis-result")).toContainText("$5,000");
    await page.getByTestId("template-card").filter({ hasText: "Response rates" }).click();
    await expect(page.getByTestId("analysis-row").first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("template-card").filter({ hasText: "Pipeline by stage" }).click();
    await page.getByTestId("analysis-filters").getByLabel("Period").selectOption("30");
    await page.getByTestId("save-bar").getByRole("switch", { name: "Share with the workspace" }).click();
    await page.getByTestId("analysis-save").click();
    await expect(page.getByTestId("saved-row")).toHaveCount(1, { timeout: 10_000 });
    await expect(page.getByTestId("saved-row")).toContainText("Shared");
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 }); // the app wide toast is checked in its own round
    await axe(page, "analyses");
    const tag = Math.random().toString(36).slice(2, 8);
    const invite = await (await page.request.post("/api/team/invites", { data: { email: `max-${tag}@example.com`, role: "member" }, headers: owner.headers })).json();
    member = await person(browser, `max-${tag}@example.com`, "Max Mate");
    await confirmEmail(member.page.request, `max-${tag}@example.com`);
    expect((await member.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: member.headers })).status()).toBe(200);
    await member.page.goto("/app/analyses");
    await expect(member.page.getByTestId("saved-row")).toHaveCount(1, { timeout: 20_000 });
    await member.page.getByTestId("saved-row").click();
    await expect(member.page.getByRole("button", { name: /^Delete / })).toHaveCount(0);
    await member.page.goto("/app/contacts?tab=suggestions");
    await expect(member.page.getByText("Nothing to update")).toBeVisible({ timeout: 20_000 });
  });

  test("CRM keys in the ? sheet; the single key switch turns them off and Ctrl K still works", async () => {
    const page = owner.page;
    await page.goto("/app/contacts");
    await expect(page.getByTestId("contacts-tab-people")).toBeVisible({ timeout: 20_000 });
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");
    const sheet = page.getByTestId("shortcuts-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("section").first()).toHaveAttribute("aria-label", "CRM");
    await shot(page, "td10-sheet-1280-light");
    await axe(page, "sheet");
    await page.getByTestId("single-keys-switch").getByRole("switch").click();
    await expect(page.getByTestId("single-keys-switch").getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("?");
    await expect(sheet).toHaveCount(0);
    await page.keyboard.press("Shift+S");
    await expect(page).toHaveURL(/\/app\/contacts$/);
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await (await page.request.get("/api/crm-td10/prefs")).json()).shortcutsOff).toBe(true);
    await page.request.put("/api/crm-td10/prefs", { data: { shortcutsOff: false }, headers: owner.headers });
  });

  test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
    test.setTimeout(240_000);
    const page = owner.page;
    mail("lou@pier.example", "Lou", "Talk tomorrow?\n\nThanks,\nLou Park\nFounder", 1);
    await page.request.post("/api/crm-td10/suggestions/scan", { headers: owner.headers });
    const run = async (theme: string) => {
      for (const w of [1280, 390]) {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
        await page.goto("/app/contacts?tab=suggestions");
        await expect(page.getByTestId("crm-suggestions")).toBeVisible({ timeout: 20_000 });
        await shot(page, `td10-suggestions-${w}-${theme}`);
        await axe(page, `suggestions ${w} ${theme}`);
        await page.goto("/app/analyses");
        await expect(page.getByTestId("analysis-panel")).toBeVisible({ timeout: 20_000 });
        await expect(page.getByTestId("analysis-row").first()).toBeVisible({ timeout: 20_000 });
        await shot(page, `td10-analyses-${w}-${theme}`);
        await axe(page, `analyses ${w} ${theme}`);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(scroll, `no sideways scroll at ${w}`).toBeLessThanOrEqual(1);
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
});
