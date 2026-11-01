import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R108 contracts: pick a template, answer the interview (with an error on the way), preview, create the Doc with
 * reminder tasks, download Word, send to sign; an admin edits a clause (new version) and makes and retires a
 * workspace template; a member sees no admin controls. With SHOTS_DIR set it saves the UX gate screenshots at 1280
 * and 390 in light, dark and Forest and checks each view with axe (serious or critical fails the run).
 */
test.skip(process.env.CONTRACTS_E2E !== "1", "needs Tools on with the stand in engine: CONTRACTS_E2E=1 TOOLS_ENABLED=true TOOLS_FEATURES=templates,esign,share and DOC_ENGINE_URL at e2e/support/auto-engine.mjs");
const DIR = process.env.SHOTS_DIR;
let visitor = 0;
const ip = () => `10.108.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  if (!process.env.E2E_BASE_URL) await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function axe(page: Page, where: string) {
  await page.waitForTimeout(300);
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} ${v.nodes.slice(0, 2).map((n) => n.target).join(" | ")}`);
}
async function shot(page: Page, name: string, problems: string[]) {
  problems.push(...(await axe(page, name)));
  if (!DIR) return;
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}
async function openContracts(page: Page) {
  await page.goto("/app/tools/templates?view=contracts");
  await expect(page.getByTestId("contract-note").first()).toBeVisible({ timeout: 20_000 });
}
async function next(page: Page) { await page.getByRole("button", { name: "Next", exact: true }).click(); }
async function answerService(page: Page) {
  await page.getByTestId("contract-template-std-service").getByRole("button", { name: /^Start/ }).click();
  await expect(page.getByTestId("contract-step")).toBeVisible();
  await expect(page.getByLabel("Your business name")).not.toHaveValue("");
  // Error path: nothing in the client name.
  await next(page);
  await expect(page.getByText("Fill this in.").first()).toBeVisible();
  await page.getByLabel("Client name").fill("Bright Bakery Pty Ltd");
  await page.getByLabel("Client ABN (optional)").fill("51 824 753 557");
  await next(page);
  await expect(page.getByText(/ABN doesn't look right/)).toBeVisible();
  await page.getByLabel("Client ABN (optional)").fill("51 824 753 556");
  await next(page);
  await page.getByLabel("What will you do?").fill("Design and build a new website with an online order form.");
  await next(page);
  await page.getByRole("radio", { name: "By the hour" }).check();
  await page.getByLabel("Amount").fill("120");
  await expect(page.getByTestId("contract-preview")).toContainText("$120 an hour");
  await next(page);
  await page.getByRole("radio", { name: "Yes" }).nth(1).check(); // renew automatically
  await expect(page.getByLabel(/Notice needed to stop renewal/)).toBeVisible();
  await page.getByLabel("End date", { exact: true }).fill("2030-10-31");
  await next(page);
  await next(page);
  await expect(page.getByTestId("contract-review")).toBeVisible();
}

for (const size of [{ name: "1280", width: 1280, height: 860 }, { name: "390", width: 390, height: 844 }]) {
  test(`R108 ${size.name}: interview, preview, Doc with reminders, Word and send to sign`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const problems: string[] = [];
    await demo(page);
    await openContracts(page);
    await expect(page.getByTestId("contract-template-std-nda")).toBeVisible();
    await shot(page, `r108-gallery-${size.name}-light`, problems);
    await answerService(page);
    await expect(page.getByText(/Decide on renewal before the notice date/)).toBeVisible();
    await shot(page, `r108-review-${size.name}-light`, problems);
    {
      await page.getByRole("tab", { name: "Preview" }).click();
      await expect(page.getByTestId("contract-preview")).toBeVisible();
      await shot(page, `r108-preview-${size.name}-light`, problems);
      await page.getByRole("tab", { name: "Questions" }).click();
    }
    const word = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download Word" }).click();
    expect((await word).suggestedFilename()).toMatch(/^Service agreement.*\.docx$/);
    await page.getByRole("button", { name: "Create Doc" }).click();
    await expect(page.getByTestId("contract-made")).toContainText("Saved as a Doc");
    await expect(page.getByTestId("contract-made")).toContainText("2 reminder tasks added");
    await page.getByRole("link", { name: "Open the Doc" }).click();
    await expect(page).toHaveURL(/\/app\/docs\//);
    await expect(page.locator("main")).toContainText("This is a template, not legal advice.", { timeout: 20_000 });
    await expect(page.locator("main")).toContainText("Bright Bakery Pty Ltd");
    // Send to sign hands the PDF to the e-sign page.
    await openContracts(page);
    await expect(page.getByText("Service agreement: Multies Demo and Bright Bakery Pty Ltd").or(page.getByText(/Service agreement: .* and Bright Bakery Pty Ltd/)).first()).toBeVisible();
    await answerService(page);
    await page.getByRole("button", { name: "Send to sign" }).click();
    await expect(page).toHaveURL(/\/app\/tools\/sign\?result=/, { timeout: 60_000 });
    expect(problems).toEqual([]);
  });
}

test("R108 admin: clause versions and a workspace template; dark and Forest", async ({ page }) => {
  test.setTimeout(150_000);
  const problems: string[] = [];
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await openContracts(page);
  await page.getByRole("button", { name: "Clause library" }).click();
  await page.getByRole("button", { name: /^Which law applies/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByTestId("clause-editor")).toBeVisible();
  await page.getByLabel("Clause text").fill("The law of {{state}}, Australia applies to this agreement.\n\n[[if has_end]]\nThis clause has a broken test");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText(/needs an \[\[end\]\]/)).toBeVisible();
  await page.getByLabel("Clause text").fill("The law of {{state}}, Australia applies to this agreement and its courts hear any case about it.");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("Saved as version 1")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Which law applies/ })).toContainText("Version 1");
  await expect(page.getByText("Standard wording")).toBeVisible();
  await shot(page, "r108-clauses-1280-light", problems);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, "r108-clauses-1280-dark", problems);
  await page.getByRole("button", { name: "Back to templates" }).click();
  await page.getByTestId("contract-template-std-nda").getByRole("button", { name: "Make our version" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Name").fill("Fintex NDA");
  await dlg.getByRole("button", { name: "Remove Giving information back" }).click();
  await shot(page, "r108-template-editor-1280-dark", problems);
  await dlg.getByRole("button", { name: "Save template" }).click();
  const ours = page.locator('[data-testid^="contract-template-ctp"]').filter({ hasText: "Fintex NDA" });
  await expect(ours).toContainText("Your version");
  await expect(ours).toContainText("8 clauses");
  await shot(page, "r108-gallery-1280-dark", problems);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r108-gallery-390-dark", problems);
  await page.setViewportSize({ width: 1280, height: 860 });
  await ours.getByRole("button", { name: "Retire" }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: "Retire" }).click();
  await expect(ours).toContainText("Retired");
  await expect(ours.getByRole("button", { name: "Bring back" })).toBeVisible();
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await openContracts(page);
  await shot(page, "r108-gallery-1280-forest", problems);
  await page.getByTestId("contract-template-std-privacy").getByRole("button", { name: /^Start/ }).click();
  await shot(page, "r108-interview-1280-forest", problems);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, "r108-interview-390-forest", problems);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(problems).toEqual([]);
});

test("R108 member: no admin controls; Docs templates links to contracts", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  await page.route("**/api/contracts", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, canManage: false } });
  });
  await page.route("**/api/contracts/clauses", async (route) => route.fulfill({ response: await route.fetch() }));
  await page.goto("/app/templates");
  await page.getByTestId("contracts-entry").getByRole("link", { name: "Open contracts" }).click();
  await expect(page.getByTestId("contract-note").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Make our version" })).toHaveCount(0);
  await page.getByRole("button", { name: "Clause library" }).click();
  await expect(page.getByText("Only workspace admins can change clauses.")).toBeVisible();
  await expect(page.getByRole("button", { name: "New clause" })).toHaveCount(0);
  await page.getByRole("button", { name: /^GST/ }).click();
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
});
