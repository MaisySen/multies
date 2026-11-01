import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R103 Docs plus: link library (empty, add, tags, filter, remove), save a page (happy path and a private address
 * refused), PDF snapshot, doc comments (team), comments on a shared link (visitor posts, admin approves), a project
 * guest commenting, and spell check in a doc. The clipper reads a pretend web here (DOCS_PLUS_FAKE_WEB=1).
 * With SHOTS_DIR set it saves the UX gate screenshots (1280 and 390, light, dark, Forest) and checks axe.
 */
const DIR = process.env.SHOTS_DIR;

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
async function axe(page: Page, where: string, include?: string) {
  await page.waitForTimeout(300);
  const b = new AxeBuilder({ page });
  const { violations } = await (include ? b.include(include) : b).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function api<T = Record<string, unknown>>(page: Page, method: "post" | "patch" | "put" | "get", path: string, data?: unknown): Promise<T> {
  const origin = new URL(page.url()).origin;
  const r = await page.request[method](path, { headers: { origin }, data });
  expect(r.ok(), `${method} ${path} ${r.status()}`).toBeTruthy();
  return (await r.json()) as T;
}

test.describe.configure({ mode: "serial" });

test("link library: empty state, save a page, add a link, tags, refused private address, PDF", async ({ page }) => {
  test.setTimeout(120_000);
  await demo(page);
  await page.goto("/app/docs");
  await page.getByRole("link", { name: "Link library" }).first().click();
  await expect(page).toHaveURL(/\/app\/docs\/links/);
  await expect(page.getByRole("heading", { name: "Link library" })).toBeVisible();
  await expect(page.getByText("No links yet")).toBeVisible();
  await shot(page, "library-empty-1280-light");
  // Error path: a private address is refused with plain words.
  await page.getByTestId("save-page").click();
  await page.getByTestId("save-link-url").fill("http://127.0.0.1/admin");
  await page.getByTestId("save-link-submit").click();
  await expect(page.getByRole("alert")).toContainText("private");
  await shot(page, "save-page-error-1280-light");
  // Happy path: a public page becomes a doc in Web clips (keyboard: Enter submits).
  await page.getByTestId("save-link-url").fill("https://news.example.org/2026/roast");
  await page.getByTestId("save-link-tags").fill("coffee, guides");
  await page.getByTestId("save-link-tags").press("Enter");
  await expect(page.getByTestId("link-card").first()).toContainText("How we roast coffee", { timeout: 15_000 });
  await expect(page.getByTestId("link-card").first()).toContainText("#coffee");
  // A plain link (bookmark) with a tag.
  await page.getByTestId("add-link").click();
  await page.getByTestId("save-link-url").fill("news.example.org/brew");
  await page.getByTestId("save-link-tags").fill("brewing");
  await page.getByTestId("save-link-submit").click();
  await expect(page.getByTestId("link-card")).toHaveCount(2, { timeout: 15_000 });
  // Filter by tag and by saved pages.
  await page.getByRole("button", { name: "#brewing" }).click();
  await expect(page.getByTestId("link-card")).toHaveCount(1);
  await page.getByRole("button", { name: "#brewing" }).click();
  await page.getByRole("button", { name: "Saved pages" }).click();
  await expect(page.getByTestId("link-card")).toHaveCount(1);
  await page.getByRole("button", { name: "All links" }).click();
  // PDF snapshot downloads a real PDF.
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download How we roast coffee as PDF/ }).click();
  const file = await dl;
  expect(file.suggestedFilename()).toBe("How we roast coffee.pdf");
  const errors = await axe(page, "library", "main");
  await shot(page, "library-1280-light");
  // Remove asks first.
  await page.getByRole("button", { name: /^Remove How to brew/ }).click();
  await page.getByTestId("confirm-remove-link").click();
  await expect(page.getByTestId("link-card")).toHaveCount(1);
  // Open the saved doc: it keeps the source link and the article text, without the page chrome.
  await page.getByRole("link", { name: "Open doc" }).first().click();
  await expect(page.getByText("Saved from")).toBeVisible();
  await expect(page.getByText("First crack")).toBeVisible();
  await expect(page.getByText("Footer text")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("doc comments, shared link comments with review, and spell check", async ({ page, browser }) => {
  test.setTimeout(150_000);
  await demo(page);
  const project = (await api<{ project: { id: string } }>(page, "post", "/api/projects", { name: `Client ${Date.now() % 100000}`, key: `C${Date.now() % 1000}` })).project;
  const doc = (await api<{ doc: { id: string } }>(page, "post", "/api/docs", { title: "Client brief", projectId: project.id, text: "We will recieve teh files on Monday." })).doc;
  await page.goto(`/app/docs/${doc.id}`);
  // Spell check: the dialog finds the typos and fixes them in the doc.
  await page.getByTestId("spell-button").first().click();
  await expect(page.getByTestId("spell-issues")).toContainText("recieve");
  await shot(page, "spell-dialog-1280-light");
  expect(await axe(page, "spell dialog", "[data-testid=spell-dialog]")).toEqual([]);
  await page.getByTestId("spell-fix-all").click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("textbox", { name: "Doc body" })).toContainText("We will receive the files on Monday.");
  await expect(page.getByRole("textbox", { name: "Doc body" })).toHaveAttribute("spellcheck", "true");
  // Team comment with the keyboard.
  await page.getByTestId("doc-comments-button").click();
  await expect(page.getByTestId("doc-comments-panel")).toBeVisible();
  await expect(page.getByText("No comments yet")).toBeVisible();
  await page.getByTestId("doc-comment-input").fill("Looks good, ship it");
  await page.getByTestId("doc-comment-input").press("Control+Enter");
  await expect(page.getByTestId("doc-comment")).toContainText("Looks good, ship it");
  expect(await axe(page, "comments panel", "[data-testid=doc-comments-panel]")).toEqual([]);
  await shot(page, "comments-1280-light");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("doc-comments-panel")).toHaveCount(0);
  // Share link with comments on.
  const link = (await api<{ link: { id: string; url: string } }>(page, "post", "/api/share-links", { kind: "doc", targetId: doc.id })).link;
  await page.reload();
  await page.getByRole("button", { name: /share/i }).first().click();
  await page.getByTestId("share-comments-toggle").first().click();
  await expect(page.getByTestId("share-comments-toggle").first()).toBeChecked();
  await expect(page.getByText(/Comments on/)).toBeVisible();
  await page.keyboard.press("Escape");
  const visitor = await (await browser.newContext()).newPage();
  const path = new URL(link.url).pathname;
  await visitor.goto(path);
  await expect(visitor.getByRole("heading", { name: "Comments" })).toBeVisible();
  await expect(visitor.getByText("Looks good, ship it")).toHaveCount(0); // team comments stay inside
  await visitor.getByLabel("Name", { exact: true }).fill("Sam Visitor");
  await visitor.getByLabel("Comment", { exact: true }).fill("Can we see the timeline?");
  await visitor.getByRole("button", { name: "Send comment" }).click();
  await expect(visitor.getByText("Thanks. Your comment shows here once the team reviews it.")).toBeVisible();
  await expect(visitor.getByText("Can we see the timeline?")).toHaveCount(0);
  expect(await axe(visitor, "shared page", "body")).toEqual([]);
  if (DIR) await visitor.screenshot({ path: `${DIR}/shared-link-comments-1280-light.png`, fullPage: true });
  // The admin reviews and approves; the visitor sees it.
  await page.getByTestId("doc-comments-button").click();
  await page.getByTestId("comments-tab-public").click();
  await expect(page.getByText("Waiting for review")).toBeVisible();
  await shot(page, "comments-review-1280-light");
  await page.getByRole("button", { name: "Approve" }).click();
  await visitor.reload();
  await expect(visitor.getByText("Can we see the timeline?")).toBeVisible();
  // A project guest reads and adds team comments on the project's doc.
  const inv = await api<{ guest: { id: string }; inviteUrl?: string }>(page, "post", "/api/guests", { projectId: project.id, email: `guest${Date.now() % 100000}@example.org`, name: "Mia Guest" });
  const url = inv.inviteUrl ?? (await api<{ inviteUrl: string }>(page, "post", `/api/guests/${inv.guest.id}/link`)).inviteUrl;
  const guest = await (await browser.newContext({ extraHTTPHeaders: { "x-forwarded-for": `10.103.${Date.now() % 250}.7` } })).newPage();
  await guest.goto(new URL(url).pathname);
  await guest.getByRole("button", { name: "Client brief" }).first().click({ timeout: 20_000 });
  await expect(guest.getByTestId("guest-doc-comments")).toContainText("Looks good, ship it");
  await guest.getByTestId("guest-comment-input").fill("Thanks team");
  await guest.getByRole("button", { name: "Comment" }).click();
  await expect(guest.getByTestId("guest-doc-comments")).toContainText("Thanks team");
});

