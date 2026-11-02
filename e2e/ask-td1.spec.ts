import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * TD1 Ask v2 (run with E2E_TD1=on: ASK_TD1 on, ASK_AI_FAKE=1 so the AI is a local stand in). AI on by default; an
 * admin turns it off (admin switch, member read only, Ask says so, no provider call) and back on; Ask about this from a task, a doc and a meeting; coverage
 * line; a cited source shown as gone once deleted; Ctrl K matches by meaning; error with Retry and offline.
 * SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest, with axe on each.
 */
test.skip(!process.env.E2E_TD1 || process.env.E2E_TD1 === "off", "TD1 runs with E2E_TD1=on");
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person;
let task = { id: "", ref: "" }, docId = "";

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

test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }) => {
  const tag = Math.random().toString(36).slice(2, 8);
  owner = await person(browser, `tia-${tag}@example.com`, "Tia Owner");
  member = await join(browser, `mo-${tag}@example.com`, "Mo Mate", "member");
  const post = (path: string, data: unknown) => owner.page.request.post(path, { data, headers: owner.headers }).then((r) => r.json());
  const t = (await post("/api/tasks", { title: "Kestrel launch checklist", notes: "launch is on Friday the 14th" })).task;
  task = { id: t.id, ref: t.ref };
  docId = (await post("/api/docs", { title: "Kestrel press brief", text: "the kestrel press kit goes out Monday" })).doc.id;
  await post("/api/tasks", { title: "Kestrel invoice to send" });
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("AI is on by default; an admin turns it off, the member sees it read only, and Ask says so", async () => {
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings#ai-trust");
  await expect(page.getByTestId("ai-trust-status")).toContainText("AI is on", { timeout: 20_000 });
  await expect(page.getByTestId("ai-trust-default")).toBeVisible();
  await member.page.goto("/app/settings#ai-trust");
  await expect(member.page.getByTestId("ai-trust-status")).toContainText("AI is on", { timeout: 20_000 });
  await expect(member.page.getByTestId("ai-trust-member")).toBeVisible();
  await expect(member.page.getByTestId("ai-trust-switch")).toHaveCount(0);
  expect((await member.page.request.put("/api/ai-trust", { data: { enabled: false }, headers: member.headers })).status()).toBe(403);
  await page.getByRole("switch", { name: "Allow AI in this workspace" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("ai-trust-status")).toContainText("AI is off");
  await page.goto("/app/tools/ask");
  await expect(page.getByTestId("ask-ai-off")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ask-ai-off-settings")).toBeVisible();
  await shot(page, "td1-ai-off-1280-light");
  await axe(page, "ai off");
  await member.page.goto("/app/tools/ask");
  await expect(member.page.getByTestId("ask-ai-off")).toContainText("Ask an admin", { timeout: 20_000 });
  await expect(member.page.getByTestId("ask-ai-off-settings")).toHaveCount(0);
  expect((await member.page.request.post("/api/ask", { data: { question: "kestrel launch" }, headers: member.headers })).status()).toBe(409);
});

test("Settings: only an admin switches AI back on; everyone sees the provider and where it runs", async () => {
  await member.page.goto("/app/settings#ai-trust");
  await expect(member.page.getByTestId("ai-trust-status")).toContainText("AI is off", { timeout: 20_000 });
  await expect(member.page.getByTestId("ai-trust-switch")).toHaveCount(0);
  const page = owner.page;
  await page.goto("/app/settings#ai-trust");
  await expect(page.getByTestId("ai-trust-status")).toContainText("AI is off", { timeout: 20_000 });
  await page.getByRole("switch", { name: "Allow AI in this workspace" }).focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("ai-trust-status")).toContainText("AI is on");
  await expect(page.getByTestId("ai-trust-providers")).toContainText("outside Australia");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 }); // the toast fades first
  await axe(page, "settings trust");
  await member.page.reload();
  await expect(member.page.getByTestId("ai-trust-status")).toContainText("AI is on", { timeout: 20_000 });
});

