import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W1: product shots for the public pages, from the sample (demo) workspace of this build: made up data only.
 * Not part of the normal run. W1_SHOTS=1 npx playwright test e2e/marketing-shots-w1.spec.ts, then
 * scripts in the W1 task turn the PNGs into the webp files in public/shots/.
 */
const OUT = process.env.W1_SHOTS_DIR ?? "/tmp/w1shots";
const ROUTES: [string, string, string?][] = [
  ["mail", "/app/mail", 'text=Launch checklist for Friday'], ["tasks", "/app/tasks"], ["chat", "/app/chat"], ["docs", "/app/docs", 'a[href^="/app/docs/"]:not([href$="/links"]):not([href$="/help-center"]) >> nth=2'],
  ["files", "/app/files"], ["meetings", "/app/meetings"], ["booking", "/app/scheduling?tab=resources"],
  ["contacts", "/app/contacts", 'a[href^="/app/contacts/"]:not([href*="invoices"]):not([href*="portals"]), [role="row"] >> nth=1'], ["invoices", "/app/contacts/invoices"], ["sign", "/app/forms"],
  ["social", "/app/social"], ["agents", "/app/approvals"],
];

test.setTimeout(600_000);

test("product shots, light and dark", async ({ page }) => {
  test.skip(!process.env.W1_SHOTS, "only when making the W1 product shots");
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Try the live demo" }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  // Made up sample records for the areas the demo leaves empty: invoices and files.
  await page.request.put("/api/invoices/settings", { data: { businessName: "Harbour Design", abn: "51 824 753 556", bsb: "062000", accountNumber: "12345678", accountName: "Harbour Design Pty Ltd" } }).catch(() => {});
  const inv = [["Ola Park", "Website build", 300000], ["Bondi Bakery", "Brand refresh", 185000], ["Coastal Physio", "Booking page setup", 64000], ["Sam Lee", "Logo design", 120000]] as const;
  for (const [i, [buyerName, description, unitCents]] of inv.entries()) {
    const d = await (await page.request.post("/api/invoices/docs", { data: { kind: i === 3 ? "quote" : "invoice", buyerName, buyerEmail: "hello@example.com", lines: [{ description, quantityMilli: 1000, unitCents }] } })).json().catch(() => null) as { doc?: { id: string } } | null;
    if (d?.doc && i < 3) await page.request.post(`/api/invoices/docs/${d.doc.id}/issue`, { data: {} }).catch(() => {});
  }
  await page.goto("/app/files");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  const input = page.locator('input[type="file"]').first();
  if (await input.count()) {
    await input.setInputFiles(["Brand guidelines.pdf", "Office fitout quote.pdf", "Client brief.pdf", "Q4 plan.pdf"].map((name) => ({ name, mimeType: "application/pdf", buffer: pdf }))).catch(() => {});
    await page.waitForTimeout(2500);
  }
  // The sample inbox has one thread that names another mail provider; archive it so no other company's name shows.
  await page.goto("/app/mail");
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  const other = page.locator("text=Can we move our team over this week?").first();
  if (await other.count()) { await other.click().catch(() => {}); await page.waitForTimeout(800); await page.keyboard.press("e").catch(() => {}); await page.waitForTimeout(1200); }
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((t) => localStorage.setItem("multies-theme", t), theme);
    for (const [name, path, open] of ROUTES.filter(([n]) => !process.env.W1_ONLY || process.env.W1_ONLY.split(",").includes(n))) {
      await page.goto(path);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
      if (open) {
        const link = page.locator(open).first();
        if (await link.count()) { await link.click().catch(() => {}); await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {}); }
      }
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${OUT}/${name}-${theme}.png` });
    }
  }
});

test("home page shots for the owner", async ({ page }) => {
  test.skip(!process.env.W1_HOME_SHOTS, "only when asked");
  const out = process.env.W1_HOME_SHOTS!;
  mkdirSync(out, { recursive: true });
  for (const [w, h, scheme, name] of [[1280, 800, "light", "home-1280-light"], [1280, 800, "dark", "home-1280-dark"], [390, 844, "light", "home-390-light"], [390, 844, "dark", "home-390-dark"]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const ok = page.getByRole("button", { name: "OK" });
    if (await ok.isVisible().catch(() => false)) await ok.click().catch(() => {});
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: w === 390 ? false : false });
    if (w === 1280 && scheme === "light") {
      await page.locator("#features").scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/home-1280-areas.png` });
    }
  }
});
