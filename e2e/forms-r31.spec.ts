import { test, expect, type Browser } from "@playwright/test";
import { SHOTS_ROOT } from "./support/shots";

/**
 * R31: form logic and results. Build a form where "Details" shows only when "Is it urgent?" is
 * Yes, fill in the public form (hidden, then shown, then a required error), send it, and read the
 * response and the summary in the Responses view.
 */
let visitor = 0;
const ip = () => `10.131.${test.info().workerIndex % 200}.${++visitor}`;

async function signUp(browser: Browser) {
  const base = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 900 }, timezoneId: "UTC", colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": ip() } });
  const page = await ctx.newPage();
  const headers = { origin: new URL(base).origin };
  const tag = Math.random().toString(36).slice(2, 8);
  expect((await page.request.post("/api/auth/sign-up/email", { data: { name: "Ada Owner", email: `ada-${tag}@example.com`, password: "a-strong-password" }, headers })).status()).toBe(200);
  await page.request.patch("/api/account/preferences", { data: { timezone: "UTC", locale: "en" }, headers });
  return { ctx, page, headers, base };
}

const SHOTS = `${SHOTS_ROOT}/multies-r31`;

test("a question shown only for one answer, inline errors, and the Responses view", async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page } = await signUp(browser);
  await page.goto("/app/forms");
  await page.getByRole("button", { name: "New form" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Name").fill("Support request");
  // Field 3 becomes a Yes / No choice; field 4 (Details) shows only when it is Yes, and is required then.
  await dlg.getByLabel("Field 3 label").fill("Is it urgent?");
  await dlg.getByLabel("Field 3 type").selectOption("select");
  await dlg.getByLabel("Choices").fill("Yes, No");
  await dlg.getByLabel("Field 4 label").fill("What is the deadline?");
  const row4 = dlg.locator("li").filter({ has: page.getByLabel("Field 4 label") });
  await row4.getByLabel("Required").check();
  await dlg.getByTestId("logic-toggle-3").click();
  await row4.getByRole("button", { name: "Add condition" }).first().click(); // TD2 on: show, require and disable each have one
  const cond = row4.getByTestId("logic-condition").first();
  await expect(cond.getByLabel("Question")).toHaveValue("what_do_you_need");
  await cond.getByLabel("Value").selectOption("Yes");
  await row4.getByLabel("Shortest").fill("5");
  await expect(dlg.getByTestId("logic-problem")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/forms-logic.png` });
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("form-row").filter({ hasText: "Support request" })).toBeVisible();

  const forms = (await (await page.request.get("/api/forms")).json()).forms as { name: string; url: string; fields: { id: string; logic?: unknown }[] }[];
  const form = forms.find((f) => f.name === "Support request")!;
  expect(form.fields[3].logic).toEqual({ join: "all", conditions: [{ field: "what_do_you_need", op: "is", value: "Yes" }] });

  const outsider = await browser.newPage({ extraHTTPHeaders: { "x-forwarded-for": ip() } });
  await outsider.goto(new URL(form.url).pathname);
  const f = outsider.getByTestId("public-form");
  await expect(f.getByLabel("Your name")).toBeVisible();
  await expect(f.getByLabel(/What is the deadline/)).toHaveCount(0);
  await f.getByLabel("Your name").fill("Grace Lee");
  await f.getByLabel("Email").fill("grace@harbourcoffee.com.au");
  await f.getByLabel("Is it urgent?").selectOption("Yes");
  await expect(f.getByLabel(/What is the deadline/)).toBeVisible();
  await f.getByRole("button", { name: "Send" }).click();
  await expect(f.getByRole("alert")).toHaveText('Please fill in "What is the deadline?".');
  await f.getByLabel(/What is the deadline/).fill("Fri");
  await f.getByRole("button", { name: "Send" }).click();
  await expect(f.getByRole("alert")).toHaveText('"What is the deadline?" needs at least 5 characters.');
  // Switching to No hides it again and drops the error.
  await f.getByLabel("Is it urgent?").selectOption("No");
  await expect(f.getByLabel(/What is the deadline/)).toHaveCount(0);
  await f.getByLabel("Is it urgent?").selectOption("Yes");
  await f.getByLabel(/What is the deadline/).fill("Friday 5pm");
  await outsider.waitForTimeout(2000); // the form's minimum fill time
  await f.getByRole("button", { name: "Send" }).click();
  await expect(outsider.getByTestId("form-done")).toBeVisible();
  await outsider.close();
  await expect.poll(async () => ((await (await page.request.get("/api/forms")).json()).forms as { name: string; submitCount: number }[]).find((x) => x.name === "Support request")?.submitCount, { timeout: 10_000 }).toBe(1);
  await page.reload();

  await page.getByTestId("form-row").filter({ hasText: "Support request" }).getByRole("button", { name: "Responses" }).click();
  const results = page.getByTestId("form-results");
  await expect(results.getByTestId("response-row")).toHaveCount(1);
  await expect(results.getByTestId("response-row")).toContainText("Friday 5pm");
  await results.getByLabel("Search answers").fill("nobody-matches");
  await expect(results.getByText("No responses match.")).toBeVisible();
  await results.getByLabel("Search answers").fill("grace");
  await expect(results.getByTestId("response-row")).toHaveCount(1);
  await results.getByRole("tab", { name: "Summary" }).click();
  const urgent = results.getByTestId("summary-question").filter({ hasText: "Is it urgent?" });
  await expect(urgent).toContainText("Yes");
  await expect(urgent).toContainText("1 · 100%");
  await ctx.close();
});
