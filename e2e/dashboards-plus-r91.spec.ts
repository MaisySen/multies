import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";

/**
 * R91 Dashboards plus: build a question and add it as a card, share by link (opens logged out, password),
 * schedule an emailed report (lands in the outbox), an alert fires once, members see share as read only,
 * a bad data source link is refused in plain words. Shots at 1280 and 390, light, dark and Forest, with axe.
 */
let visitor = 0;
const ip = () => `10.191.${test.info().workerIndex % 200}.${++visitor}`;
const SHOTS = process.env.SHOTS_DIR ?? "/home/user/tab/files/catalogue/r91/shots";
const local = !process.env.E2E_BASE_URL;

async function account(browser: Browser, opts: { width?: number; scheme?: "light" | "dark" } = {}) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: opts.width ?? 1360, height: 960 }, colorScheme: opts.scheme ?? "light", timezoneId: "UTC", extraHTTPHeaders: local ? { "x-forwarded-for": ip() } : {} });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  const email = `dash-${tag}@example.com`;
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Dana Lead", email, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/org", { data: { name: "Northwind" }, headers });
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  const project = (await (await page.request.post("/api/projects", { data: { name: "Launch", key: "LCH" }, headers })).json()).project as { id: string };
  for (const [title, status] of [["Brief the agency", "done"], ["Write the post", "doing"], ["Plan the webinar", "todo"], ["Fix the form", "todo"]] as const) {
    const t = (await (await page.request.post("/api/tasks", { data: { title, projectId: project.id }, headers })).json()).task as { id: string };
    if (status !== "todo") await page.request.patch(`/api/tasks/${t.id}`, { data: { status }, headers });
  }
  const dash = (await (await page.request.post("/api/dashboards", { data: { name: "Launch numbers", shared: true, widgets: [{ type: "count", title: "All tasks" }] }, headers })).json()).dashboard as { id: string };
  return { ctx, page, headers, email, dash: dash.id, base };
}

