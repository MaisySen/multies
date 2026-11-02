import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";

/**
 * TD2 Forms pro (FORMS_TD2=on in the e2e server). Builder: new types, blocks, conditions, page settings. Public form at
 * 390 and 1280: pages with a progress bar, file upload (progress, too big, wrong type), a drawn and a typed signature,
 * required when, one question at a time with Enter and Shift Enter only, offline, a load error with Retry, a slow upload.
 * The owner sees the files in Responses and deletes a response. SHOTS_DIR: shots at 1280 and 390, light, dark, Forest; axe.
 */
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.194.${test.info().workerIndex % 200}.${++visitor}`;
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

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
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: full });
}
const noHScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
async function visitorPage(browser: Browser, width = 390) {
  const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL!, viewport: { width, height: width === 390 ? 844 : 860 }, extraHTTPHeaders: { "x-forwarded-for": ip() } });
  return { ctx, page: await ctx.newPage() };
}
type FormOut = { id: string; slug: string; url: string; fields: { id: string; label: string; type: string }[]; td2?: { progress: boolean; oneAtATime: boolean } };
async function makeForm(page: Page, body: Record<string, unknown>): Promise<FormOut> {
  const r = await page.request.post("/api/forms", { data: body });
  expect(r.status(), await r.text()).toBe(201);
  return (await r.json()).form as FormOut;
}
const PRO = (oneAtATime = false) => ({ name: "Supplier sign up", target: "task", description: "Two short pages. It takes about a minute.", td2: { progress: true, oneAtATime }, fields: [
  { id: "name", label: "Your name", type: "text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "kind", label: "You are", type: "select", options: ["A person", "A business"], required: true },
  { id: "p2", label: "Page", type: "page" },
  { id: "papers", label: "Your papers", type: "heading", text: "PDF or a photo, up to 1 MB each." },
  { id: "abn", label: "Business number", type: "text", requireWhen: { join: "all", conditions: [{ field: "kind", op: "is", value: "A business" }] } },
  { id: "docs", label: "Documents", type: "file", fileTypes: ["pdf", "images"], maxSizeMb: 1, maxFiles: 2 },
  { id: "site", label: "Website", type: "url" },
  { id: "start", label: "Start time", type: "time" },
  { id: "stars", label: "How was this form?", type: "rating", display: "stars", rules: { min: 1, max: 5 } },
  { id: "sig", label: "Signature", type: "signature", required: true },
] });
async function draw(page: Page) {
  const box = (await page.getByTestId("signature-sig").locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 20 + i * 14, box.y + box.height / 2 + (i % 2 ? -18 : 18));
  await page.mouse.up();
  await page.getByTestId("signature-use-sig").click();
  await expect(page.getByText("Signature saved.")).toBeVisible();
}

test("builder: new types, blocks, conditions and page settings save", async ({ page }) => {
  await demo(page);
  await page.goto("/app/forms");
  await page.getByRole("button", { name: "New form" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Name").fill("Event sign up");
  await dlg.getByLabel("Field 4 type").selectOption("file");
  await expect(dlg.getByTestId("td2-file-settings")).toBeVisible();
  await dlg.getByLabel("Largest file").selectOption("5");
  await dlg.getByTestId("add-block").selectOption("page");
  await dlg.getByRole("button", { name: "Add field" }).click();
  await dlg.getByLabel("Field 6 type").selectOption("signature");
  await dlg.getByTestId("logic-toggle-5").click();
  await expect(dlg.getByTestId("td2-require")).toBeVisible();
  await dlg.getByTestId("td2-form-settings").getByRole("switch", { name: "One question at a time" }).click();
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(dlg).toBeHidden();
  const list = await (await page.request.get("/api/forms")).json();
  const f = (list.forms as FormOut[]).find((x) => x.fields.some((y) => y.type === "signature"))!;
  expect(f.fields.map((x) => x.type)).toEqual(["text", "email", "text", "file", "page", "signature"]);
  expect(f.td2).toEqual({ progress: true, oneAtATime: true });
});

test("public form on a phone: pages, progress, uploads with errors, signature, required when, then the owner's responses", async ({ page, browser }) => {
  await demo(page);
  const f = await makeForm(page, PRO());
  const { ctx, page: v } = await visitorPage(browser, 390);
  await v.goto(`/f/${f.slug}`);
  await expect(v.getByTestId("form-progress")).toContainText("Page 1 of 2");
  await v.getByTestId("form-next").click();
  await expect(v.getByText('Please fill in "Your name".')).toBeVisible();
  await v.getByLabel("Your name").fill("Mina Rai");
  await v.getByLabel("Email").fill("mina@example.com");
  await v.getByLabel("You are").selectOption("A business");
  await v.getByTestId("form-next").click();
  await expect(v.getByTestId("form-progress")).toContainText("Page 2 of 2");
  await expect(v.getByRole("heading", { name: "Your papers" })).toBeVisible();
  const input = v.locator('input[type="file"][name="docs"]');
  await input.setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1024 * 1024 + 50, 0x25) });
  await expect(v.getByText(/Too big/)).toBeVisible();
  await input.setInputFiles({ name: "tool.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  await expect(v.getByText(/isn't accepted here/).first()).toBeVisible();
  await input.setInputFiles({ name: "licence.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(v.getByTestId("upload-item").filter({ hasText: "licence.pdf" }).locator(".text-good")).toBeVisible();
  await v.getByLabel("Website (optional)", { exact: true }).fill("example.com");
  await v.getByTestId("stars-stars").getByRole("radio", { name: "4 stars" }).click();
  await draw(v);
  await noHScroll(v);
  await v.getByTestId("form-send").click();
  await expect(v.getByText('Please fill in "Business number".')).toBeVisible();
  await v.getByLabel("Business number").fill("51 824 753 556");
  await v.getByTestId("form-send").click();
  await expect(v.getByTestId("form-done")).toBeVisible({ timeout: 15_000 });
  await ctx.close();
  // The owner sees the file and the signature, and can delete the response.
  await page.goto("/app/forms");
  await page.getByTestId("form-row").filter({ hasText: "Supplier sign up" }).getByRole("button", { name: "Responses" }).click();
  const res = page.getByTestId("form-results");
  await expect(res.getByTestId("response-file")).toContainText("licence.pdf");
  await expect(res.getByRole("img", { name: "Signature" })).toBeVisible();
  const dl = await page.request.get((await res.getByTestId("response-file").getAttribute("href"))!);
  expect(dl.status()).toBe(200);
  expect(dl.headers()["content-disposition"]).toMatch(/^attachment/);
  await res.getByTestId("response-delete").click();
  await res.getByTestId("response-delete-confirm").click();
  await expect(res.getByText("No responses yet")).toBeVisible();
});

test("keyboard only: one question at a time with Enter and Shift Enter, and a typed signature", async ({ page, browser }) => {
  await demo(page);
  const f = await makeForm(page, { ...PRO(true), fields: PRO(true).fields.filter((x) => !["docs", "papers", "stars"].includes(x.id)) });
  const { ctx, page: v } = await visitorPage(browser, 1280);
  await v.goto(`/f/${f.slug}`);
  await expect(v.getByTestId("public-form")).toHaveAttribute("data-mode", "one");
  await expect(v.getByLabel("Your name")).toBeFocused();
  await v.keyboard.type("Ravi Shah");
  await v.keyboard.press("Enter");
  await expect(v.getByLabel("Email")).toBeFocused();
  await v.keyboard.press("Shift+Enter");
  await expect(v.getByLabel("Your name")).toHaveValue("Ravi Shah");
  await v.keyboard.press("Enter");
  await v.keyboard.type("ravi@example.com");
  await v.keyboard.press("Enter");
  await v.keyboard.press("Enter"); // nothing picked: stays with an error
  await expect(v.getByText('Please choose an answer for "You are".')).toBeVisible();
  await v.getByLabel("You are").selectOption("A person");
  await v.getByLabel("You are").press("Enter");
  // Business number is not required for a person, web address and time are optional.
  await v.keyboard.press("Enter");
  await v.keyboard.press("Enter");
  await v.keyboard.press("Enter");
  await expect(v.getByTestId("form-progress")).toContainText("Question");
  await v.getByRole("button", { name: "Type your name instead" }).focus();
  await v.keyboard.press("Enter");
  await v.getByTestId("signature-typed-sig").focus();
  await v.keyboard.type("Ravi Shah");
  await v.keyboard.press("Enter");
  await expect(v.getByText("Signature saved.")).toBeVisible();
  await axe(v, "one at a time");
  await v.getByTestId("form-send").focus();
  await v.keyboard.press("Enter");
  await expect(v.getByTestId("form-done")).toBeVisible({ timeout: 15_000 });
  await ctx.close();
});

test("states: offline, a load error with Retry, and a slow upload with progress", async ({ page, browser }) => {
  await demo(page);
  const f = await makeForm(page, PRO());
  const { ctx, page: v } = await visitorPage(browser, 390);
  let fail = true;
  await v.route(`**/api/public/forms/${f.slug}`, (r) => (fail && r.request().method() === "GET" ? r.abort() : r.continue()));
  await v.goto(`/f/${f.slug}`);
  await expect(v.getByTestId("form-load-error")).toBeVisible({ timeout: 15_000 });
  await axe(v, "load error");
  fail = false;
  await v.getByRole("button", { name: "Retry" }).click();
  await expect(v.getByTestId("public-form")).toBeVisible({ timeout: 15_000 });
  await ctx.setOffline(true);
  await expect(v.getByTestId("form-offline")).toBeVisible();
  await ctx.setOffline(false);
  await expect(v.getByTestId("form-offline")).toBeHidden();
  await v.getByLabel("Your name").fill("Slow Upload");
  await v.getByLabel("Email").fill("slow@example.com");
  await v.getByLabel("You are").selectOption("A person");
  await v.getByTestId("form-next").click();
  await v.route("**/uploads?field=docs", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await v.locator('input[type="file"][name="docs"]').setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(v.getByRole("progressbar", { name: "Uploading scan.pdf" })).toBeVisible();
  await expect(v.getByTestId("upload-item").locator(".text-good")).toBeVisible({ timeout: 10_000 });
  await ctx.close();
});

test("shots: builder and public form at 1280 and 390, light, dark and Forest", async ({ page, browser }) => {
  test.skip(!DIR, "shots only when SHOTS_DIR is set");
  test.setTimeout(400_000);
  await demo(page);
  const f = await makeForm(page, PRO());
  const one = await makeForm(page, { ...PRO(true), name: "One at a time" });
  const run = async (theme: string, scheme: "light" | "dark") => {
    for (const w of [1280, 390]) {
      await page.setViewportSize({ width: w, height: w === 390 ? 844 : 860 });
      await page.goto("/app/forms");
      await page.getByTestId("form-row").filter({ hasText: "Supplier sign up" }).getByRole("button").nth(1).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByTestId("logic-toggle-5").click();
      await noHScroll(page);
      await shot(page, `builder-${w}-${theme}`);
      await axe(page, `builder ${w} ${theme}`);
      await page.keyboard.press("Escape");
      const { ctx, page: v } = await visitorPage(browser, w);
      await v.emulateMedia({ colorScheme: scheme });
      await v.goto(`/f/${f.slug}`);
      await expect(v.getByTestId("public-form")).toBeVisible();
      await noHScroll(v);
      await shot(v, `public-p1-${w}-${theme}`, w === 1280);
      await axe(v, `public p1 ${w} ${theme}`);
      await v.getByLabel("Your name").fill("Mina Rai");
      await v.getByLabel("Email").fill("mina@example.com");
      await v.getByLabel("You are").selectOption("A business");
      await v.getByTestId("form-next").click();
      await v.locator('input[type="file"][name="docs"]').setInputFiles({ name: "too-big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(1024 * 1024 + 50, 0x25) });
      await v.getByTestId("form-send").click();
      await noHScroll(v);
      await shot(v, `public-p2-errors-${w}-${theme}`, w === 1280);
      await axe(v, `public p2 ${w} ${theme}`);
      await v.goto(`/f/${one.slug}`);
      await expect(v.getByTestId("public-form")).toBeVisible();
      await shot(v, `public-one-${w}-${theme}`);
      await axe(v, `public one ${w} ${theme}`);
      await ctx.close();
    }
  };
  for (const scheme of ["light", "dark"] as const) { await page.emulateMedia({ colorScheme: scheme }); await run(scheme, scheme); }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  await expect(page.getByTestId("branding-settings")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  const save = page.getByTestId("brand-actions").getByRole("button", { name: /save/i });
  if (await save.count()) await save.first().click();
  await page.waitForTimeout(800);
  await run("forest", "light");
});
