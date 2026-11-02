import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * TD3 meetings to tasks (MEET_TD3=on in the e2e server, AI_FAKE=1 so the AI provider is a local stand in).
 * Pasted transcript to suggestions with a real quote, accept, undo, discard, bring back, the manual path by keyboard,
 * no key, load error with Retry, slow load skeleton, offline, the follow up email opening in the composer as a draft.
 * SHOTS_DIR: shots at 1280 and 390, light, dark and Forest; axe 0 serious or critical on every state.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.195.${test.info().workerIndex % 200}.${++visitor}`;
const TRANSCRIPT = "Maria: Let's ship the pricing page on Friday. Sam: I will write the launch email by Thursday.";
const FAKE_KEY = ["sk", "e2e", "td3", "fake", "key", "0123456789"].join("-");
const OFF = process.env.MEET_TD3 === "off";
test.beforeEach(({}, info) => { test.skip(OFF !== info.title.startsWith("flag off"), OFF ? "TD3 flows need MEET_TD3 on" : "flag off check runs with MEET_TD3=off"); });

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include("[data-testid^='meeting-suggest']").exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.locator("[data-testid^='meeting-suggest']").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function newMeeting(page: Page, title = "Launch sync") {
  const r = await page.request.post("/api/meetings", { data: { title, startsAt: new Date(Date.now() - 3_600_000).toISOString(), durationMin: 30, invitees: ["guest@example.com"] } });
  expect(r.status(), await r.text()).toBeLessThan(300);
  return (await r.json()).meeting.id as string;
}
async function setKey(page: Page, on: boolean) {
  const r = on ? await page.request.put("/api/ai/key", { data: { provider: "openai", apiKey: FAKE_KEY } }) : await page.request.delete("/api/ai/key");
  expect(r.status(), await r.text()).toBeLessThan(300);
}
async function open(page: Page, id: string) {
  await page.goto(`/app/meetings/${id}`);
  await expect(page.getByTestId("meeting-suggest")).toBeVisible({ timeout: 20_000 });
}
async function pasteAndSuggest(page: Page) {
  await page.getByTestId("meeting-suggest-source").selectOption("pasted");
  await page.getByTestId("meeting-suggest-paste").fill(TRANSCRIPT);
  await page.getByTestId("meeting-suggest-run").click();
  await expect(page.getByTestId("meeting-suggestion")).toHaveCount(1, { timeout: 15_000 });
}

for (const width of [1280, 390]) {
  test(`suggest, accept, undo, discard and bring back at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    await demo(page);
    await setKey(page, true);
    const id = await newMeeting(page);
    await open(page, id);
    await expect(page.getByTestId("meeting-suggest-empty")).toBeVisible();
    await axe(page, `empty ${width}`);
    await pasteAndSuggest(page);
    const s = page.getByTestId("meeting-suggestion");
    await expect(s.getByTestId("meeting-suggestion-quote")).toContainText("I will write the launch email by Thursday.");
    await expect(s).toContainText("Write the launch email");
    await noHScroll(page);
    await axe(page, `suggested ${width}`);
    // Accept: one task; a second click cannot make another (the button is gone and the server claims once).
    await s.getByTestId("meeting-suggestion-accept").click();
    await expect(page.getByTestId("meeting-suggestion-accepted")).toHaveCount(1);
    await expect(page.getByTestId("meeting-suggestion")).toHaveCount(0);
    // Undo takes the task back and reopens the suggestion.
    await page.getByTestId("meeting-suggestion-undo").click();
    await expect(page.getByTestId("meeting-suggestion")).toHaveCount(1);
    await expect(page.getByTestId("meeting-suggestion-accepted")).toHaveCount(0);
    // Discard, then bring it back.
    await page.getByTestId("meeting-suggestion-discard").click();
    await expect(page.getByTestId("meeting-suggest-discarded")).toContainText("1 discarded");
    await page.getByTestId("meeting-suggest-discarded").locator("summary").click();
    await page.getByRole("button", { name: /Bring back/ }).click();
    await expect(page.getByTestId("meeting-suggestion")).toHaveCount(1);
    await noHScroll(page);
  });
}

