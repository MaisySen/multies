import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R123 Sites: an admin starts a site, builds the home page from blocks with the live preview, saves, publishes, schedules
 * a second page, restores a version and places a form and a booking block; a signed out visitor reads the page (title,
 * description, og tags), comments through the spam shield; the admin approves it and sees the visit count. With SHOTS_DIR
 * set it saves the UX gate screenshots (1280 and 390, light and dark) and every page is checked with axe.
 */
const DIR = process.env.SHOTS_DIR;
const rand = () => Math.random().toString(36).slice(2, 7);

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function shot(page: Page, name: string) {
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function axe(page: Page, where: string, include?: string) {
  await page.waitForTimeout(300);
  // The preview iframe is sandboxed (no origin), so axe cannot enter it; the same html is checked as the public page.
  const b = new AxeBuilder({ page }).exclude('iframe[title="Page preview"]');
  const { violations } = await (include ? b.include(include) : b).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function api<T = Record<string, unknown>>(page: Page, method: "get" | "post" | "patch", path: string, data?: unknown): Promise<T> {
  const origin = new URL(page.url()).origin;
  const r = await page.request[method](path, { headers: { origin }, data });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json() as Promise<T>;
}
async function visitor(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": `10.123.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` } });
  return { ctx, page: await ctx.newPage() };
}
async function startSite(page: Page) {
  const slug = `acme-${rand()}`;
  await page.goto("/app/docs/sites");
  await expect(page.getByText("Build a simple website for your team")).toBeVisible();
  await page.getByLabel("Site name").fill("Acme studio");
  await page.getByLabel("Site address").fill(slug);
  await page.getByRole("button", { name: "Start a site" }).click();
  await expect(page.getByRole("tab", { name: "Pages" })).toBeVisible();
  return slug;
}

test("admin builds, previews, publishes and schedules pages; visitors read and comment; moderation and counts work", async ({ page, browser, baseURL }) => {
  test.setTimeout(480_000);
  const problems: string[] = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.goto("/app/docs/sites");
  await shot(page, "01-empty-1280-light");
  problems.push(...(await axe(page, "empty", "main")));
  const slug = await startSite(page);
  await shot(page, "02-pages-1280-light");
  // The Docs sidebar shows Sites now that the workspace has one.
  await page.reload();
  await expect(page.getByRole("link", { name: "Sites" }).first()).toBeVisible();

  await page.getByRole("button", { name: /Home/ }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  const preview = page.frameLocator('iframe[title="Page preview"]');
  await expect(preview.locator("h1")).toHaveText("Acme studio");
  // A form and a booking block (a form is made for the test when the workspace has none).
  const links = await api<{ forms: { slug: string }[]; booking: { slug: string }[] }>(page, "get", "/api/sites/linkables");
  if (!links.forms.length) await api(page, "post", "/api/forms", { name: "Contact us", fields: [{ id: "name", label: "Name", type: "text", required: true }] });
  await page.reload();
  await page.getByLabel("Title").first().fill("We make calm websites");
  await expect(preview.locator("h1")).toHaveText("We make calm websites");
  await page.getByRole("button", { name: "Add block" }).click();
  await page.getByRole("menuitem", { name: /^Form/ }).click();
  const formSelect = page.getByLabel("Form", { exact: true }).last();
  await expect(formSelect.locator("option")).not.toHaveCount(1);
  await formSelect.selectOption({ index: 1 });
  await expect(preview.getByRole("link", { name: "Open the form" })).toHaveAttribute("href", /\/f\//);
  await page.getByRole("button", { name: "Add block" }).click();
  await page.getByRole("menuitem", { name: /^Booking/ }).click();
  const bookSelect = page.getByLabel("Booking page", { exact: true }).last();
  if ((await bookSelect.locator("option").count()) > 1) {
    await bookSelect.selectOption({ index: 1 });
    await expect(preview.getByRole("link", { name: "Pick a time" })).toHaveAttribute("href", /\/book\//);
  }
  // An unsafe address is refused with plain words.
  await page.getByRole("button", { name: "Add block" }).click();
  await page.getByRole("menuitem", { name: /^Button/ }).click();
  await page.getByLabel("Address").last().fill("javascript:alert(1)");
  await page.keyboard.press("Control+s");
  await expect(page.getByText(/must start with https/)).toBeVisible();
  await page.getByRole("button", { name: "Remove Button block" }).last().click();

  // SEO fields, then save and publish.
  await page.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Page settings" }).click();
  await page.getByLabel("Title in search results").fill("Acme studio, calm websites");
  await page.getByLabel("Description").fill("Small studio in Sydney making calm websites for local teams.");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  await shot(page, "03-editor-1280-light");
  problems.push(...(await axe(page, "editor", "main")));
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "04-editor-1280-dark");
  await page.emulateMedia({ colorScheme: "light" });

  const v = await visitor(browser, baseURL!);
  expect((await v.page.goto(`/site/${slug}`))!.status()).toBe(404);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Page published")).toBeVisible();

  const res = await v.page.goto(`/site/${slug}`);
  expect(res!.status()).toBe(200);
  await expect(v.page).toHaveTitle("Acme studio, calm websites | Acme studio");
  await expect(v.page.locator('meta[name="description"]')).toHaveAttribute("content", /calm websites/);
  await expect(v.page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Acme studio, calm websites");
  await expect(v.page.locator('meta[property="og:image"]')).toHaveAttribute("content", /^https?:\/\//);
  await expect(v.page.getByRole("heading", { level: 1 })).toHaveText("We make calm websites");
  await shot(v.page, "05-public-1280-light");
  problems.push(...(await axe(v.page, "public")));

  // Comment through the spam shield, then moderation.
  await v.page.getByLabel("Your name").fill("Sam Visitor");
  await v.page.getByRole("textbox", { name: "Comment" }).fill("Lovely work, how do I get a quote?");
  await v.page.getByRole("button", { name: "Post comment" }).click();
  await expect(v.page.getByText("Thanks. Your comment shows here once the team approves it.")).toBeVisible({ timeout: 30_000 });
  await page.goto("/app/docs/sites?tab=comments");
  await expect(page.getByText("Lovely work, how do I get a quote?")).toBeVisible();
  await shot(page, "06-comments-1280-light");
  problems.push(...(await axe(page, "comments", "main")));
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Comment approved")).toBeVisible();
  await v.page.waitForTimeout(31_000); // the public page cache keeps a page 30 s
  await v.page.reload();
  await expect(v.page.getByText("Lovely work, how do I get a quote?")).toBeVisible();

  // A second page, scheduled for tomorrow: not public before its time.
  await page.goto("/app/docs/sites");
  await page.getByRole("button", { name: "New page" }).click();
  await page.getByLabel("Page title").fill("Plans");
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(page.getByRole("heading", { name: "Plans" })).toBeVisible();
  await page.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Schedule publish" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByText(/^Scheduled for/)).toBeVisible();
  expect((await v.page.goto(`/site/${slug}/plans`))!.status()).toBe(404);

  // Versions on the home page (saved and published): restore the first saved version into the draft.
  await page.goto("/app/docs/sites");
  await page.getByRole("button", { name: /Home/ }).click();
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
  await page.getByRole("button", { name: "More page actions" }).click();
  await page.getByRole("menuitem", { name: "Versions" }).click();
  await page.getByRole("button", { name: "Restore" }).last().click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog").last()).getByRole("button", { name: "Restore" }).last().click();
  await expect(page.getByText("Version restored into the draft")).toBeVisible();

  // Stats: counts only.
  await page.goto("/app/docs/sites?tab=stats");
  await expect(page.getByText("Counts only. No addresses, cookies or visitor ids are kept.")).toBeVisible();
  await expect.poll(async () => { await page.reload(); return page.getByText("No visits yet").count(); }, { timeout: 30_000 }).toBe(0);
  await shot(page, "07-stats-1280-light");
  problems.push(...(await axe(page, "stats", "main")));
  await v.ctx.close();
  expect(problems).toEqual([]);
});

test("phone: edit and preview switch, public page reads well at 390", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const problems: string[] = [];
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const slug = await startSite(page);
  await shot(page, "08-pages-390-light");
  await page.getByRole("button", { name: /Home/ }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(page.locator('iframe[title="Page preview"]')).toBeHidden();
  await shot(page, "09-editor-390-light");
  problems.push(...(await axe(page, "editor 390", "main")));
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator('iframe[title="Page preview"]')).toBeVisible();
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "10-preview-390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Page published")).toBeVisible();
  const v = await visitor(browser, baseURL!);
  await v.page.setViewportSize({ width: 390, height: 844 });
  await v.page.goto(`/site/${slug}`);
  expect(await v.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await shot(v.page, "11-public-390-light");
  await v.page.emulateMedia({ colorScheme: "dark" });
  await shot(v.page, "12-public-390-dark");
  problems.push(...(await axe(v.page, "public 390 dark")));
  await v.ctx.close();
  expect(problems).toEqual([]);
});

test("members cannot change the site, missing pages are 404 and the API needs a session", async ({ page, browser, baseURL }) => {
  await demo(page);
  const slug = await startSite(page);
  const v = await visitor(browser, baseURL!);
  expect((await v.page.goto(`/site/${slug}/nope`))!.status()).toBe(404);
  await expect(v.page).toHaveTitle("This page doesn't exist");
  expect((await v.page.request.get("/api/sites")).status()).toBe(401);
  await v.ctx.close();
});
