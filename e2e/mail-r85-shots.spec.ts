import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * R85: screenshots and axe for Mail (UX gate items 6, 9 and 10). Runs only with SHOTS_DIR set. PHASE=before shoots the
 * Inbox as it was; the default (after) shoots Inbox tabs, the tabs sheet, the move to tab menu, Rules (list, editor with
 * the test result, run log) and labels, at 1280 and 390, light and dark, and Forest at 1280.
 */
const DIR = process.env.SHOTS_DIR;
const PHASE = process.env.PHASE ?? "after";
test.skip(!DIR, "screenshots only with SHOTS_DIR");

let visitor = 0;
const ip = () => `10.185.${test.info().workerIndex % 200}.${++visitor}`;

async function demo(page: Page) {
  await page.goto("/login");
  await page.getByRole("button", { name: "Explore a demo workspace" }).click();
  await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
}
async function busiest(page: Page) {
  const overview = await (await page.request.get("/api/mail/overview")).json();
  return [...overview.mailboxes].sort((a, b) => (b.folders.inbox?.total ?? 0) - (a.folders.inbox?.total ?? 0))[0] as { id: string; address: string };
}
async function shot(page: Page, name: string) {
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: false });
}
async function axe(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).include("main").analyze();
  return violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${label}: ${v.id} ${v.nodes.slice(0, 3).map((n) => n.target).join(" | ")}`);
}
const noSideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test("mail screenshots and axe", async ({ page, context, baseURL }) => {
  test.setTimeout(300_000);
  if (!process.env.E2E_BASE_URL) await context.setExtraHTTPHeaders({ "x-forwarded-for": ip() });
  const origin = new URL(baseURL!).origin;
  await page.setViewportSize({ width: 1280, height: 860 });
  await demo(page);
  const mb = await busiest(page);
  const bad: string[] = [];

  if (PHASE === "before") {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [w, h] of [[1280, 860], [390, 844]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`/app/mail?mailbox=${mb.id}`);
        await shot(page, `mail-before-inbox-${w === 1280 ? "desktop" : "phone"}-${scheme}`);
      }
    }
    return;
  }

  const headers = { origin };
  await page.request.put("/api/mail/splits/style", { headers, data: { style: "categories" } });
  const snip = await (await page.request.post("/api/mail/snippets", { headers, data: { name: "Got it", body: "Thanks {{first_name}}, we got your message and will reply today." } })).json();
  const first = (await (await page.request.get(`/api/mail/messages?mailboxId=${mb.id}&folder=inbox&limit=5`)).json()).messages as { id: string; threadId: string; from: { address: string } }[];
  const domain = first[0].from.address.split("@")[1];
  await page.request.post("/api/mail/labels", { headers, data: { threadId: first[0].threadId, label: "Clients" } });
  await page.request.post("/api/mail/labels", { headers, data: { threadId: first[1].threadId, label: "Follow up" } });
  const rule = await (await page.request.post("/api/mail/rules", { headers, data: {
    name: "Client mail", mailboxId: mb.id, conditions: [{ field: "domain", value: domain }],
    actions: [{ kind: "label", label: "Clients" }, { kind: "auto_reply", snippetId: snip.snippet.id }, { kind: "notify" }],
  } })).json();
  await page.request.post("/api/mail/rules", { headers, data: { name: "Receipts", mailboxId: mb.id, enabled: false, conditions: [{ field: "subject", value: "receipt" }, { field: "hasAttachment" }], actions: [{ kind: "label", label: "Receipts" }, { kind: "archive" }] } });
  await page.request.post(`/api/mail/rules/${rule.rule.id}/run-recent`, { headers });

  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [w, h] of [[1280, 860], [390, 844]] as const) {
      const size = w === 1280 ? "desktop" : "phone";
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/app/mail?mailbox=${mb.id}`);
      await expect(page.getByRole("tablist", { name: "Inbox tabs" })).toBeVisible();
      await shot(page, `mail-after-inbox-${size}-${scheme}`);
      if (!(await noSideways(page))) bad.push(`${scheme} ${w} inbox: sideways scroll`);
      bad.push(...(await axe(page, `${scheme} ${w} inbox`)));
      await page.getByRole("button", { name: "Edit tabs" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await shot(page, `mail-after-tabs-sheet-${size}-${scheme}`);
      await page.keyboard.press("Escape");
      await page.goto(`/app/mail/rules?mailbox=${mb.id}`);
      await expect(page.getByTestId("rules-list")).toBeVisible();
      await shot(page, `mail-after-rules-${size}-${scheme}`);
      if (!(await noSideways(page))) bad.push(`${scheme} ${w} rules: sideways scroll`);
      bad.push(...(await axe(page, `${scheme} ${w} rules`)));
      const rowAct = async (name: string) => {
        const row = page.getByTestId(`rule-${rule.rule.id}`);
        if (w === 1280) return row.getByRole("button", { name }).click();
        await row.getByRole("button", { name: /^More for/ }).click();
        await page.getByRole("menuitem", { name }).click();
      };
      await rowAct("Edit");
      await page.getByRole("button", { name: "Test on recent mail" }).click();
      await expect(page.getByTestId("rule-test-result")).toBeVisible();
      await shot(page, `mail-after-rule-editor-${size}-${scheme}`);
      bad.push(...(await axe(page, `${scheme} ${w} rule editor`)));
      await page.keyboard.press("Escape");
      await rowAct("Run log");
      await expect(page.getByTestId("rule-runs")).toBeVisible();
      await shot(page, `mail-after-rule-log-${size}-${scheme}`);
      await page.keyboard.press("Escape");
    }
  }
  // Empty states.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`/app/mail?mailbox=${mb.id}&label=Nothing+here`);
  await shot(page, "mail-after-label-empty-desktop-light");

  // One brand theme.
  await page.goto("/app/settings/branding");
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.getByRole("button", { name: "Save brand" }).click();
  await page.waitForTimeout(800);
  await page.goto(`/app/mail?mailbox=${mb.id}`);
  await shot(page, "mail-after-inbox-desktop-forest");
  bad.push(...(await axe(page, "forest inbox")));
  await page.goto(`/app/mail/rules?mailbox=${mb.id}`);
  await expect(page.getByTestId("rules-list")).toBeVisible();
  await shot(page, "mail-after-rules-desktop-forest");
  bad.push(...(await axe(page, "forest rules")));
  expect(bad).toEqual([]);
});