test("Ask about this from a task page: scoped, cited, says what it read", async () => {
  const page = owner.page;
  await page.goto(`/app/tasks/${task.ref}`);
  const btn = page.getByTestId("ask-about-this").first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/about=tasks/);
  await expect(page.getByTestId("ask-about")).toContainText("Kestrel launch checklist", { timeout: 20_000 });
  await page.getByTestId("ask-box").fill("when is the launch");
  await page.getByTestId("ask-box").press("Enter");
  const answer = page.getByTestId("ask-answer").last();
  await expect(answer).toBeVisible({ timeout: 20_000 });
  await expect(answer.getByTestId("ask-about-line")).toContainText("Kestrel launch checklist");
  await expect(answer.getByTestId("ask-coverage")).toContainText("Items you cannot open");
  await expect(answer.getByTestId("ask-cite").first()).toBeVisible();
  await axe(page, "about answer");
});

test("Ask about this from a doc; once the doc is deleted the source shows as gone and is never opened", async () => {
  const page = owner.page;
  await page.goto(`/app/docs/${docId}`);
  await page.getByTestId("ask-about-this").first().click({ timeout: 20_000 });
  await page.getByTestId("ask-box").fill("what goes out monday");
  await page.getByTestId("ask-box").press("Enter");
  await expect(page.getByTestId("ask-answer").last()).toHaveAttribute("data-status", "answered", { timeout: 20_000 });
  const url = page.url();
  expect((await page.request.delete(`/api/docs/${docId}`, { headers: owner.headers })).status()).toBeLessThan(300);
  await page.goto(url);
  await expect(page.getByTestId("ask-gone").last()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("ask-answer").last()).toHaveAttribute("data-status", "restricted");
  await expect(page.getByTestId("ask-thread")).not.toContainText("press kit goes out");
});

test("Ctrl K shows matches by meaning that word search misses", async () => {
  const page = owner.page;
  await page.goto("/app/tools/ask");
  await expect(page.getByTestId("ask-box")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").first().fill("unpaid bill");
  await expect(page.getByTestId("palette-meaning")).toContainText("Kestrel invoice to send", { timeout: 20_000 });
  await page.keyboard.press("Escape");
});

test("a failed load shows Retry; offline the question waits and is answered once back online", async () => {
  const page = owner.page;
  await page.route("**/api/ai-trust", (r) => r.abort());
  await page.goto("/app/settings#ai-trust");
  await expect(page.getByTestId("ai-trust").getByRole("button", { name: /retry|try again/i })).toBeVisible({ timeout: 20_000 });
  await page.unroute("**/api/ai-trust");
  await page.goto("/app/tools/ask");
  await expect(page.getByTestId("ask-box")).toBeVisible({ timeout: 20_000 });
  await page.context().setOffline(true);
  await page.getByTestId("ask-box").fill("kestrel launch");
  await page.getByTestId("ask-submit").click();
  // Offline: the app says so and the question waits; back online it is answered.
  await expect(page.getByRole("status").filter({ hasText: "You are offline" })).toBeVisible({ timeout: 20_000 });
  await page.context().setOffline(false);
  await expect(page.getByTestId("ask-answer").last()).toBeVisible({ timeout: 20_000 });
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.setTimeout(240_000);
  const page = owner.page;
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/settings#ai-trust");
      await expect(page.getByTestId("ai-trust-providers")).toBeVisible({ timeout: 20_000 });
      await page.getByTestId("ai-trust").scrollIntoViewIfNeeded();
      await shot(page, `td1-settings-${w}-${theme}`);
      await axe(page, `settings ${w} ${theme}`);
      await page.goto(`/app/tools/ask?about=tasks:${task.id}&title=Kestrel%20launch%20checklist`);
      await expect(page.getByTestId("ask-about")).toBeVisible({ timeout: 20_000 });
      await shot(page, `td1-about-${w}-${theme}`);
      await axe(page, `about ${w} ${theme}`);
      await page.goto(`/app/tasks/${task.ref}`);
      await expect(page.getByTestId("ask-about-this").first()).toBeVisible({ timeout: 20_000 });
      await shot(page, `td1-task-${w}-${theme}`);
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
