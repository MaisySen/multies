import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * R116 Translate and read aloud (run with E2E_R116=on: TRANSLATE_R116=on, ASK_TD1 on via E2E_TD1=on, ASK_AI_FAKE=1 so
 * the AI is the local stand in; no provider is called). Translate a mail, a doc selection and a chat message and show
 * the original; read aloud controls appear and stop on navigation; AI switch OFF says so plainly; 375, 390, 430 and
 * 1280 in light, dark and Forest with no sideways scroll, 44 px tap targets and axe 0 serious on the new parts.
 * The device speech engine is replaced by a recorder so the test is the same on every machine.
 */
test.skip(process.env.E2E_R116 !== "on", "R116 runs with E2E_R116=on");
const DIR = process.env.SHOTS_DIR;
test.describe.configure({ mode: "serial" });
let page: Page;
let headers: Record<string, string>;
let mailUrl = "", docId = "", channelId = "";
const CHAT = "Can you send the invoice for this week please";

async function shot(p: Page, name: string) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(p: Page, label: string, ...sel: string[]) {
  let b = new AxeBuilder({ page: p });
  for (const s of sel) b = b.include(s);
  const { violations } = await b.analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function noSideScroll(p: Page, label: string) {
  const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(w.sw, `${label} sideways scroll`).toBeLessThanOrEqual(w.iw + 1);
}
async function tapTargets(p: Page, scope: string, label: string) {
  const small = await p.locator(`${scope} button:visible, ${scope} select:visible`).evaluateAll((els) => els
    .map((e) => { const r = e.getBoundingClientRect(); return { t: (e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; })
    .filter((r) => r.h > 0 && (r.h < 44 || r.w < 44)));
  expect(small, `${label} tap targets`).toEqual([]);
}
const speech = (p: Page) => p.evaluate(() => (window as unknown as { __speech: { spoken: number; cancelled: number; paused: number } }).__speech);

test.beforeAll(async ({ browser }) => {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, extraHTTPHeaders: { "x-forwarded-for": `10.116.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
  await ctx.addInitScript(() => {
    const rec = { spoken: 0, cancelled: 0, paused: 0, lang: "" };
    (window as unknown as { __speech: typeof rec }).__speech = rec;
    const voices = [{ lang: "en-AU", name: "Test English", localService: true, default: true, voiceURI: "en" }, { lang: "hi-IN", name: "Test Hindi", localService: true, default: false, voiceURI: "hi" }];
    class Utterance { text: string; lang = ""; rate = 1; voice: unknown = null; onend: null | (() => void) = null; onerror: null | ((e: { error: string }) => void) = null; constructor(t: string) { this.text = t; } }
    const synth = {
      getVoices: () => voices, speaking: false, paused: false,
      speak(u: Utterance) { rec.spoken++; rec.lang = u.lang; this.speaking = true; },
      cancel() { rec.cancelled++; this.speaking = false; },
      pause() { rec.paused++; this.paused = true; }, resume() { this.paused = false; },
      addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: Utterance, configurable: true });
  });
  page = await ctx.newPage();
  headers = { origin: new URL(base).origin };
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  expect((await (await page.request.get("/api/config")).json()).translateR116).toBe(true);
  const me = await (await page.request.get("/api/account/me")).json();
  // The person's last language choice is kept on this device: Nepali.
  await page.evaluate((id) => localStorage.setItem(`multies.translate.${id}`, JSON.stringify({ target: "ne", autoOffer: true })), me.user.id);
  const doc = await (await page.request.post("/api/docs", { data: { title: "Weekly update", text: "Hello team, the report is ready.\n\nThe invoice is due on Friday." }, headers })).json();
  docId = doc.doc.id;
  const channels = (await (await page.request.get("/api/chat/channels")).json()).channels as { id: string; name: string }[];
  channelId = (channels.find((c) => c.name === "general") ?? channels[0]).id;
  expect((await page.request.post(`/api/chat/channels/${channelId}/messages`, { data: { body: CHAT }, headers })).status()).toBe(201);
});

test("mail: translate keeps the message, Show original, read aloud stops on navigation", async () => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/mail");
  await page.getByTestId("mail-row").first().click();
  const bar = page.getByTestId("mail-lang-r116").last();
  await expect(bar).toBeVisible({ timeout: 15_000 });
  mailUrl = page.url();
  await expect(bar.getByTestId("translate-offer")).toContainText("This looks like English.");
  await bar.getByTestId("translate-mail").click();
  await expect(bar.getByTestId("mail-translated-note")).toContainText("Translated from English into Nepali", { timeout: 15_000 });
  const frame = bar.locator('iframe[title="Message content"]');
  const body = async () => ((await frame.count()) ? await bar.frameLocator('iframe[title="Message content"]').locator("body").innerText() : await bar.innerText());
  await expect.poll(body).toContain("[Nepali]");
  await shot(page, "r116-mail-1280-translated");
  await bar.getByRole("button", { name: "Show original" }).click();
  await expect(bar.getByTestId("mail-translated-note")).toContainText("Showing the original");
  await expect.poll(body).not.toContain("[Nepali]");
  await bar.getByRole("button", { name: "Show translation" }).click();
  await expect.poll(body).toContain("[Nepali]");

  await bar.getByTestId("read-mail").click();
  const reading = bar.getByTestId("read-aloud-bar");
  await expect(reading).toContainText("Reading aloud");
  await expect.poll(async () => (await speech(page)).spoken).toBeGreaterThan(0);
  await reading.getByRole("button", { name: "Pause reading" }).click();
  await expect(reading).toContainText("Paused");
  await reading.getByRole("button", { name: "Resume reading" }).click();
  await expect(reading.getByLabel("Speed")).toBeVisible();
  await axe(page, "mail bar", '[data-testid="mail-lang-r116"]');
  const before = (await speech(page)).cancelled;
  await page.locator('a[href="/app/docs"]').first().click();
  await expect(page).toHaveURL(/\/app\/docs/);
  await expect(page.getByTestId("read-aloud-bar")).toHaveCount(0);
  expect((await speech(page)).cancelled).toBeGreaterThan(before);
});

test("doc: translate the whole doc and a selection side by side, save as a copy, original untouched", async () => {
  test.setTimeout(120_000);
  await page.goto(`/app/docs/${docId}`);
  await page.getByTestId("doc-lang-button").click();
  await page.getByRole("menuitem", { name: "Translate doc" }).click();
  const dlg = page.getByTestId("doc-translate-dialog");
  await expect(dlg.getByTestId("doc-translation")).toContainText("[Nepali] Hello team, the report is ready.", { timeout: 15_000 });
  await expect(dlg.getByTestId("doc-translation")).toContainText("[Nepali] The invoice is due on Friday.");
  await shot(page, "r116-doc-1280-side-by-side");
  await axe(page, "doc dialog", 'dialog[open]');
  await page.keyboard.press("Escape");
  // Select the first paragraph only.
  const first = page.locator(".ProseMirror p").first();
  await first.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.getByTestId("doc-lang-button").click();
  await page.getByRole("menuitem", { name: "Translate selection" }).click();
  await expect(page.locator("dialog[open]").getByText("Translate selection", { exact: true })).toBeVisible();
  await expect(dlg.getByTestId("doc-translation")).toContainText("[Nepali] Hello team, the report is ready.", { timeout: 15_000 });
  await expect(dlg.getByTestId("doc-translation")).not.toContainText("invoice");
  await dlg.page().getByTestId("doc-save-copy").click();
  await expect(page).not.toHaveURL(new RegExp(docId));
  await expect(page).toHaveURL(/\/app\/docs\//);
  const orig = await (await page.request.get(`/api/docs/${docId}`)).json();
  expect(JSON.stringify(orig)).not.toContain("[Nepali]");
});

test("chat: translate a message inline with Show original, read aloud stops on navigation", async () => {
  test.setTimeout(120_000);
  await page.goto(`/app/chat/${channelId}`);
  const msg = page.getByTestId("chat-message").filter({ hasText: CHAT }).last();
  await expect(msg).toBeVisible({ timeout: 15_000 });
  await expect(msg.getByTestId("chat-translate-offer")).toContainText("Translate to Nepali");
  await msg.hover();
  await msg.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Translate" }).click();
  await expect(msg.getByTestId("chat-translation")).toContainText(`[Nepali] ${CHAT}`, { timeout: 15_000 });
  await expect(msg.getByTestId("chat-translated-note")).toContainText("Translated from English into Nepali");
  await msg.getByRole("button", { name: "Show original" }).click();
  await expect(msg.getByTestId("chat-translation")).not.toContainText("[Nepali]");
  await msg.getByRole("button", { name: "Show translation" }).click();
  await shot(page, "r116-chat-1280-translated");
  await msg.hover();
  await msg.getByRole("button", { name: "More message actions" }).click();
  await page.getByRole("menuitem", { name: "Read aloud" }).click();
  await expect(msg.getByTestId("read-aloud-bar")).toContainText("Reading aloud");
  await axe(page, "chat message", '[data-testid="chat-translation"]', '[data-testid="read-aloud-bar"]');
  const before = (await speech(page)).cancelled;
  await page.locator('a[href="/app/docs"]').first().click();
  await expect(page.getByTestId("read-aloud-bar")).toHaveCount(0);
  expect((await speech(page)).cancelled).toBeGreaterThan(before);
});

test("settings row, and AI switch OFF says so plainly with no translation", async () => {
  test.setTimeout(90_000);
  await page.goto("/app/settings");
  const row = page.getByTestId("translate-settings");
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByLabel("Translate into")).toHaveValue("ne");
  await shot(page, "r116-settings-1280");
  await axe(page, "settings row", '[data-testid="translate-settings"]');
  expect((await page.request.put("/api/ai-trust", { data: { enabled: false }, headers })).status()).toBe(200);
  try {
    await page.goto(`/app/docs/${docId}`);
    await page.getByTestId("doc-lang-button").click();
    await page.getByRole("menuitem", { name: "Translate doc" }).click();
    await expect(page.getByTestId("translate-error")).toContainText(/AI is off/i, { timeout: 15_000 });
    await expect(page.getByTestId("translate-error").getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("doc-translation")).not.toContainText("[Nepali]");
    await shot(page, "r116-ai-off-1280");
    await page.keyboard.press("Escape");
  } finally {
    expect((await page.request.put("/api/ai-trust", { data: { enabled: true }, headers })).status()).toBe(200);
  }
});

test("phone and desktop widths, light, dark and Forest", async () => {
  test.setTimeout(300_000);
  const themes: ("light" | "dark" | "forest")[] = ["light", "dark", "forest"];
  for (const theme of themes) {
    if (theme === "forest") {
      await page.emulateMedia({ colorScheme: "light" });
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto("/app/settings/branding");
      await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: "Forest", exact: true }).click();
      const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
      if (await save.count()) await save.first().click();
      await page.waitForTimeout(800);
    } else await page.emulateMedia({ colorScheme: theme });
    for (const width of [375, 390, 430, 1280]) {
      const phone = width < 640;
      await page.setViewportSize({ width, height: phone ? 844 : 860 });
      const tag = `${width}-${theme}`;
      await page.goto(mailUrl);
      const bar = page.getByTestId("mail-lang-r116").last();
      await expect(bar).toBeVisible({ timeout: 15_000 });
      await bar.getByTestId("translate-mail").click();
      await expect(bar.getByTestId("mail-translated-note")).toBeVisible({ timeout: 15_000 });
      await noSideScroll(page, `mail ${tag}`);
      if (phone) await tapTargets(page, '[data-testid="mail-lang-r116"] > div:first-child', `mail ${tag}`);
      await axe(page, `mail ${tag}`, '[data-testid="mail-lang-r116"]');
      await shot(page, `r116-mail-${tag}`);

      await page.goto(`/app/docs/${docId}`);
      const btn = page.getByTestId("doc-lang-button");
      await expect(btn).toBeVisible({ timeout: 15_000 });
      if (phone) { const b = await btn.boundingBox(); expect(b!.height).toBeGreaterThanOrEqual(44); expect(b!.width).toBeGreaterThanOrEqual(44); }
      await btn.click();
      await page.getByRole("menuitem", { name: "Translate doc" }).click();
      await expect(page.getByTestId("doc-translation")).toContainText("[Nepali]", { timeout: 15_000 });
      await noSideScroll(page, `doc ${tag}`);
      await axe(page, `doc ${tag}`, 'dialog[open]');
      await shot(page, `r116-doc-${tag}`);
      await page.keyboard.press("Escape");

      await page.goto(`/app/chat/${channelId}`);
      const msg = page.getByTestId("chat-message").filter({ hasText: CHAT }).last();
      await expect(msg).toBeVisible({ timeout: 15_000 });
      if (phone) {
        await msg.getByTestId("message-more").click();
        const sheet = page.getByTestId("message-action-sheet");
        await expect(sheet.getByRole("button", { name: "Read aloud" })).toBeVisible();
        await sheet.getByRole("button", { name: "Translate" }).click();
      } else {
        await msg.hover();
        await msg.getByRole("button", { name: "More message actions" }).click();
        await page.getByRole("menuitem", { name: "Translate" }).click();
      }
      await expect(msg.getByTestId("chat-translation")).toContainText("[Nepali]", { timeout: 15_000 });
      await noSideScroll(page, `chat ${tag}`);
      await axe(page, `chat ${tag}`, '[data-testid="chat-translation"]');
      await shot(page, `r116-chat-${tag}`);
    }
  }
});
