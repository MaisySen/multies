/**
 * AI2 (AI_CONNECT_AI2=on in the e2e server, E2E_AI2=off for the old screen): Settings, AI. Paste a key once and the
 * provider is detected, pick a model from the live list (mocked providers, AI_FAKE), Test connection success and
 * failure, the curated fallback, the one tap OpenRouter sign in with a good and a bad state, axe at 1280 light and
 * 390 dark. No real provider is called: the local stand ins answer (src/server/services/ai/fake-fetch.ts).
 */
import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const AI2_ON = process.env.E2E_AI2 !== "off";
let visitor = 0;
const ip = () => `10.241.${test.info().workerIndex % 200}.${++visitor}`;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
async function signUp(browser: Browser, width = 1280, height = 900) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Olive Owner", email: `owner-${uniq()}@acme.io`, password: "a-strong-password" }, headers })).status()).toBe(200);
  expect((await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers })).status()).toBe(200);
  await page.setViewportSize({ width, height });
  return page;
}
const SHOTS = process.env.AI2_SHOTS || "";
/** The AI section itself (Settings scrolls inside the app shell, so a page shot would show the top of Settings). */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  const vp = page.viewportSize()!;
  await page.setViewportSize({ width: vp.width, height: 2600 });
  await page.locator("#ai").screenshot({ path: `${SHOTS}/${name}.png` });
  await page.setViewportSize(vp);
}
async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).include("#ai").analyze();
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}
const KEY = (tag = "") => `sk-ant-api03-e2e${tag}${"k".repeat(36)}WXYZ`;
async function openAi(page: Page, path = "/app/settings") {
  await page.goto(`${path}#ai`);
  await expect(page.getByTestId("ai2-panel")).toBeVisible({ timeout: 20_000 });
}
async function connect(page: Page, key: string) {
  await page.getByTestId("ai2-key").fill(key);
  await page.getByTestId("ai2-connect-submit").click();
}

