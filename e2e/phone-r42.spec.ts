import { test, expect, type Page } from "@playwright/test";

/**
 * R42 phone helper: the mail selects open the app's bottom sheet at 390 px (compose From, Undo window and Remind me,
 * plus the bulk bar's Move to when a row can be picked), and the Tasks list gets the board's rapid add at its foot.
 * SHOTS=before or SHOTS=after saves screenshots to /home/user/tab/files/multies-r42/ (before skips the new checks).
 */
let visitor = 0;
test.beforeEach(async ({ context }) => {
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.142.${test.info().workerIndex % 200}.${++visitor}` });
});
test.setTimeout(180_000);

const SHOTS = process.env.SHOTS;
const AFTER = SHOTS !== "before";
const DIR = "/home/user/tab/files/multies-r42";
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 30_000 });
}
async function shot(page: Page, name: string) { if (SHOTS) await page.screenshot({ path: `${DIR}/${name}.png`, type: "png" }); }
const pick = (page: Page, name: string) => page.locator(`[data-testid="phone-select"][data-name="${name}"]`);

for (const scheme of ["light", "dark"] as const) {
  test(`mail selects open the bottom sheet on a phone (${scheme})`, async ({ page }) => {
    test.skip(!AFTER, "the pickers are already in this build; only after shots");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(PHONE);
    await demo(page);
    await page.goto("/app/mail");
    await expect(page.getByTestId("mail-star").first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Compose" }).first().click();
    const from = pick(page, "From");
    await expect(from).toBeVisible();
    await from.click();
    const sheet = page.getByTestId("picker-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("radio").first()).toBeVisible();
    await expect(sheet.locator("[aria-checked='true']")).toHaveCount(1);
    await shot(page, `mailpick-after-compose-from-phone-${scheme}`);
    // Escape closes only the sheet; Compose behind it stays open (R42 fix: React bubbles keys through portals).
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("dialog", { name: "New message" })).toBeVisible();

    // Remind me: pick a value in the sheet and the real select follows.
    await pick(page, "Remind me if no reply").click({ timeout: 10_000 });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("radio", { name: "Remind in 3 days" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Remind me if no reply" })).toHaveValue("3");
    await expect(pick(page, "Remind me if no reply")).toContainText("Remind in 3 days");

    await pick(page, "Undo send window").click({ timeout: 10_000 });
    await expect(sheet).toBeVisible();
    await shot(page, `mailpick-after-undo-window-phone-${scheme}`);
    await sheet.locator("[aria-checked='true']").click();
    await expect(sheet).toBeHidden();
    await page.getByRole("button", { name: "Close and save draft" }).click();

    // The selection bar's Move to: an icon on phones that opens the same sheet.
    await page.getByTestId("mail-select").first().click();
    await expect(page.getByTestId("bulk-bar")).toBeVisible();
    await pick(page, "Move to").click({ timeout: 10_000 });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Archive" })).toBeVisible();
    await shot(page, `mailpick-after-bulk-move-phone-${scheme}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways).toBeLessThanOrEqual(1);
  });

  for (const [where, size] of [["desktop", DESK], ["phone", PHONE]] as const) {
    test(`Tasks list rapid add on ${where} (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize(size);
      await demo(page);
      await page.goto("/app/tasks?view=list");
      await expect(page.getByTestId(where === "phone" ? "phone-task-list" : "task-table")).toBeVisible({ timeout: 15_000 });
      await page.mouse.wheel(0, 4000);
      if (!AFTER) { await shot(page, `listadd-before-list-${where}-${scheme}`); return; }
      const add = page.getByTestId("list-composer").getByRole("button", { name: "Add task" });
      await add.scrollIntoViewIfNeeded();
      await shot(page, `listadd-after-row-${where}-${scheme}`);
      await add.click();
      const input = page.getByTestId("list-composer").getByRole("textbox");
      await expect(input).toBeFocused();
      const tag = `${where}-${scheme}-${Date.now() % 100000}`;
      await input.fill(`R42 rapid one ${tag}`);
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await input.fill(`R42 rapid two ${tag}`);
      await input.press("Enter");
      await expect(page.getByText(`R42 rapid one ${tag}`).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(`R42 rapid two ${tag}`).first()).toBeVisible({ timeout: 15_000 });
      await expect(input).toBeFocused();
      await input.fill("half typed");
      await shot(page, `listadd-after-typing-${where}-${scheme}`);
      await input.press("Escape");
      await expect(input).toBeHidden();
      await expect(add).toBeVisible();
      // Exactly one of each landed (the create is idempotent, a retry is never doubled).
      const tasks = (await (await page.request.get("/api/tasks")).json()).tasks as { title: string }[];
      expect(tasks.filter((t) => t.title === `R42 rapid one ${tag}`)).toHaveLength(1);
      expect(tasks.filter((t) => t.title === `R42 rapid two ${tag}`)).toHaveLength(1);
      if (where === "phone") {
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(sideways).toBeLessThanOrEqual(1);
      }
    });
  }
}