test("UX gate shots: 390 and dark and Forest", async ({ page }) => {
  test.skip(!DIR, "shots only");
  test.setTimeout(120_000);
  await demo(page);
  await api(page, "post", "/api/docs-plus/links", { url: "https://news.example.org/brew", tags: ["brewing", "guides"] });
  const clip = await api<{ doc: { id: string } }>(page, "post", "/api/docs-plus/clip", { url: "https://news.example.org/2026/roast", tags: ["coffee"] });
  await api(page, "post", `/api/docs-plus/docs/${clip.doc.id}/comments`, { body: "Worth a read before Friday" });
  const views = async (tag: string) => {
    await page.goto("/app/docs/links");
    await expect(page.getByTestId("link-card").first()).toBeVisible();
    await shot(page, `library-${tag}`);
    const e1 = await axe(page, `library ${tag}`, "main");
    await page.goto(`/app/docs/${clip.doc.id}?comments=1`);
    await expect(page.getByTestId("doc-comments-panel")).toBeVisible();
    await shot(page, `comments-${tag}`);
    const e2 = await axe(page, `comments ${tag}`, "[data-testid=doc-comments-panel]");
    expect([...e1, ...e2]).toEqual([]);
  };
  await page.emulateMedia({ colorScheme: "dark" });
  await views("1280-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-dark");
  await page.emulateMedia({ colorScheme: "light" });
  await views("390-light");
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(scroll).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await views("1280-forest");
  await page.setViewportSize({ width: 390, height: 844 });
  await views("390-forest");
});
