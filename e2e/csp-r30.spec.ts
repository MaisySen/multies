import { test, expect, type Page } from "@playwright/test";

/**
 * R30 security: no page may trip the Content Security Policy. Any securitypolicyviolation event, or a
 * console line where the browser refused something under the CSP or the Permissions-Policy header,
 * fails the test. Covers the public pages, the signed in app (inbox, tasks, docs editor, chat,
 * calendar, meetings, settings and billing) and the API reference page.
 */
async function watch(page: Page) {
  const problems: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || "inline"} on ${location.pathname}`);
    });
  });
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|connect|frame|apply|create)|Permissions-Policy|Unrecognized feature/i.test(t)) problems.push(`${m.type()}: ${t.slice(0, 300)}`);
  });
  return {
    async collect() {
      const fromPage = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => [] as string[]);
      return [...problems, ...fromPage];
    },
  };
}

async function visit(page: Page, path: string, ready?: () => Promise<void>) {
  const res = await page.goto(path);
  expect(res?.headers()["content-security-policy"], `CSP on ${path}`).toBeTruthy();
  if (ready) await ready();
  // W4: pages that poll (presence, counts) never go network idle; wait a bounded while, then look (the CSP events stay collected).
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

test("public pages raise no CSP violations", async ({ page }) => {
  const w = await watch(page);
  await visit(page, "/", async () => { await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); });
  await visit(page, "/login", async () => { await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible(); });
  await visit(page, "/signup", async () => { await expect(page.getByLabel("Work email")).toBeVisible(); });
  await visit(page, "/pricing");
  expect(await w.collect()).toEqual([]);
});

test("signed in app raises no CSP violations", async ({ page }) => {
  test.setTimeout(90_000);
  const w = await watch(page);
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Cass Policy");
  await page.getByLabel("Work email").fill(`csp-${Date.now()}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app\//, { timeout: 15_000 });
  for (const p of ["/app/inbox", "/app/tasks", "/app/chat", "/app/calendar", "/app/meetings", "/app/settings", "/app/billing"]) await visit(page, p);
  // The docs editor: open a new doc and type, so the editor and its collab code run.
  await visit(page, "/app/docs");
  const create = page.getByRole("button", { name: /new (doc|page)/i }).first();
  if (await create.isVisible().catch(() => false)) {
    await create.click();
    await page.waitForURL(/\/app\/docs\/.+/, { timeout: 10_000 }).catch(() => undefined);
    const editor = page.locator("[contenteditable=true]").first();
    if (await editor.isVisible().catch(() => false)) { await editor.click(); await page.keyboard.type("Policy check"); }
    await page.waitForTimeout(800);
  }
  expect(await w.collect()).toEqual([]);
});

test("API reference page raises no CSP violations", async ({ page }) => {
  const w = await watch(page);
  await visit(page, "/api/v1/reference");
  expect(await w.collect()).toEqual([]);
});
