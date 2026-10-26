import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * Round 21 Triage end to end: a public form for a project with Triage on lands in Triage (not in the
 * project list), is accepted with an assignee and then shows in the project; another item is declined.
 */
let visitor = 0;
const ip = () => `10.121.${test.info().workerIndex % 200}.${++visitor}`;

async function owner(page: Page) {
  const base = test.info().project.use.baseURL!;
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  await page.request.patch("/api/org", { data: { name: "Harbour Studio" }, headers });
  return headers;
}

test("a form submission waits in Triage, is accepted with an assignee and shows in the project; another is declined", async ({ page, browser, context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const headers = await owner(page);
  const project = (await (await page.request.post("/api/projects", { data: { name: "Client requests", key: "REQ" }, headers })).json()).project;
  expect((await (await page.request.patch(`/api/projects/${project.id}`, { data: { triage: true }, headers })).json()).project.triage).toBe(true);
  const form = (await (await page.request.post("/api/forms", { data: { name: "Contact us", projectId: project.id }, headers })).json()).form;
  // A couple of items from other sources, so the queue looks like a real morning.
  await page.request.post("/api/triage", { data: { title: "Can you add two more mailboxes for the Sydney office?", notes: "Hi team,\n\nWe are hiring two people in Sydney next month. Could you set up mailboxes for them?\n\nThanks,\nMaria", source: "mail", from: "Maria Chen <maria@blueharbor.example>", projectId: project.id }, headers });
  await page.request.post("/api/triage", { data: { title: "Invoice 2041 looks doubled", notes: "The October invoice shows the same line twice.", source: "api", from: "billing-bot@ledger.example", projectId: project.id }, headers });
  await page.request.post("/api/triage", { data: { title: "Limited offer: 50% off ads this week", notes: "Click here to claim.", source: "mail", from: "Promo Team <offers@adsplace.example>", projectId: project.id }, headers });

  const subject = `Website refresh quote ${Date.now().toString().slice(-5)}`;
  const outsider = await browser.newPage({ extraHTTPHeaders: process.env.E2E_BASE_URL ? {} : { "x-forwarded-for": ip() } });
  await outsider.goto(new URL(form.url).pathname);
  const f = outsider.getByTestId("public-form");
  await f.getByLabel("Your name").fill("Grace Lee");
  await f.getByLabel("Email").fill("grace@harbourcoffee.com.au");
  await f.getByLabel("What do you need?").fill(subject);
  await f.getByLabel("Details (optional)").fill("We would like a quote for a new homepage and a booking page before December.");
  await outsider.waitForTimeout(1600);
  await f.getByRole("button", { name: "Send" }).click();
  await expect(outsider.getByTestId("form-done")).toBeVisible();
  await outsider.close();

  // Not in the project list yet.
  expect(((await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks as unknown[]).length).toBe(0);

  await page.setViewportSize({ width: 1360, height: 860 });
  await page.goto("/app/triage");
  const list = page.getByTestId("triage-list");
  await expect(list.getByText(subject)).toBeVisible();
  await expect(page.getByRole("link", { name: /Triage/ }).getByLabel("4 waiting in Triage")).toBeVisible();
  await list.getByRole("option").filter({ hasText: subject }).click();
  const preview = page.getByTestId("triage-preview");
  await expect(preview.getByRole("heading", { name: subject })).toBeVisible();
  await expect(preview).toContainText("From grace@harbourcoffee.com.au");
  const shots = "/home/user/tab/files/multies-r21";
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/triage.png` });

  await preview.getByLabel("Assignee").selectOption({ label: "Ada Owner" });
  await preview.getByRole("button", { name: "Accept and assign" }).click();
  await expect(list.getByText(subject)).toHaveCount(0);
  const tasks = (await (await page.request.get(`/api/tasks?projectId=${project.id}`)).json()).tasks as { title: string; assignee: { name: string } | null }[];
  expect(tasks.map((t) => t.title)).toEqual([subject]);
  expect(tasks[0].assignee?.name).toBe("Ada Owner");
  await page.goto(`/app/tasks?project=${project.id}&view=list`);
  await expect(page.getByText(subject).first()).toBeVisible();

  // Decline the promo with the keyboard: select it, press d, confirm.
  await page.goto("/app/triage");
  await page.getByTestId("triage-list").getByRole("option").filter({ hasText: "Limited offer" }).click();
  await page.keyboard.press("d");
  const dialog = page.getByRole("dialog", { name: "Decline this item?" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Reason/).fill("Advertising");
  await dialog.getByRole("button", { name: "Decline" }).click();
  await expect(page.getByTestId("triage-list").getByText("Limited offer")).toHaveCount(0);
  expect((await (await page.request.get("/api/triage/count")).json()).count).toBe(2);
});
