import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R81B: screenshots and the accessibility check for the screens whose words changed in the rename (UX gate items 6,
 * 9 and 10). Runs only with SHOTS_DIR set: Mail settings (Email Worker setup), the landing page (DNS records and
 * questions), Pricing questions, Agents and Developers, at 1280 and 390, light and dark, and one brand theme.
 */
const DIR = process.env.SHOTS_DIR;
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.181.${test.info().workerIndex % 200}.${++visitor}`;

async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}

async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}

const PUBLIC: [string, string, string | null][] = [
  ["/", "landing-dns", "text=_domainkey"],
  ["/", "landing-faq", "text=Where is my email stored?"],
  ["/pricing", "pricing-faq", "text=Where is my email stored?"],
  ["/agents", "agents", "text=MULTIES_AGENT_KEY"],
  ["/developers", "developers", null],
];

test.use({ actionTimeout: 15_000 });

test("rename screens: screenshots, no sideways scroll, axe", async ({ page, context }) => {
  test.setTimeout(900_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const bad: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const [path, name, anchor] of PUBLIC) {
        await page.goto(path);
        if (anchor) await page.locator(anchor).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => undefined);
        await shot(page, `${name}-${w}-${scheme}`);
        if (!(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))) bad.push(`${path} ${w} ${scheme}: sideways scroll`);
        if (anchor !== null || path === "/developers") bad.push(...(await axe(page, `${path} ${w} ${scheme}`)));
      }
    }
  }

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  const worker = page.getByRole("region", { name: "Email Worker settings" }).or(page.getByLabel("Email Worker settings"));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/app/settings/mail");
      await worker.first().scrollIntoViewIfNeeded({ timeout: 15_000 });
      await shot(page, `settings-mail-worker-${w}-${scheme}`);
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))) bad.push(`settings mail ${w} ${scheme}: sideways scroll`);
      bad.push(...(await axe(page, `settings mail ${w} ${scheme}`)));
    }
  }

  // One brand theme.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto("/app/settings/branding");
  const forest = page.getByRole("button", { name: "Forest", exact: true });
  await forest.first().waitFor({ timeout: 20_000 });
  {
    await forest.first().click();
    await page.getByRole("button", { name: "Save brand" }).click();
    await page.waitForTimeout(800);
    await page.goto("/app/settings/mail");
    await worker.first().scrollIntoViewIfNeeded({ timeout: 15_000 });
    await shot(page, "settings-mail-worker-1280-forest");
    bad.push(...(await axe(page, "settings mail forest")));
  }
  expect(bad).toEqual([]);
});