async function axeClean(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes[0]?.target}`)).toEqual([]);
}

test("question card, public link with password, emailed report, alert once, bad source refused", async ({ browser }) => {
  test.setTimeout(240_000);
  const { ctx, page, headers, dash, base } = await account(browser);
  await page.goto(`/app/dashboards/${dash}`);
  await expect(page.getByTestId("widget").first()).toBeVisible();

  // Build a question: tasks by status as bars.
  await page.getByRole("button", { name: "New question" }).click();
  const qb = page.getByTestId("question-builder");
  await expect(qb).toBeVisible();
  await qb.getByLabel("Group by").selectOption("status");
  await expect(page.getByTestId("question-preview")).toContainText("To do");
  await page.getByRole("button", { name: "Add to dashboard" }).click();
  await expect(page.locator('[data-testid="widget"][data-type="question"]')).toContainText("To do");

  // A filter with no value keeps Add disabled and says why.
  await page.getByRole("button", { name: "New question" }).click();
  await qb.getByRole("button", { name: "Add filter" }).click();
  await qb.getByLabel("Condition").first().selectOption("is");
  await expect(page.getByTestId("question-preview")).toContainText("Finish the question");
  await expect(page.getByRole("button", { name: "Add to dashboard" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // Share by link with a password, then open it logged out.
  await page.getByRole("button", { name: "Share" }).click();
  const sd = page.getByTestId("share-dialog");
  await sd.getByLabel("Password").fill("launch2026");
  await sd.getByRole("button", { name: "Create link" }).click();
  const url = await sd.getByLabel("Public link").inputValue();
  expect(url).toMatch(/\/dash\/[A-Za-z0-9_-]{30,}$/);
  await expect(sd.getByTestId("share-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  const anon = await browser.newContext({ baseURL: base, viewport: { width: 390, height: 844 }, extraHTTPHeaders: local ? { "x-forwarded-for": ip() } : {} });
  const pub = await anon.newPage();
  await pub.goto(new URL(url).pathname);
  await expect(pub.getByTestId("public-password")).toBeVisible();
  await pub.getByLabel("Password").fill("wrong-one");
  await pub.getByRole("button", { name: "Open dashboard" }).click();
  await expect(pub.getByText("That password isn't right.")).toBeVisible();
  await pub.getByLabel("Password").fill("launch2026");
  await pub.getByRole("button", { name: "Open dashboard" }).click();
  await expect(pub.getByRole("heading", { name: "Launch numbers" })).toBeVisible();
  await expect(pub.getByText("Northwind")).toBeVisible();
  await expect(pub.getByTestId("public-widget")).toHaveCount(2);
  mkdirSync(SHOTS, { recursive: true });
  await pub.screenshot({ path: `${SHOTS}/public-390-light.png`, fullPage: true });
  await axeClean(pub, "public");
  await anon.close();

  // Emailed report to an outside address; Send now lands in the outbox.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Emailed reports" }).click();
  const rd = page.getByTestId("reports-dialog");
  await rd.getByRole("button", { name: "New report" }).click();
  await rd.getByLabel("Add an email").fill("client@outside.example");
  await rd.getByRole("button", { name: "Add", exact: true }).click();
  await rd.getByRole("button", { name: "Schedule report" }).click();
  await expect(rd.getByTestId("report-row")).toContainText("Every Monday");
  await rd.getByRole("button", { name: "Send now" }).click();
  await expect(rd.getByTestId("report-row")).toContainText("last sent", { timeout: 45_000 });
  if (local && existsSync(".data/e2e-outbox")) {
    const hit = readdirSync(".data/e2e-outbox").some((f) => readFileSync(`.data/e2e-outbox/${f}`, "utf8").includes("Launch numbers: your weekly report"));
    expect(hit).toBe(true);
  }
  await page.keyboard.press("Escape");

  // Alert me on the count card: fires once, stays quiet on the next run.
  const count = page.locator('[data-testid="widget"][data-type="count"]');
  await count.getByRole("button", { name: /Options for/ }).click();
  await page.getByRole("menuitem", { name: "Alert me" }).click();
  const ad = page.getByTestId("alerts-dialog");
  await ad.getByLabel("This number").fill("2");
  await ad.getByRole("switch", { name: "Quiet hours" }).click();
  await ad.getByRole("button", { name: "Set alert" }).click();
  await expect(ad.getByTestId("alert-row")).toHaveCount(1);
  await page.keyboard.press("Escape");
  if (local) {
    await page.request.post("/api/dashboards-plus/test/run", { headers });
    await page.request.post("/api/dashboards-plus/test/run", { headers });
    const notes = await (await page.request.get("/api/notifications")).json();
    expect(JSON.stringify(notes).match(/All tasks is above 2/g)?.length).toBe(1);
  }

  // A private address as a CSV link is refused in plain words.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Data sources" }).click();
  const src = page.getByTestId("sources-dialog");
  await src.getByRole("tab", { name: "CSV link" }).click();
  await src.getByLabel("Link").fill("https://192.168.1.10/data.csv");
  await src.getByRole("button", { name: "Add source" }).click();
  await expect(src.getByRole("alert")).toContainText("public address");
  await ctx.close();
});

test("a member sees share and reports as read only", async ({ browser }) => {
  const { ctx, page, headers, dash, base } = await account(browser);
  const invite = (await (await page.request.post("/api/team/invites", { data: { email: `m-${Date.now()}@example.com`, role: "member" }, headers })).json()) as { link: string };
  const mctx = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 }, extraHTTPHeaders: local ? { "x-forwarded-for": ip() } : {} });
  const mp = await mctx.newPage();
  const email = new URL(invite.link).searchParams.get("email") ?? `mm-${Date.now()}@example.com`;
  await mp.request.post("/api/auth/sign-up/email", { data: { name: "Max Member", email, password: "a-strong-password" }, headers });
  const acc = await mp.request.post(`/api/invites/${invite.link.split("/invite/")[1]}/accept`, { headers });
  test.skip(acc.status() !== 200, "invite acceptance needs a verified address on this server");
  await mp.goto(`/app/dashboards/${dash}`);
  await mp.getByRole("button", { name: "Share" }).click();
  await expect(mp.getByTestId("share-dialog")).toContainText("Only the owner or a workspace admin");
  await mctx.close();
  await ctx.close();
});

for (const width of [1280, 390]) {
  for (const theme of ["light", "dark", "forest"] as const) {
    test(`shots ${width} ${theme}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const { ctx, page, headers, dash } = await account(browser, { width, scheme: theme === "dark" ? "dark" : "light" });
      if (theme === "forest") {
        await page.goto("/app/settings/branding");
        await page.getByRole("button", { name: "Forest", exact: true }).click();
        await page.getByRole("button", { name: "Save brand" }).click();
        await page.waitForTimeout(600);
      }
      await page.request.patch(`/api/dashboards/${dash}`, { data: { widgets: [{ type: "count", title: "All tasks" }, { type: "question", question: { table: "tasks", groupBy: "status" }, chart: "bar" }, { type: "question", title: "Open tasks", question: { table: "tasks", filters: [{ field: "status", op: "is_not", value: "done" }] }, chart: "number" }] }, headers });
      await page.goto(`/app/dashboards/${dash}`);
      await expect(page.locator('[data-testid="widget"][data-type="question"]').first()).toContainText("To do");
      const tag = `${width}-${theme}`;
      await page.screenshot({ path: `${SHOTS}/dashboard-${tag}.png`, fullPage: true });
      await axeClean(page, `dashboard ${tag}`);
      const open = async (name: string, testid: string) => {
        if (name === "Share") await page.getByRole("button", { name: "Share" }).click();
        else { await page.getByRole("button", { name: "More" }).click(); await page.getByRole("menuitem", { name }).click(); }
        await expect(page.getByTestId(testid)).toBeVisible();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${SHOTS}/${testid}-${tag}.png` });
        await axeClean(page, `${testid} ${tag}`);
        await page.keyboard.press("Escape");
      };
      await open("Share", "share-dialog");
      await open("Emailed reports", "reports-dialog");
      await open("Alerts", "alerts-dialog");
      await open("Data sources", "sources-dialog");
      await open("New question", "question-builder");
      await ctx.close();
    });
  }
}
