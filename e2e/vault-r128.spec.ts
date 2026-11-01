import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R128 Team password vault (VAULT_R128=on in the e2e server). Set up, empty states, a folder and an item at 1280 and 390,
 * generator, reveal and copy audited, sharing with a member who opens and reads it, view only, removal with key rotation,
 * a secure share link opened in a fresh context, wrong passphrase, auto lock, activity with CSV, and no plaintext in any
 * request. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest, with axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person;
const OWNER_PASS = "owner vault passphrase 42";
const MEMBER_PASS = "member vault passphrase 7";
const SECRET = "Pw-for-the-router-9!";
const sent: string[] = [];

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLEERR", m.text().slice(0, 400)); });
  page.on("request", (r) => { if (r.url().includes("/api/")) { const b = r.postData(); if (b) sent.push(b); } });
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
async function axe(page: Page, label: string) {
  // Toasts fade in and out (their own component); the page under them is what is checked here.
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function openVault(page: Page, pass: string) {
  await page.goto("/app/tools/vault");
  const locked = page.getByTestId("vault-locked");
  const toolbar = page.getByTestId("vault-toolbar");
  await expect(locked.or(toolbar)).toBeVisible({ timeout: 20_000 });
  if (await locked.isVisible()) {
    await page.getByTestId("vault-open-pass").fill(pass);
    await page.getByTestId("vault-open-go").click();
    await expect(toolbar).toBeVisible({ timeout: 20_000 });
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  owner = await person(browser, `vault-owner-${Date.now()}@example.com`, "Vera Owner");
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("set up: the passphrase rules, the no recovery warning, then the empty vault", async () => {
  const page = owner.page;
  await page.goto("/app/tools/vault");
  await expect(page.getByTestId("vault-setup")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("vault-setup")).toContainText("nobody can recover");
  await axe(page, "setup");
  await page.getByTestId("vault-setup-pass").fill("short");
  await page.getByTestId("vault-setup-go").click();
  await expect(page.getByRole("alert")).toContainText("at least 10");
  await page.getByTestId("vault-setup-pass").fill(OWNER_PASS);
  await page.getByTestId("vault-setup-pass2").fill(OWNER_PASS + "x");
  await page.getByTestId("vault-setup-go").click();
  await expect(page.getByRole("alert")).toContainText("don't match");
  await page.getByTestId("vault-setup-pass2").fill(OWNER_PASS);
  await page.getByTestId("vault-setup-go").click();
  await expect(page.getByRole("alert")).toContainText("Tick the box");
  await page.getByTestId("vault-setup-ack").check();
  await page.getByTestId("vault-setup-go").click();
  await expect(page.getByTestId("vault-empty")).toContainText("No folders yet", { timeout: 30_000 });
  await axe(page, "empty");
});

test("a folder and an item with a generated password; reveal and copy are audited", async () => {
  const page = owner.page;
  await page.getByTestId("vault-new-folder").first().click();
  await page.getByTestId("vault-folder-name").fill("Office logins");
  await page.getByTestId("vault-folder-save").click();
  await expect(page.getByTestId("vault-folder")).toContainText("Office logins");
  await expect(page.getByText("No items yet")).toBeVisible();
  // Generated password in the form.
  await page.getByTestId("vault-new-item").click();
  await page.getByTestId("vault-item-title").fill("Router admin");
  await page.getByTestId("vault-item-username").fill("admin");
  await page.getByTestId("vault-item-generate").click();
  const gen = (await page.getByTestId("vault-generated").textContent())!;
  expect(gen.length).toBe(20);
  await page.getByTestId("vault-use-generated").click();
  await expect(page.getByTestId("vault-item-password")).toHaveValue(gen);
  await page.getByTestId("vault-item-password").fill(SECRET);
  await page.getByTestId("vault-item-url").fill("router.example");
  await page.getByTestId("vault-item-save").click();
  await expect(page.getByTestId("vault-item")).toContainText("Router admin");
  // Detail: hidden until revealed; reveal writes the audit first.
  await page.getByTestId("vault-item").first().click();
  await expect(page.getByTestId("vault-value-password")).not.toContainText(SECRET);
  const audited = page.waitForResponse((r) => r.url().endsWith("/api/vault/audit") && r.request().method() === "POST");
  await page.getByTestId("vault-reveal-password").click();
  expect((await audited).status()).toBe(201);
  await expect(page.getByTestId("vault-value-password")).toContainText(SECRET);
  await page.getByTestId("vault-copy-password").click();
  await expect(page.getByText("clipboard clears in 30 seconds").first()).toBeVisible();
  await page.keyboard.press("Escape");
  // Search.
  await page.getByTestId("vault-search").fill("nothing like this");
  await expect(page.getByText("No items match.")).toBeVisible();
  await page.getByTestId("vault-search").fill("");
});

test("the generator on its own: length and kinds", async () => {
  const page = owner.page;
  await page.getByTestId("vault-open-generator").click();
  const g = page.getByTestId("vault-generator");
  await g.getByLabel("Length").fill("40");
  await g.getByLabel("Symbols").uncheck();
  const v = (await page.getByTestId("vault-generated").textContent())!;
  expect(v).toHaveLength(40);
  expect(v).toMatch(/^[A-Za-z0-9]+$/);
  await page.keyboard.press("Escape");
});

test("share with a member who opens it, view only, then removal rotates the key", async ({ browser }) => {
  test.setTimeout(180_000);
  member = await join(browser, `vault-member-${Date.now()}@example.com`, "Max Member", "member");
  const mp = member.page;
  // Before setting up: the member is offered set up; after it, nothing is shared yet.
  await mp.goto("/app/tools/vault");
  await mp.getByTestId("vault-setup-pass").fill(MEMBER_PASS);
  await mp.getByTestId("vault-setup-pass2").fill(MEMBER_PASS);
  await mp.getByTestId("vault-setup-ack").check();
  await mp.getByTestId("vault-setup-go").click();
  await expect(mp.getByTestId("vault-empty")).toContainText("Nothing shared with you yet", { timeout: 30_000 });
  await expect(mp.getByTestId("vault-open-audit")).toHaveCount(0);
  // Owner gives view access.
  const page = owner.page;
  await page.getByTestId("vault-open-access").click();
  await page.getByTestId("vault-access-pick").selectOption({ label: "Max Member" });
  await page.getByTestId("vault-access-add").click();
  await expect(page.getByTestId("vault-access-row")).toHaveCount(2);
  await axe(page, "access");
  await page.keyboard.press("Escape");
  // Member opens the vault again (new page load) and reads the item.
  await openVault(mp, MEMBER_PASS);
  await expect(mp.getByTestId("vault-folder")).toContainText("Office logins");
  await expect(mp.getByTestId("vault-new-item")).toHaveCount(0); // view only
  await mp.getByTestId("vault-item").first().click();
  await mp.getByTestId("vault-reveal-password").click();
  await expect(mp.getByTestId("vault-value-password")).toContainText(SECRET);
  await expect(mp.getByTestId("vault-edit")).toHaveCount(0);
  await mp.keyboard.press("Escape");
  // Owner removes the member: the folder gets a new key at once.
  await page.getByTestId("vault-open-access").click();
  await page.getByTestId("vault-access-remove").click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(page.getByText("the folder has a new key").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("vault-rotate-banner")).toHaveCount(0);
  // The member sees nothing now.
  await mp.reload();
  await openVault(mp, MEMBER_PASS);
  await expect(mp.getByTestId("vault-empty")).toContainText("Nothing shared with you yet");
  expect((await mp.request.get("/api/vault/audit", { headers: member.headers })).status()).toBe(403);
});

test("a secure share link opens once in a fresh browser", async ({ browser }) => {
  test.skip(process.env.SECURE_SHARE_E2E !== "1", "needs a local server with secret links on (TOOLS_FEATURES=all)");
  const page = owner.page;
  await openVault(page, OWNER_PASS);
  await page.getByTestId("vault-item").first().click();
  await page.getByTestId("vault-share").click();
  await page.getByTestId("vault-share-make").click();
  const link = (await page.getByTestId("vault-share-link").textContent())!;
  expect(link).toContain("#");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const fresh = await browser.newContext();
  const p = await fresh.newPage();
  await p.goto(link);
  await p.getByRole("button", { name: "Show secret" }).click();
  await expect(p.locator("body")).toContainText(SECRET, { timeout: 15_000 });
  const again = await fresh.newPage();
  await again.goto(link);
  await expect(again.locator("body")).not.toContainText(SECRET);
  await fresh.close();
});

test("activity for admins with a CSV, wrong passphrase, lock and auto lock", async () => {
  test.setTimeout(120_000);
  const page = owner.page;
  await page.getByTestId("vault-open-audit").click();
  await expect(page.getByTestId("vault-audit-row").first()).toBeVisible();
  await expect(page.getByTestId("vault-audit")).toContainText("revealed password");
  await expect(page.getByTestId("vault-audit")).not.toContainText(SECRET);
  const dl = page.waitForEvent("download");
  await page.getByTestId("vault-audit-csv").click();
  expect((await dl).suggestedFilename()).toBe("vault-activity.csv");
  await page.keyboard.press("Escape");
  // Lock, then a wrong passphrase.
  await page.locator('[data-testid="vault-lock"]:visible').first().click();
  await expect(page.getByTestId("vault-locked")).toBeVisible();
  await page.getByTestId("vault-open-pass").fill("not the passphrase at all");
  await page.getByTestId("vault-open-go").click();
  await expect(page.getByTestId("vault-open-error")).toContainText("Wrong passphrase. 4 tries left");
  // Auto lock after 15 idle minutes (the page clock is moved forward).
  await page.clock.install();
  await openVault(page, OWNER_PASS);
  await page.clock.fastForward("16:00");
  await expect(page.getByTestId("vault-locked")).toBeVisible({ timeout: 10_000 });
  // The server never received a passphrase or a secret in clear.
  const all = sent.join("\n");
  for (const s of [OWNER_PASS, MEMBER_PASS, SECRET, "Router admin", "Office logins", "router.example"]) expect(all).not.toContain(s);
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(300_000);
  const page = owner.page;
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/tools/vault");
      await expect(page.getByTestId("vault-locked").or(page.getByTestId("vault-toolbar"))).toBeVisible({ timeout: 20_000 });
      if (await page.getByTestId("vault-locked").isVisible()) { await shot(page, `r128-locked-${w}-${theme}`); await axe(page, `locked ${w} ${theme}`); }
      await openVault(page, OWNER_PASS);
      await shot(page, `r128-folder-${w}-${theme}`);
      await axe(page, `folder ${w} ${theme}`);
      await page.getByTestId("vault-item").first().click();
      await shot(page, `r128-item-${w}-${theme}`);
      await axe(page, `item ${w} ${theme}`);
      await page.keyboard.press("Escape");
      await page.locator('[data-testid="vault-lock"]:visible').first().click();
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
