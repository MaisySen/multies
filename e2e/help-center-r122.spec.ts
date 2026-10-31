import { test, expect, chromium, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R122 help center: an admin sets it up in Docs, publishes a doc, adds a category; a signed out visitor reads, searches,
 * gives feedback and asks a question; the admin approves and answers it. Unpublished articles and another workspace's
 * articles are 404 for visitors. With SHOTS_DIR set it saves the UX gate screenshots and checks every page with axe.
 */
const DIR = process.env.SHOTS_DIR;
const rand = () => Math.random().toString(36).slice(2, 8);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string, include = "main") {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include(include).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function api(page: Page, method: "post" | "patch", path: string, data: unknown) {
  const origin = new URL(page.url()).origin;
  const r = await page.request[method](path, { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function visitorPage(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": `10.122.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` } });
  return { ctx, page: await ctx.newPage() };
}

test("admin sets up a help center, publishes a doc; visitors read, search, give feedback and ask; nothing private leaks", async ({ page, baseURL }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const slug = `e2e-help-${rand()}`;
  await page.goto("/app/docs/help-center");
  await expect(page.getByRole("heading", { name: "Set up your help center" })).toBeVisible();
  await shot(page, "r122-setup-1280-light");
  expect(await axe(page, "setup")).toEqual([]);
  const address = page.locator('input[aria-describedby="slug-hint"]');
  await address.fill("ab");
  await expect(page.getByText("Use 3 to 60 lowercase letters")).toBeVisible();
  await address.fill(slug);
  await page.getByRole("button", { name: "Turn on help center" }).click();
  await expect(page.getByRole("tab", { name: "Articles" })).toBeVisible();
  await expect(page.getByText("No articles yet")).toBeVisible();
  await shot(page, "r122-articles-empty-1280-light");

  // A doc with a private draft beside it.
  const pub = await api(page, "post", "/api/docs", { title: "Reset your password", text: "Open the sign in page and choose Forgot password. We email you a link." });
  await api(page, "post", "/api/docs", { title: "Internal pricing notes", text: "privateneedle margin numbers" });
  void pub;
  await page.getByRole("button", { name: "Publish a doc" }).first().click();
  const dlg = page.getByRole("dialog", { name: "Publish a doc" });
  await dlg.getByPlaceholder("Search docs").fill("Reset your");
  await dlg.getByRole("option", { name: /Reset your password/ }).click();
  await dlg.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("link", { name: "Reset your password" }).first()).toBeVisible();

  // A category, then a draft article that must stay private.
  await page.getByRole("tab", { name: "Categories" }).click();
  await page.getByLabel("Name").fill("Account");
  await page.getByRole("button", { name: "Add category" }).click();
  await expect(page.getByText("Account", { exact: true })).toBeVisible();
  const draftDoc = await api(page, "post", "/api/docs", { title: "Draft billing guide", text: "draftneedle words" });
  await api(page, "post", "/api/help-center/articles", { docId: (draftDoc.doc ?? draftDoc).id, status: "draft" });

  // Visitors (signed out).
  const v = await visitorPage(await chromium.launch(), baseURL!);
  const base = `/help/${slug}`;
  await v.page.setViewportSize({ width: 1280, height: 860 });
  await v.page.goto(base);
  await expect(v.page.getByRole("heading", { name: "How can we help?" })).toBeVisible();
  await expect(v.page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${base}$`));
  await shot(v.page, "r122-public-home-1280-light");
  expect(await axe(v.page, "public home", "body")).toEqual([]);
  await v.page.getByRole("searchbox").fill("forgot password");
  await v.page.getByRole("button", { name: "Search" }).click();
  await expect(v.page.getByRole("link", { name: /Reset your password/ })).toBeVisible();
  await shot(v.page, "r122-public-search-1280-light");
  for (const q of ["privateneedle", "draftneedle"]) {
    await v.page.goto(`${base}/search?q=${q}`);
    await expect(v.page.getByText(/No results/)).toBeVisible();
  }
  expect((await v.page.request.get(`${base}/a/draft-billing-guide`)).status()).toBe(404);
  await v.page.goto(`${base}/a/reset-your-password`);
  await expect(v.page.getByRole("heading", { name: "Reset your password", level: 1 })).toBeVisible();
  await shot(v.page, "r122-public-article-1280-light");
  expect(await axe(v.page, "public article", "body")).toEqual([]);
  await v.page.waitForTimeout(2_100);
  await v.page.getByLabel(/What was missing/).fill("A screenshot would help");
  await v.page.getByRole("button", { name: "Yes, it helped" }).click();
  await expect(v.page.getByText("Thanks for telling us")).toBeVisible();
  // Ask a question.
  await v.page.goto(`${base}/ask`);
  await v.page.getByLabel("Your question").fill("Can I sign in with my phone number?");
  await v.page.waitForTimeout(2_100);
  await v.page.getByRole("button", { name: "Post question" }).click();
  await expect(v.page.getByRole("heading", { name: "Thanks, we have your question" })).toBeVisible();
  await v.page.goto(`${base}/questions`);
  await expect(v.page.getByText("Can I sign in with my phone number?")).toHaveCount(0);

  // The admin approves and answers; the visitor sees the best answer.
  await page.goto("/app/docs/help-center?tab=questions");
  await page.getByRole("button", { name: /Can I sign in with my phone number/ }).click();
  const qd = page.getByRole("dialog");
  await qd.getByLabel("Answer as the team").fill("Not yet. Use your email address for now.");
  await qd.getByRole("button", { name: "Post answer" }).click();
  await qd.getByRole("button", { name: "Mark best" }).click();
  await qd.getByRole("button", { name: "Approve" }).click();
  await expect(qd.getByText("Best answer")).toBeVisible();
  await shot(page, "r122-question-1280-light");
  expect(await axe(page, "question dialog", "dialog")).toEqual([]);
  await page.keyboard.press("Escape");
  await v.page.goto(`${base}/questions`);
  await v.page.getByRole("link", { name: /Can I sign in with my phone number/ }).click();
  await expect(v.page.getByText("Best answer")).toBeVisible();
  await shot(v.page, "r122-public-question-1280-light");
  expect(await axe(v.page, "public question", "body")).toEqual([]);
  // Feedback reached the team only.
  await page.goto("/app/docs/help-center?tab=feedback");
  await expect(page.getByText("A screenshot would help")).toBeVisible();

  // Another workspace's article is not reachable under this address.
  const other = await (await chromium.launch()).newContext({ baseURL });
  const op = await other.newPage();
  await demo(op);
  const oslug = `e2e-other-${rand()}`;
  await api(op, "patch", "/api/help-center", { slug: oslug, on: true });
  const od = await api(op, "post", "/api/docs", { title: "Other company secret", text: "otherneedle" });
  await api(op, "post", "/api/help-center/articles", { docId: (od.doc ?? od).id });
  expect((await v.page.request.get(`/help/${oslug}/a/other-company-secret`)).status()).toBe(200);
  expect((await v.page.request.get(`${base}/a/other-company-secret`)).status()).toBe(404);
  await v.page.goto(`${base}/search?q=otherneedle`);
  await expect(v.page.getByText(/No results/)).toBeVisible();
  await other.close();

  // UX gate shots: team tabs and public pages at 1280 and 390, light, dark and Forest.
  const views = async (suffix: string) => {
    for (const tab of ["articles", "questions", "categories", "settings"]) {
      await page.goto(`/app/docs/help-center?tab=${tab}`);
      await expect(page.getByRole("tab", { name: "Articles" })).toBeVisible();
      await shot(page, `r122-${tab}-${suffix}`);
      expect(await axe(page, `${tab} ${suffix}`)).toEqual([]);
    }
  };
  const pubViews = async (suffix: string) => {
    for (const [name, path] of [["public-home", base], ["public-article", `${base}/a/reset-your-password`]] as const) {
      await v.page.goto(path);
      await shot(v.page, `r122-${name}-${suffix}`);
      expect(await axe(v.page, `${name} ${suffix}`, "body")).toEqual([]);
    }
  };
  await views("1280-light");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await views("390-dark");
  await page.setViewportSize({ width: 1280, height: 860 });
  await views("1280-dark");
  await v.page.emulateMedia({ colorScheme: "dark" });
  await pubViews("1280-dark");
  await v.page.setViewportSize({ width: 390, height: 844 });
  await pubViews("390-dark");
  await v.page.emulateMedia({ colorScheme: "light" });
  await pubViews("390-light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await views("1280-forest");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-forest");
  // No horizontal scroll on the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await v.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await v.ctx.close();
});

test("visitor pages answer 404 for unknown and switched off help centers", async ({ page, baseURL }) => {
  await demo(page);
  const slug = `e2e-off-${rand()}`;
  await api(page, "patch", "/api/help-center", { slug, on: false });
  const v = await visitorPage(await chromium.launch(), baseURL!);
  expect((await v.page.request.get(`/help/${slug}`)).status()).toBe(404);
  expect((await v.page.request.get(`/help/no-such-center-${rand()}`)).status()).toBe(404);
  await api(page, "patch", "/api/help-center", { on: true });
  expect((await v.page.request.get(`/help/${slug}`)).status()).toBe(200);
  await v.page.goto(`/help/${slug}`);
  await expect(v.page.getByText("Nothing here yet")).toBeVisible();
  await v.ctx.close();
});
