import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R124 Blog: an admin starts a site and its blog, writes a post in the Docs editor, sets excerpt and tags, publishes it
 * and schedules a second; turns on the newsletter. A signed out visitor reads the index, post, tag page and RSS (title
 * and og tags), and subscribes through the double opt in box; the admin sees the waiting subscriber. With SHOTS_DIR set
 * it saves the UX gate screenshots (1280 and 390, light and dark); every screen is checked with axe.
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
async function axe(page: Page, where: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
}
async function visitor(browser: Browser, baseURL: string) {
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": `10.124.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}` } });
  return { ctx, page: await ctx.newPage() };
}

test("admin writes, publishes and schedules posts; visitors read, follow RSS and subscribe with double opt in", async ({ page, browser, baseURL }) => {
  test.setTimeout(420_000);
  const problems: string[] = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);

  // A site first (R123), then the blog.
  const slug = `blog-${rand()}`;
  await page.goto("/app/docs/sites");
  await page.getByLabel("Site name").fill("Acme studio");
  await page.getByLabel("Site address").fill(slug);
  await page.getByRole("button", { name: "Start a site" }).click();
  await page.getByRole("tab", { name: "Blog" }).click();
  await expect(page.getByText("Start a blog on your site")).toBeVisible();
  await shot(page, "01-start-1280-light");
  problems.push(...(await axe(page, "start")));
  await page.getByRole("button", { name: "Start the blog" }).click();
  await expect(page.getByText("Write your first post")).toBeVisible();
  problems.push(...(await axe(page, "empty posts")));

  // First post: title, body in the editor, excerpt, tags, publish now.
  await page.getByRole("button", { name: "New post" }).first().click();
  await page.getByLabel("Title").fill("Our spring menu");
  await page.getByRole("button", { name: "Create post" }).click();
  await expect(page).toHaveURL(/\/app\/docs\/sites\/blog\//);
  const editor = page.locator(".ProseMirror").first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("Fresh peas, mint and lemon arrive this week. Come and try the new plates.");
  await page.waitForTimeout(2500); // the doc autosaves
  await page.getByLabel("Excerpt").fill("Three new plates for spring.");
  await page.getByLabel("Excerpt").blur();
  await page.getByLabel("Tags").fill("Menu, Spring");
  await page.getByLabel("Tags").press("Enter");
  await expect(page.getByRole("button", { name: "Remove tag Spring" })).toBeVisible();
  await shot(page, "02-editor-1280-light");
  problems.push(...(await axe(page, "editor")));
  await page.getByTestId("post-publish").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  problems.push(...(await axe(page, "publish dialog")));
  await page.getByTestId("publish-confirm").click();
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();

  // Second post, scheduled for tomorrow.
  await page.goto("/app/docs/sites?tab=blog");
  await page.getByRole("button", { name: "New post" }).first().click();
  await page.getByLabel("Title").fill("Summer hours");
  await page.getByRole("button", { name: "Create post" }).click();
  await expect(page.locator(".ProseMirror").first()).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("post-publish").click();
  await page.getByLabel("Pick a date and time").check();
  await page.getByTestId("publish-confirm").click();
  await expect(page.getByText(/Goes live/).first()).toBeVisible();

  // Newsletter settings (admin): mailbox, sender, address, subscribe box on.
  await page.goto("/app/docs/sites?tab=blog&view=settings");
  const mb = page.getByLabel("Sends from");
  await expect(mb).toBeVisible();
  const first = await mb.locator("option").nth(1).getAttribute("value");
  expect(first, "the demo workspace has a mailbox").toBeTruthy();
  await mb.selectOption(first!);
  await page.getByLabel("Sender name").fill("Acme studio");
  await page.getByLabel("Sender name").blur();
  await page.getByLabel("Contact address").fill("1 George St, Sydney NSW 2000");
  await page.getByLabel("Contact address").blur();
  await expect(page.getByText(/^Ready\./)).toBeVisible();
  const sw = page.getByRole("switch", { name: "Show a subscribe box on the blog" });
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  await expect(page.getByText(/Visitors can subscribe/)).toBeVisible();
  await shot(page, "03-settings-1280-light");
  problems.push(...(await axe(page, "settings")));

  // Posts list in both themes and on a phone.
  await page.goto("/app/docs/sites?tab=blog");
  await expect(page.getByTestId("blog-posts").getByText("Our spring menu")).toBeVisible();
  await shot(page, "04-posts-1280-light");
  await setTheme(page, "dark");
  await shot(page, "05-posts-1280-dark");
  problems.push(...(await axe(page, "posts dark")));
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "06-posts-390-dark");
  await setTheme(page, "light");
  await shot(page, "07-posts-390-light");
  problems.push(...(await axe(page, "posts 390")));
  await page.getByTestId("blog-posts").getByText("Our spring menu").click();
  await expect(page.getByRole("button", { name: "Post settings" })).toBeVisible();
  await shot(page, "08-editor-390-light");
  await page.getByRole("button", { name: "Post settings" }).click();
  await expect(page.getByLabel("Excerpt")).toBeVisible();
  await shot(page, "09-settings-sheet-390-light");
  problems.push(...(await axe(page, "editor 390")));
  await page.setViewportSize({ width: 1280, height: 860 });

  // A signed out visitor.
  const v = await visitor(browser, baseURL!);
  const r = await v.page.goto(`/site/${slug}/blog`);
  expect(r?.status()).toBe(200);
  await expect(v.page.getByRole("link", { name: "Our spring menu" })).toBeVisible();
  await expect(v.page.getByText("Summer hours")).toHaveCount(0);
  await shot(v.page, "10-public-index-1280");
  problems.push(...(await axe(v.page, "public index")));
  await v.page.getByRole("link", { name: "Our spring menu" }).click();
  await expect(v.page.getByRole("heading", { name: "Our spring menu" })).toBeVisible();
  await expect(v.page.getByText("Fresh peas, mint and lemon")).toBeVisible();
  expect(await v.page.locator('meta[property="og:title"]').getAttribute("content")).toContain("Our spring menu");
  expect(await v.page.locator('meta[property="og:type"]').getAttribute("content")).toBe("article");
  await expect(v.page).toHaveTitle(/Our spring menu/);
  problems.push(...(await axe(v.page, "public post")));
  await shot(v.page, "11-public-post-1280");
  const rss = await v.page.request.get(`/site/${slug}/blog/rss.xml`);
  expect(rss.headers()["content-type"]).toContain("xml");
  const xml = await rss.text();
  expect(xml).toContain("<rss version=\"2.0\"");
  expect(xml).toContain("Our spring menu");
  expect(xml).not.toContain("Summer hours");
  const tag = await v.page.goto(`/site/${slug}/blog/tag/spring`);
  expect(tag?.status()).toBe(200);
  await expect(v.page.getByRole("link", { name: "Our spring menu" })).toBeVisible();
  const sitemap = await v.page.request.get(`/site/${slug}/sitemap.xml`);
  if (sitemap.ok()) expect(await sitemap.text()).toContain("/blog/");

  // Subscribe with double opt in.
  await v.page.goto(`/site/${slug}/blog`);
  await v.page.getByLabel("Email address").fill(`reader-${rand()}@example.com`);
  await v.page.waitForTimeout(1300);
  await v.page.getByRole("button", { name: "Subscribe" }).click();
  await expect(v.page.locator("#sub-status")).toContainText("Check your inbox", { timeout: 30_000 });
  await v.page.setViewportSize({ width: 390, height: 844 });
  await shot(v.page, "12-public-index-390");
  problems.push(...(await axe(v.page, "public index 390")));
  await v.ctx.close();

  // The admin sees the waiting subscriber; drafts are not public.
  await page.goto("/app/docs/sites?tab=blog&view=subscribers");
  await expect(page.getByText("Waiting to confirm").first()).toBeVisible();
  await expect(page.getByText(/reader-.*@example\.com/)).toBeVisible();
  await shot(page, "13-subscribers-1280-light");
  problems.push(...(await axe(page, "subscribers")));

  expect(problems, problems.join("\n")).toEqual([]);
});