test.describe("AI2 connect AI", () => {
  test.skip(!AI2_ON, "flag off run");

  test("paste a key, detect the provider, pick a model, test it, axe at 1280 light", async ({ browser }) => {
    const page = await signUp(browser);
    await page.emulateMedia({ colorScheme: "light" });
    await openAi(page);
    await expect(page.getByTestId("ai2-builtin")).toContainText("Built-in AI");
    await shot(page, "ai2-1280-light-empty");
    expect(await axe(page)).toEqual([]);
    await page.getByTestId("ai2-key").fill(`  ${KEY()}  `);
    await expect(page.getByTestId("ai2-detected")).toHaveText("Looks like Anthropic key.");
    await expect(page.getByTestId("ai2-card-anthropic")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("ai2-connect-submit").click();
    await expect(page.getByTestId("ai2-connected")).toContainText("Anthropic, key ending WXYZ");
    const select = page.getByTestId("ai2-model-select");
    await expect(select).toHaveValue("claude-haiku-5-5");
    await expect(select.locator("optgroup[label='Recommended'] option")).toHaveText("Claude Haiku 5.5, recommended for inbox");
    await page.getByTestId("ai2-model-search").fill("sonnet");
    await select.selectOption("claude-sonnet-5-5");
    await expect(page.getByText("Model saved")).toBeVisible();
    await page.getByTestId("ai2-model-search").fill("");
    await page.getByTestId("ai2-test").click();
    await expect(page.getByTestId("ai2-test-result")).toContainText(/Connected\. Replies in (under 0\.1|\d+\.\d) s/);
    await shot(page, "ai2-1280-light-connected");
    expect(await axe(page)).toEqual([]);
    // One brand theme (Forest): shot and axe.
    await page.goto("/app/settings/branding");
    await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Forest", exact: true }).click();
    const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
    if (await save.count()) await save.first().click();
    await page.waitForTimeout(800);
    await openAi(page);
    await shot(page, "ai2-1280-forest-connected");
    expect(await axe(page)).toEqual([]);
    // The key never comes back to the browser.
    expect(JSON.stringify(await (await page.request.get("/api/ai/status")).json())).not.toContain(KEY());
  });

  test("a refused key, a typed model when the live list fails, and a model the key cannot use", async ({ browser }) => {
    const page = await signUp(browser);
    await openAi(page);
    await connect(page, KEY("FAKEBAD"));
    await expect(page.getByRole("alert")).toHaveText("That key was refused. Check it and paste it again.");
    // Live list fails: Connect asks for a model id and proves it before saving.
    await page.getByTestId("ai2-key").fill(KEY("FAKELISTFAIL"));
    await page.getByTestId("ai2-connect-model").fill("claude-haiku-5-5");
    await page.getByTestId("ai2-connect-submit").click();
    await expect(page.getByTestId("ai2-connected")).toBeVisible();
    await expect(page.getByTestId("ai2-fallback")).toHaveText("Could not load the live list, showing common models.");
    await page.getByText("Advanced: type a model id").click();
    await page.getByTestId("ai2-model-typed").fill("missing-model");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByTestId("ai2-model-select")).toHaveValue("missing-model");
    await page.getByTestId("ai2-test").click();
    await expect(page.getByTestId("ai2-test-result")).toHaveText("That model is not available on your key.");
  });

  test("one tap OpenRouter: good state connects, a bad state is refused", async ({ browser }) => {
    const page = await signUp(browser);
    await openAi(page);
    await page.goto("/api/ai/oauth/openrouter/callback?code=mock-code&state=made-up-state-0123456789");
    await expect(page.getByTestId("ai2-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/expired or was started somewhere else/)).toBeVisible();
    await expect(page).not.toHaveURL(/ai_error/);
    expect((await (await page.request.get("/api/ai/status")).json()).connected).toBe(false);
    await page.getByTestId("ai2-openrouter").click();
    await expect(page.getByText("Connected to OpenRouter")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("ai2-connected")).toContainText("OpenRouter");
    await expect(page.getByTestId("ai2-model-select")).toHaveValue("anthropic/claude-haiku-5.5");
  });

  test("phone width, dark: fits, no sideways scroll, axe clean", async ({ browser }) => {
    const page = await signUp(browser, 390, 844);
    await page.emulateMedia({ colorScheme: "dark" });
    await openAi(page, "/app/settings/general");
    await shot(page, "ai2-390-dark-empty");
    expect(await axe(page)).toEqual([]);
    await connect(page, KEY());
    await expect(page.getByTestId("ai2-connected")).toBeVisible();
    await shot(page, "ai2-390-dark-connected");
    expect(await axe(page)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("AI switch off: the AI card says AI is off at once and built in AI is not in use, then on again (MB-330)", async ({ browser }) => {
    test.skip(process.env.E2E_TD1 !== "on", "needs the workspace AI switch (run with E2E_TD1=on)");
    const page = await signUp(browser, 1280, 900);
    await openAi(page, "/app/settings/general");
    await expect(page.getByTestId("ai2-off")).toHaveCount(0);
    const sw = page.getByRole("switch", { name: "Allow AI in this workspace" });
    await sw.click();
    await expect(page.getByTestId("ai2-off")).toBeVisible();
    await expect(page.getByTestId("ai2-off")).toContainText("AI is off");
    await expect(page.locator("#ai")).not.toContainText("work right away");
    const st = await (await page.request.get("/api/ai/status")).json();
    expect(st.builtin).toMatchObject({ off: true, active: false });
    await page.reload();
    await expect(page.getByTestId("ai2-off")).toBeVisible({ timeout: 20_000 });
    expect(await axe(page)).toEqual([]);
    await page.getByRole("switch", { name: "Allow AI in this workspace" }).click();
    await expect(page.getByTestId("ai2-off")).toHaveCount(0);
    await expect(page.getByTestId("ai2-panel")).toBeVisible();
    expect((await (await page.request.get("/api/ai/status")).json()).builtin).toMatchObject({ off: false });
  });
});

test.describe("AI2 flag off", () => {
  test.skip(AI2_ON, "runs with E2E_AI2=off");
  test("shows today's screen", async ({ browser }) => {
    const page = await signUp(browser);
    await page.goto("/app/settings#ai");
    await expect(page.getByLabel("Provider")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Save key" })).toBeVisible();
    await expect(page.getByTestId("ai2-panel")).toHaveCount(0);
    expect((await page.request.post("/api/ai/models", { data: {}, headers: { origin: new URL(test.info().project.use.baseURL!).origin } })).status()).toBe(404);
  });
});
