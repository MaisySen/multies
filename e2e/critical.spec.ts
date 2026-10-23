import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Critical paths, end to end over the real UI and API: sign up and verify, send mail,
 * change plan, invite a teammate, create and use an API key, export data.
 * The local server writes every email to .data/e2e-outbox (OUTBOX_DIR); against a
 * deployed environment (E2E_BASE_URL) the email based steps are skipped.
 */
const OUTBOX = ".data/e2e-outbox";
const local = !process.env.E2E_BASE_URL;

/**
 * Sign-up is limited to 5 per minute per client IP, and this suite creates more accounts
 * than that. Locally each browser context presents its own client address, the way
 * separate visitors would, so the real limits stay switched on for the run.
 */
let visitor = 0;
async function asNewVisitor(context: BrowserContext) {
  const worker = test.info().workerIndex % 200;
  if (local) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${worker}.0.${++visitor}` });
}
test.beforeEach(async ({ context }) => asNewVisitor(context));

function lastEmailTo(address: string): { subject: string; text: string } | undefined {
  const files = readdirSync(OUTBOX).sort();
  for (const f of files.reverse()) {
    const m = JSON.parse(readFileSync(join(OUTBOX, f), "utf8")) as { to: string[]; subject: string; text: string };
    if (m.to.includes(address)) return m;
  }
  return undefined;
}

async function signUp(page: Page, name: string, email: string) {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`Good (morning|afternoon|evening), ${name.split(" ")[0]}`) })).toBeVisible();
}

test("sign up, then confirm the email address from the verification email", async ({ page }) => {
  test.skip(!local, "needs the local outbox");
  const email = `verify-${Date.now()}@example.com`;
  await signUp(page, "Vera Verify", email);
  await expect.poll(() => lastEmailTo(email)?.subject).toContain("Confirm your email");
  const link = lastEmailTo(email)!.text.match(/https?:\/\/\S+/)![0];
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
  await expect.poll(() => lastEmailTo(email)?.subject).toContain("Welcome to");
});

test("send a message from the demo workspace and find it in Sent", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.goto("/app/mail?compose=1");
  const compose = page.getByRole("dialog", { name: "New message" });
  await expect(compose).toBeVisible();
  const subject = `E2E hello ${Date.now()}`;
  await compose.getByLabel("To").fill("someone@example.com");
  await compose.getByLabel("Subject").fill(subject);
  await compose.getByLabel("Message").fill("Sent by the end to end suite.");
  await compose.getByRole("button", { name: "Send" }).click();
  await expect(compose).toBeHidden();
  await page.getByRole("navigation", { name: "Folders" }).getByRole("button", { name: /^Sent/ }).click();
  await expect(page.getByText(subject).first()).toBeVisible();
});

test("upgrade the plan and see the new limits", async ({ page }) => {
  await signUp(page, "Paula Plan", `plan-${Date.now()}@example.com`);
  await page.goto("/app/settings/billing");
  await expect(page.getByText("Starter").first()).toBeVisible();
  await page.getByRole("button", { name: "Switch to Pro" }).click();
  await expect(page.getByText("Plan updated")).toBeVisible();
  await expect(page.getByText("0 / 5").first()).toBeVisible(); // Pro allows 5 domains
});

test("invite a teammate who signs up and joins the workspace", async ({ page, browser }) => {
  await signUp(page, "Olive Owner", `owner-${Date.now()}@example.com`);
  const mate = `mate-${Date.now()}@example.com`;
  await page.goto("/app/settings/team");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("dialog").getByLabel("Email").fill(mate);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = (await page.getByTestId("invite-link").textContent())!.trim();
  expect(link).toContain("/invite/");

  const other = await browser.newContext();
  await asNewVisitor(other);
  const p2 = await other.newPage();
  await p2.goto(link);
  await p2.getByRole("link", { name: "Create your account" }).click();
  await p2.getByLabel("Your name").fill("Mason Mate");
  await p2.getByLabel("Password", { exact: true }).fill("a-strong-password");
  await p2.getByRole("button", { name: "Create account" }).click();
  await p2.getByRole("button", { name: "Accept and open workspace" }).click();
  await expect(p2).toHaveURL(/\/app/);
  await other.close();

  await page.reload();
  await expect(page.getByRole("list", { name: "Members" }).getByText("Mason Mate")).toBeVisible();
});

test("create an API key and call the REST API with it", async ({ page, request }) => {
  await signUp(page, "Abe Api", `api-${Date.now()}@example.com`);
  await page.goto("/app/settings/developers");
  await page.getByRole("button", { name: "Create API key" }).click();
  await page.getByRole("dialog").getByLabel("Name").fill("E2E");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  const secret = (await page.getByRole("dialog", { name: "Copy your API key" }).locator("code").first().textContent())!.trim();
  expect(secret).toMatch(/^mm_live_/);
  const res = await request.get("/api/v1/domains", { headers: { authorization: `Bearer ${secret}` } });
  expect(res.status()).toBe(200);
  expect((await request.get("/api/v1/domains", { headers: { authorization: "Bearer mm_live_wrongwrongwrongwrongwrong" } })).status()).toBe(401);
});

test("download a copy of my data", async ({ page }) => {
  await signUp(page, "Dana Data", `data-${Date.now()}@example.com`);
  await page.goto("/app/settings/account");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download my data" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^mymail-account-.*\.json$/);
});
