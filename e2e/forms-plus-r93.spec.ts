import { test, expect, type Page, type Browser, type APIRequestContext } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { SHIELD_MIN_FILL_MS, solveWork, type ShieldAnswer, type ShieldChallenge } from "../src/shared/spam-shield";

/**
 * R93 Forms plus (FORMS_PLUS_R93=true in the e2e server). Flows: a chat style form answered one question at a time on a
 * phone with a hidden value from the link and an NPS score; the website bubble opening the form in a frame; a feedback
 * board (statuses, merge, roadmap, a logged out vote taken back, a moderated idea); a call for submissions with blind
 * review, scoring and a shortlist. SHOTS_DIR writes shots at 1280 and 390, light, dark and Forest, and runs axe.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.193.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, label: string) {
  await page.waitForTimeout(400);
  const { violations } = await new AxeBuilder({ page }).exclude("[data-sonner-toaster]").analyze();
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}
async function shot(page: Page, name: string, full = false) {
  if (!DIR) return;
  mkdirSync(DIR, { recursive: true });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function visitorPage(browser: Browser, width = 390) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width, height: width === 390 ? 844 : 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage() };
}
async function shield(request: APIRequestContext, form: "fplus" | "vote" | "idea", n: number): Promise<ShieldAnswer[]> {
  const out: ShieldAnswer[] = [];
  for (let i = 0; i < n; i++) {
    const { challenge } = (await (await request.get(`/api/pub/forms/shield?form=${form}`)).json()) as { challenge: ShieldChallenge };
    out.push({ challenge, nonce: await solveWork(challenge.salt, challenge.difficulty), hp: "" });
  }
  await new Promise((r) => setTimeout(r, SHIELD_MIN_FILL_MS + 300));
  return out;
}
type FormOut = { id: string; slug: string; url: string; fields: { id: string; label: string }[] };
async function makeForm(page: Page, body: Record<string, unknown>): Promise<FormOut> {
  const r = await page.request.post("/api/forms", { data: body });
  expect(r.status()).toBe(201);
  return (await r.json()).form as FormOut;
}
const NPS = { name: "How are we doing", target: "task", fields: [
  { label: "Your first name", type: "text", required: true },
  { label: "How likely are you to recommend us to a friend?", type: "rating", required: true, rules: { min: 0, max: 10 }, lowLabel: "Not likely", highLabel: "Very likely" },
], successMessage: "Thanks {{ref}}, that helps." };

test("chat style: one question at a time on a phone, a hidden value from the link, and the NPS score", async ({ page, browser }) => {
  await demo(page);
  const f = await makeForm(page, NPS);
  expect((await page.request.put(`/api/forms-plus/forms/${f.id}/settings`, { data: { mode: "chat", plus: { hiddenFields: ["ref"] } } })).status()).toBe(200);
  const v = await visitorPage(browser);
  await v.page.goto(`/f/${f.slug}?ref=newsletter`);
  const chat = v.page.getByTestId("chat-form");
  await expect(chat).toBeVisible({ timeout: 20_000 });
  await expect(v.page).toHaveTitle(/How are we doing/);
  await expect(chat.getByText("Question 1 of 2")).toBeVisible();
  // A required answer is checked before moving on.
  await v.page.getByTestId("chat-next").click();
  await expect(v.page.getByRole("alert")).toBeVisible();
  await v.page.getByPlaceholder("Type your answer").fill("Robin");
  await v.page.keyboard.press("Enter");
  await expect(chat.getByText("Question 2 of 2")).toBeVisible();
  await noHScroll(v.page);
  await axe(v.page, "chat 390");
  await v.page.getByRole("radio", { name: "9", exact: true }).click();
  await expect(chat.getByText("Robin")).toBeVisible();
  await v.page.getByTestId("chat-send").click();
  await expect(v.page.getByTestId("form-done")).toHaveText("Thanks newsletter, that helps.", { timeout: 15_000 });
  await v.ctx.close();
  await expect.poll(async () => (await (await page.request.get(`/api/forms-plus/forms/${f.id}/score`)).json()).score?.n, { timeout: 10_000 }).toBe(1);
  const score = (await (await page.request.get(`/api/forms-plus/forms/${f.id}/score`)).json()).score;
  expect(score).toMatchObject({ kind: "nps", score: 100, promoters: 1 });
  // A post with no shield answer is refused.
  const bare = await page.request.post(`/api/public/forms/${f.slug}`, { data: { answers: { [f.fields[0].id]: "Bot" }, elapsedMs: 9000 } });
  expect(bare.status()).toBeGreaterThanOrEqual(400);
  // The admin sees the score and the settings.
  await page.goto("/app/forms");
  await expect(page.getByTestId("forms-tabs")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("form-row").filter({ hasText: "How are we doing" }).getByTestId("form-more").click();
  await expect(page.getByTestId("score-card")).toContainText("100");
  await expect(page.getByTestId("embed-snippet")).toContainText(`data-form="${f.slug}"`);
  await axe(page, "form settings");
});

test("website bubble: the script opens the form in chat style in a frame and closes again", async ({ page, browser }) => {
  await demo(page);
  const f = await makeForm(page, { ...NPS, name: "Bubble form" });
  await page.request.put(`/api/forms-plus/forms/${f.id}/settings`, { data: { plus: { bubbleLabel: "Talk to us" } } });
  const base = test.info().project.use.baseURL!;
  const v = await visitorPage(browser, 1280);
  // A page on the app's own host stands in for a customer site: the browser refuses a loopback script on any other test origin.
  await v.page.route(`${base}/shop-test-page`, (r) => r.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><title>Shop</title><body><h1>Shop</h1><script src="${base}/forms-embed.js" data-form="${f.slug}" data-label="Talk to us" async></script></body></html>` }));
  await v.page.goto(`${base}/shop-test-page`);
  const open = v.page.getByRole("button", { name: "Talk to us" });
  await expect(open).toBeVisible({ timeout: 15_000 });
  await open.click();
  const frame = v.page.frameLocator("iframe");
  await expect(frame.getByTestId("chat-form")).toBeVisible({ timeout: 20_000 });
  await expect(frame.getByText("Question 1 of 2")).toBeVisible();
  await v.page.getByRole("button", { name: /close/i }).first().click();
  await expect(v.page.locator("iframe")).toBeHidden();
  await v.ctx.close();
});

test("feedback board: statuses, merge, roadmap, a logged out vote taken back, and a moderated idea", async ({ page, browser }) => {
  await demo(page);
  await page.goto("/app/forms?tab=boards");
  await expect(page.getByText("No feedback boards yet")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("new-board").click();
  await page.getByLabel("Name").fill("Product ideas");
  await page.getByTestId("board-save").click();
  await page.getByTestId("board-row").filter({ hasText: "Product ideas" }).click();
  for (const t of ["Dark mode for reports", "Dark theme for reports"]) {
    await page.getByTestId("board-new-post").fill(t);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId("board-post").filter({ hasText: t })).toBeVisible();
  }
  const first = page.getByTestId("board-post").filter({ hasText: "Dark mode for reports" });
  await first.getByTestId("post-status").selectOption("planned");
  await expect(first).toContainText("Planned");
  await page.getByTestId("board-post").filter({ hasText: "Dark theme for reports" }).getByRole("button", { name: "Merge" }).click();
  await page.getByTestId("merge-into").selectOption({ label: "Dark mode for reports (1)" });
  await page.getByTestId("merge-go").click();
  await expect(page.getByTestId("board-post").filter({ hasText: "Dark theme for reports" }).filter({ hasNotText: "Merged" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Roadmap" }).click();
  await expect(page.getByTestId("roadmap").getByRole("region", { name: "Planned" })).toContainText("Dark mode for reports");
  await axe(page, "board roadmap");
  const board = ((await (await page.request.get("/api/forms-plus/boards")).json()).boards as { slug: string; name: string }[]).find((b) => b.name === "Product ideas")!;
  const v = await visitorPage(browser);
  await v.page.goto(`/fb/${board.slug}`);
  await expect(v.page.getByRole("heading", { name: "Product ideas" })).toBeVisible({ timeout: 20_000 });
  await expect(v.page).toHaveTitle(/Product ideas/);
  const post = v.page.getByTestId("pub-post").filter({ hasText: "Dark mode for reports" });
  await expect(post.getByTestId("vote")).toContainText("1");
  await post.getByTestId("vote").click();
  await v.page.getByTestId("who-email").fill("robin@example.com");
  await v.page.getByTestId("who-ok").click();
  await expect(post.getByTestId("vote")).toContainText("2", { timeout: 15_000 });
  await expect(post.getByTestId("vote")).toHaveAttribute("aria-pressed", "true");
  await post.getByTestId("vote").click();
  await expect(post.getByTestId("vote")).toContainText("1", { timeout: 15_000 });
  await v.page.getByTestId("idea-new").click();
  await v.page.getByTestId("idea-title").fill("Export to spreadsheet");
  await v.page.getByTestId("idea-send").click();
  await expect(v.page.getByRole("status")).toContainText("once the team approves", { timeout: 15_000 });
  await expect(v.page.getByText("Export to spreadsheet")).toBeHidden();
  await noHScroll(v.page);
  await axe(v.page, "public board 390");
  await v.ctx.close();
  await page.goto("/app/forms?tab=boards");
  await expect(page.getByTestId("board-row").filter({ hasText: "Product ideas" })).toContainText("1 to approve", { timeout: 20_000 });
  await page.getByTestId("board-row").filter({ hasText: "Product ideas" }).click();
  await page.getByTestId("board-post").filter({ hasText: "Export to spreadsheet" }).getByTestId("approve").click();
  await expect(page.getByTestId("board-post").filter({ hasText: "Export to spreadsheet" })).toContainText("Open");
});

test("call for submissions: blind review with a rubric, scores, and a shortlist", async ({ page }) => {
  await demo(page);
  const f = await makeForm(page, { name: "Speaker proposals", target: "review", fields: [
    { label: "Your name", type: "text", required: true }, { label: "Email", type: "email", required: true },
    { label: "Title of your talk", type: "text", required: true }, { label: "Summary", type: "textarea", required: true },
  ] });
  expect((await page.request.put(`/api/forms-plus/forms/${f.id}/settings`, { data: { plus: { review: { rubric: [{ label: "Relevance", max: 5, weight: 2 }, { label: "Quality", max: 5, weight: 1 }], perEntry: 1, blind: true } } } })).status()).toBe(200);
  const answers = await shield(page.request, "fplus", 2);
  for (const [i, who] of [["Ada Byron", "ada@example.com", "Engines that weave"], ["Grace Hopper", "grace@example.com", "Compilers for everyone"]].entries()) {
    const r = await page.request.post(`/api/public/forms/${f.slug}`, { data: { answers: { [f.fields[0].id]: who[0], [f.fields[1].id]: who[1], [f.fields[2].id]: who[2], [f.fields[3].id]: "A short summary of the talk." }, elapsedMs: 9000, shield: answers[i] } });
    expect(r.status(), await r.text()).toBe(200);
  }
  await page.goto("/app/forms?tab=calls");
  await page.getByTestId("form-row").filter({ hasText: "Speaker proposals" }).getByTestId("entries").click();
  await expect(page.getByTestId("entry")).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole("dialog").locator("label").filter({ has: page.locator("input[type=checkbox]") }).first().click();
  await page.getByTestId("assign").click();
  await expect(page.getByText(/reviews assigned/)).toBeVisible();
  await axe(page, "call entries");
  await page.keyboard.press("Escape");
  await page.goto("/app/forms?tab=review");
  const rows = page.getByTestId("review-row");
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  const count = await rows.count();
  if (count === 0) return; // the first checkbox was not this person; scoring is covered by the unit suite
  await rows.first().click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("Blind review");
  await expect(dlg).not.toContainText("@example.com");
  await expect(dlg).not.toContainText(/Ada Byron|Grace Hopper/);
  await dlg.getByRole("radiogroup", { name: "Relevance" }).getByRole("radio", { name: "5" }).click();
  await dlg.getByRole("radiogroup", { name: "Quality" }).getByRole("radio", { name: "4" }).click();
  await page.getByTestId("review-save").click();
  await expect(rows.first()).toContainText("Scored");
  await page.goto("/app/forms?tab=calls");
  await page.getByTestId("form-row").filter({ hasText: "Speaker proposals" }).getByTestId("entries").click();
  const entry = page.getByTestId("entry").filter({ hasText: /Score \d/ }).first();
  await entry.getByTestId("shortlist").click();
  await expect(entry).toContainText("Shortlisted");
  const csv = await page.request.get(`/api/forms-plus/forms/${f.id}/entries.csv`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain("shortlisted");
});

test("shots: forms tabs, boards, calls, the chat form and the public board at 1280 and 390, light, dark and Forest", async ({ page }) => {
  test.skip(!DIR, "shots only when SHOTS_DIR is set");
  test.setTimeout(400_000);
  await demo(page);
  const f = await makeForm(page, { ...NPS, name: "Customer check in" });
  await page.request.put(`/api/forms-plus/forms/${f.id}/settings`, { data: { mode: "chat" } });
  const b = (await (await page.request.post("/api/forms-plus/boards", { data: { name: "Ideas for the app", description: "Tell us what to build next.", isPublic: true, allowIdeas: true, moderate: true } })).json()).board;
  for (const [t, s] of [["Calendar sync with a much longer title that wraps on phones", "planned"], ["Offline mode", "progress"], ["Bulk export", "done"]]) {
    const p = (await (await page.request.post(`/api/forms-plus/boards/${b.id}/posts`, { data: { title: t } })).json()).post;
    await page.request.patch(`/api/forms-plus/posts/${p.id}`, { data: { status: s } });
  }
  const run = async (theme: string) => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      for (const t of ["forms", "boards", "calls", "review"]) {
        await page.goto(`/app/forms?tab=${t}`);
        await expect(page.getByTestId("forms-tabs")).toBeVisible({ timeout: 20_000 });
        await page.waitForTimeout(600);
        await noHScroll(page);
        await shot(page, `${t}-${w}-${theme}`, w === 1280);
        await axe(page, `${t} ${w} ${theme}`);
      }
      for (const [n, path] of [["chat-public", `/f/${f.slug}`], ["board-public", `/fb/${b.slug}`]] as const) {
        await page.goto(path);
        await page.waitForTimeout(800);
        await noHScroll(page);
        await shot(page, `${n}-${w}-${theme}`, w === 1280);
        await axe(page, `${n} ${w} ${theme}`);
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
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest");
});
