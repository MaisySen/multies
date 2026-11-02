import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * R126 People (PEOPLE_R126=on in the e2e server): Contacts > Staff directory and org chart, a profile, time away,
 * onboarding checklist to tasks with no duplicates on reassign, the assets register with assign, history and a QR
 * label that opens only for signed in members, member limits, the error state with Retry, flag off unchanged, and
 * SHOTS_DIR shots at 1280 and 390 in light, dark and Forest with axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.197.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string>; id: string };
let owner: Person, member: Person;
let assetId = "";

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers, id: "" };
}
async function axe(page: Page, label: string) {
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

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const s = Date.now().toString(36);
  owner = await person(browser, `owner-r126-${s}@example.com`, "Olive Owner");
  await owner.page.request.patch("/api/org", { data: { name: "Acme people" }, headers: owner.headers });
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email: `member-r126-${s}@example.com`, role: "member" }, headers: owner.headers })).json();
  member = await person(browser, `member-r126-${s}@example.com`, "Max Member");
  await confirmEmail(member.page.request, `member-r126-${s}@example.com`);
  expect((await member.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: member.headers })).status()).toBe(200);
  const staff = await (await owner.page.request.get("/api/people/staff")).json();
  owner.id = staff.people.find((p: { name: string }) => p.name === "Olive Owner").userId;
  member.id = staff.people.find((p: { name: string }) => p.name === "Max Member").userId;
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("Contacts has a Staff tab; directory, search and a profile edit", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/contacts");
  await page.getByTestId("contacts-tab-staff").click();
  await expect(page.getByTestId("staff-page")).toBeVisible();
  await expect(page.getByTestId("staff-card")).toHaveCount(2);
  await page.getByTestId("staff-search").fill("max");
  await expect(page.getByTestId("staff-card")).toHaveCount(1);
  await page.getByTestId("staff-card").click();
  await expect(page.getByTestId("staff-profile")).toBeVisible();
  await page.getByTestId("profile-edit").click();
  await page.getByTestId("profile-title").fill("Designer");
  await page.getByTestId("profile-team").fill("Product");
  await page.getByTestId("profile-skills").fill("Figma, Research");
  await page.getByTestId("profile-manager").selectOption(owner.id);
  await page.getByTestId("profile-start").fill("2026-11-09");
  await page.getByTestId("profile-save").click();
  await expect(page.getByRole("heading", { name: "Max Member" })).toBeVisible();
  await expect(page.getByText("Designer · Product")).toBeVisible();
  await expect(page.getByText("Reports to")).toBeVisible();
});

test("org chart is a keyboard tree", async () => {
  const page = owner.page;
  await page.goto("/app/contacts/staff?view=org");
  const nodes = page.getByTestId("org-node");
  await expect(nodes).toHaveCount(2);
  await nodes.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(nodes.nth(1)).toBeFocused();
  await expect(nodes.nth(1)).toHaveAttribute("aria-level", "2");
  await page.keyboard.press("ArrowLeft");
  await expect(nodes.first()).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(nodes.first()).toHaveAttribute("aria-expanded", "false");
  await expect(nodes).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(nodes).toHaveCount(2);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Max Member" })).toBeVisible();
});

test("onboarding checklist creates tasks once; assigning again adds nothing", async () => {
  const page = owner.page;
  await page.goto("/app/settings/team");
  await page.getByTestId("team-onboarding").getByRole("link", { name: "Open checklists" }).click();
  await expect(page.getByTestId("onboarding-settings")).toBeVisible();
  await page.getByTestId("tpl-new").click();
  await expect(page.getByTestId("tpl-row")).toHaveCount(4);
  await page.getByTestId("tpl-save").click();
  await expect(page.getByTestId("tpl-list")).toContainText("New starter");
  await page.goto(`/app/contacts/staff/${member.id}`);
  await page.getByTestId("run-assign").click();
  await expect(page.getByTestId("run-start")).toHaveValue(/2026-11-09|11\/09\/2026|09\/11\/2026/);
  await page.getByTestId("run-save").click();
  await expect(page.getByText("4 tasks created")).toBeVisible();
  await expect(page.getByTestId("run-progress")).toHaveText("0 of 4 done");
  await expect(page.getByTestId("profile-runs")).toContainText("Read the team handbook");
  await page.getByTestId("run-assign").click();
  await page.getByTestId("run-save").click();
  await expect(page.getByText(/Due dates updated|Already assigned/)).toBeVisible();
  await expect(page.getByTestId("run-progress")).toHaveText("0 of 4 done");
  const tasks = await (await page.request.get("/api/tasks?q=handbook")).json().catch(() => null);
  if (tasks?.tasks) expect(tasks.tasks.filter((t: { title: string }) => t.title === "Read the team handbook")).toHaveLength(1);
});

