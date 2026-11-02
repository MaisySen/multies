import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { confirmEmail } from "./support/confirm-email";

/**
 * TD5 mentions (MENTIONS_TD5=on in the e2e server; E2E_MENTIONS_TD5=off runs the flag off check only): @ picker for
 * records in chat and a task description by keyboard only, chips, the References panel both ways with its loading,
 * empty, error with Retry and offline states, a member reading a private channel mention as "Restricted item", and
 * SHOTS_DIR shots at 1280 and 390 in light, dark and Forest with axe on each.
 */
const OFF = process.env.E2E_MENTIONS_TD5 === "off";
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.198.${test.info().workerIndex % 200}.${++visitor}`;
type Person = { ctx: BrowserContext; page: Page; headers: Record<string, string> };
let owner: Person, member: Person;
let projectId = "", taskId = "", docId = "", emptyDocId = "", generalId = "";

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
  owner = await person(browser, `owner-td5-${s}@example.com`, "Olive Owner");
  const invite = await (await owner.page.request.post("/api/team/invites", { data: { email: `member-td5-${s}@example.com`, role: "member" }, headers: owner.headers })).json();
  member = await person(browser, `member-td5-${s}@example.com`, "Max Member");
  await confirmEmail(member.page.request, `member-td5-${s}@example.com`);
  expect((await member.page.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers: member.headers })).status()).toBe(200);
  const r = owner.page.request;
  projectId = (await (await r.post("/api/projects", { data: { name: "Orbit" }, headers: owner.headers })).json()).project.id;
  taskId = (await (await r.post("/api/tasks", { data: { projectId, title: "Ship orbit launch" }, headers: owner.headers })).json()).task.id;
  docId = (await (await r.post("/api/docs", { data: { title: "Orbit launch plan", text: "plan" }, headers: owner.headers })).json()).doc.id;
  emptyDocId = (await (await r.post("/api/docs", { data: { title: "Quiet page", text: "nothing" }, headers: owner.headers })).json()).doc.id;
  generalId = (await (await r.get("/api/chat/channels")).json()).channels.find((x: { name: string }) => x.name === "general").id;
});
test.afterAll(async () => { await owner?.ctx.close(); await member?.ctx.close(); });

test("flag off: no mention paths, no panel, chat picker as today", async () => {
  test.skip(!OFF, "flag on run");
  const page = owner.page;
  expect((await page.request.get("/api/mentions/search?q=orbit")).status()).toBe(404);
  await page.goto(`/app/docs/${docId}`);
  await expect(page.getByText("Orbit launch plan").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("references-panel")).toHaveCount(0);
  await page.goto(`/app/chat/${generalId}`);
  await page.getByTestId("chat-composer").fill("@orb");
  await expect(page.getByTestId("mention-picker-td5")).toHaveCount(0);
});

test("chat: @ picks a record by keyboard, the card shows, the doc lists the message", async () => {
  test.skip(OFF, "flag off run");
  const page = owner.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/app/chat/${generalId}`);
  const box = page.getByTestId("chat-composer");
  await box.click();
  await box.pressSequentially("Read @orbit l");
  const picker = page.getByTestId("mention-picker-td5");
  await expect(picker.getByRole("option", { name: /Orbit launch plan/ })).toBeVisible();
  await shot(page, "td5-chat-picker-1280-light");
  await axe(page, "chat picker");
  // Arrow to the doc, Enter picks it (and does not send).
  for (let i = 0; i < 6; i++) {
    if (await picker.getByRole("option", { name: /Orbit launch plan/ }).getAttribute("aria-selected") === "true") break;
    await box.press("ArrowDown");
  }
  await box.press("Enter");
  await expect(box).toHaveValue(/@\[Orbit launch plan\] $/);
  await box.press("Escape");
  await box.press("Enter");
  await expect(page.getByTestId("chat-link").filter({ hasText: "Orbit launch plan" }).first()).toBeVisible();
  await page.goto(`/app/docs/${docId}`);
  const panel = page.getByTestId("references-panel");
  await expect(panel.getByTestId("refs-in")).toContainText("#general");
  await shot(page, "td5-doc-refs-1280-light");
});

