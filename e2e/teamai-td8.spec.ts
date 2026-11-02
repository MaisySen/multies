import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * TD8 Team AI (TEAMAI_TD8=on in the e2e server, AI_FAKE=1 answers the provider locally): the no key and ready states,
 * memory added by an admin and suggested by a member, tabs by keyboard, an instruction set tried, a routine on a new
 * task writing a draft, @assistant answering in a channel thread, the error state with Retry, flag off unchanged, and
 * SHOTS_DIR shots at 1280 and 390 in light, dark and Forest with axe on each.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person;
const FAKE_KEY = ["e2e", "placeholder", "not", "a", "key"].join("-");

async function person(browser: Browser, email: string, name: string): Promise<Person> {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message.slice(0, 300)));
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name, email, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  return { ctx, page, headers };
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

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  const s = Date.now().toString(36);
  owner = await person(browser, `owner-td8-${s}@example.com`, "Olive Owner");
  await owner.page.request.patch("/api/org", { data: { name: "Acme team ai" }, headers: owner.headers });
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email: `member-td8-${s}@example.com`, role: "member" }, headers: owner.headers })).json();
  member = await person(browser, `member-td8-${s}@example.com`, "Max Member");
  await confirmEmail(member.page.request, `member-td8-${s}@example.com`);
  expect((await member.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: member.headers })).status()).toBe(200);
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("no key state, then memory by keyboard, and the ready state once a key is in", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/team-ai");
  await expect(page.getByTestId("teamai-no-key")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Nothing remembered yet")).toBeVisible();
  await page.getByTestId("memory-input").focus();
  await page.keyboard.type("Support hours are 9 to 5, Monday to Friday");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("memory-list")).toContainText("Support hours are 9 to 5");
  await expect(page.getByTestId("memory-list")).toContainText("Added by Olive Owner");
  expect((await page.request.put("/api/ai/key", { data: { provider: "openai", apiKey: FAKE_KEY }, headers: owner.headers })).status()).toBe(200);
  await page.reload();
  await expect(page.getByTestId("teamai-ready")).toBeVisible({ timeout: 20_000 });
  // Tabs move with the arrow keys.
  await page.getByTestId("teamai-tab-memory").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("teamai-tab-instructions")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("teamai-tab-instructions")).toBeFocused();
});

test("instruction set: make, try, and a routine on a new task writes a draft", async () => {
  const page = owner.page;
  await page.goto("/app/settings/team-ai?tab=instructions");
  await page.getByTestId("ins-new").click();
  await page.getByTestId("ins-name").fill("Next steps");
  await page.getByTestId("ins-body").fill("Suggest three next steps for this.");
  await page.getByRole("dialog").getByRole("switch").click();
  await page.getByTestId("ins-save").click();
  await expect(page.getByTestId("ins-list")).toContainText("Next steps");
  await expect(page.getByTestId("ins-list")).toContainText("Shared");
  await page.getByRole("button", { name: "Try it" }).click();
  await expect(page.getByTestId("try-result")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await page.goto("/app/settings/team-ai?tab=routines");
  await page.getByTestId("routine-new").click();
  await page.getByTestId("routine-name").fill("New task ideas");
  await page.getByTestId("routine-ins").selectOption({ label: "Next steps" });
  await page.getByTestId("routine-trigger").selectOption("task_created");
  await page.getByTestId("routine-save").click();
  await expect(page.getByTestId("routine-list")).toContainText("When a task is created");
  const proj = await (await page.request.post("/api/projects", { data: { name: "Launch" }, headers: owner.headers })).json();
  expect((await page.request.post("/api/tasks", { data: { projectId: proj.project.id, title: "Write launch email" }, headers: owner.headers })).status()).toBe(201);
  await page.goto("/app/settings/team-ai?tab=runs");
  await expect(page.getByTestId("run-list")).toContainText("New task ideas", { timeout: 20_000 });
  await expect(page.getByTestId("run-list").getByText("Done").first()).toBeVisible();
  await page.getByText("Show draft").first().click();
  await expect(page.getByRole("button", { name: "Post to a channel" }).first()).toBeVisible();
});

test("@assistant answers in the channel thread; members suggest and cannot manage", async () => {
  const chans = await (await owner.page.request.get("/api/chat/channels")).json();
  const g = chans.channels.find((x: { name: string }) => x.name === "general");
  const posted = await (await member.page.request.post(`/api/chat/channels/${g.id}/messages`, { data: { body: "@assistant when is support open?" }, headers: member.headers })).json();
  await expect.poll(async () => {
    const t = await (await member.page.request.get(`/api/chat/messages/${posted.message.id}/thread`)).json();
    return JSON.stringify(t).includes("\"Assistant\"");
  }, { timeout: 20_000 }).toBe(true);
  const page = member.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/settings/team-ai");
  await expect(page.getByTestId("teamai-ready")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("memory-add")).toHaveText("Suggest");
  await page.getByTestId("memory-input").fill("We close on public holidays");
  await page.getByTestId("memory-add").click();
  await expect(page.getByTestId("memory-list")).toContainText("Suggested");
  await expect(page.getByRole("button", { name: /^Edit note/ })).toHaveCount(0);
  await page.goto("/app/settings/team-ai?tab=routines");
  await expect(page.getByText("Admins set up routines.")).toBeVisible();
  await expect(page.getByTestId("routine-new")).toHaveCount(0);
});

test("error state retries; flag off hides the page and the settings entry", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  let fail = true;
  await page.route("**/api/team-ai/memory", (r) => (fail && r.request().method() === "GET" ? r.fulfill({ status: 500, body: "{}" }) : r.continue()));
  await page.goto("/app/settings/team-ai");
  await expect(page.getByTestId("load-error")).toBeVisible({ timeout: 20_000 });
  fail = false;
  await page.getByTestId("load-error-retry").click();
  await expect(page.getByTestId("memory-list")).toBeVisible();
  await page.unroute("**/api/team-ai/memory");
  await page.route("**/api/config", async (r) => { const res = await r.fetch(); const j = await res.json(); await r.fulfill({ response: res, json: { ...j, teamaiTd8: false } }); });
  await page.goto("/app/settings/team");
  await expect(page.getByRole("link", { name: "Team AI" })).toHaveCount(0);
  await page.goto("/app/settings/team-ai");
  await expect(page.getByText("Team AI is not available yet")).toBeVisible();
  await page.unroute("**/api/config");
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(300_000);
  const page = owner.page;
  const pages: [string, string, string][] = [
    ["memory", "/app/settings/team-ai", "memory-list"], ["instructions", "/app/settings/team-ai?tab=instructions", "ins-list"],
    ["routines", "/app/settings/team-ai?tab=routines", "routine-list"], ["runs", "/app/settings/team-ai?tab=runs", "run-list"],
  ];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id).first()).toBeVisible({ timeout: 20_000 });
        await shot(page, `td8-${name}-${w}-${theme}`);
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