test("assets: create, assign with history, QR label, warranty soon, CSV", async () => {
  const page = owner.page;
  await page.goto("/app/contacts/staff?view=assets");
  await expect(page.getByText("No assets yet")).toBeVisible();
  await page.getByTestId("asset-new").click();
  await page.getByTestId("asset-name").fill("MacBook Air 13");
  const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId("asset-warranty").fill(soon);
  await page.getByTestId("asset-save").click();
  await expect(page.getByTestId("asset-page")).toBeVisible();
  assetId = decodeURIComponent(page.url().split("/assets/")[1]);
  await expect(page.getByRole("img", { name: /QR label for A-0001/ })).toBeVisible();
  await page.getByTestId("asset-assignee").selectOption(member.id);
  await page.getByTestId("asset-assign").click();
  await expect(page.getByTestId("asset-history")).toContainText("Assigned to Max Member");
  await page.goto("/app/contacts/staff?view=assets");
  await expect(page.getByTestId("warranty-soon")).toContainText("1 warranty ends soon");
  const csv = await page.request.get("/api/people/assets.csv");
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("MacBook Air 13");
  await page.goto(`/app/contacts/staff/${member.id}`);
  await expect(page.getByTestId("profile-assets")).toContainText("A-0001");
});

test("the QR link opens only for signed in members of the workspace", async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const anon = await browser.newContext({ baseURL: base });
  const p = await anon.newPage();
  await p.goto(`/app/contacts/assets/${assetId}`);
  await expect(p.getByTestId("asset-page")).toHaveCount(0);
  await expect(p).toHaveURL(/login|sign/);
  expect((await p.request.get(`/api/people/assets/${assetId}`)).status()).toBe(401);
  await anon.close();
  const other = await person(browser, `other-r126-${Date.now().toString(36)}@example.com`, "Oscar Other");
  expect((await other.page.request.get(`/api/people/assets/${assetId}`)).status()).toBe(404);
  await other.page.goto(`/app/contacts/assets/${assetId}`);
  await expect(other.page.getByText("Asset not found")).toBeVisible();
  await other.ctx.close();
});

test("member: reads, edits only self, adds own time away, no admin controls", async () => {
  const page = member.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/contacts/staff/${member.id}`);
  await expect(page.getByTestId("profile-edit")).toBeVisible();
  await expect(page.getByTestId("run-assign")).toHaveCount(0);
  await page.getByTestId("away-add").click();
  await page.getByTestId("away-start").fill("2026-12-22");
  await page.getByTestId("away-end").fill("2026-12-24");
  await page.getByTestId("away-save").click();
  await expect(page.getByTestId("profile-away")).toContainText(/22 Dec 2026|Dec 22, 2026/);
  await page.goto(`/app/contacts/staff/${owner.id}`);
  await expect(page.getByRole("heading", { name: "Olive Owner" })).toBeVisible();
  await expect(page.getByTestId("profile-edit")).toHaveCount(0);
  await page.goto("/app/contacts/staff?view=assets");
  await expect(page.locator("text=MacBook Air 13 >> visible=true").first()).toBeVisible();
  await expect(page.getByTestId("asset-new")).toHaveCount(0);
  await page.goto(`/app/contacts/assets/${assetId}`);
  await expect(page.getByTestId("asset-page")).toBeVisible();
  await expect(page.getByTestId("asset-edit")).toHaveCount(0);
  await expect(page.getByTestId("asset-assign")).toHaveCount(0);
  expect((await page.request.patch(`/api/people/staff/${owner.id}`, { data: { title: "Boss" }, headers: member.headers })).status()).toBe(403);
  expect((await page.request.post("/api/people/assets", { data: { name: "Phone" }, headers: member.headers })).status()).toBe(403);
  expect((await page.request.get("/api/people/assets.csv")).status()).toBe(403);
  await page.goto("/app/settings/team/onboarding");
  await expect(page.getByTestId("onboarding-settings")).toBeVisible();
  await expect(page.getByTestId("tpl-new")).toHaveCount(0);
});

test("away view shows the time away; error state retries; flag off leaves Contacts unchanged", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/contacts/staff?view=away");
  await expect(page.getByTestId("away-table")).toBeVisible();
  let fail = true;
  await page.route("**/api/people/staff", (r) => (fail ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await page.goto("/app/contacts/staff");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await page.getByTestId("load-error-retry").click();
  await expect(page.getByTestId("staff-card").first()).toBeVisible();
  await page.unroute("**/api/people/staff");
  await page.route("**/api/config", async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, peopleR126: false } }); });
  await page.goto("/app/contacts");
  await expect(page.getByTestId("contacts-tab-people")).toBeVisible();
  await expect(page.getByTestId("contacts-tab-staff")).toHaveCount(0);
  await page.goto("/app/contacts/staff");
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.unroute("**/api/config");
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(300_000);
  const page = owner.page;
  const pages: [string, string, string][] = [
    ["directory", "/app/contacts/staff", "staff-card"], ["org", "/app/contacts/staff?view=org", "org-node"], ["away", "/app/contacts/staff?view=away", "away-table"],
    ["assets", "/app/contacts/staff?view=assets", "warranty-soon"], ["profile", `/app/contacts/staff/${member.id}`, "profile-runs"],
    ["asset", `/app/contacts/assets/${assetId}`, "asset-history"], ["onboarding", "/app/settings/team/onboarding", "tpl-list"],
  ];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id).first()).toBeVisible({ timeout: 20_000 });
        await shot(page, `r126-${name}-${w}-${theme}`);
        await axe(page, `${name} ${w} ${theme}`);
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
  if (await save.isEnabled().catch(() => false)) await save.click();
  await page.waitForTimeout(500);
  await run("forest");
});