test("task description: @ by keyboard, chip in view, References both ways, Escape closes", async () => {
  test.skip(OFF, "flag off run");
  const page = owner.page;
  await page.goto(`/app/tasks?project=${projectId}&task=${taskId}`);
  await page.getByTestId("edit-description").first().click();
  const ta = page.locator("textarea:focus");
  await ta.pressSequentially("See @orbit");
  await expect(page.getByTestId("mention-picker-td5")).toBeVisible();
  await ta.press("Escape");
  await expect(page.getByTestId("mention-picker-td5")).toHaveCount(0);
  await ta.pressSequentially(" l");
  await expect(page.getByTestId("mention-picker-td5").getByRole("option", { name: /Orbit launch plan/ })).toBeVisible();
  for (let i = 0; i < 6; i++) {
    if (await page.getByTestId("mention-picker-td5").getByRole("option", { name: /Orbit launch plan/ }).getAttribute("aria-selected") === "true") break;
    await ta.press("ArrowDown");
  }
  await ta.press("Enter");
  await expect(ta).toHaveValue(/@\[Orbit launch plan\]/);
  await page.keyboard.press("Tab");
  await page.getByRole("heading", { name: "References" }).first().click();
  await expect(page.locator("a.ref-chip", { hasText: "Orbit launch plan" }).first()).toBeVisible();
  await expect(page.getByTestId("references-panel").first().getByTestId("refs-out")).toContainText("Orbit launch plan");
  await page.goto(`/app/docs/${docId}`);
  await expect(page.getByTestId("references-panel").getByTestId("refs-in")).toContainText("Ship orbit launch");
});

test("member reads a private channel mention as Restricted item; panel states", async () => {
  test.skip(OFF, "flag off run");
  const priv = (await (await owner.page.request.post("/api/chat/channels", { data: { name: "board-room", private: true }, headers: owner.headers })).json()).channel.id;
  await owner.page.request.post(`/api/chat/channels/${priv}/messages`, { data: { body: `numbers for <#task:${taskId}>` }, headers: owner.headers });
  const page = member.page;
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/app/tasks?project=${projectId}&task=${taskId}`);
  const inList = page.getByTestId("references-panel").first().getByTestId("refs-in");
  await expect(inList).toContainText("Restricted item");
  await expect(inList).not.toContainText("board-room");
  // Empty state.
  await page.goto(`/app/docs/${emptyDocId}`);
  await expect(page.getByTestId("refs-in-empty")).toBeVisible();
  // Loading then error with Retry.
  let fail = true;
  await page.route("**/api/mentions/refs/**", async (route) => { if (fail) { await new Promise((r) => setTimeout(r, 600)); await route.fulfill({ status: 500, body: "{}" }); } else await route.continue(); });
  await page.reload();
  await expect(page.getByTestId("refs-in-loading")).toBeVisible();
  await expect(page.getByTestId("refs-in-error")).toBeVisible({ timeout: 15_000 });
  await shot(page, "td5-refs-error-1280-light");
  fail = false;
  await page.getByTestId("refs-in-error").getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("refs-in-empty")).toBeVisible();
  await page.unroute("**/api/mentions/refs/**");
  // Offline.
  await member.ctx.setOffline(true);
  await expect(page.getByTestId("refs-in-offline")).toBeVisible();
  await shot(page, "td5-refs-offline-1280-light");
  await member.ctx.setOffline(false);
  await expect(page.getByTestId("refs-in-offline")).toHaveCount(0);
  // A made up id from another workspace: 404, and resolve says deleted.
  expect((await page.request.get("/api/mentions/refs/doc/doc_not_here")).status()).toBe(404);
});

test("shots and axe at 1280 and 390, light, dark and Forest", async () => {
  test.skip(OFF, "flag off run");
  test.setTimeout(300_000);
  const page = owner.page;
  const pages: [string, string, string][] = [["doc", `/app/docs/${docId}`, "refs-in"], ["task", `/app/tasks?project=${projectId}&task=${taskId}`, "refs-out"], ["chat", `/app/chat/${generalId}`, "chat-link"]];
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const [name, url, id] of pages) {
        await page.goto(url);
        await expect(page.getByTestId(id).first()).toBeVisible({ timeout: 20_000 });
        if (name !== "chat") await page.getByTestId(id).first().scrollIntoViewIfNeeded();
        await shot(page, `td5-${name}-${w}-${theme}`);
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