test("keyboard only: add an action item and accept it, no AI key needed", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await setKey(page, false);
  const id = await newMeeting(page, "Keyboard sync");
  await open(page, id);
  await expect(page.getByTestId("meeting-suggest-ai-note")).toBeVisible();
  await expect(page.getByTestId("meeting-suggest-run")).toBeDisabled();
  await page.getByTestId("meeting-suggest-add").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("meeting-suggest-form-title")).toBeFocused();
  await page.keyboard.type("Send the venue shortlist");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("meeting-suggestion-accepted")).toContainText("Send the venue shortlist");
  // The pasted text can be selected and made into a task too.
  await page.getByTestId("meeting-suggest-source").selectOption("pasted");
  const box = page.getByTestId("meeting-suggest-paste");
  await box.fill(TRANSCRIPT);
  await box.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.indexOf("write"), el.value.indexOf(" by Thursday")); });
  await box.dispatchEvent("mouseup");
  await page.getByTestId("meeting-suggest-from-selection").click();
  await expect(page.getByTestId("meeting-suggest-form-title")).toHaveValue("write the launch email");
  await page.getByTestId("meeting-suggest-form-save").click();
  await expect(page.getByTestId("meeting-suggestion-accepted")).toHaveCount(2);
  await axe(page, "manual");
});

test("load error with Retry, slow load skeleton, offline", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const id = await newMeeting(page, "States sync");
  let fail = true;
  await page.route(`**/api/meeting-td3/${id}`, async (route) => (fail ? route.fulfill({ status: 500, body: "{}" }) : route.continue()));
  await page.goto(`/app/meetings/${id}`);
  await expect(page.getByTestId("meeting-suggest-error")).toBeVisible({ timeout: 20_000 });
  await axe(page, "error");
  await shot(page, "td3-error-1280-light");
  fail = false;
  await page.getByTestId("meeting-suggest-retry").click();
  await expect(page.getByTestId("meeting-suggest")).toBeVisible();
  await page.unroute(`**/api/meeting-td3/${id}`);
  await page.route(`**/api/meeting-td3/${id}`, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
  await page.reload();
  await expect(page.getByTestId("meeting-suggest-loading")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("meeting-suggest")).toBeVisible({ timeout: 20_000 });
  await page.unroute(`**/api/meeting-td3/${id}`);
  await page.context().setOffline(true);
  await expect(page.getByTestId("meeting-suggest-offline")).toBeVisible();
  await expect(page.getByTestId("meeting-suggest-add")).toBeDisabled();
  await page.context().setOffline(false);
  await expect(page.getByTestId("meeting-suggest-offline")).toBeHidden();
});

test("follow up email opens in the composer as a draft, never sent", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const id = await newMeeting(page, "Follow sync");
  await open(page, id);
  await page.getByTestId("meeting-suggest-add").click();
  await page.getByTestId("meeting-suggest-form-title").fill("Share the recap deck");
  await page.getByTestId("meeting-suggest-form-save").click();
  await expect(page.getByTestId("meeting-suggestion-accepted")).toHaveCount(1);
  let sent = 0;
  page.on("request", (r) => { if (r.method() === "POST" && /\/api\/mail\/send|\/api\/mail-schedules\/send/.test(r.url())) sent++; });
  await page.getByTestId("meeting-follow-up").click();
  await expect(page).toHaveURL(/\/app\/mail/, { timeout: 20_000 });
  const subject = page.getByRole("textbox", { name: /subject/i }).first();
  await expect(subject).toHaveValue("Follow up: Follow sync", { timeout: 20_000 });
  await expect(page.getByText("Share the recap deck").first()).toBeAttached();
  await page.waitForTimeout(1500);
  expect(sent).toBe(0);
});

test("shots at 1280 and 390, light, dark and Forest", async ({ page }) => {
  test.setTimeout(180_000);
  await demo(page);
  await setKey(page, true);
  const id = await newMeeting(page, "Shots sync");
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page, id);
  await pasteAndSuggest(page);
  await page.getByTestId("meeting-suggest-add").click();
  await page.getByTestId("meeting-suggest-form-title").fill("Send the venue shortlist");
  await page.getByTestId("meeting-suggest-form-save").click();
  await expect(page.getByTestId("meeting-suggestion-accepted")).toHaveCount(1);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
      await open(page, id);
      await noHScroll(page);
      await axe(page, `${scheme} ${width}`);
      await shot(page, `td3-${width}-${scheme}`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 860 });
    await open(page, id);
    await axe(page, `forest ${width}`);
    await shot(page, `td3-${width}-forest`);
  }
});

test("flag off: no card, and the paths are 404", async ({ page }) => {
  await demo(page);
  const id = await newMeeting(page, "Off sync");
  await page.goto(`/app/meetings/${id}`);
  await expect(page.getByTestId("meeting-notes")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("meeting-suggest")).toHaveCount(0);
  expect((await page.request.get(`/api/meeting-td3/${id}`)).status()).toBe(404);
  expect((await page.request.post(`/api/meeting-td3/${id}/suggestions`, { data: { title: "x", accept: true } })).status()).toBe(404);
});
